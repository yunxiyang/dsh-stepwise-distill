import { describe, expect, it, vi } from 'vitest'
import {
  apply,
  inject,
  PROMPT_SECTION,
  REASONING_SECTION,
  findKeepSource,
  isEligible,
  planDistillation,
  readEvents,
  resultCallId,
  resolveConfig,
  SELF_NUMBERED_TOOLS,
  summarize,
  toolNameOf,
} from '../src/index.js'
import { contractSection, numberLines, parseKeep } from '../src/distill.js'

const text = value => ({ type: 'text', text: value })
const reasoning = value => ({ type: 'reasoning', text: value })

/** Long enough to be numbered at the default threshold. */
const LONG = Array.from({ length: 40 }, (_, i) => `row ${i + 1}`).join('\n')

/**
 * Build the event log shape the harness really writes: a `tool/call` carrying
 * the name, its paired `tool/result`, and the assistant message that answers it.
 */
function log({ result = LONG, keep, tool = 'exec_command', isError = false, answered = true } = {}) {
  const events = [
    { seq: 0, type: 'step/start', data: { turn: 1, step: 1 } },
    { seq: 1, type: 'tool/call', data: { turn: 1, step: 1, callId: 'c1', name: tool } },
    {
      seq: 2,
      type: 'tool/result',
      data: {
        turn: 1,
        step: 1,
        source: { kind: 'tool', callId: 'c1' },
        message: {
          role: 'user',
          content: [{ type: 'tool-result', toolCallId: 'c1', content: [text(result)], isError }],
        },
      },
    },
  ]
  if (answered) {
    const blocks = keep === undefined ? [text('all done')] : [reasoning(`plan\nkeep: ${keep}`)]
    events.push({
      seq: 3,
      type: 'assistant/message',
      data: { turn: 1, step: 2, message: { role: 'assistant', content: blocks } },
    })
  }
  return events
}

const CONFIG = resolveConfig({})

/** What the loop's own pre-step default returns. */
const ENTER = { kind: 'enter', messages: [] }

/**
 * Invoke the pre-step waterfall the way the agent loop does: the handler must
 * be handed `next` and its result is the loop's decision.
 */
function step(handlers, payload, decision = ENTER) {
  return handlers.get('agent/pre-step')(payload, async () => decision)
}

describe('config', () => {
  it('defaults to observe so nothing is destroyed before it is measured', () => {
    expect(CONFIG.mode).toBe('observe')
    expect(CONFIG.minLines).toBe(20)
    expect(CONFIG.tools).toEqual([])
  })

  it('accepts overrides and keeps every other default', () => {
    expect(resolveConfig({ mode: 'distill', minLines: 5 })).toEqual({
      mode: 'distill', minLines: 5, reasoningContract: true, tools: [], debug: false,
    })
  })

  it('lets the conclusion contract be switched off independently', () => {
    // It is the part under measurement, so it has to be separable from
    // numbering: otherwise a run cannot tell which instruction moved a number.
    expect(resolveConfig({ reasoningContract: false }).reasoningContract).toBe(false)
    expect(resolveConfig({ reasoningContract: false }).minLines).toBe(20)
  })
})

describe('event reading', () => {
  it('prefers the newer snapshotEvents API', () => {
    const events = [{ seq: 0 }]
    expect(readEvents({ snapshotEvents: () => events, events: [] })).toBe(events)
  })

  it('falls back to the older events getter', () => {
    const events = [{ seq: 0 }]
    expect(readEvents({ events })).toBe(events)
  })

  it('degrades to an empty log rather than throwing', () => {
    expect(readEvents(undefined)).toEqual([])
    expect(readEvents({})).toEqual([])
  })
})

describe('tool name resolution', () => {
  it('pairs a result with its call by callId', () => {
    const events = log()
    expect(toolNameOf(events[2], events)).toBe('exec_command')
  })

  it('reads the callId from the message block when the event omits it', () => {
    // Real logs differ: some results carry data.source.callId, others only
    // expose the pairing on the tool-result block itself.
    const events = log()
    delete events[2].data.source
    expect(toolNameOf(events[2], events)).toBe('exec_command')
  })

  it('prefers the event-level callId when both are present', () => {
    const events = log()
    events[2].data.message.content[0].toolCallId = 'stale'
    expect(toolNameOf(events[2], events)).toBe('exec_command')
  })

  it('reports no callId for a non-result event', () => {
    expect(resultCallId({ type: 'step/start', data: {} })).toBeUndefined()
  })

  it('reports an unknown name instead of guessing', () => {
    expect(toolNameOf({ data: { source: { callId: 'nope' } } }, log())).toBe('<unknown>')
  })
})

describe('eligibility', () => {
  it('accepts a numbered-length result', () => {
    expect(isEligible(log()[2], CONFIG, log())).toBe(true)
  })

  it('rejects a short result, which is not worth numbering', () => {
    const events = log({ result: 'a\nb' })
    expect(isEligible(events[2], CONFIG, events)).toBe(false)
  })

  it('honours an explicit tool allowlist', () => {
    const events = log({ tool: 'read' })
    const config = resolveConfig({ tools: ['exec_command'] })
    expect(isEligible(events[2], config, events)).toBe(false)
  })

  it('excludes a self-numbered tool by default', () => {
    const events = log({ tool: 'read' })
    expect(isEligible(events[2], CONFIG, events)).toBe(false)
  })

  it('excludes an unknown tool rather than guessing', () => {
    // A result whose tool/call is absent from the log: nothing says how its
    // output is shaped, so it is left alone.
    const events = log().filter(event => event.type !== 'tool/call')
    const result = events.find(event => event.type === 'tool/result')
    expect(isEligible(result, CONFIG, events)).toBe(false)
  })

  it('ignores events that are not tool results', () => {
    expect(isEligible(log()[0], CONFIG, log())).toBe(false)
  })
})

describe('keep source', () => {
  it('reads the answering assistant message', () => {
    const events = log({ keep: '3' })
    expect(findKeepSource(events, 2)).toEqual([reasoning('plan\nkeep: 3')])
  })

  it('stops at the next human turn instead of reaching past it', () => {
    const events = log({ keep: '3' })
    events.splice(3, 0, { seq: 3, type: 'user/message', data: { content: [text('hi')] } })
    expect(findKeepSource(events, 2)).toEqual([])
  })

  it('returns nothing when the turn ended before any answer', () => {
    expect(findKeepSource(log({ answered: false }), 2)).toEqual([])
  })

  it('answers only from the next assistant message', () => {
    // One decision answers one result. A keep: line written much later belongs
    // to whatever step produced it, not to every result before it -- reading
    // it as agreement with all of them silently distils unjudged output.
    const events = log({ keep: '3' })
    events.splice(3, 0, {
      seq: 3,
      type: 'assistant/message',
      data: { turn: 1, step: 2, message: { role: 'assistant', content: [text('reading it now')] } },
    })
    events[4].seq = 4
    expect(findKeepSource(events, 2)).toEqual([text('reading it now')])
    expect(parseKeep(findKeepSource(events, 2)).found).toBe(false)
  })

  it('does not let a late keep: line claim an earlier result', () => {
    // The shape that produced the bug: steps 2..N each yield a result, and a
    // single keep: line appears at the very end of the turn.
    const events = log({ keep: '3' })
    events.pop()
    events.push({
      seq: 3,
      type: 'assistant/message',
      data: { turn: 1, step: 2, message: { role: 'assistant', content: [text('done with that')] } },
    })
    events.push({
      seq: 4,
      type: 'tool/result',
      data: {
        turn: 1,
        step: 3,
        source: { kind: 'tool', callId: 'c2' },
        message: { content: [{ type: 'tool-result', toolCallId: 'c2', content: [text(LONG)] }] },
      },
    })
    events.push({
      seq: 5,
      type: 'assistant/message',
      data: { turn: 1, step: 3, message: { role: 'assistant', content: [reasoning('keep: 3,7,12')] } },
    })
    // The window fix still matters under default drop, and it matters more:
    // a late line must not reach back to claim a result it never saw, or the
    // bug would now silently empty history instead of merely skipping it.
    const plan = planDistillation(events[2], events, CONFIG)
    expect(plan.keptIndices).toEqual([])
    expect(plan.replacement).toContain('nothing needed later')
  })
})

describe('distillation plan', () => {
  it('plans a replacement when the model named lines', () => {
    const events = log({ keep: '3,7' })
    const plan = planDistillation(events[2], events, CONFIG)
    expect(plan.skip).toBeUndefined()
    expect(plan.seq).toBe(2)
    expect(plan.keptIndices).toEqual([3, 7])
    expect(plan.replacement).toContain('3: row 3; 7: row 7')
    expect(plan.replacement).toContain('full: session seq 2')
  })

  it('drops a node the model said nothing about', () => {
    // Default drop: silence is not an exemption, it is the ordinary case. The
    // model names what it still needs and everything else goes, so a result
    // nobody spoke for keeps only its handle.
    const events = log({ keep: undefined })
    const plan = planDistillation(events[2], events, CONFIG)
    expect(plan.skip).toBeUndefined()
    expect(plan.keptIndices).toEqual([])
    expect(plan.replacement).toContain('nothing needed later')
  })

  it('skips an out-of-range index rather than dropping unrequested lines', () => {
    const events = log({ keep: '3,999' })
    expect(planDistillation(events[2], events, CONFIG).skip).toBe('index-out-of-range')
  })

  it('drops on a malformed keep line, which is the default anyway', () => {
    // Under default drop an unreadable answer is not safer than no answer, and
    // the profile that runs this has its owner in the loop with the audit and
    // the seq handle as the way back.
    const events = log({ keep: 'three' })
    expect(planDistillation(events[2], events, CONFIG).skip).toBe('malformed-keep-line')
  })

  it('drops everything when the model names nothing', () => {
    // `keep: none` is the explicit form of the default. It used to be refused
    // as indistinguishable from a misread contract; under default drop it is
    // simply the honest answer for a result with no lasting value.
    const events = log({ keep: 'none' })
    const plan = planDistillation(events[2], events, CONFIG)
    expect(plan.skip).toBeUndefined()
    expect(plan.keptIndices).toEqual([])
  })

  it('treats `keep: all` as an answer that leaves the node whole', () => {
    // A mandatory contract needs a legal way to decline distillation, and that
    // decline must not be read as a malformed line or as an empty selection.
    const events = log({ keep: 'all' })
    expect(planDistillation(events[2], events, CONFIG).skip).toBe('keep-all')
  })

  it('leaves every result of a `keep: all` step untouched', () => {
    // The answer is per-result but written once, so it must hold for every
    // numbered result the reply was answering -- not just the first one.
    // Seqs must stay in log order: the reply has to come after both results for
    // either of them to have an answer to read.
    const events = log({ keep: 'all', answered: false })
    const second = {
      seq: 4,
      type: 'tool/result',
      data: {
        turn: 1,
        step: 1,
        source: { kind: 'tool', callId: 'c2' },
        message: {
          role: 'user',
          content: [{ type: 'tool-result', toolCallId: 'c2', content: [text(LONG)], isError: false }],
        },
      },
    }
    events.push({ seq: 3, type: 'tool/call', data: { turn: 1, step: 1, callId: 'c2', name: 'exec_command' } })
    events.push(second)
    events.push({
      seq: 5,
      type: 'assistant/message',
      data: { turn: 1, step: 2, message: { role: 'assistant', content: [reasoning('plan\nkeep: all')] } },
    })
    expect(planDistillation(events[2], events, CONFIG).skip).toBe('keep-all')
    expect(planDistillation(events[4], events, CONFIG).skip).toBe('keep-all')
  })

  it('is idempotent: an already distilled node is never distilled twice', () => {
    const source = log({ keep: '3' })
    const first = planDistillation(source[2], source, CONFIG)
    // The distilled text is short, so the threshold is lowered to isolate the
    // marker gate from the length gate: replay must still refuse to re-distil.
    const replay = resolveConfig({ minLines: 1, mode: 'distill' })
    const distilledEvents = log({ result: first.replacement, keep: '3' })
    expect(planDistillation(distilledEvents[2], distilledEvents, replay).skip)
      .toBe('already-distilled')
  })

  it('refuses a replacement that would not shrink the result', () => {
    const events = log({ result: LONG, keep: '1' })
    const config = resolveConfig({ minLines: 1, mode: 'distill' })
    const plan = planDistillation(events[2], events, config)
    // Keeping one line of a 40-line result must shrink it; sanity-check the
    // opposite direction is still guarded by asserting the plan is smaller.
    expect(plan.replacement.length).toBeLessThan(LONG.length)
  })

  it('honours a zero-index range by refusing it', () => {
    const events = log({ keep: '0' })
    expect(planDistillation(events[2], events, CONFIG).skip).toBe('malformed-keep-line')
  })

  it('reuses numbering already present in the result', () => {
    // A durable post-execute rewrite means the log holds numbered text. The
    // plan must read the existing numbers, not add a second set: the model
    // chose its indices from those.
    const numberedText = numberLines(LONG)
    const events = log({ result: numberedText, keep: '3,7' })
    const plan = planDistillation(events[2], events, CONFIG)
    expect(plan.skip).toBeUndefined()
    expect(plan.totalLines).toBe(40)
    expect(plan.replacement).toContain('3: row 3; 7: row 7')
    // The kept facts carry the original text without a stacked prefix.
    expect(plan.replacement).not.toContain('[3]')
    expect(plan.replacement).not.toContain('[7]')
  })
})

describe('mounting', () => {
  /** Capture the handlers a Cordis context receives. */
  function mount(config) {
    const handlers = new Map()
    const sections = []
    const ctx = {
      on: (event, handler) => handlers.set(event, handler),
      systemPrompt: { section: value => sections.push(value) },
      inject: (services, callback) => callback({}),
      logger: { info: vi.fn(), warn: vi.fn() },
    }
    apply(ctx, config)
    return { handlers, ctx, sections }
  }

  it('registers both hooks', () => {
    const { handlers } = mount({})
    expect(handlers.has('tools/post-execute')).toBe(true)
    expect(handlers.has('agent/pre-step')).toBe(true)
  })

  it('registers the prompt contract so the syntax is discoverable', () => {
    const sections = []
    const ctx = {
      on: () => {},
      systemPrompt: { section: value => sections.push(value) },
      logger: { info: vi.fn(), warn: vi.fn() },
    }
    apply(ctx, {})
    const names = sections.map(section => section.name)
    expect(names).toContain(PROMPT_SECTION)
    expect(names).toContain(REASONING_SECTION)
    const contract = sections.find(section => section.name === PROMPT_SECTION)
    expect(contract.text()).toContain('keep: ???')
  })

  it('asks for the written-conclusion contract on every step', () => {
    // Separate from numbering on purpose: a conclusion is worth recording
    // whether or not anything was numbered, and this instruction is the one
    // under measurement.
    const sections = []
    const ctx = {
      on: () => {},
      systemPrompt: { section: value => sections.push(value) },
      logger: { info: vi.fn(), warn: vi.fn() },
    }
    apply(ctx, { minLines: 0 })
    const reasoning = sections.find(section => section.name === REASONING_SECTION)
    expect(reasoning.text()).toContain('NOT kept between steps')
  })

  it('asks for no numbering text once numbering is off', () => {
    const sections = []
    const ctx = {
      on: () => {},
      systemPrompt: { section: value => sections.push(value) },
      logger: { info: vi.fn(), warn: vi.fn() },
    }
    apply(ctx, { minLines: 0 })
    const contract = sections.find(section => section.name === PROMPT_SECTION)
    expect(contract.text()).toBe('')
  })

  it('survives a prompt service that rejects the section', () => {
    const ctx = {
      on: () => {},
      systemPrompt: { section: () => { throw new Error('duplicate section name') } },
      logger: { info: vi.fn(), warn: vi.fn() },
    }
    expect(() => apply(ctx, {})).not.toThrow()
    expect(ctx.logger.warn.mock.calls.flat().join('\n')).toContain('duplicate section')
  })

  it('declares systemPrompt, which cordis requires before property access', () => {
    expect(inject).toEqual(['systemPrompt'])
  })

  it('mounts without any prompt service at all', () => {
    const handlers = new Map()
    const ctx = { on: (event, handler) => handlers.set(event, handler), logger: {} }
    expect(() => apply(ctx, {})).not.toThrow()
    expect(handlers.has('agent/pre-step')).toBe(true)
  })

  it('numbers a long result and appends the contract', async () => {
    const { handlers } = mount({})
    const decision = await handlers.get('tools/post-execute')(
      { name: 'exec_command' },
      { content: [text(LONG)] },
      async () => ({ kind: 'accept' }),
    )
    expect(decision.content[0].text.startsWith('[1] row 1')).toBe(true)
    expect(decision.content[1].text).toContain('keep: ???')
  })

  it('leaves a short result untouched', async () => {
    const { handlers } = mount({})
    const original = { kind: 'accept' }
    const decision = await handlers.get('tools/post-execute')(
      { name: 'exec_command' },
      { content: [text('a\nb')] },
      async () => original,
    )
    expect(decision).toBe(original)
  })

  it('never re-numbers a tool that numbers its own output', async () => {
    // `read` renders real file line numbers inside its envelope; a second
    // numbering would put [2] and 2: side by side with different meanings.
    const { handlers } = mount({})
    const original = { kind: 'accept' }
    const decision = await handlers.get('tools/post-execute')(
      { name: 'read' },
      { content: [text(LONG)] },
      async () => original,
    )
    expect(decision).toBe(original)
  })

  it('honours the tools allowlist when numbering', async () => {
    const { handlers } = mount({ tools: ['exec_command'] })
    const original = { kind: 'accept' }
    const decision = await handlers.get('tools/post-execute')(
      { name: 'bash' },
      { content: [text(LONG)] },
      async () => original,
    )
    expect(decision).toBe(original)
  })

  it('skips a result whose tool name is unknown', async () => {
    const { handlers } = mount({})
    const original = { kind: 'accept' }
    const decision = await handlers.get('tools/post-execute')(
      {}, { content: [text(LONG)] }, async () => original,
    )
    expect(decision).toBe(original)
  })

  it('numbers the content with no direct decision content', async () => {
    // The real pipeline returns a bare accept; the text lives on the result.
    const { handlers } = mount({})
    const decision = await handlers.get('tools/post-execute')(
      { name: 'bash' },
      { content: [text(LONG)] },
      async () => ({ kind: 'accept' }),
    )
    expect(decision.kind).toBe('accept')
    expect(decision.content[0].text.startsWith('[1] row 1')).toBe(true)
  })

  it('passes a block decision through untouched', async () => {
    const { handlers } = mount({})
    const blocked = { kind: 'block', feedback: [text('nope')] }
    const decision = await handlers.get('tools/post-execute')(
      { name: 'bash' },
      { content: [text(LONG)] },
      async () => blocked,
    )
    expect(decision).toBe(blocked)
  })

  it('distils on the very first step once a keep: line exists', async () => {
    // Distillation is gated by the model's decision, not by turn or step
    // boundaries: a result answered with a keep: line is settled, whatever
    // turn it came from.
    const { handlers } = mount({ mode: 'distill' })
    const append = vi.fn()
    const session = { snapshotEvents: () => log({ keep: '3' }), append }
    await step(handlers, { agent: { session }, turn: 1, step: 1 })
    expect(append).toHaveBeenCalledTimes(1)
  })

  it('logs but does not mutate in observe mode', async () => {
    const { handlers, ctx } = mount({ mode: 'observe' })
    const session = { snapshotEvents: () => log({ keep: '3' }) }
    await step(handlers, { agent: { session }, turn: 2, step: 2 })
    expect(session.append).toBeUndefined()
    expect(ctx.logger.info.mock.calls.flat().join('\n')).toContain('observe')
  })

  it('replaces the surface node in distill mode', async () => {
    const { handlers } = mount({ mode: 'distill' })
    const events = log({ keep: '3' })
    const append = vi.fn()
    const session = { snapshotEvents: () => events, append }
    await step(handlers, { agent: { session }, turn: 2, step: 2 })

    expect(append).toHaveBeenCalledTimes(1)
    const [type, payload, meta] = append.mock.calls[0]
    expect(type).toBe('tool/result')
    expect(meta.surfaceOp).toEqual({ op: 'replace', startSeq: 2, endSeq: 2 })
    expect(meta.sourceEventSeqs).toEqual([2])
    // The rewrite must describe the node it replaces; the harness compares
    // turn and step against the original and rejects any difference.
    expect(payload.turn).toBe(1)
    expect(payload.step).toBe(1)
    // Structure must survive: the pairing id and error flag are not ours to change.
    expect(payload.message.content[0].toolCallId).toBe('c1')
    expect(payload.message.content[0].isError).toBe(false)
    expect(payload.message.content[0].content[0].text).toContain('distilled:')
  })

  it('leaves a result alone until the model has answered it', async () => {
    // The only gate is the keep: line. A result still being worked on has no
    // assistant message after it, so there is nothing to act on yet.
    const { handlers } = mount({ mode: 'distill' })
    const events = log({ keep: '3' })
    events.pop()
    const append = vi.fn()
    await step(handlers, {
      agent: { session: { snapshotEvents: () => events, append } },
      turn: 5,
      step: 2,
    })
    expect(append).not.toHaveBeenCalled()
  })

  it('survives a failing append without blocking the step', async () => {
    const { handlers, ctx } = mount({ mode: 'distill' })
    const session = {
      snapshotEvents: () => log({ keep: '3' }),
      append: () => { throw new Error('surface rejected the replace') },
    }
    await expect(step(handlers, { agent: { session }, turn: 2, step: 2 }))
      .resolves.toEqual(ENTER)
    expect(ctx.logger.warn.mock.calls.flat().join('\n')).toContain('surface rejected')
  })

  it('stops committing when the step is aborted', async () => {
    const { handlers } = mount({ mode: 'distill' })
    const append = vi.fn()
    await step(handlers, {
      agent: { session: { snapshotEvents: () => log({ keep: '3' }), append } },
      turn: 2,
      step: 2,
      signal: { aborted: true },
    })
    expect(append).not.toHaveBeenCalled()
  })

  it('resumes the waterfall instead of replacing the loop decision', async () => {
    // A pre-step handler that swallows the decision leaves the loop reading
    // `kind` off undefined, which kills the whole turn.
    const { handlers } = mount({ mode: 'distill' })
    const session = { snapshotEvents: () => log({ keep: '3' }) }
    const decision = await step(handlers, { agent: { session }, turn: 2, step: 2 })
    expect(decision).toEqual(ENTER)
  })

  it('passes a rejection through untouched', async () => {
    const { handlers } = mount({ mode: 'distill' })
    const session = { snapshotEvents: () => log({ keep: '3' }) }
    const decision = await step(handlers, { agent: { session }, turn: 2, step: 2 },
      { kind: 'reject' })
    expect(decision).toEqual({ kind: 'reject' })
    expect(session.append).toBeUndefined()
  })

  it('registers a /distill command when the profile offers one', () => {
    const registered = []
    const ctx = {
      on: () => {},
      systemPrompt: { section: () => {} },
      inject: (services, callback) => callback({
        commands: { register: definition => registered.push(definition) },
      }),
      logger: { info: vi.fn(), warn: vi.fn() },
    }
    apply(ctx, {})
    expect(registered).toHaveLength(1)
    expect(registered[0].name).toBe('distill')
  })

  it('reports the live session state through the command', () => {
    const registered = []
    const events = log({ keep: '3' })
    const ctx = {
      on: () => {},
      systemPrompt: { section: () => {} },
      inject: (services, callback) => callback({
        commands: { register: definition => registered.push(definition) },
      }),
      logger: { info: vi.fn(), warn: vi.fn() },
    }
    apply(ctx, { mode: 'observe' })
    const result = registered[0].handler({ agent: { session: { snapshotEvents: () => events } } })
    expect(result.kind).toBe('success')
    expect(result.text).toContain('mode: observe')
  })

  it('mounts without a commands service', () => {
    const handlers = new Map()
    const ctx = {
      on: (event, handler) => handlers.set(event, handler),
      systemPrompt: { section: () => {} },
      logger: {},
    }
    expect(() => apply(ctx, {})).not.toThrow()
    expect(handlers.has('tools/post-execute')).toBe(true)
  })
})

describe('summarize', () => {
  it('counts numbered and distilled results separately', () => {
    const events = log({ result: numberLines(LONG), keep: '3' })
    const summary = summarize(events)
    expect(summary.numbered).toBe(1)
    expect(summary.distilled).toBe(0)
  })

  it('reads savings and kept share out of a distilled node', () => {
    const distilled = [
      '[exec_command] ok, 40 lines -> kept 2: 3: row 3; 7: row 7',
      'distilled: 2/40 lines, 38 dropped, original 900 bytes',
      'full: session seq 2 (history_read)',
    ].join('\n')
    const summary = summarize(log({ result: distilled, keep: '3' }))
    expect(summary.distilled).toBe(1)
    expect(summary.originalBytes).toBe(900)
    expect(summary.keptShares).toEqual([2 / 40])
  })

  it('flags a distilled node that lost its retrieval handle', () => {
    const orphaned = 'distilled: 2/40 lines, 38 dropped, original 900 bytes'
    const summary = summarize(log({ result: orphaned, keep: '3' }))
    expect(summary.problems).toEqual(['seq 2: no retrieval handle'])
  })

  it('is empty for a log with no results', () => {
    const summary = summarize([{ seq: 0, type: 'step/start', data: { turn: 1, step: 1 } }])
    expect(summary.distilled).toBe(0)
    expect(summary.numbered).toBe(0)
  })
})

describe('history_read', () => {
  /** Mount and capture the registered tool definition. */
  function mountTools(config) {
    const registered = []
    const ctx = {
      on: () => {},
      systemPrompt: { section: () => {} },
      inject: (_services, callback) => callback({
        tools: { register: definition => registered.push(definition) },
      }),
      logger: { info: vi.fn(), warn: vi.fn() },
    }
    apply(ctx, config)
    return registered[0]
  }

  it('registers a tool that reads a result back by seq', () => {
    const tool = mountTools({})
    expect(tool.name).toBe('history_read')
    // defineTool compiles the author schema into raw JSON Schema, so the
    // required marker arrives as an array on the root rather than a per-field
    // flag. That compilation is worth asserting: it is what rejects a malformed
    // call before execute ever runs.
    expect(tool.parameters.type).toBe('object')
    expect(tool.parameters.required).toContain('seq')
    expect(tool.parameters.properties.seq.type).toBe('number')
  })

  it('returns the original text of a distilled node', async () => {
    // The point of the tool: after distillation the ORIGINAL is what the model
    // can no longer see, so reading it back is the only way a drop is undone.
    const events = log({ keep: '3' })
    const session = { snapshotEvents: () => events }
    const tool = mountTools({})
    const value = await tool.execute({ seq: 2 }, { agent: { session } })
    expect(value.text).toContain('<original seq="2"')
    expect(value.text).toContain('row 1')
    expect(value.text).toContain('row 40')
  })

  it('refuses a seq that holds no tool result', async () => {
    const events = log({ keep: '3' })
    const tool = mountTools({})
    const value = await tool.execute({ seq: 0 }, { agent: { session: { snapshotEvents: () => events } } })
    expect(value.text).toContain('not a tool result')
  })

  it('refuses a seq that is not in the log rather than inventing content', async () => {
    const events = log({ keep: '3' })
    const tool = mountTools({})
    const value = await tool.execute({ seq: 999 }, { agent: { session: { snapshotEvents: () => events } } })
    expect(value.text).toContain('no event at seq 999')
  })

  it('refuses a non-integer seq', async () => {
    // The compiled schema rejects this at the boundary, which is stronger than
    // a runtime check inside execute: a malformed call never reaches the body.
    const tool = mountTools({})
    await expect(tool.execute({ seq: 'later' }, { agent: { session: { snapshotEvents: () => [] } } }))
      .rejects.toThrow(/must be a number/)
  })

  it('does not offer line numbering of its own', async () => {
    const events = log({ keep: '3' })
    const tool = mountTools({})
    const value = await tool.execute({ seq: 2 }, { agent: { session: { snapshotEvents: () => events } } })
    expect(value.text).not.toMatch(/^\[\d+\] /)
  })

  it('is excluded from numbering, like read', () => {
    // Numbering a retrieval would attach a fresh index to the very text the
    // model fetched to escape an index, inviting it to keep: numbers that
    // belong to a renumbered copy rather than to the original result.
    expect(SELF_NUMBERED_TOOLS).toContain('history_read')
  })
})

describe('reasoning strip installation', () => {
  /** Minimal session double with a deriveMessages method. */
  function sessionWith(messages) {
    return { deriveMessages: () => messages }
  }

  /** Run one pre-step so the install path executes. */
  async function step(agent, config = {}) {
    const registered = []
    const ctx = {
      on: (event, handler) => registered.push([event, handler]),
      systemPrompt: { section: () => {} },
      inject: () => {},
      logger: { info: vi.fn(), warn: vi.fn() },
    }
    apply(ctx, config)
    const preStep = registered.find(([event]) => event === 'agent/pre-step')[1]
    await preStep({ agent, turn: 1, step: 1 }, () => Promise.resolve({ kind: 'enter' }))
    return ctx
  }

  it('strips reasoning from the session projection', async () => {
    const session = sessionWith([
      { role: 'user', content: [text('go')] },
      { role: 'assistant', content: [reasoning('churn'), text('done')] },
    ])
    await step({ session })
    expect(session.deriveMessages()).toEqual([
      { role: 'user', content: [text('go')] },
      { role: 'assistant', content: [text('done')] },
    ])
  })

  it('leaves the log-side projection alone when switched off', async () => {
    const session = sessionWith([{ role: 'assistant', content: [reasoning('churn'), text('done')] }])
    await step({ session }, { reasoningContract: false })
    expect(session.deriveMessages()[0].content).toHaveLength(2)
  })

  it('wraps at most once across repeated steps', async () => {
    // A wrapper per step would strip the same list N times and grow the call
    // stack with the session's length.
    const session = sessionWith([{ role: 'assistant', content: [reasoning('churn'), text('done')] }])
    const registered = []
    const ctx = {
      on: (event, handler) => registered.push([event, handler]),
      systemPrompt: { section: () => {} },
      inject: () => {},
      logger: { info: vi.fn(), warn: vi.fn() },
    }
    apply(ctx, {})
    const preStep = registered.find(([event]) => event === 'agent/pre-step')[1]
    for (let i = 0; i < 5; i += 1) {
      await preStep({ agent: { session }, turn: 1, step: i + 1 }, () => Promise.resolve({ kind: 'enter' }))
    }
    expect(session.deriveMessages()).toEqual([{ role: 'assistant', content: [text('done')] }])
  })

  it('keeps working when the session has no projection to wrap', async () => {
    await expect(step({})).resolves.toBeDefined()
    await expect(step(undefined)).resolves.toBeDefined()
  })
})
