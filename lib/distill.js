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
  return splitLines(text).length > minLines
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
 * The contract prefers reasoning because the transport layer strips reasoning
 * from the request, so the control signal never re-enters history as noise
 * (DESIGN.md section 6.2). Text blocks are accepted because a model that
 * answers without reasoning must still be able to steer distillation; the
 * stripper removes the line from later requests.
 *
 * @param blocks - content blocks from one assistant message.
 * @returns `{ found, indices, malformed }`; `found` is false when no contract
 *   line exists, and `malformed` is true when a line exists but is unreadable.
 */
export function parseKeep(blocks) {
  const joined = textOf(blocks)
  const match = joined.match(/(?:^|\n)\s*keep:\s*([^\n]*)/i)
  if (match === null) {
    const last = reasoningOf(blocks).pop()
    if (last === undefined) return { found: false, indices: [], malformed: false }
    const inner = last.match(/(?:^|\n)\s*keep:\s*([^\n]*)/i)
    if (inner === null) return { found: false, indices: [], malformed: false }
    return fromLine(inner[1])
  }
  return fromLine(match[1])
}

/**
 * Build one contract result from the text following `keep:`.
 * @param raw - the text after the prefix.
 * @returns `{ found, indices, malformed }`.
 */
function fromLine(raw) {
  const indices = parseIndices(raw)
  if (indices === null) return { found: true, indices: [], malformed: true }
  return { found: true, indices, malformed: false }
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
  const factsLine = facts.length > 0 ? facts.join('; ') : 'none'
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
 * Render the numbering contract appended to one tool result.
 *
 * The contract travels with the numbered text so a model that sees results in
 * a resumed or replayed session still knows how to answer.
 *
 * @param eligibleCount - how many results in this step were numbered.
 * @returns the instruction text.
 */
export function numberingContract(eligibleCount) {
  return [
    '',
    '---',
    `The ${eligibleCount} result(s) above are line-numbered for compaction.`,
    'When a result is not worth keeping in full, end your reply with one line:',
    `  ${KEEP_PREFIX} 3,7,12`,
    'listing only the line numbers whose content you must retain; when you do,',
    'those lines are kept and every other line is replaced by a handle that',
    'reads them back on demand. Reply with no such line to keep every result',
    'verbatim.',
  ].join('\n')
}

/**
 * Render the system-prompt section announcing the contract.
 *
 * This is the only place the model learns that numbered results exist and how
 * to answer them, so it states the exact line syntax and the default (say
 * nothing, keep everything). It contributes nothing until a result has
 * actually been numbered, because a contract that never applies is prompt
 * noise on every turn.
 *
 * @param minLines - the line threshold the plugin numbers at.
 * @returns the instruction text.
 */
export function contractSection(minLines) {
  return [
    `Tool results longer than ${minLines} lines are line-numbered for history compaction.`,
    'Numbers exist so you can choose what survives into later turns: after you have',
    'read a numbered result, decide which lines carry facts you will still need, and',
    'end that reply with one line of your own:',
    `  ${KEEP_PREFIX} 3,7,12`,
    'Use the numbers you were given, comma-separated. Those lines are kept verbatim',
    'and every other line is replaced by a short handle that can read the original',
    'back on demand, so dropping a line is recoverable rather than destructive.',
    'Keep the lines you would act on, quote, or cite; drop listings, progress noise,',
    'and boilerplate. Put the line at the very end of your reply.',
    'Say nothing about compaction if you would rather keep a result in full:',
    'a reply without that line keeps every result of that step verbatim.',
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
