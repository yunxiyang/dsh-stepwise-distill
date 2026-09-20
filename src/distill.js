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
 * Collect reasoning-block text in message order.
 * @param blocks - content blocks from one message.
 * @returns reasoning texts.
 */
function reasoningOf(blocks) {
  if (!Array.isArray(blocks)) return []
  return blocks.filter(isReasoning).map(block => block.text)
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
  // A distilled result and a summarized tool call are the two things this
  // plugin can lose on purpose, so both are readable back. The call matters
  // because its `arguments` hold the patch text the model wrote, and the file
  // it patched has since moved on.
  if (event.type === 'tool/call') {
    return renderToolCallRead(event, seq)
  }
  if (event.type !== 'tool/result') {
    return {
      ok: false,
      text: `history_read: seq ${seq} is a ${String(event.type)}, `
        + 'not a tool result or tool call',
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
 * Render one tool call's arguments, for retrieval by seq.
 *
 * `arguments` is a JSON string, so it is parsed and re-indented: the caller
 * wants the patch or command text the model actually wrote, and raw escaped
 * JSON is unreadable for exactly the purpose this call exists to serve.
 *
 * @param event - the `tool/call` event, already resolved.
 * @param seq - the requested sequence number, echoed into the envelope.
 * @returns `{ ok, text }`; `ok` is false with a refusal message otherwise.
 */
export function renderToolCallRead(event, seq) {
  const raw = event.data?.arguments
  if (typeof raw !== 'string' || raw.length === 0) {
    return { ok: false, text: `history_read: seq ${seq} carries no arguments` }
  }
  const name = String(event.data?.name ?? 'tool')

  let rendered = raw
  let pretty = false
  try {
    rendered = flattenArguments(JSON.parse(raw))
    pretty = true
  } catch {
    // Not JSON: some tools take a bare string. The raw text is still the
    // original, so it is returned as-is rather than refused.
  }

  return {
    ok: true,
    text: [
      `<original seq="${seq}" type="tool/call" name="${name}" `
      + `bytes="${raw.length}"${pretty ? ' reformatted="json"' : ''}>`,
      rendered,
      '</original>',
    ].join('\n'),
  }
}

/**
 * Render decoded arguments as readable text rather than escaped JSON.
 *
 * Re-serializing with indentation only touches the OUTER braces: a patch held
 * in an `input` field still arrives as one line of `\n` escapes, unreadable for
 * the one purpose this read serves. A lone string argument is therefore
 * unwrapped to its text, and a multi-field argument lists each field with its
 * value decoded, so newlines inside a value are real newlines.
 *
 * @param value - the parsed arguments.
 * @returns the readable rendering.
 */
function flattenArguments(value) {
  // A single string field is the common case (patch input, command body): the
  // value IS the content, so the wrapper is dropped entirely.
  if (typeof value === 'string') return value
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const entries = Object.entries(value)
    if (entries.length === 1 && typeof entries[0][1] === 'string') return entries[0][1]
    return entries
      .map(([key, item]) => {
        const body = typeof item === 'string' ? item : JSON.stringify(item)
        return `${key}: ${body}`
      })
      .join('\n')
  }
  return JSON.stringify(value)
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

/**
 * Drop the raw material of steps that already have a summary.
 *
 * This is the second half of the step-summary design: the summary says what a
 * step concluded, and this removes what it did to get there. The raw events
 * stay in the log -- only the projection changes -- so nothing is lost, only
 * un-replayed, and `history_read` still returns any of it by seq.
 *
 * A message is dropped when its step was summarized AND it is not itself the
 * summary. Matching on step rather than on content matters: the raw assistant
 * message and its tool results share a step with the summary that replaces
 * them, and a content-based rule would eventually drop a summary too.
 *
 * @param messages - the projected message list.
 * @param summarized - a Set of `"turn/step"` keys already summarized.
 * @param stepOf - maps one message to its `"turn/step"` key, or undefined.
 * @returns a new list, or the original when nothing was dropped.
 */
export function dropSummarizedSteps(messages, summarized, stepOf) {
  if (!Array.isArray(messages) || summarized.size === 0) return messages
  const out = []
  let changed = false
  for (const message of messages) {
    const key = stepOf(message)
    if (key !== undefined && summarized.has(key)) {
      changed = true
      continue
    }
    out.push(message)
  }
  return changed ? out : messages
}

/**
 * Put the newest step's raw material back into the projected list.
 *
 * A step's material is replaced on the log when its record is written, so the
 * projection carries records only. That reads well for steps the agent has
 * finished reasoning about, and badly for the one it is reasoning about now:
 * the record says what the step concluded, and the agent has no way to check
 * the conclusion against what it actually ran. A measured run responded by
 * reading the same file four times, once after each record that replaced a
 * read of it.
 *
 * So the newest step is projected as its raw messages PLUS its record. The
 * step being reasoned about keeps its evidence; every earlier step keeps its
 * conclusion. As the session advances the window moves: what was newest is
 * then an earlier step, and the next projection shows its record alone.
 *
 * @param messages - the projected message list, records included.
 * @param records - `{ key, message, rawSeqs }` per record, oldest first.
 * @param messagesOfSeq - maps a surface seq to the messages it contributes.
 * @returns a list with the newest step's material restored after its record.
 */
export function restoreNewestStep(messages, records, messagesOfSeq) {
  if (!Array.isArray(messages) || records.length === 0) return messages
  const newest = records[records.length - 1]
  const restored = []
  for (const seq of newest.rawSeqs ?? []) {
    for (const message of messagesOfSeq(seq) ?? []) restored.push(message)
  }
  if (restored.length === 0) return messages

  const out = []
  let placed = false
  for (const message of messages) {
    out.push(message)
    if (placed || message?.id !== newest.message?.id) continue
    // The record first, then what it recorded: the record orients the reader,
    // the material lets them verify it.
    for (const raw of restored) out.push(raw)
    placed = true
  }
  return placed ? out : messages
}
