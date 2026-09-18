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
  isLongEnough,
  isNumbered,
  numberLines,
  numberingContract,
  parseKeep,
  shouldNumber,
  splitLines,
  stripNumbering,
  textLeaves,
} from './distill.js'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'stepwise-distill'

/** Settings namespace the Host serves and the browser card claims. */
export const SETTINGS_NAMESPACE = 'stepwise-distill'

/**
 * Services this plugin reads.
 *
 * `systemPrompt` must be declared: cordis throws on property access without a
 * matching entry, so the prompt contract cannot be registered opportunistically.
 * The service ships in the base bundle, so every profile has it.
 */
export const inject = ['systemPrompt']

/**
 * Services read when the running profile provides them.
 *
 * Only the prompt service is required; the command is registered through
 * `ctx.commands` when a profile offers one, so a headless run still loads.
 */
export const optionalInject = ['commands']

/** Default line threshold above which a tool result is numbered. */
export const DEFAULT_MIN_LINES = 20

/**
 * Tools whose output already carries authoritative line numbers.
 *
 * `read` renders its own numbering through `formatReadOutput` in
 * `@deepseek-ai/dsh-tool-fs`, unconditionally and using real file line numbers
 * (see DESIGN.md section 6.1.1). Numbering that output again would put `[2]`
 * and `2:` side by side with different meanings, so those results are left
 * alone. Numbering is for tools whose output is unstructured command text.
 */
export const SELF_NUMBERED_TOOLS = ['read']

/** Placeholder for a result whose `tool/call` is missing from the log. */
export const UNKNOWN_TOOL = '<unknown>'

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
 * Whether a tool's results are outside this plugin's scope.
 *
 * Two independent reasons: the tool numbers its own output (`read`), or the
 * profile narrowed `tools` to a set that excludes it. Both mean "leave the
 * result exactly as the tool produced it".
 *
 * @param toolName - the tool that produced the result.
 * @param config - resolved plugin config.
 * @returns true when the result must not be numbered or distilled.
 */
export function shouldSkip(toolName, config) {
  // An unpaired result cannot be attributed to a tool, so its output format is
  // unknown. Leaving it untouched follows the design's "when in doubt, keep the
  // original" rule rather than numbering text whose shape is a guess.
  if (toolName === undefined || toolName === null || toolName === UNKNOWN_TOOL) return true
  if (SELF_NUMBERED_TOOLS.includes(toolName)) return true
  return config.tools.length > 0 && !config.tools.includes(toolName)
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
  const callId = resultCallId(event)
  if (callId === undefined) return UNKNOWN_TOOL
  const source = (events ?? []).find(
    other => other.type === 'tool/call' && other.data?.callId === callId,
  )
  return source?.data?.name ?? UNKNOWN_TOOL
}

/**
 * Resolve the callId that pairs one result with its call.
 *
 * Two shapes exist in the wild: the result event may carry
 * `data.source.callId`, and the tool-result block always carries
 * `data.message.content[].toolCallId`. Observed logs use one or the other, so
 * both are accepted rather than assuming a single producer.
 *
 * @param event - a `tool/result` event.
 * @returns the callId, or undefined when the event is not a tool result.
 */
export function resultCallId(event) {
  if (event?.type !== 'tool/result') return undefined
  const direct = event.data?.source?.callId
  if (direct !== undefined) return direct
  for (const block of event.data?.message?.content ?? []) {
    if (block?.toolCallId !== undefined) return block.toolCallId
  }
  return undefined
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
  if (shouldSkip(toolNameOf(event, events), config)) return false
  return leaves.some(leaf => isLongEnough(leaf.text, config.minLines))
}

/**
 * Collect the blocks of the assistant message that answered one tool result.
 *
 * A step runs `assistant/message` -> `tool/call` -> `tool/result`, so the
 * message that answers a result is the NEXT assistant message, the model's
 * first reply after seeing it. That message is where a `keep:` line about this
 * result can appear.
 *
 * Widening the window is a real bug, not a theoretical one. Collecting every
 * assistant message until the next human turn let one `keep: 3,7,12` written at
 * step 52 of a long turn be claimed by all ten earlier results of that turn,
 * silently distilling output the model had never judged. Narrowing it to the
 * next message is what keeps one decision answering one result.
 *
 * @param events - the full event log.
 * @param seq - the result event's sequence number.
 * @returns the contributing blocks, empty when the turn ended first.
 */
export function findKeepSource(events, seq) {
  // Sequence numbers are sparse in older session formats, so the scan follows
  // log order and compares seqs rather than assuming seq equals an index.
  for (const event of events) {
    if (event?.seq === undefined || event.seq <= seq) continue
    if (event.type === 'user/message') return []
    if (event.type === 'assistant/message') return event.data?.message?.content ?? []
  }
  return []
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
  const target = leaves.find(leaf => isLongEnough(leaf.text, config.minLines))
  if (target === undefined) return { skip: 'no-long-leaf' }
  if (isDistilled(target.text)) return { skip: 'already-distilled' }

  const blocks = findKeepSource(events, event.seq)
  if (blocks.length === 0) return { skip: 'no-keep-source' }

  const { found, indices, malformed } = parseKeep(blocks)
  if (!found) return { skip: 'no-keep-line' }
  if (malformed) return { skip: 'malformed-keep-line' }
  // An empty selection is a decision to keep nothing. That is legal, but it is
  // never useful, and it is indistinguishable from a misread contract, so the
  // node keeps its original text.
  if (indices.length === 0) return { skip: 'empty-keep-line' }

  // The result may already carry the numbering written by an earlier
  // post-execute pass, which is durable in the log. Re-numbering it would
  // stack prefixes and shift every index the model chose from, so the
  // existing numbering is reused as-is.
  const lines = isNumbered(target.text) ? splitLines(target.text) : splitLines(numberLines(target.text))
  const inRange = indices.filter(index => index >= 1 && index <= lines.length)
  if (inRange.length !== indices.length) return { skip: 'index-out-of-range' }

  const replacement = buildDistilledText({
    toolName: toolNameOf(event, events),
    isError: event.data.message.content?.[target.outer]?.isError === true,
    totalLines: lines.length,
    keptLines: lines,
    keptIndices: inRange,
    // Report the size the model actually saw. A numbered result carries a
    // counter on every line, so measuring the numbered text would overstate
    // both the original and the saving.
    originalText: stripNumbering(target.text),
    seq: event.seq,
  })

  // A replacement that is not smaller would trade real content for framing.
  if (replacement.length >= target.text.length) return { skip: 'not-smaller' }

  return {
    seq: event.seq,
    outer: target.outer,
    index: target.index,
    originalBytes: stripNumbering(target.text).length,
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
/**
 * Summarize what distillation has done to one event log.
 *
 * Pure over the log so it can answer for a live session and for an archived
 * file alike, which is what makes the same numbers available to the command,
 * to the offline audit script, and to any future UI.
 *
 * @param events - the session's events in log order.
 * @returns counts, byte savings, and the kept share of each distilled node.
 */
export function summarize(events) {
  const total = { numbered: 0, distilled: 0, originalBytes: 0, distilledBytes: 0 }
  const keptShares = []
  const problems = []
  const seen = new Set()

  for (const event of events) {
    if (event?.type !== 'tool/result') continue
    for (const leaf of textLeaves(event.data?.message)) {
      if (isNumbered(leaf.text) && !isDistilled(leaf.text)) total.numbered += 1
      const marker = distillMarker(leaf.text)
      if (marker === undefined) continue
      if (seen.has(event.seq)) continue
      seen.add(event.seq)

      total.distilled += 1
      total.distilledBytes += leaf.text.length
      if (!leaf.text.includes('history_read')) {
        problems.push(`seq ${event.seq}: no retrieval handle`)
      }
      const size = /original (\d+) bytes/.exec(leaf.text)
      if (size !== null) total.originalBytes += Number(size[1])
      const share = /^(\d+)\/(\d+) lines/.exec(marker)
      if (share !== null && Number(share[2]) > 0) {
        keptShares.push(Number(share[1]) / Number(share[2]))
      }
    }
  }

  return {
    ...total,
    savedBytes: Math.max(0, total.originalBytes - total.distilledBytes),
    keptShares,
    problems,
  }
}

/**
 * Render the summary as the text a `/distill` invocation shows.
 * @param summary - the value returned by {@link summarize}.
 * @param config - resolved plugin config.
 * @returns human-readable lines.
 */
export function renderSummary(summary, config) {
  const lines = [
    `mode: ${config.mode}${config.mode === 'observe' ? ' (nothing is rewritten)' : ''}`,
    `numbered results awaiting a keep: line: ${summary.numbered}`,
    `distilled results: ${summary.distilled}`,
  ]
  if (summary.distilled > 0) {
    const share = summary.keptShares.length === 0
      ? 0
      : summary.keptShares.reduce((sum, value) => sum + value, 0) / summary.keptShares.length
    lines.push(`bytes removed: ${summary.savedBytes} of ${summary.originalBytes}`)
    lines.push(`kept share of lines: mean ${(share * 100).toFixed(1)}%`)
  }
  if (summary.problems.length > 0) {
    lines.push('PROBLEMS:')
    for (const problem of summary.problems) lines.push(`  ${problem}`)
  }
  if (config.mode === 'distill' && summary.numbered > 0 && summary.distilled === 0) {
    lines.push('')
    lines.push('A numbered result is distilled only after you answer it with a keep: line.')
  }
  return lines.join('\n')
}

export function apply(ctx, config) {
  const resolved = resolveConfig(config)
  ctx.logger?.info?.(`[${name}] loaded: mode=${resolved.mode} `
    + `minLines=${resolved.minLines} debug=${String(resolved.debug)}`)

  /**
   * Register one hook, tolerating an event the running profile does not declare.
   *
   * Hook registration goes through cordis's event registry, which rejects a
   * name the host never declared. `agent/pre-step` is a waterfall owned by
   * `dsh-agent`, so a profile that runs without the agent loop -- a one-shot
   * headless task, for instance -- has no such event, and the plugin must
   * still load there because numbering runs earlier and independently.
   *
   * @param event - event name to subscribe.
   * @param handler - listener for that event.
   * @returns whether the hook was registered.
   */
  const listen = (event, handler) => {
    try {
      ctx.on(event, handler)
      return true
    } catch (error) {
      ctx.logger?.warn?.(`[${name}] hook "${event}" unavailable: ${String(error)}`)
      return false
    }
  }

  /**
   * Tell the model that numbered results exist and how to answer them.
   *
   * Without this the contract is unguessable: the numbering alone does not say
   * what to do with it, and a model that never emits a `keep:` line never
   * distills anything. The text is empty when numbering is off, so the section
   * costs nothing on a profile that only observes.
   */
  try {
    ctx.systemPrompt.section({
      name: PROMPT_SECTION,
      order: PROMPT_SECTION_ORDER,
      // Evaluated per assembly, so a Settings-UI change to minLines takes
      // effect on the next turn without a restart.
      text: () => {
        const live = resolveConfig(config)
        return live.minLines > 0 ? contractSection(live.minLines) : ''
      },
    })
  } catch (error) {
    // A prompt contribution is a convenience: numbering and solidification
    // read the loader config and keep working without it, so a rejected
    // section must not take the plugin down.
    ctx.logger?.warn?.(`[${name}] prompt section not installed: ${String(error)}`)
  }
  /**
   * Number long tool results as they are produced.
   *
   * Numbering happens at execution time, not on the surface, because the model
   * must see the numbers while it still has the content in view -- that is what
   * its `keep:` line refers to.
   */
  /**
   * Expose what distillation is doing, on demand, inside the running session.
   *
   * The same numbers the offline audit reports, computed from the live log, so
   * an operator can tell "nothing qualifies yet" apart from "the model is not
   * answering" without leaving the conversation.
   */
  const registerCommand = (commands) => {
    commands.register({
      name: 'distill',
      description: 'Show what stepwise distillation has done to this session',
      handler: (invocation) => {
        const current = resolveConfig(config)
        const summary = summarize(readEvents(invocation?.agent?.session))
        return { kind: 'success', text: renderSummary(summary, current) }
      },
    })
  }
  if (typeof ctx.inject === 'function') {
    ctx.inject(optionalInject, (injected) => {
      if (injected?.commands === undefined) return
      try {
        registerCommand(injected.commands)
      } catch (error) {
        ctx.logger?.warn?.(`[${name}] /distill not registered: ${String(error)}`)
      }
    })
  }

  listen('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    const current = resolveConfig(config)
    if (decision?.kind !== 'accept' || current.minLines <= 0) return decision
    // A self-numbered tool already tells the model which line is which; a
    // second numbering would contradict it.
    if (SELF_NUMBERED_TOOLS.includes(exec?.name) || shouldSkip(exec?.name, current)) return decision

    // `next()` returns the tool's own decision, which is usually a bare
    // `{kind:'accept'}` meaning "unchanged"; the content under decision lives
    // on the result the pipeline handed us. Replacing content is expressed by
    // returning a populated accept.
    const blocks = Array.isArray(decision.content) ? decision.content : result?.content
    if (!Array.isArray(blocks)) return decision

    let numbered = 0
    const mapped = blocks.map(block => {
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
  listen('agent/pre-step', async ({ agent, turn, step, signal }, next) => {
    process.stderr.write(`[stepwise] pre-step turn=${turn} step=${step}\n`)

    // This hook is a waterfall: the loop reads `kind` off the returned
    // decision, so the chain must always be resumed. Solidification is a side
    // effect around it, never a replacement for it.
    const decision = await next()
    const current = resolveConfig(config)
    const events = readEvents(agent?.session)
    if (events.length === 0) return decision

    const plans = []
    for (const event of events) {
      if (event.type !== 'tool/result') continue
      const plan = planDistillation(event, events, current)
      if (plan.skip === undefined) {
        plans.push(plan)
      } else if (current.debug && plan.skip !== 'ineligible') {
        ctx.logger?.info?.(`[${name}] seq ${event.seq} left as-is: ${plan.skip}`)
      }
    }
    if (plans.length === 0) return decision

    const saved = plans.reduce(
      (sum, plan) => sum + (plan.originalBytes - plan.replacement.length),
      0,
    )
    if (current.mode === 'observe') {
      ctx.logger?.info?.(`[${name}] observe: turn ${turn} step ${step} would distill `
        + `${plans.length} result(s), saving ~${saved} chars`)
      return decision
    }

    let committed = 0
    for (const plan of plans) {
      if (signal?.aborted) break
      try {
        commit(agent, events, plan)
        committed += 1
      } catch (error) {
        // Solidification improves history; it must never block the step.
        ctx.logger?.warn?.(`[${name}] seq ${plan.seq} not distilled: ${String(error)}`)
      }
    }
    ctx.logger?.info?.(`[${name}] distilled ${committed}/${plans.length} result(s) before `
      + `turn ${turn} step ${step}, ~${saved} chars`)
    return decision
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
function commit(agent, events, plan) {
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
    // The rewrite must describe the node it replaces, not the step doing the
    // replacing: the harness compares turn, step, callId, and isError against
    // the original and rejects any difference.
    turn: original.data.turn,
    step: original.data.step,
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
