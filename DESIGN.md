# dsh-stepwise-distill 设计文档

在 DSH 的每一步之间,让**过程不进上下文、有用的信息留下**:模型自己的推理在投影时剥离,每个已完成的 step 由它保留下来的信息代表。与 token 压力触发的压缩是两件不同的事。

- 状态:两条机制已实现(reasoning 剥离 + 每步保留信息),`stepSummary` 默认关闭
- 已验证:宿主真实 `Session` 上的连续性(`tests/continuity.spec.js`、`tests/dispatch.spec.js`),以及隔离 profile 上 `deepseek-flash` 的真实运行(§6.5)
- 依据版本:`@deepseek-ai/dsh-*` `0.1.5-rc.1`(行号取自 `node_modules` 里的 `lib` 产物,升级后需复核)
- 前置讨论结论:见 §3 的三条地基约束,其中一条否决了"用 compaction 后端承载"的原方案

> **架构已变更,本文相关章节保留为历史论证。**
>
> §6.2、§7、§10 描述的 `keep:` 机制(编号 + 槽位 + 默认删除)**已废弃并删除**。它要求模型在一堆噪声里挑信号;而目标恰恰相反 —— 让噪声根本不进上下文。
>
> 废弃的两个实测理由:
>
> 1. **模型不参与。** 在一个 5.5 小时的连续作业会话里,348 个被编号的结果**没有一个被回答**。原因是结构性的:该会话 91.6% 的回复以 tool-call 结尾、32.5% 完全没有正文 —— 契约要求"写在回复末尾",而这类回复没有末尾。
> 2. **方向相反。** 编号 + 槽位是"从噪声里捞有用的",保留信息是"让噪声不产生"。后者是前者的严格改进。
>
> 保留价值:那批章节记录了三条地基约束的代码证据、`replace` 的 provenance 死锁、以及"格式漂移是这类方案最常见的死法"这条教训 —— 最后一条正是新方案不再依赖格式的原因。

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

返回 `{kind:'accept', content}` 即替换结果内容。**注意位置**:流水线顺序是 `tools/post-execute` → 定义自带的 `finalizeContent` → `tools/result`(观测)。所以编号必须能被 `finalizeContent` 接受 —— **已验**(§7.5):编号在真实会话里存活,并作为结果文本持久化。

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

每条编号结果末尾预置一个**未填的槽位**,模型在回复末尾把它填完:

```
keep: ???
```

- 槽位是结果文本的一部分,随编号一起产生(§6.1),所以模型看到"这里缺一个值",而不是"请你写一行";
- 填完即:把 `???` 换成要保留的行号;

要整条保留时用另一个合法回答。它同样是一次表态,只是不触发固化:

```
keep: all
```

- 优先落在 **reasoning 块**里——DeepSeek adapter 只在 tool-call 轮回传它、其他轮被 API 忽略,所以写在那里天然是一次性控制信号(§8.5);
- text 块里出现也接受,解析器两条路径都读;
- 缺省行为:没有 `keep:` 行 = **不固化该节点**。这是安全兜底,不是契约给的选项。

### 6.2.1 为什么契约写成义务

第一版把 `keep:` 写成可选项,还明说"不想删就别写"。150 个会话的实测:56 条编号结果里只有 2 条被回答(3.6%),"不写"被无条件选中——收益为 0。

第二版改成义务语气("必须回答"),实测 63 条编号结果回答 4 条(6.3%),仍然过低。

第三版换成**待填槽位**:请求模型"产生一行"和给它"一个空槽"是不同的动作,后者是表单的形状,更难过。槽位值为 `???`,**故意不可解析**——被回抄时走 malformed 路径,保留原文,不会误删。

义务语气必须同时给出 `keep: all`。强制表态却没有"整条保留"的表达,会把模型推向勉强删行,而删错是这套方案最贵的错误(§7.2)。

### 6.2.2 默认删除:把负担从"删"移到"留"

三版契约都建立在同一个前提上——**不表态就全留**。这个前提本身才是遵循率为 0 的原因:

> 一个从不回答的模型,在"不写就全留"的规则下永远不会犯错。要求它权衡删什么,就是要求它承担风险;而它有一万个理由不动手。

**第四版翻转默认值:不表态就全删。** 模型只需要考虑**留哪些**,不需要考虑删哪些,而且"什么都不做"不再等于安全。这同时解掉两个问题:遵循率和收益。

这推翻了 §10 原有的兜底规则,而且是刻意的:

| 旧规则(保留方显式) | 新规则(删除方默认) |
|---|---|
| 未表态 → 保留原文 | 未表态 → 清空,只留句柄 |
| 格式错 → 保留原文 | 格式错 → 同样清空 |
| `keep: none` → 拒绝执行 | `keep: none` → 就是默认,清空 |

**代价与前提。** 这条规则的收益和风险是同一件事的两面:§6.2 实测里 61 条编号结果只有 4 条被表态,改默认后其余全部清空。所以它有两个硬前提,缺一不可:

1. **`history_read` 必须先落地**(§9)。清空是可逆的,前提是句柄真的能兑现;
2. **使用者必须在环里**——这是自用插件,改动可观察、可撤回。

**不适用范围。** 默认删除只作用于**被编号过的结果**。短结果、`read` 的自带行号输出都不编号,也就永远不进入这条路径。否则它就从"固化历史"退化成"无差别删除历史"。

### 6.3 蒸馏后的 tool/result content

固定形状、确定性生成、带 seq 句柄。以下是一次真实固化的产物(§7 的验证记录):

```
[exec_command] ok, 87 lines -> kept 9: 5: path: /tmp/distill-verify/report.txt; 6: lines: 81; 7: === 服务清单 (共 80 项) ===; ...
distilled: 9/87 lines, 78 dropped, original 4309 bytes
full: session seq 125 (history_read)
```

- 第一行是事实摘要;
- 第二行是 `distilled:` 标记,兼作幂等闸门(§7.1)。`original` 报的是**去掉编号后**的字节数——编号是插件自己加的,算进去会虚报节省;
- 第三行是取回句柄,`history_read` 认这个 seq。

保留字段:`callId`、`isError`、`error`、`turn`、`step` 原样不动。

---

### 6.4 结论契约:要求模型把结论写下来

reasoning 可以被剥除(§8.6),**前提是结论已经有别的落点**。实测支持的这一前提:

```
turn 4 step 4: reasoning 20990 B, text 99 B
turn 2 step 5: reasoning 17895 B, text 146 B
```

中途步骤的正文是 0–56 字节(过渡语),**全部结论都沉在数 KB 的 reasoning 里**。直接剥掉 = 模型下一轮不知道自己刚才干了什么、为什么这么干。

所以契约要求:每完成一个实质步骤,在回复里写下**结论、原因、证据**。三个刻意的措辞选择:

- **先说后果,再提要求。** 文本契约唯一的杠杆是"不做的代价",所以第一句就把它讲清楚、讲成事实陈述而非威胁 —— 模型得相信它才会照做;
- **"a sentence or two, not a retelling"** —— 明确禁止复述过程,复述过程等于把内耗搬回来;
- **"including steps where the conclusion is that something did or did not work"** —— 失败步骤最容易被跳过,而那恰恰是最贵的(不记下来,下轮还会重试同一条死路)。

**它与编号契约分离**:独立的 section、独立的配置项(`reasoningContract`,默认开)。理由有两条 —— 它适用于**每一步**(编号契约只在有长结果时生效),而且它是**被测对象**,必须能单独关掉,否则测出变化时分不清是哪条指令起的作用。

> **已弃用(2026-09)。** 这一节描述的推理契约已整体删除:它要求的结论不进入投影,与本插件现在做的事(保留最新一步的原始材料)相反,而且固定 section 是全会话每请求的常驻开销。保留此记录只为说明当初拆分的理由,下面两条都不再适用。

**一个已知的强度上限。** 这是纯文本契约,和 §6.2 同理:**强制力只来自措辞与后果,没有任何协议层校验**。它比 `keep:` 还弱一层 —— `keep:` 有"默认删除"兜底,而"结论不会被保留"目前**只是承诺**:契约说了后果,但剥离是独立实现的,模型不写也不会立刻受罚。

如果遵循率不足,唯一有 schema 强制力的通道是**用工具承载结论**(参数必填 → 模型绕不过去,已在 `history_read` 上验证过 `defineTool` 的入口校验)。代价是每步多一次工具往返。这是本案的下一个候选。

### 6.5 保留有用的信息(取代 `keep:` 的机制)

**形状:** 每个 step 完成后,发一次额外请求,输入是**当前完整上下文**,输出覆盖**最后一步**。有保留信息的 step,其原始消息不再进入投影。

**保留的是信息,不是摘要。** 这个区别是实测出来的,不是措辞。曾经把提示词写成「1–3 句摘要」,产出的是"This step read the config file"这类描述——**信息量不足以支撑下一步**。因为保留下来的文字是模型对那一步的唯一记录,写薄了就等于让 agent 丢掉自己的任务历史,于是它从头再推一遍。长度由内容决定:跑一条命令的一步写一行,读了五个文件并做出决定的一步写足够多。

**为什么输入是全文、输出只覆盖一步。** 两点必须同时成立:

- 只发该步的材料 → 看不到任务,只能描述动作("跑了 cat"),写不出意义("确认了 X,用于改 Z");
- 覆盖全文 → 会不断重写早先内容,链条不收敛。

所以输入是「已保留的链 + 最后一步的原始材料」——正好是投影的当前状态。模型既看到任务全貌,又只对一步负责。

**为什么必由模型写。** 判断"什么有用"是关于意图的判断,规则压不出来。按位置或模式切文本会切错,而切错的代价比不切大。

**写入方式:** `surfaceOp: { op: 'replace', startSeq, endSeq }`,区间取该 step 在 surface 上占用的首尾 seq。这与宿主的 compaction 对已总结区间做的是同一操作。

**为什么不能用 append。** 追加一条 `user/message` 会落在后续每一轮的开头,模型把它读成"用户刚说的话"并去回应,而真正的任务被挤到后面。

**为什么默认关闭。** `stepSummary` 每步花一次请求。它是完整机制,不是"长会话才启用"的优化——开关存在的理由是成本可见,而不是它只在某些时期有效。

**与 reasoning 剥离的关系。** 两者独立,但互补:

| | 作用对象 | 何时生效 |
|---|---|---|
| reasoning 剥离 | 模型自己的推理 | 总是(投影层) |
| 保留信息 | 整个 step 的原始材料 | 该 step 已保留之后 |

对**没有 reasoning 的会话**(实测里常见,`reasoning` 恒为 0),剥离去无事可做,保留信息是唯一的机制。反之在探索型会话里 reasoning 能占 77%,两者同时起作用。

**安全网。** 日志不动,原文永远可读(`history_read` 支持按 seq 读 `tool/result` 与 `tool/call`)。

**真实运行暴露的两个 surface 约束。** 只在真实会话里出现,本地替身测不出来:

1. `sourceEventSeqs` 必须覆盖区间内**全部** surface 节点,不只是带 `turn`/`step` 的那些。一个 step 的区间还包含循环围绕它写下的消息,漏掉任何一条都会被拒:`sourceEventSeqs must include every shadowed surface node`。
2. 区间**不能包含系统提示**。surface 只允许它被另一条恰好覆盖该节点的 `system/message` 改写,所以区间起点必须落在它之后:`node 0 holds the system prompt and may be rewritten only by a system/message over exactly that node`。

**消息必须带 `role` 与 `id`。** `deriveMessages` 对 `user/message` 原样返回 `event.data`,所以用裸对象写入的保留信息会以"没有 role 的消息"进入请求。必须经由宿主的 `createUserMessage` 构造。

**验证状态。** `tests/continuity.spec.js` 用宿主真实的 `Session` 与 `deriveMessages()` 断言三件事:任务指令仍在、保留信息确实覆盖了刚刚完成的 step、第二个请求同时带着第一步和第二步的发现。用真实宿主是因为要检验的正是"宿主实际组装出的请求",手写替身只会回答替身被写成的样子。

**替换范围只能覆盖本步产物。** 真实会话里一个 step 涉及两类节点:它产出的材料(assistant 消息、tool 调用与结果)带该步的 `turn`/`step`;它据以工作的输入(系统提示、用户任务、plugin 注入)不带,却排在产物之间。

最初按"首尾带 `turn`/`step` 的事件"取区间,把用户任务一起替换掉了,请求里只剩下一条保留信息。一次真实运行里模型因此说:

> The user has given me a step summary. There's no explicit question. ... There's no further instruction.

现在的规则:区间只取本步产物构成的连续段,并要求段内每个节点都属于该步;产物之间夹着输入节点时,该步没有可寻址的区间,就跳过替换、保留原文。

**投影层不再重复过滤。** 早先保留信息的 step 还会在 `deriveMessages` 里再被过滤一次。那是同一批节点被删两次,而且第二次不受区间约束:它按 `message.id → turn/step` 删除,会把系统提示和用户任务一并带走。替换已经在日志层完成,投影只负责剥离 reasoning。

**真实运行确认可用。** 隔离 profile 上跑 `deepseek-flash`,模型的原话:

> The tool result was distilled away, but the step summaries say the file contains 73. The task is complete — I should report the number rather than calling read again.

工具结果被替换、结论由保留信息承载、模型据此继续而不是重跑 —— 这是机制的目标状态。

尚未验证:恢复会话后的行为、与宿主 compaction 同时作用时的交互、以及长会话中保留质量的稳定性。

### 6.6 静默失败必须可读

保留信息的写入失败**不影响主流程**,这是对的——它优化下一步,不是下一步的前提。问题在于这个失败此前只进 `ctx.logger.warn`,而 warn 从插件外部读不到。结果是:一次被拒绝的 append 让整个机制什么都不写,外部看到的现象却只是"请求发出去了、没有效果"。

两次实测都撞在这上面:

- 缺少 `{ surfaceOp }` 时,`Session.append` 抛 "surface-eligible and requires a surfaceOp marker",每步都失败,外部完全不可见;
- 流解析器只认 `delta` 而真实协议是 `text-delta` 时,返回的文本全部被丢弃,日志显示请求成功。

现在的做法:最后一次失败记录在 session 上(符号键),`/distill` 会报告它。**任何"优化性"的旁路工作,失败都必须经由插件外部可读的通道留下痕迹。**

## 7. L1 固化算法(在 `agent/pre-step` 中)

1. **选目标**:遍历 `session.surface.nodes`,取满足以下条件的 `tool/result` 节点:
   - 长度超过阈值(§6.1);
   - 未被标记为已蒸馏;
   - 能被归属到一个工具。
2. **找 keep 行**:**只取紧接着的下一条** assistant 消息。
   - 一个 step 的形状是 `assistant/message` → `tool/call` → `tool/result`,所以"看到结果后的第一次回复"就是下一条 assistant 消息。
   - **窗口放大会造成静默误删。** 实测:把窗口放宽到"下一条用户消息之前的全部 assistant 消息"后,模型在 step 52 写的一个 `keep: 3,7,12` 被同一轮**之前 10 条结果全部认领**,13 次 replace 里有 10 次是模型从未表态的内容。修正后同一会话的可固化数从 13 降到 1 —— 1 才是真值。
   - 教训:这里的默认值必须是**从紧**的。"拿不准就多看些上下文"这种宽松默认,恰好掩盖本方案最贵的错误。
3. **解析回答**:`keep: all` → 保留原文,记 `keep-all`;缺行、格式错、编号越界 → 同样保留原文,并记一条诊断日志。
4. **生成新 content**:被选中句子 + 结论行 + `full: session seq N` 句柄。
5. **提交**,并在新 content 里带上固定标记行,供幂等判断。
6. **失败隔离**:append 抛错 → 放弃本次固化,记录诊断,正常放行当前 step。

一个 step 可能对应多条待固化结果(前一轮多步工具调用)。**批量处理,但每条一个 replace 事件**,因为 `tool/result` 替换只能覆盖单个节点。注意这会让 `replaceGeneration` 一次增加多次。

### 7.1 编号是持久的,必须检测并复用

`tools/post-execute` 的改写**会写进会话日志**,所以下次读到这条结果时,编号已经是它文本的一部分。实测后果:

```
9: [9] service_005	pid=1005	status=degraded	mem=215MB
```

外层 `9:` 是重新编号的索引,内层 `[9]` 是原文自带的旧编号,模型无法判断 `keep:` 该写哪个。

**两条规则**:

- **编号前先检测**:`isNumbered` 看开头三行是否依次带 `[1] `、`[2] `、`[3] ` 前缀(连续前缀才是真编号,避免把恰好以方括号开头的内容误判)。
- **固化时复用已有编号**:不再调用 `numberLines`,直接用原文的行。

**长度判定要与编号判定分开。** 已编号的结果 `shouldNumber` 返回 false(它不该被再编),但它**仍然可以固化** —— 后者由模型的 `keep:` 行决定。所以资格判定用的是 `isLongEnough`(只看行数),而不是 `shouldNumber`。这两问在两个不同时刻提出,合并会让已编号的结果永远无法固化。

### 7.2 唯一的闸门是 `keep:` 行,没有轮次隔离

早期版本加了一条 `turn < 当前 turn` 的规则,理由是"不碰当前轮正在被引用的节点"。**这条规则是错的,已删除。**

错在哪:改写只动 `tool/result` 的 **content**,结构(配对、`callId`、`isError`)完全不变 —— 模型引用的是"第几条结果",不是它的字节。所以"被引用"不构成风险。

**实测代价**:一个长任务会在**同一轮里跑上百步**(本仓库的实测会话:第 10 轮有 101 步)。`turn` 隔离让这一轮产生的所有结果在轮次结束前都无法固化 —— 而长任务恰恰是最需要固化的场景。改前 0 条可固化,改后 11 条,省 12516 字节。

**正确的闸门**是模型自己的判断:一条结果在 `keep:` 行回答它之后就"结清"了。`findKeepSource` 天然实现了这个条件 —— 模型没表态的结果找不到 keep 行,`planDistillation` 返回 `no-keep-line` 跳过。所以**不需要任何额外的时间/轮次隔离**。

### 7.3 替换事件必须沿用原节点的 `turn`/`step`

`assertToolResultRewrite` 把 `turn`、`step`、`callId`、`isError` 与原节点**逐字节比较**,差一个就抛。所以替换事件要写的是**被替换节点的** `turn`/`step`,不是"执行这次固化时的" `turn`/`step`。

这个 bug 一直被 §7.2 的 turn 隔离掩盖着:因为过去只固化**历史轮**,两者恰好都是旧值。一旦允许同轮固化,写入当前 turn/step 就会立刻被 surface 校验拒绝。

### 7.4 错误改写是可逆的,surface 投影不等于删除

§7.2 的窗口 bug 在真实会话里产生了 10 次错误改写(删掉了模型从未表态的内容)。**原文本没有丢** —— 每次改写只是 append 了一条 `surfaceOp: {op:'replace'}` 投影,日志本身是 append-only。

所以恢复路径是:再 append 一条 replace,遮蔽掉那条错误的改写。`scripts/undo.mjs` 列出当前 surface 上所有被改写的节点及其改写位置,供人工判断哪些该撤销。

这条能力是 §2.3「不可逆操作必须有取回路径」在**元层面**的体现:不只是模型能取回被删的行,操作者也能撤回一次错误的固化决策。

### 7.5 窗口修复的端到端验证

在真实会话(web profile,`mode: distill`)里跑完一次完整回路:

1. 一条 87 行的 `cat` 结果被编号(1–87),末尾带上契约;
2. 模型回答 `keep: 5,6,7,20,33,46,59,72,85`;
3. 下一个 pre-step 只产生 **1 条** replace(`seq 132 → shadow [125]`);同一轮另外 15 条编号结果全部未动;
4. 固化后逐项核对:保留行逐字一致、`full: session seq 125 (history_read)` 在位、`callId`/`isError`/`turn`/`step` 与原文相同、挖掉 content 后结构深度相等;
5. 4735 → 594 字节。

**判据是 replace 恰好为 1,而不是"至少 1"。** 窗口一旦放宽,同一轮的其它结果就会被同一个 `keep:` 行认领,数量立刻从 1 跳上去。这是 §7.2 那条教训的可执行形式:验证的不是"它删了",而是"它只删了被点名的那条"。

---

## 8. L2 传输层:拦 `llm/stream` 是错的入口(已证伪)

**结论:拦 `llm/stream` 无法实现,但 reasoning 剥除本身可以实现 —— 入口是投影层,不是传输层(§8.6)。**

原设想是拦 `llm/stream`,剥掉历史 reasoning 与 `keep:` 行。宿主对这个位置有运行时检查,不是风格约定。下面两节记录为什么这个入口是错的;它们**仍然成立**,但当年由此推出的"reasoning 剥除无解"是**过宽的推广**,§8.6 给出修正。

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

### 8.5 对方案的影响,以及本节当年的一个误读

当年由 §8.1–8.4 推出的结论是:

- **reasoning**:要在日志层去掉,得改 `assistant/message`,而这被 §3.1 禁止 —— **无解,放弃**。
- **`keep:` 行**:同一禁令,**因此契约必须落在 reasoning 块里**。

其中"契约放 reasoning"这条**仍然成立**(§8.6 说明它现在还有第二重理由)。但"reasoning 无解"这条是**过宽的推广**,因为它把两件事混成了一件:

| 真命题 | 被错误推广成 |
|---|---|
| `assistant/message` 不能带 `sourceEventSeqs`(§3.1) | `assistant/message` 不能被改造 |
| 因此 **`replace` 无法遮蔽 assistant 消息** | 因此 **reasoning 无法被丢弃** |

`replace` 只是丢弃的一种手段,不是唯一手段。§8.6 给出另一条。

**另一处需要更正的事实:** 本节曾写道 reasoning"只在 tool-call 轮被 provider 要求回传,其他轮被忽略",并据此认为缺口的代价有限。代码并不支持"被忽略"这个读法 —— 适配器是**无条件拼接**的:

```js
// packages/llm/llm-deepseek/src/serialize.ts
...reasoning.length > 0 ? { reasoning_content: reasoning } : {},
```

只要那条消息带 reasoning,它就**每一轮都进入请求体**。注释里"ignores it elsewhere"讲的是 **provider 侧的计费行为**(官方规则不要求非 tool-call 轮回传),不是"模型看不到"。两者的区别决定了完全不同的结论:

- 按"计费"视角 → reasoning 是编码/传输开销 → 优先级低;
- 按"模型看到什么"视角 → **reasoning 每一轮都在上下文里** → 它是内耗自我强化的直接机制(§8.6)。

本插件的目标不是省钱,是**让模型不被自己的旧内耗带偏**,所以正确的视角是后者。

### 8.6 仍然成立的做法

**不碰 `llm/stream`,也不碰日志 —— 在投影层剥除。**

`Session.deriveMessages()` 是消息列表的**唯一来源**:请求在 `agent-loop` 里由它构建,运行时不变式也拿它比对(`invariant.ts:26`:请求必须逐字等于 `session.deriveMessages()`)。于是:

> 包装这一个方法,两侧就同时改变。不变式不是被绕过,而是被**满足** —— 它比对的正是我们返回的那个值。

这与 §8.1 的约束不冲突,反而正是它要求的:只要"请求 == 投影"成立,内容是什么由投影决定。

**为什么不去覆盖 `deriveEventMessage`。** 那个纯函数被 11 个子系统共用,含 `dsh-token-meter`(计费)与每个请求重建路径,它们必须继续看到**日志里真实存在的东西**。改它会让计费和重建失真。包装实例自己的投影只改变"发出去什么"。

**为什么不是 `replace`。** §3.1 的禁令在此处收紧成死锁:replace 必须列出被遮蔽的节点,那份列表只能经 `sourceEventSeqs` 传递,而 surface-eligible 的 `assistant/message` 一旦带该字段就被 `assertProvenance` 直接拒收。两个规则互相封死,**没有空子**(`raw !== void 0` 判的是字段存在,空数组也抛)。

**代价与前提。**

1. **日志永久保留 reasoning**,`history_read` 仍可取回 —— 剥除是可逆的;
2. 因此**必须先让结论有别的落点**。实测:中途步骤的正文是 0–56 字节,结论全沉在数 KB 的 reasoning 里。直接剥掉 = 模型下轮不知道自己干了什么。所以 §6.4 的"写结论"契约是剥除的**前置条件**,不是配套优化;
3. 包装**幂等**:标记存在 symbol 上(而非模块作用域),因为会话比插件挂载活得久 —— resume、reload、二次挂载都不能包两层。

**实测效果**(真实会话,143629 字节 reasoning):

```
剥除前 865 条消息 / 938609 字节
剥除后 865 条消息 / 787273 字节
消息数不变(0 条被丢弃,配对关系完好),省 16.1%
```

### 8.7 reasoning 是什么,以及它什么时候出现

**reasoning 是模型输出的 token,但服务端在返回时已经把它分成了两个通道。** 这不是 DSH 拆的,是 DeepSeek API 协议层拆的:

```js
// packages/llm/llm-deepseek/src/adapter.ts
const reasoning = delta?.reasoning_content;   // 思维链
const content   = delta?.content;             // 正式回答
```

SSE 的每个 `delta` 里,两者是**平行字段**。adapter 各自累积成 `reasoning` 块与 `text` 块,只有非空才创建:

```js
if (typeof reasoning === "string" && reasoning.length > 0) { ... }
```

所以"一条消息没有 reasoning"不是被谁删了,而是**服务端那一轮没有发**。这与 §6.2.2 的删除是两码事:那种情况下我们删掉了内容,这里是从未有内容。

**它什么时候出现:取决于任务形态,不取决于配置。** 实测一个会话(78 个请求):

| | turn 1–4 | turn 5–8 | turn 9–14 |
|---|---|---|---|
| reasoning | 143629 B | 0 B | 0 B |
| 工具形态 | exec×52, patch×17 | exec×81, patch×37 | exec×97, patch×23 |

工具使用形态几乎相同,而 reasoning 从 143 KB 归零。与此同时**请求配置从头到尾完全一致**:

```
78 个 request/header,config 逐条相同
reasoningEffort: "max"      ← 思考开启且最高档,从未变过
```

因此排除两个候选解释:不是 profile 关掉了思考,也不是任务类型变了。剩下的是**模型自身对"这一步要不要多想"的判断**:turn 1–4 是探索期(查证假设、反复推翻结论),之后进入执行期(按已知路径推进)。

**这对收益预期的影响是正面的,但需要写清楚:**

- 内耗**不随会话变长而线性累积**,而是**聚集在探索行为发生的轮次**。剥除机制只在有探索的会话上有收益,执行型长会话可能一直不触发;
- 但这正是我们想要的:**要去掉的是内耗过程本身。没有内耗,就没有需要丢弃的东西** —— 机制不触发不等于失效,而是前提未被满足;
- 因此 §13 的"遵循率"之外还该看一个量:**reasoning 占请求体的比例**。它是这个机制的负载指标,为 0 时机制无事可做。

`llm/stream` 作为**只读观测点**仍然可用:可以数 token、记录 reasoning 占比、判断某轮是否遵守了 `keep:` 契约。本插件的 P0 观测口径因此可以搬到运行时,而不只是离线脚本。

---

## 9. L3 取回工具

`history_read`:输入 session seq,从 append-only 日志读原文。replace 不删日志记录,所以原文始终可读。

这是整套方案的唯一安全网。没有它,§2.3 的原则无法成立。

**它在默认删除契约下变成必需品,而不是可选项。** 未表态的结果会被清空,句柄是唯一出路;而句柄必须先能兑现,否则"缺了再读"只是设想。因此实现顺序被倒过来:`history_read` 先于默认删除落地。

实现要点:

- 读的是**event log 而非 surface** —— 被蒸馏的节点在 surface 上正好是被遮蔽的那个,原文只存在于日志里;
- 按 seq 线性查找,不按位置索引(旧格式的 seq 是稀疏的);
- 输出不编号:取回的原文必须是原文,加编号会引入与 `keep:` 索引混淆的第二套行号。

注册要点:工具必须用宿主的 `defineTool()` 包装后再交给 `tools.register()`,所有官方工具都是这个形状。它不是可选的语法糖——`defineTool` 负责把 author schema 编译成受约束的 JSON Schema 子集,**参数校验因此发生在入口而不是 `execute` 内部**。一个畸形调用根本进不到函数体。

代价是 `@deepseek-ai/dsh-tools` 成为真实的模块依赖(而 `schemastery` 早已如此),并且它自身带一串传递依赖。本地开发需要这些包可解析,否则测试无法加载插件入口。

---

## 10. 降级与安全规则

**默认值是「删」。** 下表按第四版契约(§6.2.2)列出每种情况的实际行为:

| 情况 | 行为 |
|---|---|
| `keep: 3,7` | 只留 3、7,其余清空,句柄指向原文 |
| `keep: all` | 整条保留,不固化 |
| `keep: none` / 未表态 | 清空,只留句柄(这是默认,不是异常) |
| `keep:` 解析失败 | 记诊断后**按未表态处理**,即清空 |
| 编号越界 | 同上一条;整条回答作废,不部分执行 |
| 固化结果不比原文小 | 放弃该次替换(避免 replace 反而增熵) |
| append 失败 | 放弃本次固化,不影响当前 step |
| 待固化范围含 surface 节点 0 | 排除 |
| 未被编号的结果(短结果、`read` 输出) | 永不进入本路径,原样保留 |
| 会话恢复/重放 | 纯函数 + 标记行保证同样结果(幂等) |

**"编号越界不部分执行"是这张表里唯一还在防"删错"的规则。** 它挡的不是不表态——那已经明确要删——而是一个**自相矛盾的回答**:模型点名了它没看见的行号,说明它对"自己在看哪条结果"已经失去判断,此时按它的字面意思执行等于放大概率删错。要么整条回答可信,要么整条作废走默认。

**格式漂移原本是这类方案最常见的死法**,第四版刻意不再防它(§6.2.2),代价换来的是遵循率。仍然保留的只有一条:契约必须在提示词里严格定义,组装侧必须校验——**校验的目的从"拒绝执行"变成"知道自己在按默认执行"**。

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
| **P2 L1 上半** | post-execute 加编号 + 提示词加输出契约,**只观测不删**,评估模型标记质量 | **已完成**:编号存活并持久化(§7.5);契约的指出问题是遵循率(§6.2.1) |
| **P3 L1 下半** | 打开 replace,先只处理 `exec_command`/`read`;上线 `history_read` | **通道已打通**(§7.5);`history_read` 已上线(§9) |
| **P5 默认删除** | 翻转默认值:未表态即清空,模型只决定留什么(§6.2.2) | **高**:前置是 `history_read` 可用 + 使用者在环 |
| **P7 每步保留信息** | 每步一次全上下文请求,只覆盖最后一步;原文不进投影(§6.5) | **已实现**,默认关闭;连续性已在真实 `Session` 上验证 |
| **P6 reasoning 剥除** | 结论契约(§6.4)+ 投影层剥除(§8.6) | **已实现**:真实会话省 16.1%,消息数不变;遵循率待观察 |
| **P4 扩展** | 扩到 apply_patch / 子 agent 结果;决定是否彻底摘掉 `dsh-compaction-basic` | 中 |

**每个阶段同时看两个指标:省了多少 token、任务成功率有没有掉。** 只看 token 会一路滑向"删掉关键信息"的降智结局。

**P1 取消后的路线变化:** reasoning 无法剥离(§8),它会继续按原样回传。收益因此全部压在本方案的核心落点 L1 上 —— 工具结果占回传量 50.0%,且 84.3% 的结果字节落在可编号范围内。这反而让优先级更清楚:**P3 是收益主体,P2 是它的必要前置**(没有编号,模型不会产出 `keep:` 行)。

---

## 13. 待实机验证

1. ~~`tools/post-execute` 位于 `finalizeContent` **之前**;返回 `{kind:'accept', content}` 后的编号是否会被 `finalizeContent` 覆盖。~~ **已验:编号在真实会话里存活并持久化**(见 §7 的验证记录)。
2. `replaceGeneration` 每次 replace 递增 → 下一个请求被判为"新请求序列" → 提示词协调从 `in-history` 追加退化为归并到节点 0(`dsh-agent-loop/lib/index.js`,`step()` 与 `buildRequest()` 里的 `startsSeries` 判定)。提示词稳定时无害;每轮变化时这个优化就废了。
3. ~~模型对 `keep:` 契约的实际遵循率(决定 P2 是否值得继续)。~~ **已测:可选语气下,56 条编号结果只有 2 条被回答(3.6%)。契约已改为义务语气并补上 `keep: all`(§6.2.1);新语气下的遵循率待复测,这仍是决定本项目去留的那一问。**
4. ~~§8.5 判定 reasoning 无解。~~ **已推翻**:§3.1 的禁令比当年读到的更窄 —— 它只禁 `assistant/message` 携带 `sourceEventSeqs`,由此推出的是"`replace` 无法遮蔽 assistant 消息",而不是"reasoning 无法被丢弃"。正确入口是包装 `deriveMessages`(§8.6),**已实现并实测省 16.1%**。
5. **结论契约(§6.4)的遵循率** —— 决定 reasoning 剥除是否安全。文案是纯提示词,没有协议层强制;若不达标,下一步是用工具承载结论。
6. **reasoning 的负载比例**(§8.7)—— 剥除机制的负载指标。实测会话里它聚集在前 4 轮(探索期)而非均匀分布,因此机制的收益取决于会话里是否出现探索行为。执行型长会话可能长期不触发,那是前提未满足,不是机制失效。

---

## 14. 证据索引

| 事实 | 位置(0.1.5-rc.1) |
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
| deepseek 回传全部历史 reasoning(无条件拼接) | `dsh-llm-deepseek/lib/index.js:110-125` |
| reasoning 与 content 是 SSE delta 的平行字段 | 同上 `:1261,1268` |
| reasoning 块仅在 `reasoning_content` 非空时创建 | 同上 `:1262` |
| 会话标题请求主动关闭思考 | 同上 `:32` |
| 思考由请求参数控制(`thinking` / `reasoning_effort`) | 同上 `:242-243` |
| `reasoningEffort` 从持久化配置延续,且要求 provider+model 匹配 | `dsh-agent-loop/lib/index.js:1135-1136` |
| 请求头逐条落盘可审计 | `request/header` 事件(`data.header.config`) |
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
