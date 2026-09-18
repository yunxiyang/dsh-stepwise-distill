/**
 * Token pricing that matches the harness's own estimator.
 *
 * The numbers are only useful if they can be compared against the harness's
 * context breakdown, so this mirrors `packages/llm/token-meter/src/estimate.ts`
 * exactly: a fixed 4-characters-per-token density plus per-block structural
 * overhead. Exact tokenization is deliberately out of scope; a consistent
 * estimate across sessions is what the P0 baseline needs.
 *
 * @module dsh-stepwise-distill/scripts/lib/pricing
 */

/** Fixed text-density estimate, matching the harness. */
const CHARS_PER_TOKEN = 4

/** Per-block structural overhead for JSON framing and type tags. */
const BLOCK_OVERHEAD = 4

/** Role-field framing overhead added to every priced message. */
export const ROLE_OVERHEAD = 4

/** Heuristic tokens for text that carries no typed block. */
function structural(value) {
  return BLOCK_OVERHEAD + Math.ceil(JSON.stringify(value).length / CHARS_PER_TOKEN)
}

/**
 * Price content blocks recursively, following the harness estimator.
 * @param blocks - content blocks to price.
 * @returns estimated tokens including per-block overhead.
 */
export function estimateContent(blocks) {
  if (!Array.isArray(blocks)) return 0
  let tokens = 0
  for (const block of blocks) {
    switch (block?.type) {
      case 'text':
      case 'reasoning':
        tokens += Math.ceil(String(block.text ?? '').length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD
        break
      case 'tool-call':
        tokens += Math.ceil(String(block.name ?? '').length / CHARS_PER_TOKEN)
          + Math.ceil(String(block.arguments ?? '').length / CHARS_PER_TOKEN)
          + BLOCK_OVERHEAD
        break
      case 'tool-result':
        tokens += estimateContent(block.content) + BLOCK_OVERHEAD
        break
      default:
        tokens += structural(block)
    }
  }
  return tokens
}

/**
 * Price one message: role framing plus its content.
 * @param message - a model-facing message.
 * @returns estimated tokens.
 */
export function estimateMessage(message) {
  if (message === null || message === undefined) return 0
  return ROLE_OVERHEAD + estimateContent(message.content)
}

/**
 * Price the system prompt, which adapters serialize as a plain string.
 * @param message - the `system/message` node.
 * @returns estimated tokens with role framing and no block overhead.
 */
export function estimateSystem(message) {
  if (message === null || message === undefined) return 0
  const text = Array.isArray(message.content)
    ? message.content.filter(block => block?.type === 'text').map(block => block.text).join('\n')
    : String(message.content ?? '')
  return ROLE_OVERHEAD + Math.ceil(text.length / CHARS_PER_TOKEN)
}

/**
 * Classify the byte weight of a message into the categories DESIGN.md reports.
 *
 * The split is what identifies the problem: a session dominated by reasoning
 * needs the transport-layer strip, while one dominated by tool results needs
 * in-place distillation.
 *
 * @param message - a model-facing message.
 * @returns byte counts by category plus the total.
 */
export function weighMessage(message) {
  const weight = {
    text: 0, reasoning: 0, toolCallArgs: 0, toolResult: 0, other: 0, total: 0,
  }
  // Returns the bytes this subtree contributes to `toolResult`, so a
  // tool-result block's payload is attributed to the tool bucket rather than
  // to whichever block happens to wrap it.
  const walk = (blocks) => {
    let bytes = 0
    if (!Array.isArray(blocks)) return bytes
    for (const block of blocks) {
      switch (block?.type) {
        case 'text':
          weight.text += byteLength(block.text)
          bytes += byteLength(block.text)
          break
        case 'reasoning':
          weight.reasoning += byteLength(block.text)
          bytes += byteLength(block.text)
          break
        case 'tool-call':
          weight.toolCallArgs += byteLength(block.arguments) + byteLength(block.name)
          bytes += byteLength(block.arguments) + byteLength(block.name)
          break
        case 'tool-result':
          bytes += walk(block.content)
          break
        default: {
          const size = byteLength(JSON.stringify(block ?? null))
          weight.other += size
          bytes += size
        }
      }
    }
    return bytes
  }
  weight.toolResult = walk(message?.content)
  weight.total = weight.text + weight.reasoning + weight.toolCallArgs
    + weight.toolResult + weight.other
  return weight
}

/** UTF-8 byte length of a value rendered as text. */
export function byteLength(value) {
  if (value === undefined || value === null) return 0
  return Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value), 'utf8')
}
