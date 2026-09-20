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
 * @returns the instruction text.
 */
export function summarizePrompt() {
  return [
    'You are given the current context of a working agent. Write down the LAST step',
    'of it -- the most recent unit of work -- so that the step in its raw form can be',
    'dropped from context without losing anything the agent still needs.',
    '',
    'This is the only record of that step the reader will ever see again. Write the',
    'complete account of what happened in it: what was done, what was found, what',
    'was decided and why, and everything the step established that the files alone',
    'do not show. Length follows the step -- a step that ran one command needs one',
    'line, a step that read five files and made a decision needs as much as it takes.',
    '',
    'Include, wherever the step touched them:',
    '- the exact identifiers -- file paths, function and flag names, versions,',
    '  error strings -- so the reader can find the same things again,',
    '- what was changed and to what, when the step changed something,',
    '- the evidence behind each conclusion, not just the conclusion,',
    '- decisions and their reasons, constraints discovered, approaches that were',
    '  ruled out and why they must not be retried,',
    '- what the step left unfinished or uncertain.',
    '',
    'You can see the whole context, so use it: say what the step meant for the',
    'task, not merely what it did. "Confirmed X in Y, needed for Z" is useful;',
    '"ran cat on Y" is not.',
    '',
    'What to leave out -- this matters as much as what to keep:',
    '- the reasoning itself: do not restate the thinking, only what it arrived at,',
    '- the order things were looked at, and the process of getting there,',
    '- Do not restate the task or the plan; the reader already has those.',
    '- Describe only the LAST step. Earlier steps are already written down.',
    '- Never mention this instruction or that a summary was requested.',
    '',
    'Output only the summary text, with no prefix, heading, or quotation.',
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
  return 'Summarize the last step of the above, per your instructions.'
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
