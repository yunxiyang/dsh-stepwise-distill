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
import { BlockAssembler, createSystemMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import {
  SUMMARY_MARKER,
  parseSummary,
  renderStepMaterial,
  renderSummaryMessage,
  summarizeInstruction,
  summarizePrompt,
} from './summarize.js'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  dropSummarizedSteps,
  reasoningContract,
  renderHistoryRead,
  stripReasoningFrom,
} from './distill.js'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'stepwise-distill'

/** Settings namespace the Host serves and the browser card claims. */
export const SETTINGS_NAMESPACE = 'stepwise-distill'

/**
 * Services this plugin reads.
 *
 * Both must be declared: cordis throws on property access without a matching
 * entry, so neither can be reached opportunistically.
 *
 * `agents` is what puts this plugin on the agent lifecycle. `agent/pre-step` is
 * dispatched through an agent-scoped carrier, and a subscription registered
 * before that service is ready does not receive it -- the plugin loads, the
 * prompt section appears, and the step hook silently never fires. Declaring
 * `agents` ties the load to the lifecycle that owns the event.
 */
export const inject = ['systemPrompt', 'agents']

/**
 * Services read when the running profile provides them.
 *
 * Only the prompt service is required; the command is registered through
 * `ctx.commands` when a profile offers one, so a headless run still loads.
 */
export const optionalInject = ['commands', 'tools', 'llm']

/**
 * Tools whose output already carries authoritative line numbers.
 *
 * `read` renders its own numbering through `formatReadOutput` in
 * `@deepseek-ai/dsh-tool-fs`, unconditionally and using real file line numbers
 * (see DESIGN.md section 6.1.1). Numbering that output again would put `[2]`
 * and `2:` side by side with different meanings, so those results are left
 * alone. Numbering is for tools whose output is unstructured command text.
 */
/** Placeholder for a result whose `tool/call` is missing from the log. */
export const UNKNOWN_TOOL = '<unknown>'

/**
 * Non-enumerable marker recording that this session's projection is wrapped.
 *
 * Stored on the session rather than in module scope because sessions outlive
 * plugin mounts: a resume, a reload, or a second mount must not wrap twice.
 */
/**
 * Append one diagnostic line to the plugin's own log file.
 *
 * The plugin's work is invisible from outside the harness: a retained note is an
 * ordinary session event, and a failure is deliberately non-fatal. That made two
 * separate outages look identical from the outside -- "the request went out and
 * nothing changed". File-based so a running process can be inspected without a
 * restart, and gated on `debug` so it costs nothing when off.
 *
 * @param enabled - whether diagnostics are on.
 * @param line - the message to record.
 */
function diagnose(enabled, line) {
  if (!enabled) return
  try {
    const fs = globalThis.process?.getBuiltinModule?.('node:fs')
    if (fs === undefined) return
    fs.appendFileSync(
      '/tmp/dsh-stepwise-distill.log',
      `${new Date().toISOString()} ${line}\n`,
    )
  } catch {}
}

export const REASONING_STRIPPED = Symbol.for('dsh-stepwise-distill.reasoningStripped')

/** Non-enumerable marker recording which `turn/step` pairs have a summary. */
export const SUMMARIZED_STEPS = Symbol.for('dsh-stepwise-distill.summarizedSteps')

/**
 * The last summary failure, readable from `/distill`.
 *
 * A summary failure never stops a step, so nothing else surfaces it. Without a
 * readable record the plugin looks healthy while writing nothing.
 */
export const LAST_SUMMARY_ERROR = Symbol.for('dsh-stepwise-distill.lastSummaryError')

/** System-prompt section asking for a written conclusion each step. */
export const REASONING_SECTION = 'stepwise-distill:reasoning'

/**
 * Sort order placing the conclusion instructions after the host's own notes.
 *
 * It is the only section this plugin contributes now, so it sits where the
 * numbering contract used to: last, after deployment persona and environment
 * notes, so it reads as operating guidance rather than as part of the persona.
 */
export const REASONING_SECTION_ORDER = 10250

/**
 * Distillation policy. Every field carries a default, so a profile patch can
 * set any subset.
 */
export const Config = z.object({
  /** Ask for a written conclusion at the end of every step. */
  reasoningContract: z.boolean().default(true),
  /** Ask the model for a step summary and keep its raw material out of later turns. */
  stepSummary: z.boolean().default(false),
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
    // On by default: the point of the plugin is to keep history usable, and a
    // step whose conclusion was never written down cannot be kept at all.
    reasoningContract: config?.reasoningContract ?? true,
    stepSummary: config?.stepSummary ?? false,
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

export function summarize(events) {
  const steps = new Set()
  for (const event of events) {
    const turn = event?.data?.turn
    const step = event?.data?.step
    if (typeof turn !== 'number' || typeof step !== 'number') continue
    steps.add(`${turn}/${step}`)
  }

  // Raw material still present for steps that have been summarized. This is
  // what the projection withholds from later turns: the author's own reasoning,
  // tool arguments, and tool output, retained in the log and readable on demand.
  let droppedBytes = 0
  let droppedPieces = 0
  const summaries = []
  for (const event of events) {
    if (event?.type === 'assistant/message') {
      for (const block of event.data?.message?.content ?? []) {
        const size = typeof block?.text === 'string' ? block.text.length : 0
        if (block?.type === 'reasoning' || block?.type === 'text') {
          if (block.type === 'reasoning') { droppedBytes += size; droppedPieces += 1 }
        } else if (block?.type === 'tool-call') {
          droppedBytes += String(block.arguments ?? '').length
          droppedPieces += 1
        }
      }
    } else if (event?.type === 'tool/result') {
      for (const outer of event.data?.message?.content ?? []) {
        for (const inner of outer?.content ?? []) {
          if (inner?.type === 'text' && typeof inner.text === 'string') {
            droppedBytes += inner.text.length
            droppedPieces += 1
          }
        }
      }
    } else if (event?.type === 'user/message') {
      // A user message appended by this plugin stores its content flat on
      // `data`; only host-built result and assistant events nest under `message`.
      const text = (event.data?.content ?? [])
        .map(block => block?.text ?? '').join('')
      if (text.startsWith('[step summary]')) summaries.push(text)
    }
  }

  // `summarized` is counted from the log, not taken from the caller.
  //
  // It used to be the caller's set size, and `/distill` called this with one
  // argument -- so the command reported "steps summarized: 0" on a session that
  // had six records in it. The log is the only source that cannot go out of
  // step with what was actually written.
  return {
    steps: steps.size,
    summarized: summaries.length,
    summaries,
    droppedBytes,
    droppedPieces,
  }
}

/**
 * Render the summary as the text a `/distill` invocation shows.
 * @param report - the value returned by {@link summarize}.
 * @param config - resolved plugin config.
 * @returns human-readable lines.
 */
export function renderSummary(report, config) {
  const lines = [
    `step summary: ${config.stepSummary ? 'on' : 'off'}`,
    `reasoning stripped from the request: ${config.reasoningContract ? 'yes' : 'no'}`,
    `steps in this session: ${report.steps}`,
    `steps written down: ${report.summarized}`,
  ]
  if (report.summarized > 0) {
    lines.push(`raw material withheld from later turns: ${report.droppedBytes} bytes `
      + `in ${report.droppedPieces} pieces`)
    const newest = report.summaries.at(-1)
    if (typeof newest === 'string') {
      lines.push('')
      lines.push('Most recent record:')
      lines.push(`  ${newest.split('\n')[0].slice(0, 160)}`)
    }
  } else {
    lines.push('')
    lines.push('No step has been written down yet. A record is written after a step')
    lines.push('completes; until then every step is still sent in full.')
  }
  lines.push('Original text is never lost: `history_read` returns any seq.')
  if (typeof report.lastError === 'string' && report.lastError.length > 0) {
    lines.push('')
    lines.push('Last summary failure (a failure never stops a step, so it is')
    lines.push('reported here rather than thrown):')
    lines.push(`  ${report.lastError.split('\n')[0]}`)
  }
  return lines.join('\n')
}


/**
 * Mount the plugin on a Cordis context.
 * @param ctx - plugin context.
 * @param config - raw plugin config from the loader.
 */
export function apply(ctx, config) {
  const resolved = resolveConfig(config)
  ctx.logger?.info?.(`[${name}] loaded: stepSummary=${String(resolved.stepSummary)} `
    + `reasoningContract=${String(resolved.reasoningContract)} debug=${String(resolved.debug)}`)

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
  /**
   * Ask for a written conclusion at the end of every step.
   *
   * Registered separately from the numbering contract because it answers a
   * different question and is gated on its own switch: it applies even when
   * nothing was numbered, and it is the part under measurement, so it must be
   * possible to turn one off without the other.
   */
  try {
    ctx.systemPrompt.section({
      name: REASONING_SECTION,
      order: REASONING_SECTION_ORDER,
      text: () => {
        const live = resolveConfig(config)
        return live.reasoningContract ? reasoningContract() : ''
      },
    })
  } catch (error) {
    ctx.logger?.warn?.(`[${name}] reasoning section not installed: ${String(error)}`)
  }
  /**
   * Expose what distillation is doing, on demand, inside the running session.
   *
   * The same numbers the offline audit reports, computed from the live log, so
   * an operator can tell "nothing qualifies yet" apart from "the model is not
   * answering" without leaving the conversation.
   */
  let llm
  /** One-shot self-check state: reports plugin wiring once per process. */

  const registerCommand = (commands) => {
    commands.register({
      name: 'distill',
      description: 'Show what stepwise distillation has done to this session',
      handler: (invocation) => {
        const current = resolveConfig(config)
        const session = invocation?.agent?.session
        const summary = summarize(readEvents(session))
        summary.lastError = session?.[LAST_SUMMARY_ERROR]
        return { kind: 'success', text: renderSummary(summary, current) }
      },
    })
  }

  /**
   * Expose the pre-distillation text of one tool result.
   *
   * This is the only path back to what a `keep:` answer dropped, and it reads
   * the append-only event log rather than the surface: a distilled node is
   * shadowed on the surface, so the surface is exactly where the original is
   * NOT. Without this tool a default-drop contract would discard history with
   * no way to recover it (DESIGN.md sections 2.3 and 9).
   */
  const registerHistoryRead = (tools) => {
    // `defineTool` compiles the author-facing schemas into the enforced JSON
    // Schema subset and supplies the default result presentation. Every host
    // tool uses this same call, so registration matches theirs exactly.
    tools.register(defineTool({
      name: 'history_read',
      description: 'Read the original text of a tool result that distillation '
        + 'replaced, or the original arguments of a tool call that was summarized, '
        + 'by the session seq from its `full: session seq N` handle.',
      parameters: {
        seq: {
          type: 'number',
          required: true,
          description: 'Session sequence number of the tool result to read back.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            seq: { type: 'integer', required: true },
            text: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: value.text }],
      },
      async execute(args, exec) {
        const seq = Number(args?.seq)
        if (!Number.isSafeInteger(seq)) {
          return { seq: -1, text: 'history_read: seq must be an integer' }
        }
        const events = readEvents(exec?.agent?.session)
        // The log is searched rather than indexed: seqs are sparse in older
        // session formats, so seq does not necessarily equal a position.
        const event = events.find(candidate => candidate?.seq === seq)
        const { text } = renderHistoryRead(event, seq)
        return { seq, text }
      },
    }))
  }

/**
   * Solidify the previous turn's results before this step's request is built.
   *
   * `agent/pre-step` is the only hook that runs on every step, that early, and
   * with `agent.session` in hand. Step 1 is skipped because no completed turn
   * exists yet to distill.
   */
  listen('agent/pre-step', async ({ agent, turn, step, signal }, next) => {
    // This hook is a waterfall: the loop reads `kind` off the returned
    // decision, so the chain must always be resumed. Solidification is a side
    // effect around it, never a replacement for it.
    const current = resolveConfig(config)
    diagnose(current.debug, `pre-step turn=${turn} step=${step} `
      + `stepSummary=${String(current.stepSummary)} llm=${String(llm !== undefined)}`)
    installReasoningStrip(agent, current)
    // Summarize the step that just ended BEFORE the next request is built: the
    // point of the summary is to decide what that request contains. Failure is
    // contained here -- a summary is an improvement to the next step's context,
    // never a precondition for it.
    if (current.stepSummary && llm !== undefined) {
      try {
        await summarizeFinishedStep(agent, llm, current, signal)
      } catch (error) {
        const message = String(error?.stack ?? error)
        diagnose(current.debug, `FAILED ${message.split('\n')[0]}`)
        ctx.logger?.warn?.(`[${name}] step summary failed: ${message}`)
        // A summary failure is deliberately non-fatal, and the warn above is
        // not readable from outside the harness -- which together made every
        // failure silent, including a rejected append that produced no summary
        // at all while the log showed a successful request. Keep the last
        // failure on the session so `/distill` can report it.
        const target = agent?.session
        if (target !== undefined) {
          Object.defineProperty(target, LAST_SUMMARY_ERROR, {
            value: message,
            enumerable: false,
            configurable: true,
          })
        }
      }
    }
    const decision = await next()
    return decision
  })
  if (typeof ctx.inject === 'function') {
    ctx.inject(optionalInject, (injected) => {
      llm = injected?.llm
      if (injected?.commands !== undefined) {
        try {
          registerCommand(injected.commands)
        } catch (error) {
          ctx.logger?.warn?.(`[${name}] /distill not registered: ${String(error)}`)
        }
      }
      if (injected?.tools !== undefined) {
        try {
          registerHistoryRead(injected.tools)
        } catch (error) {
          ctx.logger?.warn?.(`[${name}] history_read not registered: ${String(error)}`)
        }
      }
    })
  }
}

/**
 * Build a message-id to `"turn/step"` lookup over the event log.
 *
 * The projected messages carry no turn or step: they are plain conversation
 * structures. Their `id` is the durable identity the log recorded, so it is the
 * bridge back to the step a message belongs to.
 *
 * @param events - the event log, newest last.
 * @returns a function mapping a message to its step key, or undefined.
 */
/**
 * Which steps actually have a summary, read from the log.
 *
 * This is the set that may safely replace a step's raw material. It is derived
 * from the written summaries rather than from the set that guards against
 * duplicate requests, because those differ: a step whose summary request
 * returned nothing is guarded but has no replacement, and hiding its material
 * would drop the step from the conversation entirely.
 *
 * @param events - the event log, newest last.
 * @returns the `"turn/step"` keys that have a summary message.
 */
function summarizedSteps(events) {
  const keys = new Set()
  for (const event of events) {
    if (event?.type !== 'user/message') continue
    const text = (event.data?.content ?? []).map(block => block?.text ?? '').join('')
    if (!text.startsWith(SUMMARY_MARKER)) continue
    const of = event.data?.summaryOf
    if (typeof of?.turn === 'number' && typeof of?.step === 'number') {
      keys.add(`${of.turn}/${of.step}`)
    }
  }
  return keys
}

/**
 * The seqs currently visible on a session's surface, in order.
 *
 * `replace` addresses a span by its first and last surface seq, and the surface
 * is narrower than the log: anything already shadowed by an earlier replace is
 * gone from it. Reading the surface rather than the log is what keeps a
 * replacement addressable.
 *
 * @param session - the session to inspect.
 * @returns surface seqs, or an empty array when the session exposes none.
 */
function surfaceOf(session) {
  const nodes = session?.surface?.nodes
  return Array.isArray(nodes) ? nodes : []
}

/**
 * The surface seq range a step's own material occupies.
 *
 * A step writes two kinds of node. The material it PRODUCED -- its assistant
 * message and the tool calls and results under it -- carries the step's
 * `turn`/`step`. The INPUT it worked from -- the system prompt, the user's task,
 * anything a plugin injected -- carries neither, yet sits between the produced
 * nodes on the surface.
 *
 * Only the produced material is replaced. Taking the span from the first to the
 * last event with this `turn`/`step` swallows the task as well, and then the
 * request no longer contains the thing the agent was asked to do: a recorded run
 * left a model saying "The user has given me a step summary. There's no explicit
 * question."
 *
 * Contiguity is required. The surface allows a `replace` to cover a span, so the
 * produced nodes have to sit together; when an input node is interleaved, the
 * step has no addressable span and is left alone rather than rewritten.
 *
 * @param events - the event log, oldest first.
 * @param turn - turn number.
 * @param step - step number.
 * @param surfaceSeqs - seqs currently on the surface, in order.
 * @returns the span, or undefined when it cannot be replaced safely.
 */
function stepRange(events, turn, step, surfaceSeqs) {
  const onSurface = new Set(surfaceSeqs)
  const bySeq = new Map()
  for (const event of events) bySeq.set(event.seq, event)

  const produced = events.filter(event =>
    event?.data?.turn === turn
    && event?.data?.step === step
    && onSurface.has(event.seq)
    && event.type !== 'system/message')
  if (produced.length === 0) return undefined

  const startSeq = produced[0].seq
  const endSeq = produced[produced.length - 1].seq
  const seqs = surfaceSeqs.filter(seq => seq >= startSeq && seq <= endSeq)

  // Every node in the span must belong to the step. An input node inside it
  // would be destroyed by the replacement, and provenance would not permit
  // citing around it either.
  for (const seq of seqs) {
    const event = bySeq.get(seq)
    const mine = event?.data?.turn === turn && event?.data?.step === step
    if (!mine) return undefined
  }
  return { startSeq, endSeq, seqs }
}

function stepLookup(events) {
  const byId = new Map()
  for (const event of events) {
    const message = event?.data?.message
    if (typeof message?.id !== 'string') continue
    const turn = event.data?.turn
    const step = event.data?.step
    if (typeof turn !== 'number' || typeof step !== 'number') continue
    byId.set(message.id, `${turn}/${step}`)
  }
  return message => (typeof message?.id === 'string' ? byId.get(message.id) : undefined)
}

/**
 * Find the provider/model the session is running on.
 *
 * The agent's own options are authoritative; the logged request header is the
 * fallback, because a resumed session may carry no options object.
 *
 * @param events - the event log.
 * @param agent - the running agent.
 * @returns `{ provider, model }`, or undefined when neither source has them.
 */
function routeOf(events, agent) {
  const options = agent?.options
  if (typeof options?.provider === 'string' && typeof options?.model === 'string') {
    return { provider: options.provider, model: options.model }
  }
  // A summary is a secondary request: it must not invent a route. If the
  // session has not logged one yet there is nothing safe to summarize with,
  // and the caller skips rather than guessing a provider.
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]?.type !== 'request/header') continue
    const config = events[index].data?.header?.config
    if (typeof config?.provider === 'string' && typeof config?.model === 'string') {
      return { provider: config.provider, model: config.model }
    }
  }
  return undefined
}

/**
 * Ask the model to summarize the last step of the current context.
 *
 * The input is the context itself, plus one instruction -- not extracted
 * material. That is deliberate: a summarizer that cannot see the task can only
 * report what the step did ("ran cat on Y"), while one holding the context can
 * say what it established and why it matters ("confirmed X in Y, needed for Z").
 *
 * Failures return an empty string rather than throwing. A summary improves the
 * next step's context; it is never a precondition for it, and a provider that
 * is rate-limited or down must not stop the agent from working.
 *
 * @param llm - the injected llm service.
 * @param config - `{ provider, model }`, matching the session's own route.
 * @param messages - the context to summarize, as it would be sent.
 * @param signal - abort signal from the running step.
 * @returns the summary text, or `''` when none was produced.
 */
async function requestSummary(llm, config, messages, signal) {
  const request = [
    createSystemMessage(summarizePrompt(), name),
    ...messages,
    createUserMessage({ content: [{ type: 'text', text: summarizeInstruction() }] }),
  ]
  // Two contracts have to hold at once here, and each was found the hard way:
  //
  // 1. `prepareCall` resolves the provider's full config and the adapter refuses
  //    any config that changed before dispatch. Spreading the caller's
  //    `{ provider, model }` drops reasoningEffort/maxTokens and is rejected
  //    with "prepared LLM call config changed"; `call.config` is what goes out.
  // 2. Writing a record must not inherit the session's own reasoning effort.
  //    Thinking is process, and its budget comes out of the answer.
  //
  // `off` is asked for first and abandoned when the model rejects it: not every
  // model offers that effort, and the host then errors with UNSUPPORTED_
  // REASONING_EFFORT before dispatch. A real run against a provider without it
  // failed every request while the task itself completed normally, which looks
  // exactly like the mechanism being off. Omitting the field instead lets the
  // host apply the model's own default (`requested ?? reasoning.defaultEffort`).
  const route = { provider: config.provider, model: config.model }
  let call
  try {
    call = await llm.prepareCall({ ...route, reasoningEffort: 'off' }, signal)
  } catch (error) {
    if (error?.code !== 'UNSUPPORTED_REASONING_EFFORT') throw error
    call = await llm.prepareCall(route, signal)
  }
  const stream = call.stream({ ...call.config, messages: request, signal })

  // Assemble with the host's own matcher rather than a hand-rolled one. The
  // stream protocol is `block-start` / `text-delta` / `reasoning-delta` /
  // `block-end` / `usage` / `finish`, and a parser that recognizes only some of
  // those silently yields empty text -- which is exactly how an earlier version
  // discarded every summary it received while reporting a successful request.
  const assembler = new BlockAssembler()
  for await (const chunk of stream) assembler.push(chunk)
  return parseSummary(assembler.blocks())
}


/**
 * Summarize the step that just finished.
 *
 * Runs before the next step's request is built, because its whole purpose is to
 * decide what that request will contain. The context it summarizes is the one
 * already projected -- so earlier steps are present as their summaries and only
 * the last step is still in raw form. That is exactly the shape wanted: each
 * summary sees the accumulated picture plus one step of detail.
 *
 * @param agent - the running agent.
 * @param llm - the injected llm service.
 * @param config - resolved plugin config.
 * @param signal - abort signal from the running step.
 * @returns a promise resolving when the attempt is done; never rejects.
 */
async function summarizeFinishedStep(agent, llm, config, signal) {
  const session = agent?.session
  const log = line => diagnose(config.debug, line)
  if (session === undefined || llm === undefined) return log('skip: no session or no llm')
  if (typeof session.deriveMessages !== 'function') return log('skip: no deriveMessages')

  const events = readEvents(session)
  let target
  for (const event of events) {
    if (event.type === 'step/end') target = event.data
  }
  if (target === undefined) return log('skip: no step/end in log')

  const key = `${target.turn}/${target.step}`
  const route = routeOf(events, agent)
  if (route === undefined) return log(`skip ${key}: no route`)

  const context = session.deriveMessages()
  if (!Array.isArray(context) || context.length === 0) return log(`skip ${key}: empty context`)

  // Claim the step BEFORE spending a request on it.
  //
  // Marking only after a summary arrives makes an empty reply a retry loop:
  // every `agent/pre-step` sees the same unfinished step, asks again, and gets
  // the same empty answer. A measured run produced 32 identical requests, one
  // every seven seconds, and never stopped. The claim is per (turn, step) and
  // per session, so a step is asked about at most once.
  const claimed = session[SUMMARIZED_STEPS] ?? new Set()
  if (claimed.has(key)) return log(`skip ${key}: already claimed`)
  claimed.add(key)
  Object.defineProperty(session, SUMMARIZED_STEPS, { value: claimed, enumerable: false })

  const summary = await requestSummary(llm, route, context, signal)
  if (summary.length === 0) return log(`skip ${key}: empty reply (context=${context.length})`)
  log(`got ${key}: ${summary.length} chars, context=${context.length}`)

  // The summary REPLACES its step on the surface. It is not appended: an
  // appended `user/message` lands at the head of every later turn, so the model
  // reads it as something the user just said and answers it, while the task it
  // was given scrolls away. `replace` is the same operation the host's own
  // compaction performs on a span it has summarized.
  //
  // `user/message` is surface-eligible, so the surfaceOp marker is required --
  // omitting it is rejected with "surface-eligible and requires a surfaceOp
  // marker", and because a summary failure is deliberately non-fatal that error
  // is invisible from outside the harness.
  const surfaceSeqs = surfaceOf(session)
  const range = stepRange(events, target.turn, target.step, surfaceSeqs)
  // Built through the host's own constructor, not as a bare object.
  // `deriveMessages` returns a `user/message`'s `data` verbatim, so a message
  // missing `role`/`id` reaches the provider exactly like that: the request
  // carries a message with no role. The constructor supplies both, plus the
  // frozen shape every other message has.
  const message = {
    ...createUserMessage({
      content: [{ type: 'text', text: renderSummaryMessage(summary) }],
      source: { kind: 'plugin', plugin: name },
    }),
    // Provenance only: it lets a reader tell which step this record covers.
    summaryOf: { turn: target.turn, step: target.step },
  }
  if (range === undefined) {
    // No addressable span. Either the step's events are already off the
    // surface, or an input node (the task, a plugin note) sits between the
    // material it produced. Appending instead would put a `user/message` at the
    // head of every later turn, so the record is dropped and the step's material
    // is left alone -- visible in the diagnostic log rather than silent.
    return log(`skip ${key}: no addressable span`)
  }
  await session.append('user/message', message, {
    surfaceOp: { op: 'replace', startSeq: range.startSeq, endSeq: range.endSeq },
    sourceEventSeqs: range.seqs,
  })
  log(`wrote ${key}: replaced ${range.startSeq}-${range.endSeq} `
    + `(${range.seqs.length} nodes) with ${summary.length} chars`)
}


/**
 * Route every projection of this session through the reasoning strip.
 *
 * `deriveMessages` is the single source of the message list: the request is
 * built from it in `agent-loop`, and the runtime invariant compares the request
 * against it. Wrapping the one method therefore keeps both sides identical --
 * the invariant is not bypassed, it is satisfied by the same value it would
 * have compared against anyway.
 *
 * Deliberately NOT done by overriding `deriveEventMessage`: that pure function
 * is shared by eleven subsystems including the token meter and every
 * request-reconstruction path, and those must keep seeing exactly what was
 * logged. Wrapping the instance's own projection changes only what is sent.
 *
 * Idempotent and non-fatal by construction: a session is wrapped once, and any
 * failure leaves the original method in place rather than breaking the step.
 *
 * @param agent - the running agent.
 * @param config - resolved plugin config.
 */
function installReasoningStrip(agent, config) {
  if (!config.reasoningContract) return
  const session = agent?.session
  if (session === undefined || session === null) return
  if (typeof session.deriveMessages !== 'function') return
  // Marked on the session so a second mount, a resumed session, or a repeated
  // pre-step cannot stack wrappers and strip an already-stripped list.
  if (session[REASONING_STRIPPED] === true) return

  const original = session.deriveMessages.bind(session)
  try {
    // Only reasoning is removed here. A step's material is replaced on the log
    // when its record is written, so filtering it again at projection would
    // remove the same nodes twice -- and the second removal is not confined to
    // the step: it drops every message whose id maps to that step, which
    // includes the system prompt and the user's task.
    session.deriveMessages = () => stripReasoningFrom(original())
    Object.defineProperty(session, REASONING_STRIPPED, { value: true, enumerable: false })
  } catch (error) {
    session.deriveMessages = original
    agent?.logger?.warn?.(
      `[${name}] reasoning strip not installed: ${String(error)}`,
    )
  }
}

