# 入站语音条 → 文字（QQ 转写）

> 用户 2026-11-05 要求：「接通 QQ 入站 record 段→文字（fail-open）」。
> 这是「ASR 进 QQ」这条线在**桥接侧**的落地；DSH 侧的 `dsh-local-asr` 插件是另一半（见文末「遗留」）。

## 现象

- **用户看到什么**：群友/好友发来一条语音，AI 看到的是 `[语音]` —— 说了什么完全不知道；
  被问「他刚说了啥」只能干瞪眼，或者要人肉再问一遍。
- **复现步骤**：任何人给机器人发一条 QQ 语音（不附带文字）→ 进模型上下文的消息正文是 `[语音]`。
- **影响面**：所有收到语音的会话；不丢数据（消息本身照进上下文）、可恢复（改成文字即可）。

## 环境

| 项 | 值 |
| --- | --- |
| 系统 / DSH 版本 | macOS arm64 / DSH 0.2.1-rc.5 |
| SurfCore 版本 | 0.8.6（编辑会话未 bump） |
| 安装方式 | git（`plugins/surfcore`） |
| 其它相关版本 | SnowLuma 网关（OneBot v11，HTTP 3000）；QQ 侧当前**未运行** |

## 根因

- **代码位置**：`src/bridge.js` 的 `segmentsToText()`，`case 'record': out.push('[语音]'); break;`（原 1554 行）。
- **问题链条**：入站消息的正文由 `segmentsToText()` 从 OneBot 段拼出来；语音段（`record`）只有文件引用、
  没有文字，于是历史上直接压成占位符。**网关其实提供了转写能力**（`fetch_ptt_text`，MCP 别名
  `get_record_text`，参数 `{message_id}`，返回 `{text}`），但入站链路从来没调过它 ——
  历史上只把它用在**发送后回读**的实验里（`sendVoiceForV2({readback:true})`），而且实测自己发出去的语音
  拿不到转写（retcode=100「消息中不包含语音」），所以没人想到它还能用在入站。
- **为什么之前没发现**：没有语音→文字的需求，`[语音]` 被当成"正常行为"；且 `fetch_ptt_text` 的
  唯一使用点是可选的发送回读，默认关闭，等于这条能力从没被验证过。

## 完整逻辑（给用户看的那一遍）

- **链路**：QQ 语音 → SnowLuma（OneBot WS）→ `bridge.js` 的 `handleIncoming()`
  → `segmentsToText(event.message, { resolveAtName, resolveReply, resolveRecord })`
  → `record` 段命中 `resolveRecord()` → `src/record-text.js` 的取数器
  → `POST {snowluma.httpUrl}/fetch_ptt_text {message_id}` → `data.text`
  → 段文本变成 `[语音：<转写>]` → 继续走原有的入库/唤醒/上下文链路。
  读者只有这一个方向；除网关外不写任何文件，转写文本不落盘。
- **机制**：OneBot 的 `record` 段只有 `file`/`url`/`duration`，文字**只能另问网关**；
  而 QQ 的转写是"按消息 id 存"的（`message_id` 就是入站事件自带的那个字段），所以
  转写天然是**消息级**而不是段级的 —— 一条消息里两段语音，`fetch_ptt_text` 也只回一份结果。
  这就是为什么解析器必须**按消息建一次、在同消息的多次 `segmentsToText` 调用里复用**：
  `handleIncoming` 为了区分「带引用正文」和「纯正文」会把同一段消息解析**两遍**，
  不复用就是每次语音问两遍网关。
- **爆炸半径**：进程数 1（桥接进程；DSH 侧一个字节没动）× 读者数 1（`handleIncoming`；
  另有两个默认关闭的调用点：被引用消息、上线补历史）× 静默=3 ⇒ 3 分。
  碰用户数据：**是**（转写文本进模型上下文，与普通消息正文同等地位，会随会话日志落盘）；
  碰密钥：**否**（只把整数 message_id 发给本机网关，token 不进日志）；
  花钱：**否**（网关本地动作，不耗 token）。
- **取舍**：
  - **路线 A（选中）网关 `fetch_ptt_text`**：收益 = 立刻可用、零新依赖、中文识别是 QQ 自家的；
    成本 = ~250 行（含测试）几乎全在新模块；风险 = 只对"收到的"语音有效、群聊是否生成转写待真机确认；
    回滚 = 一个开关（`asrInbound.enabled=false`）或一次 revert。
  - **路线 B 本地 SenseVoice（`dsh-local-asr`）**：收益 = 不依赖 QQ 是否给转写、音频不出本机；
    成本 = 还要拿音频（`get_record` 传 `out_format:'wav'` 让网关转码，已确认网关支持）+
    内部接口鉴权 + WAV 采样率归一 + 组件令牌读取；风险 = **没有真机就确认不了返回的 wav 形状**，
    猜错就是整段垃圾文本；⇒ 放到下一轮，等 QQ 起来再验证（已写进「遗留」）。
  - **路线 C 不做**：保持现状，不满足需求。
- **生效与重启**：`bridge.js` 是 QQ 桥接进程的入口，**改完要重启桥接**才生效；
  DSH 主进程与 `plugins/asr` 都不受影响，不需要重启 DSH。

## 修法

- **新增 `src/record-text.js`**（纯逻辑 + 可注入取数器，不 import 桥接里的任何东西）：
  `recordTextConfig()` 配置收敛、`sanitizeTranscript()` 归一化（压单行/去控制字符/限长加省略号）、
  `classifyPttText()` 回包判定（retcode 100 = `no-ptt` 终局，不重试）、
  `createPttTextFetcher()`（总预算 + 退避重试 + 任何异常都收敛成 `{ok:false,reason}`）、
  `createMinuteLimiter()`（滚动窗口，超了直接放弃不排队）、`createTranscriptCache()`（只缓存成功结果）。
- **`src/bridge.js`**：
  1. `segmentsToText()` 加 `resolveRecord` 选项，`record` 段据此写 `[语音：…]`；解析器抛错只退回 `[语音]`；
  2. `cfg.socialV2.asrInbound` 默认值（深合并，老 config.json 零迁移）；
  3. `createRecordResolver({messageId})`：每条消息一个实例、内部记忆化、复用缓存；
     `fetchImpl: fetch`（显式注入，见下面的坑）；
  4. `noteRecordTextFailure()`：失败**露脸**；`no-ptt` 只进日志（"QQ 侧本来就没转写"属预期内），
     其余（超时/不可达/限流/回包异常）写活动流，同类 5 分钟只报一次；
  5. 三个调用点：`handleIncoming`（默认开）、被引用消息（默认开）、上线补历史（默认关，`history` 开关）。
- **为什么多一个模块**：AGENTS 1.3「不补屎山」——`bridge.js` 已经 1.6 万行，
  能独立测的逻辑就不该再往里塞；`record-text.js` 的 19 个用例全都不需要起桥接。
- **回滚方式**：`asrInbound.enabled=false` 立即退回旧行为（`[语音]`）；彻底回滚 = revert 这次提交
  （新模块无副作用，删掉即可）。

## 验证

- **自动化**：
  - `node scripts/test-record-text.mjs` → 19 用例全通过（含 4 条失败路径）；
  - `npm run test:regressions` → 全部通过；
  - `npm run test-voice` → 83 通过 / 0 失败；
  - `npm run test:audit` → 102/108（6 条失败与本改动无关，见下）；
  - `node scripts/test-audit-bridge.mjs` → 通过（桥接主回归）。
- **失败路径（用户看到什么 / 下一步 / 断言）**：
  - 网关超时/不可达 → 活动流出现「[语音] 转写失败：网关不可达或请求失败（已按 [语音] 处理）」，
    消息照常进上下文；断言：`text === '[语音]'` 且活动流匹配 `转写失败：…（已按 \[语音\] 处理）`；
  - QQ 侧没有转写（retcode 100）→ `[语音]`，不刷活动流；断言：网关被问过 **1** 次（不重试）且活动流无「转写失败」；
  - 开关关闭 → 一次都不问网关；断言：`fetch_ptt_text` 调用数 = 0；
  - 解析器抛错 → `[语音]`；断言：`segmentsToText` 不把异常带出去。
- **跨 realm / 桩的坑（本次踩到，已修）**：VM 版测试 harness 只把模块的**具名导出**铺进沙箱
  （`...recordText`），所以 `bridge.js` 里**不能用 `import * as X`**（`X.foo` 在沙箱里是 undefined）；
  另外模块内默认的全局 `fetch` 是 **Node 真身**，不是沙箱里的虚拟网关 —— 桥接必须显式传 `fetchImpl: fetch`，
  否则测试会真的去连 `127.0.0.1:3000`。两条都写进 PITFALLS 了。
- **手工/集成验证**：
  - harness 端到端：群聊语音 → 断言网关收到 `message_id=31001`、入库正文 `[语音：fixture-transcript]`、
    两段语音只问一次、两段拼接形态 `[语音：…]还有这段[语音：…]`（`segmentsToText` 是 `join('')`）。
  - **真机未验证**：QQ 传输当前是关的（SnowLuma 容器 `Exited (0)`、网关 3000 不通），
    所以以下三点只有 fixture 证据：① 群消息是否也生成转写；② 转写是否随消息立即就绪（我们靠退避重试兜）；
    ③ 真实网关回包的字段形状（按 MCP 目录 `{text}` 实现）。

## 没验证到的部分（老实写）

- 真机「收到语音 → AI 看到文字」全链路（要 QQ 起来）；
- 群聊语音的转写可用性（QQ 侧行为，非我们可控）；
- 转写延迟分布（决定 `attempts/retryDelayMs` 默认值是否合适，现在是 3 次 / 500ms / 总预算 4s）。

## 遗留 / 后续

- **本地 SenseVoice 兜底（路线 B）**：网关没有转写时，取音频 → 调 `dsh-local-asr` 的
  `/dsh-asr/internal/transcribe`（fail-open 第二层）。已确定的零件（2026-11-05 第二轮勘察）：
  - 取音频：SDK 有 `bot.getRecord(params)`（`get_record` 的驼峰映射，和 `bot.getImage` 同一个
    `MediaInfo` 返回类型、同一个 `GetMediaParams` 入参），返回体未在类型里约束字段
    ⇒ 复用桥接现有的图片媒体归一逻辑（已会探测 `base64` / `url` / `file` 三种形态）；
  - 转码：`get_record` 传 `out_format` 由**网关侧 ffmpeg** 转（SDK 类型里没有 `out_format`，
    因为 `GetMediaParams extends JsonObject`；MCP 目录里列了 mp3/amr/wav/flac 等）；
  - 音频格式：**不再需要桥接自己归一** —— `plugins/asr` 的组件通道已经会归一
    （2026-11-05：`normalizeWave()`，44.1k 双声道 → 16k 单声道，确定性下混+线性插值，
    10 个用例钉住；面板通道保持严格）；
  - 组件令牌：`$DSH_HOME/asr/runtime.json` 的 `x-component-token`（组件面仅回环）。
  仍未定：真机确认 SnowLuma 愿不愿意喂**入站**语音的 `file`（这决定 B 到底能不能用）。

### 先把形状量出来再写：`scripts/probe-record-shape.mjs`（2026-11-05 补）

路线 B 写不动的原因不是工程量，是**没证据**：`@snowluma/sdk` 的 `MediaInfo` 是个空接口
（`dist/types/results.d.ts:87` `export interface MediaInfo extends JsonObject {}`），
`get_record` 到底回 `base64` / `file` / `url` 里的哪个**没有任何权威定义**。
按猜测写 120 行兜底，最坏结果是「代码在、永远不触发、没人知道为什么」。

所以先加一条只读探针，一条命令把三件事一起打出来：

```bash
cd plugins/surfcore
node scripts/probe-record-shape.mjs --message <QQ消息id> [--out wav]
```

① `get_msg` 里的 `record` 段与 `file`；② `fetch_ptt_text` 有没有 QQ 自己的转写；
③ `get_record` 回包的键与形状摘要（`base64` 只报字符数、`url` 去掉 query 签名、`file` 报绝对/相对）。

- **只读**：只调查询接口，不写状态、不发消息、不改配置；令牌只在内存里用，从不打印。
- 退出码：`0` 量到了 / `2` 这条消息没有语音 / `1` 网关或参数问题（错误文案带「先确认容器在跑、端口对得上」）。
- 摘要函数是纯的（`summarizeRecordShape()`），有单测钉住"只给形状不给内容"：
  不得出现 base64 本体、不得出现 URL 里的 `sign`/token。
- 拿到真实形状后再写路线 B，并按量到的形态决定用 `base64`（首选，省一次网络往返）
  还是 `url`/`file`（后者要沿用图片链路的 SSRF/任意文件读取护栏）。
- 需要补的测试：引用一条真实语音（harness 的假 SDK 没有 `getMessage`，端到端要补桩）；
  本地音频文件大小/时长上限（路线 B 落地时）。
- 需要改的文档：控制台「语音」设置页加一个 `asrInbound.enabled` 开关（现在只能改 config.json）；
  `docs/VOICE-PACKS.md` 已补「收到的语音：自动转成文字」一节。
