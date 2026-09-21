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
 * The summary REPLACES its step: once written, the raw material is no longer
 * replayed, so the summary is the only record of that step the agent will see
 * again. That makes completeness the requirement, not brevity. An earlier
 * version asked for "1-3 sentences" and produced summaries too thin to work
 * from -- the agent lost the thread of its own task and re-asked things it had
 * already answered.
 *
 * What it must NOT do is also load-bearing: a summary that reproduces the
 * reasoning it was written from restores the problem this exists to solve.
 *
 * Each record is written against the one before it, because a step's meaning
 * depends on where the previous step left the work. Describing every step in
 * isolation produced records that each said "I deleted two lines" for what was
 * one edit in three stages -- applied, then verified, then confirmed. The
 * record says what the step moved forward when it continues the one above, and
 * describes the step on its own terms when it does not.
 *
 * @returns the instruction text.
 */
export function summarizePrompt() {
  return [
    '你看到的是一个正在工作的 agent 的当前上下文。请写下它的最后一步——最近的那一次工作——',
    '使得这一步的原始形态可以从上下文中移除，而不丢失 agent 仍需要的东西。',
    '',
    '这是读者今后唯一会再看到的关于这一步的记录。请写下这一步的完整记述：做了什么、发现了',
    '什么、决定了什么以及为什么、以及这一步确立的、光看文件看不出来的所有东西。',
    '长度取决于这一步推进了什么，而不是它花了多少工夫——读了五个文件并做出决定的一步要写足，',
    '只是应用了上文已描述的修改的一步只需要一行。',
    '',
    '凡这一步涉及到的，都要写明：',
    '- 精确的标识符——文件路径、函数名与参数名、版本号、错误信息——让读者能再次找到同样的东西，',
    '- 改了什么、改成了什么（当这一步做了修改时），',
    '- 每个结论背后的证据，而不只是结论本身，',
    '- 决策及其理由、发现的约束、被排除的做法以及为什么不能重试，',
    '- 这一步尚未完成或仍不确定的部分。',
    '',
    '你能看到全部上下文，所以要利用它：说明这一步对任务意味着什么，而不只是它做了什么。',
    '「确认了 Y 里的 X，Z 需要它」是有用的；「对 Y 执行了 cat」不是。',
    '',
    '把这一步与它前一步的记录对照着读，并让这个对照决定你怎么写：',
    '',
    '- 如果这一步延续了那条记录所描述的事，就不要再把同一件事描述一遍。写下这一步相对那条',
    '  记录的推进——它改变了、确认了或排除了什么。上一步已经计划好的修改、这一步只是把它',
    '  应用上去时，写成「应用了 X」即可，因为上一条记录已经说明 X 就是计划。',
    '- 如果这一步是另起一件事，就按它自己的样子描述。',
    '',
    '无论哪种情况，记录都只覆盖一步。不要综述历史，也不要重复更早记录已经说过的内容——点名',
    '提及即可，然后继续。',
    '',
    '要略去的内容——这与要保留的内容同样重要：',
    '- 推理本身：不要复述你是怎么得出结论的。写出某一步相对上一条记录改变了或确认了什么，',
    '  不算复述——那是这一步的产出，属于记录的一部分。',
    '- 查看事物的顺序，以及抵达结论的过程，',
    '- 不要重述任务或计划；读者已经有了。',
    '- 不要描述更早的步骤本身。前一条记录说了什么已经是给定的，这条记录只关于这一步。',
    '- 绝不要提及本指令，也不要提及曾请求过记录。',
    '',
    '只输出记录文本本身，不要前缀、标题或引号。',
  ].join('\n')
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
  return '阅读上文中最新的那条记录——也就是最近的一条 "[step summary]" 条目（如果有的话）——'
    + '然后按你的指令写下最后一步的记录。'
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
    '发现了什么，所以不要重复它们的内容。你只写那些散落在各步之间、任何单独一步都',
    '看不出来的东西。',
    '',
    '按下面的三类来写，有哪类就写哪类，没有就不写。三类都没有时，只回一个字：无。',
    '',
    '一、用户要求',
    '这一轮里用户对怎么做提出了哪些要求——风格、语言、格式、取舍、禁止的做法。',
    '写成陈述句：「用户要求 X」。只写这一轮明确表达的，不要从更早的轮次推断。',
    '',
    '二、用户教学',
    '用户在这轮里教了什么。这是最重要的一类，必须优先写全。',
    '用户的原话常常很粗糙，可能带着情绪甚至骂人，但背后往往是一条明确的规则、',
    '一条经验或一个纠正。请把它还原成通顺、完整、能照着做的表述，用你自己的话',
    '写出来。丢掉情绪，保留要求本身。不要照抄原话。',
    '用户纠正了之前的做法时，写清楚：之前是怎么做的、为什么不对、以后应该怎么做。',
    '',
    '三、新范式',
    '这一轮是否确立了一种处理问题的新做法——一套可以再用的步骤、一种查证方式、',
    '一个判断依据。有就写成可复用的形式，说明什么情况下该用它。',
    '只是完成了一件具体的事、没有形成可复用的做法时，这一类不写。',
    '',
    '写法要求：',
    '- 用中文。',
    '- 短。每一类几句话就够，不要展开成段落，不要复述过程。',
    '- 只写结论和要求，不写你是怎么得出它们的。',
    '- 只覆盖最后一轮。更早的轮次已经在上下文里了。',
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
  return '按你的指令写下最后一轮的那条补充记录。'
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
