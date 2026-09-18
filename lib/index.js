/**
 * Stepwise history solidification for DeepSeek Harness.
 *
 * Long sessions re-send almost everything they ever produced: roughly half the
 * bytes on the wire are tool results, and reasoning alone can reach a third of
 * a session. No single result is oversized, so the shipped result pruner (which
 * fires above 8192 characters) and the spill policy never trigger -- the cost is
 * accumulation, not explosion.
 *
 * This plugin fixes accumulation by rewriting tool results IN PLACE on the
 * session surface, keeping only the lines the model said it needed and leaving
 * a retrieval handle for everything else. Node count, roles, callIds, and
 * pairing stay untouched, which is exactly what the harness's surface rewrite
 * rules permit for `tool/result` events.
 *
 * Phases, per DESIGN.md section 12:
 *  - P2 (this build's default, `mode: 'observe'`): number long results and log
 *    what a model-chosen `keep:` line would have retained. Nothing is deleted.
 *  - P3 (`mode: 'distill'`): perform the replacement on `agent/pre-step`.
 *
 * @module dsh-stepwise-distill
 */

import z from '@deepseek-ai/schemastery'
import {
  buildDistilledText,
  contractSection,
  distillMarker,
  isDistilled,
  numberLines,
  numberingContract,
  parseKeep,
  shouldNumber,
  splitLines,
  textLeaves,
} from './distill.js'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'stepwise-distill'

/** Settings namespace the Host serves and the browser card claims. */
export const SETTINGS_NAMESPACE = 'stepwise-distill'

/** Default line threshold above which a tool result is numbered. */
export const DEFAULT_MIN_LINES = 20

/** Default operating mode: measure before mutating. */
export const DEFAULT_MODE = 'observe'

/**
 * Prompt section name. Sits just after the harness-source and web-surface
 * notes, so the contract reads as the last piece of operating guidance rather
 * than as part of the deployment persona.
 */
export const PROMPT_SECTION = 'stepwise-distill:contract'

/** Sort order placing this section after the harness-source and web-surface notes. */
export const PROMPT_SECTION_ORDER = 10250

/**
 * Distillation policy. Every field carries a default, so a profile patch can
 * set any subset.
 */
export const Config = z.object({
  /** `observe` numbers and reports; `distill` also rewrites the surface. */
  mode: z.union([z.const('observe'), z.const('distill')]).default(DEFAULT_MODE),
  /** Only results longer than this many lines are numbered. */
  minLines: z.number().step(1).min(1).default(DEFAULT_MIN_LINES),
  /** Tool names whose results may be distilled; empty means every tool. */
  tools: z.array(z.string()).default([]),
  /** Emit a diagnostic line for every evaluation. */
  debug: z.boolean().default(false),
})

/**
 * Resolve one config snapshot.
 *
 * Called per evaluation rather than once at mount, so a Settings-UI or patch
 * change takes effect on the next step without a restart.
 *
 * @param config - raw plugin config from the loader or the Settings section.
 * @returns the config with every default applied.
 */
export function resolveConfig(config) {
  return {
    mode: config?.mode ?? DEFAULT_MODE,
    minLines: config?.minLines ?? DEFAULT_MIN_LINES,
    tools: config?.tools ?? [],
    debug: config?.debug ?? false,
  }
}

/**
 * Read a session's immutable event log across host core versions.
 *
 * 0.1.1-rc.2 exposes events as a `session.events` getter; 0.1.5-alpha.2 renamed
 * it to `session.snapshotEvents()`. Probe both and use whichever the running
 * host provides.
 *
 * @param session - the agent's live session.
 * @returns the event array, or an empty array when neither API exists.
 */
export function readEvents(session) {
  if (typeof session?.snapshotEvents === 'function') return session.snapshotEvents()
  if (session !== undefined && session !== null && Array.isArray(session.events)) {
    return session.events
  }
  return []
}

/**
 * Resolve the tool name behind one result event.
 *
 * A `tool/result` carries only its callId; the name lives on the `tool/call`
 * event that shares it, so the log is searched for the pairing rather than
 * guessed from content.
 *
 * @param event - a `tool/result` event.
 * @param events - the full event log.
 * @returns the tool name, or `<unknown>` when no call pairs with the result.
 */
export function toolNameOf(event, events) {
  const callId = event?.data?.source?.callId
  if (callId === undefined) return '<unknown>'
  const source = (events ?? []).find(
    other => other.type === 'tool/call' && other.data?.callId === callId,
  )
  return source?.data?.name ?? '<unknown>'
}

/**
 * Whether one tool result is eligible for numbering and distillation.
 * @param event - a `tool/result` session event.
 * @param config - resolved plugin config.
 * @param events - the full event log, for tool-name resolution.
 * @returns true when the result may be numbered.
 */
export function isEligible(event, config, events) {
  if (event?.type !== 'tool/result') return false
  const leaves = textLeaves(event.data?.message)
  if (leaves.length === 0) return false
  if (config.tools.length > 0 && !config.tools.includes(toolNameOf(event, events))) return false
  return leaves.some(leaf => shouldNumber(leaf.text, config.minLines))
}

/**
 * Find the assistant message that answered one tool result.
 *
 * The `keep:` contract is produced by the step that consumed the result, i.e.
 * the next assistant message after it and before the next human turn.
 *
 * @param events - the full event log.
 * @param seq - the result event's sequence number.
 * @returns the answering assistant message's blocks, or null.
 */
export function findKeepSource(events, seq) {
  // Sequence numbers are sparse in older session formats, so the scan follows
  // log order and compares seqs rather than assuming seq equals an index.
  for (const event of events) {
    if (event?.seq === undefined || event.seq <= seq) continue
    if (event?.type === 'user/message') return null
    if (event?.type === 'assistant/message') return event.data?.message?.content ?? null
  }
  return null
}

/**
 * Plan the distillation of one result event.
 *
 * Pure: the same event, log, and config always produce the same plan. That is
 * what makes a replay idempotent and keeps the request prefix byte-stable
 * (DESIGN.md sections 2.1 and 8.2).
 *
 * @param event - a `tool/result` event.
 * @param events - the full event log.
 * @param config - resolved plugin config.
 * @returns a plan, or `{ skip }` explaining why the node is left alone.
 */
export function planDistillation(event, events, config) {
  if (!isEligible(event, config, events)) return { skip: 'ineligible' }

  const leaves = textLeaves(event.data.message)
  const target = leaves.find(leaf => shouldNumber(leaf.text, config.minLines))
  if (target === undefined) return { skip: 'no-long-leaf' }
  if (isDistilled(target.text)) return { skip: 'already-distilled' }

  const blocks = findKeepSource(events, event.seq)
  if (blocks === null) return { skip: 'no-keep-source' }

  const { found, indices, malformed } = parseKeep(blocks)
  if (!found) return { skip: 'no-keep-line' }
  if (malformed) return { skip: 'malformed-keep-line' }
  // An empty selection is a decision to keep nothing. That is legal, but it is
  // never useful, and it is indistinguishable from a misread contract, so the
  // node keeps its original text.
  if (indices.length === 0) return { skip: 'empty-keep-line' }

  const lines = splitLines(numberLines(target.text))
  const inRange = indices.filter(index => index >= 1 && index <= lines.length)
  if (inRange.length !== indices.length) return { skip: 'index-out-of-range' }

  const replacement = buildDistilledText({
    toolName: toolNameOf(event, events),
    isError: event.data.message.content?.[target.outer]?.isError === true,
    totalLines: lines.length,
    keptLines: lines,
    keptIndices: inRange,
    originalText: target.text,
    seq: event.seq,
  })

  // A replacement that is not smaller would trade real content for framing.
  if (replacement.length >= target.text.length) return { skip: 'not-smaller' }

  return {
    seq: event.seq,
    outer: target.outer,
    index: target.index,
    originalBytes: target.text.length,
    replacement,
    keptIndices: inRange,
    totalLines: lines.length,
  }
}

/**
 * Mount the plugin on a Cordis context.
 * @param ctx - plugin context.
 * @param config - raw plugin config from the loader.
 */
export function apply(ctx, config) {
  const resolved = resolveConfig(config)
  ctx.logger?.info?.(`[${name}] loaded: mode=${resolved.mode} `
    + `minLines=${resolved.minLines} debug=${String(resolved.debug)}`)

  /**
   * Tell the model that numbered results exist and how to answer them.
   *
   * Without this the contract is unguessable: the numbering alone does not say
   * what to do with it, and a model that never emits a `keep:` line never
   * distills anything. The text is empty when numbering is off, so the section
   * costs nothing on a profile that only observes.
   */
  const registerContract = (prompt) => {
    prompt.section({
      name: PROMPT_SECTION,
      order: PROMPT_SECTION_ORDER,
      // Evaluated per assembly, so a Settings-UI change to minLines takes
      // effect on the next turn without a restart.
      text: () => {
        const live = resolveConfig(config)
        return live.minLines > 0 ? contractSection(live.minLines) : ''
      },
    })
  }
  if (typeof ctx.systemPrompt?.section === 'function') {
    registerContract(ctx.systemPrompt)
  } else if (typeof ctx.inject === 'function') {
    // Registration is advisory: the hooks below work from the loader config
    // even when no prompt service is present, so a missing service must not
    // take the plugin down.
    ctx.inject(['systemPrompt'], (promptCtx) => {
      try {
        registerContract(promptCtx.systemPrompt)
      } catch (error) {
        ctx.logger?.warn?.(`[${name}] prompt section not installed: ${String(error)}`)
      }
    })
  }

  /**
   * Number long tool results as they are produced.
   *
   * Numbering happens at execution time, not on the surface, because the model
   * must see the numbers while it still has the content in view -- that is what
   * its `keep:` line refers to.
   */
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    const current = resolveConfig(config)
    if (decision?.kind !== 'accept' || current.minLines <= 0) return decision
    if (!Array.isArray(decision.content)) return decision

    let numbered = 0
    const mapped = decision.content.map(block => {
      if (block?.type !== 'text' || !shouldNumber(block.text, current.minLines)) return block
      numbered += 1
      return { ...block, text: numberLines(block.text) }
    })
    if (numbered === 0) return decision

    mapped.push({ type: 'text', text: numberingContract(numbered) })
    if (current.debug) {
      ctx.logger?.info?.(`[${name}] numbered ${numbered} result block(s) `
        + `from ${exec?.name ?? '?'}`)
    }
    return { ...decision, content: mapped }
  })

  /**
   * Solidify the previous turn's results before this step's request is built.
   *
   * `agent/pre-step` is the only hook that runs on every step, that early, and
   * with `agent.session` in hand. Step 1 is skipped because no completed turn
   * exists yet to distill.
   */
  ctx.on('agent/pre-step', async ({ agent, turn, step, signal }) => {
    // Nothing has completed during the session's first turn, so there is
    // nothing to solidify yet. Later turns may distill on their first step:
    // the turn boundary, not the step number, is what makes work final.
    if (turn <= 1) return
    const current = resolveConfig(config)
    const events = readEvents(agent?.session)
    if (events.length === 0) return

    const plans = []
    for (const event of events) {
      if (event.type !== 'tool/result') continue
      if (event.data?.turn === undefined || event.data.turn >= turn) continue
      const plan = planDistillation(event, events, current)
      if (plan.skip === undefined) {
        plans.push(plan)
      } else if (current.debug && plan.skip !== 'ineligible') {
        ctx.logger?.info?.(`[${name}] seq ${event.seq} left as-is: ${plan.skip}`)
      }
    }
    if (plans.length === 0) return

    const saved = plans.reduce(
      (sum, plan) => sum + (plan.originalBytes - plan.replacement.length),
      0,
    )
    if (current.mode === 'observe') {
      ctx.logger?.info?.(`[${name}] observe: turn ${turn} step ${step} would distill `
        + `${plans.length} result(s), saving ~${saved} chars`)
      return
    }

    let committed = 0
    for (const plan of plans) {
      if (signal?.aborted) break
      try {
        commit(agent, events, plan, turn, step)
        committed += 1
      } catch (error) {
        // Solidification improves history; it must never block the step.
        ctx.logger?.warn?.(`[${name}] seq ${plan.seq} not distilled: ${String(error)}`)
      }
    }
    ctx.logger?.info?.(`[${name}] distilled ${committed}/${plans.length} result(s) before `
      + `turn ${turn} step ${step}, ~${saved} chars`)
  })
}

/**
 * Append one replacement event that shadows a single tool result.
 *
 * The harness permits rewriting a `tool/result`'s content and nothing else:
 * `callId`, `isError`, `turn`, and `step` are compared byte-for-byte after the
 * content is removed, so only the content is rebuilt here.
 *
 * @param agent - the running agent.
 * @param events - the full event log.
 * @param plan - the distillation plan to commit.
 * @param turn - current turn number.
 * @param step - current step number.
 */
function commit(agent, events, plan, turn, step) {
  const session = agent?.session
  if (typeof session?.append !== 'function') throw new Error('session.append is unavailable')

  const original = events.find(event => event?.seq === plan.seq)
  if (original === undefined) throw new Error(`seq ${plan.seq} is not in the log`)
  const content = (original.data.message.content ?? []).map((outer, outerIndex) => {
    if (outerIndex !== plan.outer) return outer
    return {
      ...outer,
      content: (outer.content ?? []).map((inner, innerIndex) => (
        innerIndex === plan.index ? { ...inner, text: plan.replacement } : inner
      )),
    }
  })

  session.append('tool/result', {
    turn,
    step,
    message: { ...original.data.message, content },
  }, {
    surfaceOp: { op: 'replace', startSeq: plan.seq, endSeq: plan.seq },
    // Required: the replacement must account for every node it shadows.
    sourceEventSeqs: [plan.seq],
  })

  if (distillMarker(plan.replacement) === undefined) {
    throw new Error('replacement lost its distillation marker')
  }
}
