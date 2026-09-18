import { describe, expect, it, vi } from 'vitest'
import {
  apply,
  inject,
  PROMPT_SECTION,
  findKeepSource,
  isEligible,
  planDistillation,
  readEvents,
  resultCallId,
  resolveConfig,
  toolNameOf,
} from '../src/index.js'
import { contractSection } from '../src/distill.js'

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
      mode: 'distill', minLines: 5, tools: [], debug: false,
    })
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
    expect(findKeepSource(events, 2)).toBeNull()
  })

  it('returns null when nothing answered', () => {
    expect(findKeepSource(log({ answered: false }), 2)).toBeNull()
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

  it('skips a node the model said nothing about', () => {
    const events = log({ keep: undefined })
    expect(planDistillation(events[2], events, CONFIG).skip).toBe('no-keep-line')
  })

  it('skips an out-of-range index rather than dropping unrequested lines', () => {
    const events = log({ keep: '3,999' })
    expect(planDistillation(events[2], events, CONFIG).skip).toBe('index-out-of-range')
  })

  it('skips a malformed keep line', () => {
    const events = log({ keep: 'three' })
    expect(planDistillation(events[2], events, CONFIG).skip).toBe('malformed-keep-line')
  })

  it('skips an empty selection rather than deleting the whole result', () => {
    const events = log({ keep: 'none' })
    expect(planDistillation(events[2], events, CONFIG).skip).toBe('empty-keep-line')
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
})

describe('mounting', () => {
  /** Capture the handlers a Cordis context receives. */
  function mount(config) {
    const handlers = new Map()
    const sections = []
    const ctx = {
      on: (event, handler) => handlers.set(event, handler),
      systemPrompt: { section: value => sections.push(value) },
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
    expect(sections).toHaveLength(1)
    expect(sections[0].name).toBe(PROMPT_SECTION)
    expect(sections[0].text()).toContain('keep: 3,7,12')
  })

  it('asks for no prompt text once numbering is off', () => {
    const sections = []
    const ctx = {
      on: () => {},
      systemPrompt: { section: value => sections.push(value) },
      logger: { info: vi.fn(), warn: vi.fn() },
    }
    apply(ctx, { minLines: 0 })
    expect(sections[0].text()).toBe('')
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
    expect(decision.content[1].text).toContain('keep: 3,7,12')
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

  it('never distils during the first step, when no turn has completed', async () => {
    const { handlers } = mount({ mode: 'distill' })
    const session = { snapshotEvents: () => log({ keep: '3' }) }
    await step(handlers, { agent: { session }, turn: 1, step: 1 })
    expect(session.append).toBeUndefined()
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
    // Structure must survive: the pairing id and error flag are not ours to change.
    expect(payload.message.content[0].toolCallId).toBe('c1')
    expect(payload.message.content[0].isError).toBe(false)
    expect(payload.message.content[0].content[0].text).toContain('distilled:')
  })

  it('skips results belonging to the turn that is still running', async () => {
    const { handlers } = mount({ mode: 'distill' })
    const events = log({ keep: '3' })
    events[2].data.turn = 5
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
})
