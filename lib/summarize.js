/**
 * Step summarization: turn one step's raw material into the conclusion worth
 * carrying forward.
 *
 * The problem this addresses is not cost. It is that a long conversation makes
 * an agent worse at its own task: measured across sessions, the assistant's own
 * content is 17% reasoning and 55% tool-call arguments, and every later turn
 * re-sends all of it. The model then reads its own churn, its own abandoned
 * attempts, and the full text of patches that landed in files long ago. A goal
 * restated by the user is easy to lose inside that.
 *
 * The fix is to keep the PROCESS out of the way and keep the RESULT: each step
 * is written down as a complete record of what it did and established, and the
 * raw material -- reasoning, arguments, tool output -- stays in the log,
 * readable on demand, but is not replayed.
 *
 * "Complete record", not "short summary". The written step is what the agent
 * sees instead of the original, so thinning it out costs the agent its own task
 * history: a measured run with a 1-3 sentence prompt produced summaries too thin
 * to work from, and the agent re-asked things it had already answered.
 *
 * Summaries are written by the model, never synthesized here. Choosing what
 * matters in a step is a judgement about intent, and a rule that cuts text by
 * position or pattern cannot make it. This module only shapes the request and
 * parses the reply.
 *
 * @module dsh-stepwise-distill/summarize
 */

/** Marker prefixing a summary message, so it can be recognized later. */
export const SUMMARY_MARKER = '[step summary]'

/**
 * Marker identifying a turn record.
 *
 * Distinct from {@link SUMMARY_MARKER} on purpose. A turn record is appended
 * rather than substituted, sits between the two mechanisms, and must not be
 * collected as a step record by the scanning that counts them.
 */
export const TURN_MARKER = '[turn summary]'

/**
 * System prompt for the summarization call.
 *
 * The record REPLACES its step, so it is the only trace of that step the agent
 * sees again -- but replacing is not summarizing. It records STATE: what the
 * step established, decided and changed. The material it stands in for is
 * available from the log on demand, so nothing needs to be preserved verbatim
 * here to keep it reachable.
 *
 * Two failure modes are pinned by the text below, both measured.
 *
 * The first is thinness. An earlier version asked for "1-3 sentences" and
 * produced records too thin to work from: the agent lost the thread of its own
 * task and re-asked what it had already answered.
 *
 * The second is growth. A prompt that demands a "complete record" and asks the
 * step to be related to the record before it produced records that ran longer
 * than the material they replaced -- 2.5k characters early in a session, 14k
 * later, against tool output that stayed flat at 2-3k. The bulk was traced
 * transcription of file contents, access order, and restatements of earlier
 * conclusions: process kept as prose. Records are not meant to carry the
 * material forward, so the instruction states both the ceiling (length follows
 * what the step established) and the exclusions (order, churn, restatement).
 *
 * The reader of a record is the same agent in its next step, which is why the
 * instructions separate analysis work from engineering work: what must survive
 * a read is a different set from what must survive an edit, and unstated the
 * model defaults to the union.
 *
 * @returns the instruction text.
 */
export function summarizePrompt() {
  return `你正在为一个正在工作的 agent 生成最近一步的压缩替代记录。

当前上下文中包含两部分：

1. 被压缩步骤之前已经保留的上下文，包括用户任务、此前的压缩记录以及其他仍然存在的内容；
2. 最近一步 agent 的原始工作内容，这一部分即将被压缩并从后续上下文中删除。

你的输出会替代最近一步的原始工作内容。

压缩完成后，后续 agent 将只能看到：
- 被压缩步骤之前已经保留的上下文；
- 你的输出。

最近一步的原始内容不会继续保留在模型上下文中。它只会保存在外部日志里；未来如果确实需要原始细节，可以通过显式的读取操作重新获取。

因此，你不是在给原始内容添加一段摘要，也不是在总结全部历史。
你的输出必须是一条能够替代最近一步原始内容的压缩记录。

首要目标是压缩信息，而不是总结任务、管理待办、提出建议或规划下一步。

只保留最近一步中对后续工作有用的内容：
- 本步实际获得的事实、证据和结果；
- 本步实际形成并仍然有效的结论；
- 本步实际作出的决定及其必要理由；
- 本步实际发生的文件、代码、配置或环境变化；
- 本步动作的实际执行状态；
- 影响后续判断或执行的失败、限制、冲突和不确定性；
- 后续工作需要的精确标识符、文件路径、函数名、参数名、错误信息、版本号、命令结果或任务标识；
- 本步已经执行但没有获得有效信息的动作及其结果。

不要保留以下内容：

- 反复思考、自我纠结和无效推理；
- 得出结论之前的思考过程；
- 文件、资料或工具的访问顺序；
- 没有信息增量的冗长工具输出；
- 已被最终结果取代的中间猜测；
- 之前上下文中已经存在且本步没有改变的信息；
- 只是为了说明 agent 做过什么而存在的操作流水；
- 原始内容中没有出现的任务、建议、约束、结论或推测。

不要使用“如上”“上述命令”“前面提到的修改”“按计划完成”等依赖已删除原文才能理解的表达。
如果某个动作或结果对后续工作有用，必须在记录中用足够具体的方式重新写出。
只有当指代对象在被压缩步骤之前已经保留的上下文中明确存在时，才可以使用简短指代。

一、分析、搜索和探索类工作

对于读取、搜索、浏览和分析，保留当前问题仍然需要的信息，而不是保留所有读过的资料。

保留：

- 直接回答当前问题的事实；
- 会改变判断的条件、例外、反例和边界；
- 支撑重要结论所必需的证据；
- 仍然存在的证据冲突或来源不一致；
- 关键数字、关键原文、数据结构或行为描述；
- 证据的来源、文件位置、章节、函数、行号或其他定位信息；
- 会影响当前调查方向的排除结果；
- 已检查的范围，以及“未找到”这一结果适用的范围。

删除：

- 与当前问题无关的背景材料；
- 重复出现的相同事实；
- 已被更直接证据取代的猜测；
- 只是因为被读取过、但没有影响当前判断的材料；
- 搜索、阅读和分析的顺序；
- 没有改变判断的重复解释。

严格区分以下表达：

- “在范围 R 内没有找到 X”；
- “确认 X 不存在”。

不得把前者加强成后者。

如果本步只是读取或搜索，但没有发现相关信息，仍然必须记录已执行的动作和实际范围，例如：

“已在 src/adapter.ts 和 src/runtime.ts 中搜索调用点，未发现对 parseContext 的直接调用。”

如果本步只是检查并确认结果没有变化，也必须记录这一事实，例如：

“已再次检查配置加载路径，结果与此前一致，未发现新的覆盖逻辑。”

不要因为未来可能用到某份资料，就把资料全文保留在当前上下文中。
只保留当前继续工作需要的内容；未来确实需要被删除的细节时，再通过外部日志读取原文。

二、代码修改、文件写入和工程推进类工作

对于代码修改、文件写入、命令执行、构建和测试，保留真实发生的状态，而不是保留完整的操作过程。

保留：

- 实际修改了哪些文件、函数、配置、接口或参数；
- 修改后的实际内容或行为；
- 修改是否已经成功落盘；
- 修改是否只完成了一部分；
- 哪些检查、构建、测试或验证已经执行；
- 验证是否通过、失败、部分通过或尚未结束；
- 失败原因，以及失败是否留下残余影响；
- 仍在运行的操作、任务标识和当前状态；
- 文件本身无法表达、但后续工作必须知道的决定、约束和兼容性要求。

严格区分：

- 计划修改；
- 已发出修改操作；
- 修改成功；
- 修改部分成功；
- 修改失败；
- 检查已执行；
- 检查通过；
- 检查失败；
- 检查尚未完成；
- 行为已验证；
- 仅完成静态检查但尚未验证实际行为。

不要把“提出了方案”写成“已经完成”。
不要把“写入请求已发出”写成“文件已经修改”。
不要把“命令成功退出”写成“目标行为已经验证”。

失败尝试只在以下情况保留：

- 失败原因会影响后续执行；
- 失败暴露了有效约束；
- 失败造成了部分写入或其他残余影响；
- 后续 agent 必须知道该失败，才能避免错误判断或不必要的重复。

如果失败已经被成功操作完全取代，且没有残余影响，也没有留下需要记住的约束，只保留最终有效结果即可。

如果本步只是执行一个命令、读取一个文件、运行一次测试或进行一次检查，但没有产生新的有效发现，也必须记录动作和结果。

例如：

- “已执行 \`rg ...\`，在指定目录中没有匹配结果。”
- “已读取 \`src/config.ts\`，未发现需要修改的内容。”
- “已运行测试 \`npm test\`，退出码为 0，但本步没有新增信息。”
- “命令因 \`ENOENT\` 失败，目标操作尚未完成。”
- “测试进程已启动，任务标识为 J，目前尚无最终结果。”

不要把这种情况压缩为空文本。
“已经做过但没有取得成果”本身就是后续工作需要知道的信息，否则后续 agent 可能把同一个动作误认为尚未执行并再次执行。

三、与此前上下文的关系

利用此前保留的上下文理解最近一步，但不要重新总结全部历史。

如果最近一步：

- 确认了此前的猜测，记录确认结果；
- 否定了此前的结论，记录新的实际结果；
- 解决了此前的不确定性，记录解决结果；
- 改变了此前的执行状态，记录新的状态；
- 完成了此前计划的动作，记录实际完成程度；
- 只是执行了此前计划的动作，简短记录实际执行结果；
- 没有改变已有事实，但确实执行了动作，记录动作和结果，防止后续重复执行。

此前已经存在、且本步没有变化的内容不需要重新改写。
但是，如果不记录本步动作，后续 agent 会误以为该动作尚未执行，则必须留下最小的具体记录。

不要为了“完整”而重新列出所有未完成事项。
不要主动创建待办清单。
不要主动提出下一步建议。
不要把本步发现的不确定性扩展成新的任务。

只有当最近一步实际改变了某个未完成状态、执行状态或不确定性时，才记录该变化。

四、信息的确定程度和适用范围

保持原始信息的确定程度、范围和条件。

- 一次失败不等于永久不可行；
- 一次成功不等于全面验证；
- 局部检查不等于全局确认；
- 没有找到不等于不存在；
- 计划不等于执行；
- 执行成功不等于行为验证通过；
- 推测不等于事实；
- 可能性不等于结论。

只保留原始内容实际包含的信息。
不要为了让记录显得完整而补充自己的解释、动机、建议或推断。

五、非空输出要求

每一步都必须输出非空记录。

本步有实质产出时，保留产出及其必要依据。

本步没有实质产出时，至少保留：

- 实际执行了什么；
- 执行结果是什么；
- 是否留下失败、阻塞、部分完成或未完成状态。

不要只写：

- “无进展”；
- “没有有用信息”；
- “已处理”；
- “已完成”；
- “结果同上”。

这些表述无法让后续 agent 判断本步到底发生了什么。

即使本步只是执行了一个没有产生有效信息的命令，也要记录该命令或动作的必要标识及其结果。

六、输出形式

输出长度由替代最近一步所需的信息量决定，而不是由原始内容的长度、读取的文件数量或执行的命令数量决定。

- 信息密度高的一步，可以写得更详细；
- 只是应用已知修改的一步，可以很短；
- 只是执行无结果命令的一步，应写成一条具体记录；
- 原始内容已经精炼时，直接保留或轻微压缩，不要再次扩写；
- 不要为了满足固定格式而增加没有信息价值的句子；
- 不要输出空文本。

最终只输出这一步的压缩替代记录本身。
不要添加标题、前缀、解释、评价、引号、Markdown 代码块或对本指令的提及。`
}

/**
 * Render the instruction appended to the context being summarized.
 *
 * The context is sent as the conversation it actually is, so this is the final
 * user turn rather than a wrapper around extracted material. Sending the real
 * context is what lets the summary relate the step to the task instead of
 * describing it in isolation.
 *
 * @returns the instruction text.
 */
export function summarizeInstruction() {
  return [
    '请按系统指令，为本条指令之前最近一步真实 agent 工作的原始内容生成压缩替代记录。',
    '本次压缩对象是这一步的原始工作内容，不是已有的 "[step summary]" 条目，也不包括本条指令。',
    '已有的 "[step summary]" 是此前步骤的压缩记录，仅用于理解背景、识别本步变化和避免重复，不要重新总结它们。',
    '本步原文将从后续上下文中移除，只保存在可显式读取的外部日志中；你的输出将替代它。',
    '有实质产出时保留有效信息及必要依据；没有实质产出时，也要具体记录本步实际发生了什么及其结果。',
    '严格区分计划、已执行和已验证；结果尚不可见时，只记录实际可知的状态。',
    '必须输出非空记录，不新增任务或下一步建议，只输出替代记录正文。',
  ].join('\n')
}

/**
 * System prompt for the turn record.
 *
 * A different job from {@link summarizePrompt}, and deliberately a separate
 * prompt rather than a variant of it. A step record substitutes for the step it
 * covers, so its job is to lose nothing. A turn record substitutes for nothing:
 * it is added on top, and its job is to catch what no single step holds -- what
 * the user asked for as a person, what they taught, and what pattern the turn
 * worked out. Reusing the step prompt would ask it to describe work that the
 * step records already describe.
 *
 * @returns the instruction text.
 */
export function turnPrompt() {
  return [
    '你看到的是一个正在工作的 agent 的当前上下文。请写下它的最后一轮——最近的一次用户',
    '交互到现在的整段工作——作为一条补充信息。',
    '',
    '这条记录不替代任何东西，它是附加的。上面的步间记录已经写清了每一步做了什么、',
    '发现了什么，所以不要重复它们的内容。',
    '',
    '按下面的三类来写，有哪类就写哪类，没有就不写。三类都没有时，只回一个字：无。',
    '',
    '三类有一个共同的门槛：写下来的东西必须跨任务成立。',
    '换一个完全不同的任务，这条还成立吗？不成立就删掉——它属于这一步，不属于',
    '这个 agent。这一步具体做了什么、用了哪条命令、改了哪个文件，都在步间记录里，',
    '不要在这里写第二遍。',
    '',
    '只写仍然约束当前工作的条目，不逐轮累积。之前几轮已经写过的，这一轮不必再写；',
    '只有在这轮里被改动、被推翻、或者理解变深了，才重写它。',
    '',
    '一、用户偏好',
    '用户这个人——他在意什么，为什么这么要。写成他看重的东西，不要写成对我的命令',
    '清单。他从不说想让我怎样工作，说的都是事情本身哪里不对；把他当场纠正的那件事',
    '还原成他真正在意的那个取向，并说清为什么。他提出以来一直没变、仍然约束当前',
    '工作的条目才写。',
    '',
    '二、用户教学',
    '用户在这轮里教了什么。这是最重要的一类，必须优先写全。',
    '用户的原话常常很粗糙，可能带着情绪甚至骂人，但背后往往是一条明确的规则、',
    '一条经验或一个纠正。请把它还原成通顺、完整、能照着做的表述，用你自己的话',
    '写出来。丢掉情绪，保留要求本身。不要照抄原话。',
    '用户纠正了之前的做法时，写清楚：之前是怎么做的、为什么不对、以后应该怎么做。',
    '',
    '三、新范式',
    '这一轮的做法里，哪些能脱离这件事本身存在——以后遇到同一类问题，该先查什么、',
    '怎么验证、拿什么当判据。',
    '写成一条准则，不要写成这次的操作记录：说清什么情况下用它，而不是这次怎么调的。',
    '要写版本号、文件名、接口字段这类只在这一次成立的东西，说明它背后那条更一般的',
    '准则是什么，然后写那条准则。',
    '这一轮只是完成了一件具体的事、没有留下能带走的东西时，这一类不写。',
    '',
    '写法要求：',
    '- 用中文。',
    '- 短。每一类几句话就够，不要展开成段落，不要复述过程。',
    '- 只写结论和要求，不写你是怎么得出它们的。',
    '- 不要提及本指令，也不要提及曾请求过记录。',
    '',
    '如果有内容，直接输出正文，以 "一、" 这样的分节开头，不要标题和引号。',
    '三类都没有时输出：无',
  ].join('\n')
}

/**
 * Render the instruction that closes a turn-record request.
 *
 * @returns the instruction text.
 */
export function turnInstruction() {
  return [
    '按你的指令写下最后一轮的那条补充记录。',
  ].join('\n')
}

/**
 * Render one step's raw material into the user message of a summary request.
 *
 * The material is rendered plainly rather than as a conversation: the
 * summarizer is not continuing the session, it is reading one step and
 * reporting what it found, and a chat-shaped input invites it to reply in the
 * session's voice.
 *
 * @param parts - the step's pieces, in the order they occurred.
 * @returns the user-message text.
 */
export function renderStepMaterial(parts) {
  const sections = []
  for (const part of parts) {
    if (part === undefined || part === null) continue
    const body = typeof part.text === 'string' ? part.text : String(part.text ?? '')
    if (body.trim().length === 0) continue
    sections.push(`--- ${part.kind} ---\n${body}`)
  }
  return sections.join('\n\n')
}

/**
 * Extract the summary text from a summarization reply.
 *
 * Reasoning is discarded: the summarizer may think, but its thinking is process
 * too, and carrying it forward recreates the problem this exists to solve.
 *
 * @param blocks - the assistant content blocks from the summary call.
 * @returns the summary text, or an empty string when the reply held none.
 */
export function parseSummary(blocks) {
  if (!Array.isArray(blocks)) return ''
  const text = blocks
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
    .trim()
  if (text.length === 0) return ''

  return text
}

/**
 * Render a stored summary as the message the next step will see.
 *
 * @param summary - the summary text.
 * @returns the message text.
 */
export function renderSummaryMessage(summary) {
  return `${SUMMARY_MARKER} ${String(summary).trim()}`
}

/**
 * Whether a message text is a stored step summary.
 *
 * @param text - candidate text.
 * @returns true when the text carries the summary marker.
 */
export function isSummaryText(text) {
  return typeof text === 'string' && text.startsWith(SUMMARY_MARKER)
}

/**
 * Render a turn summary as the message the next turn will see.
 *
 * @param summary - the summary text.
 * @returns the message text.
 */
export function renderTurnMessage(summary) {
  return `${TURN_MARKER} ${String(summary).trim()}`
}

/**
 * Whether a message text is a stored turn summary.
 *
 * Kept separate from {@link isSummaryText}: the step scan counts records by
 * marker, and a turn summary counted as a step record would inflate that count
 * and be read as covering a step it never saw.
 *
 * @param text - candidate text.
 * @returns true when the text carries the turn marker.
 */
export function isTurnText(text) {
  return typeof text === 'string' && text.startsWith(TURN_MARKER)
}

/**
 * Whether the model declined to write a turn summary.
 *
 * Most turns settle nothing worth carrying forward -- a question answered, a
 * command run, a file read. The prompt asks for exactly this word when there is
 * nothing of the three kinds to write, so silence stays distinguishable from an
 * empty reply, which is treated as a failure worth retrying.
 *
 * @param summary - the summary text.
 * @returns true when the model reported nothing to say.
 */
export function isNoTurnSummary(summary) {
  const text = String(summary).trim().replace(/[.。!！]/g, '')
  return text === 'NONE' || text === '无'
}
