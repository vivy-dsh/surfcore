/**
 * 入站语音条 → 文字（QQ 自己的转写）回归。
 *
 * 用户 2026-11-05 要求：「接通 QQ 入站 record 段→文字（fail-open）」。
 *
 * 这条链路为什么容易写坏，所以必须钉住：
 *   · 语音段以前一律压成 `[语音]`（bridge.js segmentsToText），群友说了什么 AI 完全不知道；
 *   · 转写要拿 message_id 去问网关（`fetch_ptt_text`），**一条消息只能问一次** ——
 *     一条消息会被 segmentsToText 解析两遍（带引用 / 纯正文），漏了复用就是双倍往返；
 *   · 转写文本是不可信输入，会进模型上下文，必须压成单行、限长；
 *   · 任何失败都必须回落 `[语音]`，绝不能让「转写失败」变成「消息进不了上下文」。
 *
 * 全部在 fixture 里跑（虚拟网关 + 临时目录），不连真实 QQ / DSH。
 * 运行：node scripts/test-record-text.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import {
  RECORD_TEXT_DEFAULTS,
  recordTextConfig,
  sanitizeTranscript,
  classifyPttText,
  describeFailure,
  createPttTextFetcher,
  createMinuteLimiter,
  createTranscriptCache,
  recordFilesFromMessage,
  summarizeRecordShape,
} from '../src/record-text.js';

let failures = 0;
async function unit(name, run) {
  try { await run(); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, error.message); }
}
async function test(name, run, harness = {}) {
  const h = await bridgeHarness(harness);
  try { await run(h); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, error.message); }
  finally { await h.close(); }
}

// ── 1. 纯逻辑：配置 / 归一化 / 回包判定 ──────────────────────────────────────

await unit('配置：缺省、非法值回落，enabled=false 要能关掉', () => {
  const d = recordTextConfig();
  assert.equal(d.enabled, true, '默认开：入站转写不需要用户准备任何东西');
  assert.equal(d.timeoutMs, RECORD_TEXT_DEFAULTS.timeoutMs);
  assert.equal(d.history, false, '上线补历史默认关（一次补历史可能好几条语音）');

  const bad = recordTextConfig({ timeoutMs: 'soon', attempts: 99, maxChars: -5, maxPerMinute: NaN, history: 'yes' });
  assert.equal(bad.timeoutMs, RECORD_TEXT_DEFAULTS.timeoutMs, '非数字回落默认');
  assert.equal(bad.attempts, RECORD_TEXT_DEFAULTS.attempts, '越界回落默认（不是夹到边界）');
  assert.equal(bad.maxChars, RECORD_TEXT_DEFAULTS.maxChars, '越界回落默认');
  assert.equal(bad.maxPerMinute, RECORD_TEXT_DEFAULTS.maxPerMinute);
  assert.equal(bad.history, false, '只有严格 true 才算开');

  assert.equal(recordTextConfig({ enabled: false }).enabled, false, '开关要能关');
  assert.equal(recordTextConfig(null).enabled, true, 'config 缺失也不能抛');
  assert.equal(recordTextConfig(['x']).enabled, true, '数组当非法值处理');
});

await unit('归一化：压单行、去控制字符、限长加省略号', () => {
  assert.equal(sanitizeTranscript('你好\n世界'), '你好 世界', '换行压成空格');
  assert.equal(sanitizeTranscript('  你  好  '), '你 好', '连续空白合一');
  assert.equal(sanitizeTranscript('行\u0000\u0007尾'), '行 尾', '控制字符不能进上下文');
  assert.equal(sanitizeTranscript(''), '');
  assert.equal(sanitizeTranscript(null), '', '非字符串给空串');
  assert.equal(sanitizeTranscript('一二三四五', 3), '一二三…', '超长截断要看得出来');
});

await unit('回包判定：retcode 100 是终局（no-ptt），其余失败可重试', () => {
  assert.deepEqual(classifyPttText({ status: 'ok', retcode: 0, data: { text: '你好' } }), { text: '你好', reason: '' });
  assert.equal(classifyPttText({ status: 'ok', retcode: 100 }).reason, 'no-ptt', '自己发的语音/无转写 = retcode 100');
  assert.equal(classifyPttText({ status: 'failed', retcode: 5 }).reason, 'retcode-5');
  assert.equal(classifyPttText({ status: 'ok', retcode: 0, data: {} }).reason, 'empty');
  assert.equal(classifyPttText(null).reason, 'bad-response');
  assert.equal(classifyPttText('nope').reason, 'bad-response');
});

await unit('失败原因都有给人看的一句话（AGENTS 1.7：可行动）', () => {
  for (const reason of ['no-ptt', 'timeout', 'fetch-error', 'rate-limited', 'bogus-9']) {
    const text = describeFailure(reason);
    assert.ok(typeof text === 'string' && text.length > 0, `${reason} 要有说明`);
    assert.ok(!text.includes('undefined'), `${reason} 的说明不能是 undefined`);
  }
  assert.match(describeFailure('timeout'), /超时/);
  assert.match(describeFailure('fetch-error'), /网关/);
});

// ── 2. 取数器：重试边界、终局不重试、超预算不卡死 ────────────────────────────

const okBody = (text) => ({ status: 'ok', retcode: 0, data: { text } });
const jsonRes = (body) => ({ ok: true, status: 200, json: async () => body });

await unit('取数器：第一枪就成功', async () => {
  const calls = [];
  const fetcher = createPttTextFetcher({
    httpUrl: 'http://127.0.0.1:3000/',
    accessToken: 'tok',
    config: recordTextConfig({}),
    fetchImpl: async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return jsonRes(okBody('你好，世界')); },
    sleep: async () => {},
  });
  const r = await fetcher.fetch(12345);
  assert.equal(r.ok, true);
  assert.equal(r.text, '你好，世界');
  assert.equal(r.attempts, 1, '成功就不该重试');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://127.0.0.1:3000/fetch_ptt_text', '末尾斜杠要收敛');
  assert.equal(calls[0].body.message_id, '12345', 'message_id 一律按字符串发');
});

await unit('取数器：retcode 100 是终局，重试也没用（不许浪费时间）', async () => {
  let n = 0;
  const fetcher = createPttTextFetcher({
    config: recordTextConfig({ attempts: 3 }),
    fetchImpl: async () => { n += 1; return jsonRes({ status: 'ok', retcode: 100 }); },
    sleep: async () => {},
  });
  const r = await fetcher.fetch(1);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no-ptt');
  assert.equal(n, 1, 'no-ptt 直接收手，不重试');
});

await unit('取数器：先超时后成功（QQ 转写晚到时靠重试救回来）', async () => {
  const slept = [];
  let n = 0;
  const fetcher = createPttTextFetcher({
    config: recordTextConfig({ attempts: 3, retryDelayMs: 400, timeoutMs: 5000 }),
    fetchImpl: async () => {
      n += 1;
      if (n === 1) throw Object.assign(new Error('timeout'), { name: 'TimeoutError' });
      return jsonRes(okBody('第二枪拿到'));
    },
    sleep: async (ms) => { slept.push(ms); },
  });
  const r = await fetcher.fetch(9);
  assert.equal(r.ok, true);
  assert.equal(r.text, '第二枪拿到');
  assert.equal(n, 2, '第一次超时后要重试');
  assert.equal(slept.length, 1, '重试之间要退避');
  assert.ok(slept[0] > 0 && slept[0] <= 400, '退避不超过配置值');
});

await unit('取数器：一直失败也只回 reason，绝不抛异常', async () => {
  let n = 0;
  const fetcher = createPttTextFetcher({
    config: recordTextConfig({ attempts: 2, retryDelayMs: 1 }),
    fetchImpl: async () => { n += 1; throw new Error('ECONNREFUSED'); },
    sleep: async () => {},
  });
  const r = await fetcher.fetch(7);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'fetch-error');
  assert.equal(n, 2, '按 attempts 重试完就收手');

  const noId = await createPttTextFetcher({ config: recordTextConfig({}), fetchImpl: async () => { throw new Error('不该被调用'); } }).fetch('');
  assert.equal(noId.ok, false);
  assert.equal(noId.reason, 'no-message-id');
});

await unit('限流：滚动窗口，0 = 不限', () => {
  let now = 1_000_000;
  const limiter = createMinuteLimiter({ now: () => now });
  assert.equal(limiter.take(2), true);
  assert.equal(limiter.take(2), true);
  assert.equal(limiter.take(2), false, '超了直接放弃（不排队）');
  now += 61_000;
  assert.equal(limiter.take(2), true, '下一分钟重新开始');
  assert.equal(limiter.take(0), true, '0 = 不限');
  const unlimited = createMinuteLimiter({ now: () => now });
  for (let i = 0; i < 50; i += 1) assert.equal(unlimited.take(0), true);
});

await unit('缓存：只留成功结果，超上限淘汰最旧', () => {
  const cache = createTranscriptCache(2);
  assert.equal(cache.get('a'), undefined);
  cache.set('a', '一');
  cache.set('b', '二');
  assert.equal(cache.get('a'), '一');
  cache.set('c', '三');
  assert.equal(cache.get('b'), undefined, '最旧的被淘汰');
  assert.equal(cache.get('a'), '一', '被读过的要保鲜');
  assert.equal(cache.get('c'), '三');
  cache.set('', '空 key 不记');
  assert.equal(cache.size, 2);
});

// ── 3. 桥接端到端（真实 bridge.js 在 VM 里跑） ───────────────────────────────

const voiceEvent = (over = {}) => ({
  post_type: 'message',
  message_type: 'group',
  group_id: 456,
  user_id: 456789,
  self_id: 1,
  message_id: 31001,
  sender: { user_id: 456789, nickname: 'fixture-voice' },
  message: [{ type: 'record', data: { file: 'fixture-record.amr', duration: 3 } }],
  ...over,
});

const pttCalls = (h) => h.calls.http.filter((c) => c.url.endsWith('/fetch_ptt_text'));
const lastStored = (h) => {
  const list = h.getSocialV2State('group:456').recentMessages;
  return list[list.length - 1];
};
const activityLog = (h) => {
  try { return fs.readFileSync(path.join(h.temp, 'state', 'qq-activity.log'), 'utf8'); } catch { return ''; }
};

await test('群聊语音条：按这条消息的 message_id 问网关，[语音：…] 进上下文', async (h) => {
  h.setMode('reserved2');
  await h.handleIncoming('group', 456, voiceEvent(), h.cfg);
  const calls = pttCalls(h);
  assert.equal(calls.length, 1, '一条消息只问一次网关');
  assert.equal(String(calls[0].body.message_id), '31001', '问的是这条消息自己的 id（不是别人的）');
  const msg = lastStored(h);
  assert.equal(msg.text, '[语音：fixture-transcript]', '带引用版文本要带转写');
  assert.equal(msg.plain, '[语音：fixture-transcript]', '纯正文版也要带（唤醒判定看的它）');
  assert.equal(msg.media.length, 0, '语音不算图片媒体');
});

await test('一条消息里两段语音：仍然只问一次网关（同消息复用）', async (h) => {
  h.setMode('reserved2');
  await h.handleIncoming('group', 456, voiceEvent({
    message_id: 31002,
    message: [
      { type: 'record', data: { file: 'a.amr', duration: 2 } },
      { type: 'text', data: { text: '还有这段' } },
      { type: 'record', data: { file: 'b.amr', duration: 4 } },
    ],
  }), h.cfg);
  assert.equal(pttCalls(h).length, 1, '两段语音共用同一次转写（segmentsToText 会被调用两遍）');
  // segmentsToText 是 out.join('')（QQ 正文自带空格，历史行为），这里跟着钉住拼接形态
  assert.equal(lastStored(h).plain, '[语音：fixture-transcript]还有这段[语音：fixture-transcript]');
});

// 网关桩：只替换 fetch_ptt_text 的回包，其余保持 harness 默认形态。
// 注意：换掉 globals.fetch 之后 harness 的 calls.http 就不再记录，所以自己数一份。
const gateway = (ptt, hits = []) => async (url) => {
  if (String(url).endsWith('/fetch_ptt_text')) { hits.push(String(url)); return ptt(); }
  return { ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: { message_id: 9001 } }) };
};
const pttJson = (body) => ({ ok: true, status: 200, json: async () => body });

const pttHits100 = [];
await test('QQ 侧没有转写（retcode 100）：回落 [语音]，不报错也不刷活动流', async (h) => {
  h.setMode('reserved2');
  await h.handleIncoming('group', 456, voiceEvent({
    message_id: 31003,
    message: [{ type: 'record', data: { file: 'c.amr', duration: 1 } }],
  }), h.cfg);
  assert.equal(lastStored(h).plain, '[语音]', '拿不到转写就保持原来的占位符');
  assert.equal(pttHits100.length, 1, 'retcode 100 也要真的问过（不是被开关挡住），且不重试');
  assert.ok(!activityLog(h).includes('转写失败'), '“本来就没有转写”属于预期内，不该刷活动流');
}, { globals: { fetch: gateway(() => pttJson({ status: 'ok', retcode: 100 }), pttHits100) } });

const pttHitsDead = [];
await test('网关不可达：回落 [语音]，消息照常进上下文，活动流看得到原因（失败可见）', async (h) => {
  h.setMode('reserved2');
  await h.handleIncoming('group', 456, voiceEvent({
    message_id: 31004,
    message: [{ type: 'record', data: { file: 'd.amr', duration: 2 } }],
  }), h.cfg);
  assert.equal(lastStored(h).plain, '[语音]', '失败一律 fail-open，绝不让消息丢失');
  assert.equal(pttHitsDead.length, 3, '不可达要按 attempts 重试完再放弃');
  assert.match(activityLog(h), /转写失败：网关不可达或请求失败（已按 \[语音\] 处理）/, '失败要出现在活动流（AGENTS 1.7）');
}, {
  config: { socialV2: { asrInbound: { retryDelayMs: 0 } } },
  globals: { fetch: gateway(() => { throw new Error('ECONNREFUSED'); }, pttHitsDead) },
});

await test('开关关掉：完全不问网关，也不改文案', async (h) => {
  h.setMode('reserved2');
  await h.handleIncoming('group', 456, voiceEvent({
    message_id: 31005,
    message: [{ type: 'record', data: { file: 'e.amr', duration: 2 } }],
  }), h.cfg);
  assert.equal(pttCalls(h).length, 0, '关掉后一次都不许问');
  assert.equal(lastStored(h).plain, '[语音]');
}, { config: { socialV2: { asrInbound: { enabled: false } } } });

await test('配置：config.json 的 asrInbound 覆盖要生效', async (h) => {
  assert.equal(h.cfg.socialV2.asrInbound.enabled, true, '没写的字段保留默认（默认开）');
  assert.equal(h.cfg.socialV2.asrInbound.history, true, '写了 history=true 就是开');
  assert.equal(h.cfg.socialV2.asrInbound.maxChars, 120, '写了 maxChars 就用它');
}, { config: { socialV2: { asrInbound: { maxChars: 120, history: true } } } });

await test('配置：没有任何 asrInbound 时用默认值（老 config.json 零迁移）', async (h) => {
  // 跨 realm：deepEqual 会因原型不同失败，逐字段比
  for (const [key, value] of Object.entries(RECORD_TEXT_DEFAULTS)) {
    assert.equal(h.cfg.socialV2.asrInbound[key], value, `${key} 要拿到默认值`);
  }
});

// ── 4. segmentsToText 契约：注入的解析器怎么用、抛错怎么收 ───────────────────

await test('segmentsToText：解析器给文本就写 [语音：…]，抛错一律退回 [语音]', async (h) => {
  const segs = [{ type: 'record', data: { file: 'x.amr' } }];
  const good = await h.segmentsToText(segs, { resolveRecord: async () => '他说明天到' });
  assert.equal(good, '[语音：他说明天到]');
  const throwing = await h.segmentsToText(segs, { resolveRecord: async () => { throw new Error('网关炸了'); } });
  assert.equal(throwing, '[语音]', '解析器抛错不能带出去');
  const empty = await h.segmentsToText(segs, { resolveRecord: async () => '   ' });
  assert.equal(empty, '[语音]', '空白转写当没有');
  const none = await h.segmentsToText(segs, {});
  assert.equal(none, '[语音]', '没注入解析器时行为不变（老路径零回归）');
});

await test('segmentsToText：被引用的语音也带转写', async (h) => {
  const segs = [
    { type: 'reply', data: { id: '9001' } },
  ];
  const text = await h.segmentsToText(segs, {
    resolveReply: async () => ({ sender: '群友', text: '[语音：fixture-transcript]' }),
  });
  assert.equal(text, '[引用 群友：[语音：fixture-transcript]]');
});

// ── 6. 本地 SenseVoice 兜底的取数与量形（为脚本 scripts/probe-record-shape.mjs 服务）─────
//
// `get_record` 的回包在 SDK 里是空接口（MediaInfo extends JsonObject {}），没有权威定义，
// 只能实测。这两条纯函数负责：从网关自己的消息里挑出 record 段，以及把实测结果压成
// 不泄密的摘要（只给长度、只给去签名的地址）。

await unit('recordFilesFromMessage：只认 record 段，且只吃网关发来的 file', () => {
  assert.deepEqual(recordFilesFromMessage({ message: [
    { type: 'text', data: { text: 'hi' } },
    { type: 'record', data: { file: 'a.amr' } },
    { type: 'image', data: { file: 'b.jpg' } },
    { type: 'record', data: { file_id: 'c.amr' } },
  ] }), ['a.amr', 'c.amr'], 'record 段的 file / file_id 都要，其它段不掺和');

  assert.deepEqual(recordFilesFromMessage({ segments: [{ type: 'record', data: { file: ' d.amr ' } }] }), ['d.amr'], '兼容 segments 字段并 trim');
  assert.deepEqual(recordFilesFromMessage({ message: [{ type: 'record', data: {} }] }), [], '没有 file 就什么都不给');
  assert.deepEqual(recordFilesFromMessage({ message: [null, 'x', { type: 'record' }] }), [], '脏数据不能抛');
  assert.deepEqual(recordFilesFromMessage(null), [], 'data 缺失也不能抛');
});

await unit('summarizeRecordShape：给形状，不给内容（base64 只报长度、url 去掉签名）', () => {
  const full = summarizeRecordShape({
    base64: 'A'.repeat(4000),
    file: 'C:\\snowluma\\cache\\stream_abc.wav',
    url: 'http://127.0.0.1:3000/media/x.wav?sign=SECRET&t=1',
  });
  assert.deepEqual(full.keys, ['base64', 'file', 'url'], '键要列全，才能知道网关给了什么');
  assert.equal(full.base64Chars, 4000, 'base64 只报长度');
  assert.equal(full.fileKind, 'absolute');
  assert.equal(full.url, 'http://127.0.0.1:3000/media/x.wav', 'query 里的签名必须丢掉');
  assert.equal(full.urlKind, 'loopback');
  assert.ok(!JSON.stringify(full).includes('SECRET'), '摘要里绝不能出现签名/令牌');
  assert.ok(!JSON.stringify(full).includes('AAAA'), '摘要里绝不能带上音频本体');

  assert.equal(summarizeRecordShape({ file: 'stream_abc.amr' }).fileKind, 'relative');
  assert.equal(summarizeRecordShape({ file: 'https://cdn.example/x.wav' }).fileKind, 'url');
  assert.equal(summarizeRecordShape({ url: 'https://cdn.example/x.wav' }).urlKind, 'other');
  assert.deepEqual(summarizeRecordShape({}).keys, [], '空回包不报错');
  assert.deepEqual(summarizeRecordShape(null).keys, [], 'null 不报错');
  assert.equal(summarizeRecordShape({ file: 'x'.repeat(80) }).file.length, 46, '过长的 file 要截断（可能带宿主路径）');
});

if (failures > 0) {
  console.error(`\n${failures} 个用例失败`);
  process.exit(1);
}
console.log('\n全部通过');
