// 入站语音条 → 文字（**收到的** QQ 语音才有转写）。
//
// 只用网关的 `fetch_ptt_text`（SnowLuma MCP 里别名 `get_record_text`，参数 `{message_id}`，
// 返回 `{text}`）：这条链路不用模型、音频不出本机，代价是只对"收到的"语音有效 ——
// 自己发出去的自测 retcode=100「消息中不包含语音」（见 bridge.js verifyVoiceMessageSent）。
//
// 这里只放"要不要用这段转写、怎么用"的纯逻辑 + 可注入的取数器；
// 谁来触发、写哪儿、怎么露脸由 bridge 决定，这样单测能直接跑这一层。
//
// 明确不做的事：
//   · 不碰本地音频文件、不做语音识别（本地 SenseVoice 引擎是下一步，见 docs/cases）；
//   · 不写日志正文以外的任何字段，也不落盘转写文本（进模型上下文即止）。

/** 配置默认值。字段都可被 config.json 的 socialV2.asrInbound 覆盖。 */
export const RECORD_TEXT_DEFAULTS = {
  // 入站语音条是否自动转写（收到的语音、以及被引用消息里的语音）。
  enabled: true,
  // 一次转写的总预算：等不到就当没有，绝不让消息一直卡着。
  timeoutMs: 4000,
  // 重试次数：QQ 侧转写可能比消息晚到一点，第一枪常常是空的。
  attempts: 3,
  retryDelayMs: 500,
  // 进上下文的转写上限（超长截断并加省略号）。
  maxChars: 300,
  // 每分钟最多问网关几次（0 = 不限）。超了直接放弃，不排队。
  maxPerMinute: 30,
  // 上线补历史里的语音是否也转写：一次补历史可能是好几条语音 = 好几次往返，默认关。
  history: false,
};

function clampNumber(value, fallback, min, max) {
  const num = Number(value);
  if (!Number.isFinite(num) || num < min || num > max) return fallback;
  return num;
}

/** 把 config.json 里的一段收敛成可用配置（非法值一律回落默认，不抛）。 */
export function recordTextConfig(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    enabled: source.enabled !== false,
    timeoutMs: clampNumber(source.timeoutMs, RECORD_TEXT_DEFAULTS.timeoutMs, 200, 30000),
    attempts: Math.round(clampNumber(source.attempts, RECORD_TEXT_DEFAULTS.attempts, 1, 5)),
    retryDelayMs: clampNumber(source.retryDelayMs, RECORD_TEXT_DEFAULTS.retryDelayMs, 0, 5000),
    maxChars: Math.round(clampNumber(source.maxChars, RECORD_TEXT_DEFAULTS.maxChars, 20, 2000)),
    maxPerMinute: Math.round(clampNumber(source.maxPerMinute, RECORD_TEXT_DEFAULTS.maxPerMinute, 0, 600)),
    history: source.history === true,
  };
}

/**
 * 转写文本进模型上下文前先归一：压成单行、去控制字符、限长。
 * 群友的语音内容是不可信输入，和普通消息正文同等地位 —— 只允许它是一行文字。
 */
export function sanitizeTranscript(text, maxChars = RECORD_TEXT_DEFAULTS.maxChars) {
  if (typeof text !== 'string') return '';
  const flat = text.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  return flat.length > maxChars ? `${flat.slice(0, maxChars)}…` : flat;
}

/**
 * 判定网关回包：只有 `status=ok && retcode=0` 且 text 非空才算拿到转写。
 * `no-ptt`（retcode 100）是终局 —— QQ 侧就是没有这条的转写，重试没意义。
 */
export function classifyPttText(body) {
  if (!body || typeof body !== 'object') return { text: '', reason: 'bad-response' };
  if (body.status !== 'ok' || body.retcode !== 0) {
    if (body.retcode === 100) return { text: '', reason: 'no-ptt' };
    return { text: '', reason: `retcode-${body.retcode ?? '?'}` };
  }
  const text = typeof body.data?.text === 'string' ? body.data.text : '';
  return { text, reason: text ? '' : 'empty' };
}

/** 失败原因 → 能照做的一句话（会出现在活动流里）。 */
export function describeFailure(reason) {
  switch (reason) {
    case 'no-ptt': return 'QQ 侧没有这条语音的转写结果';
    case 'empty': return '网关返回了空转写';
    case 'timeout': return '等转写超时';
    case 'fetch-error': return '网关不可达或请求失败';
    case 'rate-limited': return '这一分钟的转写次数已达上限';
    case 'no-message-id': return '这条消息没有可用的 message_id';
    case 'bad-response': return '网关返回了无法解析的内容';
    default: return `转写失败（${reason || '未知原因'}）`;
  }
}

const defaultSleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * 取一次转写：带总预算 + 退避重试，任何异常都收敛成 `{ok:false, reason}`，绝不抛。
 * @returns {Promise<{ok:boolean, text?:string, reason?:string, attempts?:number}>}
 */
export function createPttTextFetcher({
  httpUrl,
  accessToken,
  config,
  fetchImpl = fetch,
  sleep = defaultSleep,
} = {}) {
  const base = String(httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
  const conf = config ?? recordTextConfig({});
  return {
    async fetch(messageId) {
      const id = String(messageId ?? '').trim();
      if (!id) return { ok: false, reason: 'no-message-id' };
      const deadline = Date.now() + conf.timeoutMs;
      let reason = '';
      for (let attempt = 1; attempt <= conf.attempts; attempt += 1) {
        const left = deadline - Date.now();
        if (left <= 0) { reason = reason || 'timeout'; break; }
        try {
          const response = await fetchImpl(`${base}/fetch_ptt_text`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
            },
            body: JSON.stringify({ message_id: id }),
            signal: AbortSignal.timeout(Math.max(200, Math.min(left, conf.timeoutMs))),
          });
          const body = await response.json().catch(() => null);
          const verdict = classifyPttText(body);
          const text = sanitizeTranscript(verdict.text, conf.maxChars);
          if (text) return { ok: true, text, attempts: attempt };
          reason = verdict.reason || 'empty';
          // no-ptt = QQ 侧根本没有转写，重试只是白等
          if (reason === 'no-ptt') break;
        } catch (error) {
          reason = (error?.name === 'TimeoutError' || error?.name === 'AbortError') ? 'timeout' : 'fetch-error';
        }
        if (attempt < conf.attempts && conf.retryDelayMs > 0) {
          const wait = Math.min(conf.retryDelayMs, Math.max(0, deadline - Date.now()));
          if (wait > 0) await sleep(wait);
        }
      }
      return { ok: false, reason: reason || 'unknown' };
    },
  };
}

/** 每分钟配额（滚动窗口）。超了直接 false —— 不排队、不阻塞消息。 */
export function createMinuteLimiter({ now = () => Date.now() } = {}) {
  let windowStart = 0;
  let used = 0;
  return {
    /** @param maxPerMinute - 0 或负数 = 不限 */
    take(maxPerMinute) {
      const limit = Number(maxPerMinute);
      if (!Number.isFinite(limit) || limit <= 0) return true;
      const at = now();
      if (at - windowStart >= 60000) { windowStart = at; used = 0; }
      if (used >= limit) return false;
      used += 1;
      return true;
    },
    stats() { return { used }; },
  };
}

/** 消息 id → 转写文本的小 LRU（只缓存成功结果：失败下次还该再试）。 */
export function createTranscriptCache(limit = 200) {
  const map = new Map();
  return {
    get(id) {
      const key = String(id ?? '');
      if (!key || !map.has(key)) return undefined;
      const value = map.get(key);
      map.delete(key);
      map.set(key, value);
      return value;
    },
    set(id, value) {
      const key = String(id ?? '');
      if (!key) return;
      if (map.has(key)) map.delete(key);
      map.set(key, value);
      const max = Number(limit) > 0 ? Number(limit) : 200;
      while (map.size > max) {
        const oldest = map.keys().next().value;
        if (oldest === undefined) break;
        map.delete(oldest);
      }
    },
    get size() { return map.size; },
  };
}

/**
 * 从 `get_msg` 的 data 里挑出 record 段的 `file`（语音库文件名/相对路径，网关自己发的）。
 *
 * 只读网关发来的字段，不接受调用方现造的路径 —— 这个值最终会被原样回传给网关的
 * `get_record`，等于"让网关去读它自己目录里的某个文件"，所以名单必须来自事件本身。
 */
export function recordFilesFromMessage(data) {
  const segments = Array.isArray(data?.message) ? data.message
    : Array.isArray(data?.segments) ? data.segments : [];
  const files = [];
  for (const segment of segments) {
    if (!segment || typeof segment !== 'object' || segment.type !== 'record') continue;
    const payload = segment.data && typeof segment.data === 'object' ? segment.data : {};
    const file = String(payload.file ?? payload.file_id ?? '').trim();
    if (file) files.push(file);
  }
  return files;
}

/** URL 只留 host + path（丢掉 query：签名/token 常常就挂在 query 上）。 */
function redactUrl(value) {
  try {
    const url = new URL(String(value));
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    return { text: `${url.origin}${url.pathname}`, kind: loopback ? 'loopback' : 'other' };
  } catch { return { text: '', kind: 'unparsable' }; }
}

/**
 * `get_record` 回包的**形状摘要**。
 *
 * 为什么只能"摘要"：SDK 里 `MediaInfo extends JsonObject {}`（空接口），
 * 也就是说网关到底回 `base64` / `file` / `url` 里的哪个、有没有别的键，**没有权威定义**，
 * 只能实测。这个函数是把实测结果打印成人能看的东西：只给长度、只给去签名的地址，
 * 永不回显 base64 本体（那可能是几 MB 的语音，也可能顺手把隐私写进日志）。
 */
export function summarizeRecordShape(data) {
  const payload = data && typeof data === 'object' ? data : {};
  const keys = Object.keys(payload).filter(key => payload[key] !== undefined && payload[key] !== null).sort();
  const base64 = typeof payload.base64 === 'string' ? payload.base64 : '';
  const file = typeof payload.file === 'string' ? payload.file.trim() : '';
  const url = typeof payload.url === 'string' ? payload.url.trim() : '';
  const fileKind = !file ? 'empty'
    : /^(?:base64:\/\/|data:)/i.test(file) ? 'base64'
      : /^https?:\/\//i.test(file) ? 'url'
        : /^[a-zA-Z]:[\\/]|^\//.test(file) ? 'absolute'
          : 'relative';
  const redacted = redactUrl(url);
  return {
    keys,
    base64Chars: base64.length,
    file: file.length > 48 ? `${file.slice(0, 45)}…` : file,
    fileKind,
    url: redacted.text,
    urlKind: url ? redacted.kind : 'empty',
  };
}
