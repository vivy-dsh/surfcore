#!/usr/bin/env node
/**
 * 量一次「入站语音条的形状」：给一个 QQ 消息 id，把三条事实一次性打出来。
 *
 * 为什么需要它：本地 SenseVoice 兜底（`bot.getRecord` → `/dsh-asr/internal/transcribe`）
 * 卡在同一个问题上 —— **`get_record` 到底回什么**。SDK 里 `MediaInfo extends JsonObject {}`
 * 是个空接口（`@snowluma/sdk` dist/types/results.d.ts:87），没有权威定义，只能实测。
 * 猜着写 120 行兜底代码，不如先花一条命令把形状量出来。
 *
 * **只读**：只调网关的查询接口（get_msg / fetch_ptt_text / get_record），
 * 不写任何状态、不发消息、不改 config.json、不碰 DSH。令牌不打印，URL 去掉 query（签名）。
 *
 * 用法：
 *   node scripts/probe-record-shape.mjs --message <消息id> [--out wav] [--gateway http://127.0.0.1:3000]
 *   node scripts/probe-record-shape.mjs --file <语音库文件名>      # 已经有 file 时跳过第①②步
 *
 * 预期输出：转写有无 + record 段的 file + get_record 回包的键与形状摘要（只给长度和去签名地址）。
 * 失败后果：只打印错误并返回非 0 退出码，不影响正在跑的桥接。
 *
 * 退出码：0 = get_record 成功（形状已量到）；2 = 这条消息里没有 record 段；1 = 网关/参数问题。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { recordTextConfig, createPttTextFetcher, recordFilesFromMessage, summarizeRecordShape } from '../src/record-text.js';

const ROOT = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    args[key] = next === undefined || next.startsWith('--') ? true : (index += 1, next);
  }
  return args;
}

function loadGateway(args) {
  let config = {};
  const file = args.config ? path.resolve(String(args.config)) : path.join(ROOT, 'config.json');
  try { config = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { config = {}; }
  const httpUrl = String(args.gateway || config?.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
  const accessToken = String(config?.snowluma?.accessToken || '');
  return { httpUrl, accessToken, file };
}

async function callGateway({ httpUrl, accessToken }, action, body, timeoutMs) {
  const url = `${httpUrl}/${action}`;
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new Error(`连不上网关 ${httpUrl}（${action} ${timeoutMs}ms）：${error?.message ?? error}`
      + '；先确认 SnowLuma 容器在跑、且端口与 config.json 的 snowluma.httpUrl 一致');
  }
  const payload = await response.json().catch(() => null);
  if (!payload) throw new Error(`网关 ${httpUrl} 的 ${action} 回的不是 JSON（HTTP ${response.status}）；这个端口上可能是别的东西`);
  return { httpStatus: response.status, payload };
}

function describeCall(result, action) {
  if (!result.payload) return `${action}：回包不是 JSON（HTTP ${result.httpStatus}）`;
  const { status, retcode } = result.payload;
  return `${action}：status=${status ?? '?'} retcode=${retcode ?? '?'}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const messageId = args.message === undefined ? '' : String(args.message);
  const directFile = typeof args.file === 'string' ? args.file : '';
  if (!messageId && !directFile) {
    console.error('用法：node scripts/probe-record-shape.mjs --message <消息id> [--out wav] [--gateway http://127.0.0.1:3000]');
    return 1;
  }

  const gateway = loadGateway(args);
  const outFormat = typeof args.out === 'string' ? args.out : 'wav';
  const timeoutMs = Number(args.timeout) > 0 ? Number(args.timeout) : 8000;
  const source = typeof args.gateway === 'string' ? '命令行 --gateway' : path.relative(process.cwd(), gateway.file);
  console.log(`网关: ${gateway.httpUrl}（来源 ${source}，令牌${gateway.accessToken ? '已读取，不回显' : '未配置'}）`);

  let files = directFile ? [directFile] : [];

  if (messageId) {
    console.log(`消息 ${messageId}`);
    const message = await callGateway(gateway, 'get_msg', { message_id: Number(messageId) }, timeoutMs);
    if (!message.payload || message.payload.status !== 'ok' || message.payload.retcode !== 0) {
      console.error(`① get_msg 失败：${describeCall(message, 'get_msg')}`);
      return 1;
    }
    files = recordFilesFromMessage(message.payload.data);
    console.log(`① record 段：找到 ${files.length} 个 file${files.length ? `，如 ${JSON.stringify(files[0])}` : '（这条消息没有语音）'}`);
    if (!files.length) return 2;

    const fetcher = createPttTextFetcher({
      httpUrl: gateway.httpUrl,
      accessToken: gateway.accessToken,
      config: recordTextConfig({ attempts: 1, timeoutMs }),
      fetchImpl: fetch,
    });
    const transcript = await fetcher.fetch(messageId);
    console.log(transcript.ok
      ? `② QQ 侧转写（fetch_ptt_text）：有，${transcript.text.length} 个字符`
      : `② QQ 侧转写（fetch_ptt_text）：没有（原因 ${transcript.reason}；no-ptt = QQ 自己就没给转写）`);
  }

  let measured = false;
  for (const file of files) {
    const record = await callGateway(gateway, 'get_record', { file, out_format: outFormat }, timeoutMs);
    console.log(`③ get_record(file=${JSON.stringify(file)}, out_format=${outFormat})：${describeCall(record, 'get_record')}`);
    if (!record.payload || record.payload.status !== 'ok' || record.payload.retcode !== 0) {
      console.log(`   回包原文键：${record.payload ? Object.keys(record.payload).join('、') : '（无）'}`);
      continue;
    }
    measured = true;
    const shape = summarizeRecordShape(record.payload.data);
    console.log(`   回包键: ${shape.keys.length ? shape.keys.join('、') : '（空对象）'}`);
    console.log(`   base64: ${shape.base64Chars} 字符${shape.base64Chars ? `（≈${(shape.base64Chars * 3 / 4 / 1024).toFixed(1)} KiB）` : ''}`);
    console.log(`   file  : ${shape.fileKind}${shape.file ? ` ${shape.file}` : ''}`);
    console.log(`   url   : ${shape.urlKind}${shape.url ? ` ${shape.url}` : ''}`);
    const usable = [shape.base64Chars > 0 ? 'base64' : '', shape.urlKind === 'loopback' ? 'url' : '', shape.fileKind === 'absolute' || shape.fileKind === 'relative' ? 'file' : ''].filter(Boolean);
    console.log(`   可用来源: ${usable.length ? usable.join(' / ') : '无（三种形状都没有可用字节，得换接口）'}`);
  }
  return measured ? 0 : 1;
}

main().then(code => process.exit(code)).catch(error => {
  console.error(`探针失败：${error?.message ?? error}`);
  process.exit(1);
});
