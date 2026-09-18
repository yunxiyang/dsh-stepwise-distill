# dsh-stepwise-distill 设计文档

在 DSH 的每一步之间,把刚产生的历史**固化**成低熵形式:工具结果只留被引用的事实,思考与过程噪声不再回传。与 token 压力触发的压缩是两件不同的事。

- 状态:设计已定,待实现
- 依据版本:`@deepseek-ai/dsh-*` `0.1.5-rc.2`(行号取自 `node_modules` 里的 `lib` 产物,升级后需复核)
- 前置讨论结论:见 §3 的三条地基约束,其中一条否决了"用 compaction 后端承载"的原方案

---

## 1. 定位

### 1.1 要解决的问题

长会话的历史里,绝大部分内容在之后没有任何作用:

| 会话 | 回传总量 | 工具结果 | 工具调用参数 | 助手文本 | reasoning |
|---|---|---|---|---|---|
| welcome/ae907 | 1.37 MB | 46.6% | 36.8% | 16.3% | 0% |
| dsh-loop-continue | 0.60 MB | 41.9% | 42.6% | 13.9% | 0% |
| common/91cda | 0.79 MB | 17.7% | 18.1% | 6.0% | **57.6%** |

关键观察:**没有单条超大结果**(886 条工具结果里 0 条超过 8192 字符,平均约 750 字节)。所以 `dsh-compaction-tool-result-pruner`(默认 >8192 字符才修剪)和 `dsh-spill-policy`(默认关闭)在这些会话里**根本不触发**。问题不是"某条爆炸",而是"条数多 + 全量累积 + reasoning 永不清理"。

### 1.2 不是什么

- **不是 `dsh-compaction-basic` 那种压缩。** 那个由 token 压力触发,把一个 surface 范围折叠成一条 checkpoint 摘要消息,节点数 N→1。本方案是**逐节点原地瘦身,节点数不变**。
- **不是 spill/pruner。** 那两个挡的是"单条超大",本方案处理的是"整体累积"。
- **不删除日志。** `surfaceOp: 'replace'` 只改 surface 投影,原文留在 append-only 日志里,回放与审计完整。

### 1.3 权衡立场

**愿意多花 output token 与延迟,换取历史的信息密度。** 每步让模型输出少量结构化标记,用它驱动固化。代价是每步变慢、变贵;收益是后续每一步的输入更短、更聚焦。

---

## 2. 设计原则

1. **确定性优先。** 固化函数对同一输入必须产出同一输出(纯函数)。这既是幂等的前提,也是 KV cache 前缀复用的前提。
2. **结构不动,只降内容。** 节点数、角色、`callId`、`isError`、配对关系一律保持。provider 要求 `tool_calls` 与 `tool` 结果严格配对,破坏结构比留噪声贵得多。
3. **不可逆操作必须有取回路径。** 任何被固化掉的信息都要给句柄,否则模型删错时只能重跑工具,而带副作用的命令重跑不了。
4. **默认不动,拿不准就留原文。** 标记缺失、解析失败、契约不符——一律跳过该节点,不按残缺信息删。
5. **绝不影响主循环。** 固化失败不阻断当前 step;它只负责让历史变好,不负责让请求成功。

---

## 3. 地基约束(带代码证据)

### 3.1 `assistant/message` 无法在日志层重写

```js
// dsh-session/lib/index.js:285
if (event.type === "assistant/message" && raw !== void 0)
  throw new Error("assistant/message embeds its source stream and cannot carry sourceEventSeqs")
```

而 replace 事件的 `assertProvenance` 要求 `sourceEventSeqs` 覆盖**每一个**被遮蔽节点,缺一个就抛(`dsh-session/lib/index.js:299`)。

**推论**:"去掉思考过程""把 tool-call 参数精简成描述"这两件事**不能走 replace**。它们只能在**发出的那一刻**做(§8 传输层)。想法 1(工具结果瘦身)不受影响。

### 3.2 `tool/result` 的 replace 被专门支持,且只能改 `content`

`assertToolResultRewrite`(`dsh-session/lib/index.js:351`):

- 必须**恰好覆盖一个**当前节点;
- 目标必须是当前 `tool/result`;
- 把 `content` 挖掉后做深度相等比较——`callId`、`isError`、`error`、`turn`、`step` 等**必须逐字节相同**。

**推论**:工具结果的**内容**是官方允许重写的,结构不许动。这正是本方案的核心落点。

### 3.3 compaction seam 不是本方案的载体

`CompactionEngine`(`dsh-compaction/lib/types/index.d.ts`)的形状:

- `compactIfNeeded(agent, trigger, signal)`,trigger 只有 `'pressure' | 'context-overflow'`;
- 成功时把选中范围替换为**一条** `compactCheckpointSource` + `CompactionId` 的 user 消息;
- `compactRange` 要求端点 balanced(工具调用配对),`start`/`end` 是 **surface 位置**而非 seq。

形状不匹配:它做 N→1 的折叠,本方案做逐节点原地瘦身。**结论:自己拥有历史维护权,不挂 `dsh-compaction-basic`。**(同时挂也能跑,但它会因 surface 频繁变动而不断放弃压缩,徒增噪声。)

---

## 4. 三层机制

| 层 | 改什么 | 落点 | 官方支持度 |
|---|---|---|---|
| **L1 工具结果瘦身** | 日志层 replace `tool/result` 的 content | `agent/pre-step` + `session.append` | 一等公民(§3.2) |
| ~~**L2 输出噪声剥离**~~ | ~~发出前的字节:reasoning、keep 行~~ | ~~传输层~~ | **已证伪,见 §8** |
| **L3 原文取回** | 给模型读回日志原文的入口 | 新工具 `history_read` | 自建 |

**只剩两层。** L2 的设想被宿主的不变量检查否掉(§8),reasoning 与 `keep:` 行都无法在发出前改写。`keep:` 契约因此改为**优先落在 reasoning 块里** —— 让它在模型自己下一轮被 provider 侧自然丢弃,而不是靠我们事后清洗。

---

## 5. 接口契约

### 5.1 工具结果加工(编号)

```
'tools/post-execute'(this, exec: ToolExecution, result: Readonly<ToolExecutionResult>,
                     next) → PostToolDecision
```

`PostToolDecision`(`dsh-tools/lib/types/types.d.ts:432`):

```ts
{ kind: 'accept'; content?: ContentBlock[]; additionalContexts?: UserMessage[] }
| { kind: 'accept'; value: JsonValue;   additionalContexts?: UserMessage[] }
| { kind: 'block';  feedback: ContentBlock[]; additionalContexts?: UserMessage[] }
```

返回 `{kind:'accept', content}` 即替换结果内容。**注意位置**:流水线顺序是 `tools/post-execute` → 定义自带的 `finalizeContent` → `tools/result`(观测)。所以编号必须能被 `finalizeContent` 接受,需要在 P2 实机验证。

### 5.2 固化时机

```
'agent/pre-step'(this, { agent, messages, turn, step, signal }, next) → PreStepDecision
```

(`dsh-agent/lib/types/runtime-types.d.ts:313`)

- **唯一"每步必跑"且能拿到 `agent.session` 的钩子**;
- **第一个 step 也会跑**(`step === 1`),要跳过——此时没有"上一个已完成轮次"可固化;
- `agent/turn-stopping`(`:396`)**不能用**:它只在 inbox 没有 pending 输入时才触发,连续对话时根本不跑;
- `agent/request` 注释明写 `cannot mutate messages`(`:328`),不要在这里动手。

### 5.3 surface 重写

```js
session.append('tool/result', { turn, step, message: 新消息 }, {
  surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq },
  sourceEventSeqs: [seq],   // 必填:必须覆盖每个被遮蔽节点
})
```

读取当前 surface:`session.surface.nodes`(seq 数组)+ `session.eventAt(seq)`(取事件)。

其他硬规则:

- 端点必须引用**更早**的事件(`validateSurfaceMetadata`,`dsh-session/lib/index.js:311`);
- 节点 0 是系统提示词时受保护,只能被恰好覆盖它的 `system/message` 重写(`assertSystemHeadRewrite`,`:372`);
- 每次 replace 让 `replaceGeneration` 递增(`:414`)。

---

## 6. 数据契约

### 6.1 工具结果编号(在 post-execute 里做)

只对超过阈值的文本结果编号(建议 20 行),**且只对尚无编号的结果编号**:

```
[1] total 24
[2] drwxr-xr-x  5 user staff  160 Sep 17 16:19 src
[3] ...
```

**成本提醒**:每行编号约 3–5 token,而它进日志后每轮重发。40 行的结果就是约 200 token/轮。短结果不编号、直接放过。

#### 6.1.1 `read` 已有官方编号,必须排除

实测确认(`packages/fs/tool-fs/src/read-render.ts:150-170`):`read` 工具的**唯一**输出出口 `formatReadOutput` 无条件给每一行加编号,没有开关:

```
<path>/tmp/big.conf</path>
<type>file</type>
<content>
1: config_key_1 = value_1
2: config_key_2 = value_2
...
60: config_key_60 = value_60

(End of file - total 60 lines)
</content>
```

而且它的编号设计得比本方案更强:

- 编号是**文件真实行号**(`line.number`),不是数组下标;
- 分页读取用 `offset=` 续读,编号**跨页连续**;
- footer 说明窗口范围(`Showing lines 41-80 of 200`),并给出续读的 `offset`。

**再包一层编号是错的。** 模型会同时看到 `[2]` 与 `2:`,无法判断 `keep:` 里该写哪个;而两套编号的语义本就不同(一个是结果内下标,一个是文件行号)。**`read` 一律排除在编号之外**,它的行号直接作为 `keep:` 的取值。

适用编号的是**输出无结构**的工具(`exec_command`/`bash` 等)——它们的输出来自命令,行号只能由本插件给出。

### 6.2 模型输出契约

回复末尾单独一行:

```
keep: 3,7,12
```

- 优先落在 **reasoning 块**里——reasoning 本来就要被 L2 剥掉,控制信号天然不进后续历史;
- text 块里出现也接受,但 L2 要负责把它清洗掉(§8.2);
- 缺省行为:没有 `keep:` 行 = **不固化该节点**。

### 6.3 蒸馏后的 tool/result content

固定形状、确定性生成、带 seq 句柄:

```
[exec_command] exit=0, 42 lines → kept 3: src exists, 7: tests/ exists, 12: package.json v2.0.9
full: session seq 8412 (history_read)
```

保留字段:`callId`、`isError`、`error`、`turn`、`step` 原样不动。

---

## 7. L1 固化算法(在 `agent/pre-step` 中)

1. **跳过首步**:`step <= 1` 直接返回。
2. **选目标**:遍历 `session.surface.nodes`,取满足以下条件的 `tool/result` 节点:
   - 事件的 `turn < 当前 turn`(不碰当前轮正在被引用的节点);
   - 未被标记为已蒸馏;
   - 属于已登记编号的结果(§6.1)。
3. **找 keep 行**:在该节点之后、下一条用户消息之前的 assistant 消息里查找 `keep:` 行。
4. **解析失败即跳过**:缺行、格式错、编号越界 → 保留原文,并记一条诊断日志。
5. **生成新 content**:被选中句子 + 结论行 + `full: session seq N` 句柄。
6. **提交**,并在新 content 里带上固定标记行,供幂等判断。
7. **失败隔离**:append 抛错 → 放弃本次固化,记录诊断,正常放行当前 step。

一个 step 可能对应多条待固化结果(前一轮多步工具调用)。**批量处理,但每条一个 replace 事件**,因为 `tool/result` 替换只能覆盖单个节点。注意这会让 `replaceGeneration` 一次增加多次。

---

## 8. L2 传输层(已证伪,不做)

**结论:在当前宿主上无法实现。原方案的两件事都不能落在传输层。**

原设想是拦 `llm/stream`,剥掉历史 reasoning 与 `keep:` 行。宿主对这个位置有运行时检查,不是风格约定。

### 8.1 证据一:主循环请求必须逐字等于 surface 投影

`packages/core/agent-loop/src/invariant.ts:21-42`:

```js
ctx.on('llm/stream', (options: GenerateOptions, next) => {
  if (!isAgentLoopRequest(options)) return next()
  if (!Object.isFrozen(options)) fail('a loop-built request must be frozen')
  if (!Object.isFrozen(options.messages)) {
    fail('a loop-built request must carry a frozen messages array')
  }
  const expected = session.deriveMessages()
  if (JSON.stringify(options.messages) !== JSON.stringify(expected)) {
    fail(`llm request for session "${String(session.id)}" diverges from the
          dispatch-time durable derivation (log-reconstruction desync)`)
  }
```

`InvariantFailure` 的类型是 `(message: string) => never`(`packages/runtime-diagnostics/invariants/src/index.ts:29`)——它**抛异常**,不是记日志。任何对 `messages` 的改写都会让请求直接失败。

### 8.2 证据二:官方注释明写"只读"

`packages/llm/llm/src/index.ts:60-72`:

> the full request. A LOOP-built request carries the process-local `markAgentLoopRequest` identity and arrives **deep-frozen (mutation throws)**: its content is a pure function of the session log (the reconstructability Agent Note), so listeners **read it, never rewrite it**.

主循环在 `packages/core/agent-loop/src/agent.ts:603-616` 用 `deepFreeze` 冻结每条消息、`Object.freeze` 冻结数组后再发出。

### 8.3 证据三:投影规则没有扩展点

`Surface` 只有四种事件(`packages/core/session/src/surface.ts:22-27`),投影是**纯函数** `deriveEventMessage`,由 `Session.deriveMessages()`(`packages/core/session/src/index.ts:825`)折叠,没有任何钩子或可注入的投影器。

### 8.4 原文错在哪

§8.1 曾引用 `dsh-llm-pi-ai/lib/index.js:229` 的"元数据不匹配则降级",推出"官方为内容被外部重写预留了路径"。那段讲的是 **adapter 内部的 replay 元数据**(ids/signature)容错,管的是适配器自己能否复用 native 状态;**它不解除上层的不变量**。两件事被接错了。

### 8.5 对方案的影响

L2 想省的两块,现在只剩一条窄路:

- **reasoning**:占回传量 10.6%(实测 119 个会话,单会话最高 35.7%)。要在日志层去掉,得改 `assistant/message`,而这被 §3.1 禁止 —— **无解,放弃**。
- **`keep:` 行**:它进的是 `assistant/message` 的 text 块,同一禁令。**因此契约必须落在 reasoning 块里**,让它在模型自己下一轮被 provider 侧自然丢弃,而不是靠我们事后清洗。

**代价与补偿:** reasoning 仍留在日志里并随请求发出,但**官方规则让它在多数轮次不产生实际成本**。`packages/llm/llm-deepseek/src/serialize.ts:225-233`:

```js
// CoT passback on every reasoning-carrying turn. The official rule
// (guides/thinking_mode.mdx) requires it on tool-call turns and ignores it
// elsewhere; a gateway re-encoding the conversation for another vendor
// recovers that turn's upstream thinking signature by hashing this exact
// text, which a tool-call-free turn carries nowhere else.
...reasoning.length > 0 ? { reasoning_content: reasoning } : {},
```

即 reasoning **只在 tool-call 轮被 provider 要求回传**,其他轮被忽略。所以 §1.1 表里 reasoning 占 57.6% 的那类会话,其成本主要来自**每一轮都携带它的字节量**(编码、传输、缓存),而不是 provider 的实际计费。这降低了 L2 缺失的代价,但不消除它 —— 这也是为什么本方案把收益重心完全放在 L1。

**对 `keep:` 契约的影响:** 契约放 reasoning 仍然正确,理由从"反正会被剥掉"变成"provider 本就忽略它,所以它天然是一次性的控制信号"。放 text 反而更差 —— text 一定会被回传。

### 8.6 仍然成立的做法

`llm/stream` 作为**只读观测点**仍然可用:可以数 token、记录 reasoning 占比、判断某轮是否遵守了 `keep:` 契约。本插件的 P0 观测口径因此可以搬到运行时,而不只是离线脚本。

---

## 9. L3 取回工具

`history_read`:输入 session seq 或范围,从 append-only 日志读原文。replace 不删日志记录,所以原文始终可读。

这是整套方案的唯一安全网。没有它,§2.3 的原则无法成立。

---

## 10. 降级与安全规则

| 情况 | 行为 |
|---|---|
| 模型未输出 `keep:` 行 | 该节点不固化,保留原文 |
| `keep:` 解析失败/编号越界 | 同上,记诊断 |
| 固化结果不比原文小 | 放弃该次替换(避免 replace 反而增熵) |
| append 失败 | 放弃本次固化,不影响当前 step |
| 待固化范围含 surface 节点 0 | 排除 |
| 当前 turn 的节点 | 排除 |
| 会话恢复/重放 | 纯函数 + 标记行保证同样结果(幂等) |

**格式漂移是这类方案最常见的死法。** 契约必须在提示词里严格定义,并且组装侧校验;绝不能因为模型没照格式输出就按残缺标记删信息。

---

## 11. 成本与缓存

- **多付**:每步几十到几百 output token(keep 行 + 编号)。输出变长会**拖慢每步**——长任务里延迟比钱更真实,所以 keep 行要短,编号只给长结果。
- **省下**:L1 让历史稳定在低位,L2 让 reasoning 不再累积(实测最高占 57.6%)。
- **KV cache**:固化点逐轮前移 → 每轮只重算最近一批;已固化部分前缀逐字节稳定(靠 §2.1 的确定性),完全复用。剥离/精简也让前缀更短。
- **代价边界**:若固化规则依赖后续上下文(如"结合当前任务重写历史"),改写点会每轮前移,退化成每轮全量 prefill。**固化函数必须是单向、幂等、无后续依赖的。**

---

## 12. 分阶段路线

| 阶段 | 内容 | 风险 |
|---|---|---|
| **P0 基线** | 把测量脚本(`unzstd.mjs` 逐帧解 zstd + 按 surface 类型聚合)移入 `scripts/`,加 token 口径,记录 surface/turn 曲线 | 无 |
| ~~**P1 L2**~~ | ~~传输层剥 reasoning + 清洗 keep 行~~ **已证伪(§8),取消** | — |
| **P2 L1 上半** | post-execute 加编号 + 提示词加输出契约,**只观测不删**,评估模型标记质量 | 低;需验证 `finalizeContent` 不改写我们的编号 |
| **P3 L1 下半** | 打开 replace,先只处理 `exec_command`/`read`;上线 `history_read` | 中;不可逆,靠取回兜底 |
| **P4 扩展** | 扩到 apply_patch / 子 agent 结果;决定是否彻底摘掉 `dsh-compaction-basic` | 中 |

**每个阶段同时看两个指标:省了多少 token、任务成功率有没有掉。** 只看 token 会一路滑向"删掉关键信息"的降智结局。

**P1 取消后的路线变化:** reasoning 无法剥离(§8),它会继续按原样回传。收益因此全部压在本方案的核心落点 L1 上 —— 工具结果占回传量 50.0%,且 84.3% 的结果字节落在可编号范围内。这反而让优先级更清楚:**P3 是收益主体,P2 是它的必要前置**(没有编号,模型不会产出 `keep:` 行)。

---

## 13. 待实机验证

1. `tools/post-execute` 位于 `finalizeContent` **之前**;返回 `{kind:'accept', content}` 后的编号是否会被 `finalizeContent` 覆盖。
2. `replaceGeneration` 每次 replace 递增 → 下一个请求被判为"新请求序列" → 提示词协调从 `in-history` 追加退化为归并到节点 0(`dsh-agent-loop/lib/index.js`,`step()` 与 `buildRequest()` 里的 `startsSeries` 判定)。提示词稳定时无害;每轮变化时这个优化就废了。
3. 模型对 `keep:` 契约的实际遵循率(决定 P2 是否值得继续)。
4. §8.5 判定 reasoning 无解,前提是"日志层不能改 `assistant/message`"(§3.1)。若未来版本给 surface 投影开了扩展点,这一条需要重新评估。

---

## 14. 证据索引

| 事实 | 位置(0.1.5-rc.2) |
|---|---|
| assistant 消息禁止 `sourceEventSeqs` | `dsh-session/lib/index.js:285` |
| replace 必须覆盖所有被遮蔽节点 | 同上 `:299` |
| `tool/result` 替换只能改 `content` | 同上 `:351` |
| 节点 0 系统提示词保护 | 同上 `:372` |
| 端点须引用更早事件 | 同上 `:311` |
| `replaceGeneration` 递增 | 同上 `:414` |
| surface 四类事件 | 同上 `:919` |
| session header 的 cwd 是冻结的创建元数据 | `dsh-session/lib/index.js:997,1330` |
| 持久化路径由 cwd 编码决定 | `dsh-session-persistence-jsonl/lib/index.js:871-914` |
| `PostToolDecision` | `dsh-tools/lib/types/types.d.ts:432` |
| `tools/post-execute` 签名 | `dsh-tools/lib/types/index.d.ts:61` |
| `agent/pre-step` 签名 | `dsh-agent/lib/types/runtime-types.d.ts:313` |
| `agent/request` 不能改 messages | 同上 `:328` |
| `agent/turn-stopping` 仅在 inbox 空时跑 | `dsh-agent-loop/lib/index.js` 的 `turn()` |
| pi-ai:内容权威、元数据不匹配则降级 | `dsh-llm-pi-ai/lib/index.js:229-260` |
| deepseek 回传全部历史 reasoning | `dsh-llm-deepseek/lib/index.js:110-125` |
| `CompactionEngine` 接口形状 | `dsh-compaction/lib/types/index.d.ts` |
| 压缩范围端点须 balanced | 同上 `compactRange` 文档 |
| BlockAssembler:max-tokens 丢 tool call;已关闭 index 忽略 delta | `dsh-llm/lib/types/assembler.d.ts` |

### L2 证伪的证据(§8,取自源码检出 `dsh-v0.1.5-alpha.1-262-gb2e3b2a012`)

| 事实 | 位置 |
|---|---|
| 主循环请求必须逐字等于 `session.deriveMessages()` | `packages/core/agent-loop/src/invariant.ts:39-42` |
| `llm/stream` 请求深冻结,监听者只读 | `packages/llm/llm/src/index.ts:60-72` |
| 该检查 `prepend: true`,先于任何能短路它的监听器 | `packages/core/agent-loop/src/invariant.ts:73` |
| `InvariantFailure` 抛异常(`=> never`) | `packages/runtime-diagnostics/invariants/src/index.ts:29` |
| surface 只有四种事件类型,无投影扩展点 | `packages/core/session/src/surface.ts:22-27` |
| 投影是纯函数,`deriveMessages` 直接折叠它 | `packages/core/session/src/index.ts:825,838` |
| 主循环 `deepFreeze` 每条消息后再发出 | `packages/core/agent-loop/src/agent.ts:603-616` |
