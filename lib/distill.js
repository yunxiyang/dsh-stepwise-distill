/**
 * Pure distillation logic for stepwise history solidification.
 *
 * Everything in this module is deterministic and free of host types: the same
 * event log and the same model markers always produce the same output. That is
 * what makes a rewrite idempotent, replayable, and prefix-cache friendly
 * (DESIGN.md section 2.1). The plugin entry point supplies the events; this
 * module supplies every decision.
 *
 * @module dsh-stepwise-distill/distill
 */

/** Marker opening the machine-readable line in a distilled result. */
export const DISTILL_MARKER = 'distilled:'

/** Prefix of the `keep:` contract line the model emits. */
export const KEEP_PREFIX = 'keep:'

/**
 * Payload that answers a numbered result without distilling it.
 *
 * The contract requires an answer for every numbered result, so there has to
 * be a legal way to say "keep this one in full". Without it, a model that
 * judges a result worth keeping whole is pushed into naming a few lines
 * instead, which drops content it never chose to drop.
 */
export const KEEP_ALL = 'all'

/**
 * Blank the model is asked to fill in, appended to every numbered result.
 *
 * Asking for a line is a request to produce something; handing over an empty
 * slot is a request to complete something already there. The second is what a
 * form does, and it is harder to skip. The placeholder is deliberately not
 * parseable as a decision, so an unfilled slot falls through the same safety
 * path as a missing line and keeps the result intact.
 */
export const KEEP_PLACEHOLDER = '???'

/** First line number assigned to a numbered tool result. */
export const FIRST_LINE_NUMBER = 1

/**
 * Split a tool result's text into lines the way the counter numbers them.
 *
 * A trailing newline does not create a phantom final line: the counter and the
 * `keep:` indices must agree, and models read the numbered list, not the raw
 * bytes.
 *
 * @param text - the result text to split.
 * @returns the lines, without a trailing empty element.
 */
export function splitLines(text) {
  const lines = String(text).split('\n')
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/**
 * Number every line of one tool result.
 *
 * Indices are what the model echoes back in its `keep:` line, so they must be
 * stable across the whole session: one result, one numbering, no re-numbering
 * on later turns.
 *
 * @param text - the result text to number.
 * @returns the text with a `[n] ` prefix on each line.
 */
export function numberLines(text) {
  return splitLines(text)
    .map((line, index) => `[${index + FIRST_LINE_NUMBER}] ${line}`)
    .join('\n')
}

/**
 * Whether a tool result is long enough to be worth numbering.
 *
 * Numbering costs tokens on every later turn, so short results pass through
 * untouched (DESIGN.md section 6.1).
 *
 * @param text - candidate result text.
 * @param minLines - line threshold from the plugin config.
 * @returns true when the result should be numbered.
 */
export function shouldNumber(text, minLines) {
  if (typeof text !== 'string' || text.length === 0) return false
  if (isNumbered(text)) return false
  return isLongEnough(text, minLines)
}

/**
 * Whether a result is long enough to be worth distilling.
 *
 * Separate from {@link shouldNumber}, because the two questions differ once a
 * durable numbering exists in the log: numbering happens once, while
 * distillation is decided later by the model's `keep:` line. A numbered result
 * that correctly skips `shouldNumber` must still be eligible to distill.
 *
 * @param text - candidate result text.
 * @param minLines - line threshold from the plugin config.
 * @returns true when the result exceeds the threshold.
 */
export function isLongEnough(text, minLines) {
  if (typeof text !== 'string' || text.length === 0) return false
  return splitLines(text).length > minLines
}

/**
 * Whether a result already carries this plugin's numbering.
 *
 * Numbering is persisted: the `tools/post-execute` rewrite lands in the session
 * log, so every later read of that result sees the numbers as part of its text.
 * Without this check a result would be numbered again on each pass, stacking
 * `[9] [9] service_005` and corrupting the indices the model refers to.
 *
 * @param text - candidate result text.
 * @returns true when the text looks already numbered.
 */
export function isNumbered(text) {
  if (typeof text !== 'string') return false
  const lines = splitLines(text)
  if (lines.length < 2) return false
  // A numbering pass covers every line, so consecutive prefixes are what
  // distinguish real numbering from output that happens to start with one.
  return lines.slice(0, 3).every((line, index) => line.startsWith(`[${index + 1}] `))
}

/**
 * Flatten a message's content blocks to the plain text a model wrote.
 *
 * @param blocks - content blocks from an assistant message.
 * @returns text-block text joined by newlines.
 */
export function textOf(blocks) {
  if (!Array.isArray(blocks)) return ''
  return blocks
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
}

/**
 * Whether a content block is reasoning the transport layer strips anyway.
 * @param block - candidate content block.
 * @returns true for a reasoning block with text.
 */
export function isReasoning(block) {
  return block?.type === 'reasoning' && typeof block.text === 'string' && block.text.length > 0
}

/**
 * Extract the kept line numbers from one assistant message.
 *
 * Reasoning is the natural home for the control signal: the DeepSeek adapter
 * passes `reasoning_content` back only on tool-call turns and the API ignores
 * it elsewhere, so a line written there is one-shot by construction
 * (DESIGN.md section 8.5). Text blocks are accepted too, because a model that
 * answers without reasoning must still be able to steer distillation.
 *
 * @param blocks - content blocks from one assistant message.
 * @returns `{ found, indices, malformed, all }`; `found` is false when no
 *   contract line exists, `malformed` is true when a line exists but is
 *   unreadable, and `all` is true when the line keeps the result in full.
 */
export function parseKeep(blocks) {
  const joined = textOf(blocks)
  const match = joined.match(/(?:^|\n)\s*keep:\s*([^\n]*)/i)
  if (match === null) {
    const last = reasoningOf(blocks).pop()
    if (last === undefined) {
      return { found: false, indices: [], malformed: false, all: false }
    }
    const inner = last.match(/(?:^|\n)\s*keep:\s*([^\n]*)/i)
    if (inner === null) return { found: false, indices: [], malformed: false, all: false }
    return fromLine(inner[1])
  }
  return fromLine(match[1])
}

/**
 * Build one contract result from the text following `keep:`.
 * @param raw - the text after the prefix.
 * @returns `{ found, indices, malformed, all }`.
 */
function fromLine(raw) {
  // The answer "keep this whole result" is its own payload, not a line list.
  // It is what lets the contract be mandatory without making it destructive.
  if (String(raw).trim().toLowerCase() === KEEP_ALL) {
    return { found: true, indices: [], malformed: false, all: true }
  }
  const indices = parseIndices(raw)
  if (indices === null) return { found: true, indices: [], malformed: true, all: false }
  return { found: true, indices, malformed: false, all: false }
}

/**
 * Collect reasoning-block text in message order.
 * @param blocks - content blocks from one message.
 * @returns reasoning texts.
 */
function reasoningOf(blocks) {
  if (!Array.isArray(blocks)) return []
  return blocks.filter(isReasoning).map(block => block.text)
}

/**
 * Parse a comma-separated index list.
 *
 * A malformed entry makes the whole line untrustworthy: partial parsing would
 * mean deleting lines the model never named, which DESIGN.md section 10
 * forbids. Out-of-range and duplicate indices are dropped here and re-checked
 * by the caller against the real line count.
 *
 * A malformed entry must be distinguishable from an explicit empty selection:
 * reading "three" as "keep nothing" would delete a whole result on a typo,
 * which DESIGN.md section 10 forbids.
 *
 * @param raw - the text after the `keep:` prefix.
 * @returns sorted unique indices, or null when the list is malformed.
 */
export function parseIndices(raw) {
  const trimmed = String(raw).trim()
  if (trimmed === '' || /^(none|-|--)$/i.test(trimmed)) return []
  const parts = trimmed.split(',').map(part => part.trim()).filter(part => part !== '')
  if (parts.length === 0) return []
  const indices = []
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null
    const value = Number.parseInt(part, 10)
    if (value < FIRST_LINE_NUMBER) return null
    indices.push(value)
  }
  return [...new Set(indices)].sort((a, b) => a - b)
}

/**
 * Read the marker line of a distilled result.
 *
 * The marker is only recognized as a whole line of its own: a raw tool result
 * that merely quotes the word must not be mistaken for an already distilled
 * node, and the mistake would be permanent (the marker short-circuits future
 * distillation).
 *
 * @param text - a tool result's text.
 * @returns the marker payload, or undefined when the result is undistilled.
 */
export function distillMarker(text) {
  for (const line of String(text).split('\n')) {
    if (line.startsWith(DISTILL_MARKER)) return line.slice(DISTILL_MARKER.length).trim()
  }
  return undefined
}

/**
 * Whether a tool result already carries the distillation marker.
 *
 * This is the idempotence gate: a replay or a second pass over the same log
 * must not distill an already distilled node.
 *
 * @param text - a tool result's text.
 * @returns true when the node was distilled before.
 */
export function isDistilled(text) {
  return distillMarker(text) !== undefined
}

/**
 * Build the distilled text of one numbered tool result.
 *
 * Shape is fixed and deterministic; the `seq` handle is the retrieval path for
 * everything dropped, which DESIGN.md section 2.3 requires before any deletion
 * is allowed.
 *
 * @param options - distillation inputs.
 * @returns the replacement text.
 */
export function buildDistilledText(options) {
  const { toolName, isError, totalLines, keptLines, keptIndices, originalText, seq } = options
  const facts = keptIndices.map(index => {
    const line = keptLines[index - FIRST_LINE_NUMBER] ?? ''
    return `${index}: ${stripNumberPrefix(line).trim()}`
  })
  const head = `[${toolName}] ${isError ? 'ERROR' : 'ok'}, ${totalLines} lines`
    + ` -> kept ${keptIndices.length}`
  // An empty selection under a default-drop contract means "nothing here is
  // needed later", which is a decision, not a gap. Saying so explicitly keeps
  // the marker readable to a human auditing why a result went empty.
  const factsLine = facts.length > 0 ? facts.join('; ') : 'nothing needed later'
  const skipped = totalLines - keptIndices.length
  const summary = `${head}: ${factsLine}`
  return [
    summary,
    `${DISTILL_MARKER} ${keptIndices.length}/${totalLines} lines, `
    + `${skipped} dropped, original ${originalText.length} bytes`,
    `full: session seq ${seq} (history_read)`,
  ].join('\n')
}

/**
 * Remove the counter's own `[n] ` prefix from a numbered line.
 * @param line - a numbered line.
 * @returns the line without its counter prefix.
 */
export function stripNumberPrefix(line) {
  return String(line).replace(/^\[\d+\] ?/, '')
}

/**
 * Remove one numbering pass from a whole result.
 *
 * Used for measurement, never for output: the original size of a result is what
 * the model would have received without numbering, and counting the counters
 * would overstate both the original and the saving.
 *
 * @param text - possibly numbered result text.
 * @returns the text without its line counters.
 */
export function stripNumbering(text) {
  if (!isNumbered(text)) return String(text)
  return splitLines(text).map(stripNumberPrefix).join('\n')
}

/**
 * Render the numbering contract appended to one tool result.
 *
 * One line, not a paragraph: this text is appended to every numbered result and
 * therefore re-sent on every later turn, so it carries only the reminder that
 * the result needs an answer and which two forms that answer can take. The full
 * contract lives in the system prompt, which costs nothing per result.
 *
 * It stays in the result after distillation, which is why it must not describe
 * the surrounding content as a numbered list.
 *
 * @param eligibleCount - how many results in this step were numbered.
 * @returns the instruction text.
 */
export function numberingContract(eligibleCount) {
  return [
    '',
    `${KEEP_PREFIX} ${KEEP_PLACEHOLDER}`,
    `   ^ fill in the line numbers worth keeping from the ${eligibleCount} result(s)`,
    `     above, comma-separated, or write ${KEEP_ALL} in place of ${KEEP_PLACEHOLDER}`,
    '     to keep a result whole. The slot is required; leaving it unfilled keeps',
    '     every result verbatim.',
  ].join('\n')
}

/**
 * Render the system-prompt section announcing the contract.
 *
 * This is the only place the model learns that numbered results exist and how
 * to answer them, so it states the exact syntax, both accepted answers, and the
 * fact that answering is required. The requirement is stated as an obligation
 * rather than an option on purpose: every observed session in which the line
 * was merely permitted produced no answers at all, and an unanswered result is
 * never distilled. It contributes nothing while numbering is off, because a
 * contract that never applies is prompt noise on every turn.
 *
 * @param minLines - the line threshold the plugin numbers at.
 * @returns the instruction text.
 */
export function contractSection(minLines) {
  return [
    `Tool results longer than ${minLines} lines are line-numbered.`,
    `A numbered result ends with an unfilled slot: ${KEEP_PREFIX} ${KEEP_PLACEHOLDER}.`,
    'You fill it in, once per numbered result, by ending your reply with that line',
    'completed. Filling the slot is part of reading a numbered result here, not an',
    'optional cleanup: it is how the result is filed for later turns. Replace the',
    'placeholder with the line numbers worth keeping, comma-separated; the',
    'bracketed number at the start of a line is the one to use. A result whose',
    `content still matters can be kept whole by writing ${KEEP_ALL} instead:`,
    `  ${KEEP_PREFIX} ${KEEP_ALL}`,
    'Those lines are kept verbatim and every other line is replaced by a short',
    'handle that can read the original back on demand, so dropping a line is',
    'recoverable rather than destructive. Keep the lines you would act on, quote,',
    'or cite; drop listings, progress noise, and boilerplate. Put the completed',
    'line at the very end of your reply: leaving the slot unfilled keeps every',
    'result verbatim, which wastes the space the slot exists to reclaim.',
  ].join(' ')
}

/**
 * Render the reasoning-discipline contract.
 *
 * The other section governs what survives of a TOOL RESULT; this one governs
 * what survives of the model's own thinking. They are separate because they
 * ask for different things and fail differently, and because this one applies
 * to every step while the other only applies once something has been numbered.
 *
 * The premise is measured: reasoning is 43.7% of assistant content in a long
 * session, concentrated in a few huge blocks (one block of 21 KB carried 99
 * bytes of text). Because it is replayed on every later turn, the model keeps
 * re-reading its own churn, and churn is self-reinforcing: it sees the shape
 * of its own circling and continues it.
 *
 * Reasoning cannot be dropped safely while it is the only place a conclusion
 * exists -- in the measured session, mid-turn steps carried essentially no
 * prose (0-56 bytes) while their conclusions sat inside multi-kilobyte
 * reasoning blocks. So the contract first requires the conclusion to be
 * written down, and only then discards the process.
 *
 * @returns the instruction text.
 */
export function reasoningContract() {
  return [
    'Your reasoning is a scratch pad, not a record: it is NOT kept between steps.',
    'Only what you write in your reply survives. Anything you worked out and did',
    'not write down is gone by your next step, and you will have to work it out',
    'again from the evidence.',
    'So whenever you finish a step that reached a conclusion, write the conclusion',
    'in your reply, in plain prose, before moving on: state what you concluded,',
    'why, and what evidence in the conversation supports it. Keep it short -- a',
    'sentence or two, not a retelling of how you got there. Write it every step,',
    'including steps where the conclusion is that something did or did not work.',
    'Do not restate the plan you were given, and do not narrate the search: the',
    'value is the conclusion and its justification, not the path.',
  ].join(' ')
}

/**
 * Whether one leaf text is worth keeping in the distilled form.
 *
 * Blank lines and the echoes of the tool call itself carry no facts, so they
 * never survive distillation.
 *
 * @param text - candidate text.
 * @returns true when the text holds content.
 */
export function isSubstantive(text) {
  return typeof text === 'string' && text.trim().length > 0
}

/**
 * Pick the text leaves of one tool-result message.
 *
 * @param message - a `tool/result` message.
 * @returns ordered `{ path, text }` leaves, where `path` addresses the block.
 */
export function textLeaves(message) {
  const leaves = []
  const content = message?.content
  if (!Array.isArray(content)) return leaves
  for (const [outer, block] of content.entries()) {
    if (block?.type !== 'tool-result') continue
    const inner = block.content
    if (!Array.isArray(inner)) continue
    for (const [index, item] of inner.entries()) {
      if (item?.type !== 'text' || typeof item.text !== 'string') continue
      leaves.push({ outer, index, text: item.text })
    }
  }
  return leaves
}

/**
 * Render the original text of one tool result, for retrieval by seq.
 *
 * Distillation only appends a `surfaceOp: 'replace'` projection; the event log
 * is append-only, so the pre-distillation text is still in it. Reading it back
 * is what makes dropping a line recoverable, and it is the whole reason a
 * default-drop contract is safe to run at all.
 *
 * @param event - the `tool/result` event at the requested seq, already resolved.
 * @param seq - the requested sequence number, echoed into the envelope.
 * @returns `{ ok, text }`; `ok` is false with a refusal message otherwise.
 */
export function renderHistoryRead(event, seq) {
  if (event === undefined || event === null) {
    return { ok: false, text: `history_read: no event at seq ${seq}` }
  }
  if (event.type !== 'tool/result') {
    return {
      ok: false,
      text: `history_read: seq ${seq} is a ${String(event.type)}, not a tool result`,
    }
  }

  // Every text leaf is rendered, because a result may hold more than one and
  // the distilled replacement only reports the leaf it replaced.
  const parts = []
  for (const outer of event.data?.message?.content ?? []) {
    if (outer?.type !== 'tool-result') continue
    for (const inner of outer.content ?? []) {
      if (inner?.type !== 'text' || typeof inner.text !== 'string') continue
      parts.push(inner.text)
    }
  }
  if (parts.length === 0) {
    return { ok: false, text: `history_read: seq ${seq} carries no text content` }
  }

  const body = parts.join('\n')
  return {
    ok: true,
    text: [
      `<original seq="${seq}" type="tool/result" bytes="${body.length}">`,
      body,
      '</original>',
    ].join('\n'),
  }
}

/**
 * Remove reasoning blocks from one projected message.
 *
 * Reasoning is a scratch pad, and the measured cost of keeping it is that the
 * model re-reads its own churn on every later turn: 43.7% of assistant content
 * in a long session, concentrated in a few huge blocks (one of 21 KB carried
 * 99 bytes of text). Churn is self-reinforcing -- seeing the shape of its own
 * circling is what lets a model continue circling.
 *
 * It cannot be dropped by rewriting the log: a `replace` must list the nodes it
 * shadows, that list travels in `sourceEventSeqs`, and a surface-eligible
 * `assistant/message` carrying that field is rejected outright. So the drop
 * happens at projection time instead. The log keeps every block, `history_read`
 * still returns them, and only what the model is shown changes.
 *
 * @param message - one projected message, as `deriveMessages` returns it.
 * @returns the message without reasoning, or `null` when nothing else remains.
 *   `null` matches the host's own rule that an empty-content message does not
 *   join the surface.
 */
export function stripReasoning(message) {
  const content = message?.content
  if (!Array.isArray(content)) return message
  const kept = content.filter(block => block?.type !== 'reasoning')
  if (kept.length === content.length) return message

  // A message with a tool call but no text still has to survive: dropping it
  // would orphan its tool result, and the request would be rejected for having
  // a result no call produced.
  if (kept.length === 0) return null
  return { ...message, content: kept }
}

/**
 * Apply {@link stripReasoning} across one projected message list.
 *
 * @param messages - the list `deriveMessages` returned.
 * @returns a new list, with emptied messages removed.
 */
export function stripReasoningFrom(messages) {
  if (!Array.isArray(messages)) return messages
  const out = []
  let changed = false
  for (const message of messages) {
    const next = stripReasoning(message)
    if (next === null) { changed = true; continue }
    if (next !== message) changed = true
    out.push(next)
  }
  // Returning the original array when nothing changed keeps the hot path from
  // allocating on every step of a session that carries no reasoning at all.
  return changed ? out : messages
}
