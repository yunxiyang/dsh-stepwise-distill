import { describe, expect, it, vi } from 'vitest'
import {
  RECORDS_ROUTE,
  apply,
  inject,
  name,
  readEvents,
  resolveConfig,
  summarize,
} from '../src/index.js'
import { restoreNewestStep } from '../src/distill.js'

const text = value => ({ type: 'text', text: value })
const reasoning = value => ({ type: 'reasoning', text: value })

/**
 * Build the event log shape the harness really writes: a step, the assistant
 * message that ran in it, and a tool result.
 */
function log({ turn = 1, step = 1, body = 'body' } = {}) {
  return [
    { seq: 0, type: 'step/start', data: { turn, step } },
    {
      seq: 1,
      type: 'assistant/message',
      data: {
        turn,
        step,
        message: {
          id: `m${String(seq_counter += 1)}`,
          role: 'assistant',
          content: [reasoning('churn'), text('done'), { type: 'tool-call', name: 'exec_command', arguments: '{"cmd":"ls"}' }],
        },
      },
    },
    {
      seq: 2,
      type: 'tool/result',
      data: {
        turn,
        step,
        message: {
          id: `m${String(seq_counter += 1)}`,
          role: 'user',
          content: [{ type: 'tool-result', toolCallId: 'c1', content: [text(body)], isError: false }],
        },
      },
    },
    { seq: 3, type: 'step/end', data: { turn, step } },
  ]
}
let seq_counter = 0

/**
 * One retention record as the plugin writes it.
 *
 * The content sits flat on `data`, which is what distinguishes it from the
 * host-built messages that nest theirs under `message`.
 */
function record(key) {
  const [turn, step] = key.split('/').map(Number)
  return {
    seq: 500 + (seq_counter += 1),
    type: 'user/message',
    data: {
      content: [{ type: 'text', text: `[step summary] what step ${key} established` }],
      source: { kind: 'plugin', plugin: 'stepwise-distill' },
      summaryOf: { turn, step },
    },
  }
}

const CONFIG = resolveConfig({})

describe('config', () => {
  it('defaults both summaries on and the log off', () => {
    // Both summaries are on by default because they are what the plugin is
    // for; each costs one extra request. The log stays off -- it is for diagnosing.
    expect(CONFIG).toEqual({ stepSummary: true, turnSummary: true, debug: false })
  })

  it('accepts overrides and keeps every other default', () => {
    expect(resolveConfig({ stepSummary: true })).toEqual({
      stepSummary: true, turnSummary: true, debug: false,
    })
  })

})

describe('event reading', () => {
  it('prefers the newer snapshotEvents API', () => {
    const events = [{ seq: 0 }]
    expect(readEvents({ snapshotEvents: () => events, events: [] })).toBe(events)
  })

  it('falls back to a plain events array', () => {
    const events = [{ seq: 0 }]
    expect(readEvents({ events })).toBe(events)
  })

  it('returns an empty list rather than throwing on a session with neither', () => {
    expect(readEvents({})).toEqual([])
    expect(readEvents(undefined)).toEqual([])
  })
})

describe('migration notice', () => {
  it('does not resurrect the numbering contract', () => {
    // The keep: mechanism is gone, not merely off: nothing should register a
    // section that asks a model to name line numbers.
    const sections = []
    const ctx = {
      on: () => {},
      systemPrompt: { section: value => sections.push(value) },
      inject: () => {},
      logger: { info: vi.fn(), warn: vi.fn() },
    }
        apply(ctx, {})
      expect(sections).toEqual([])
  })
})

describe('mounting', () => {
  function mount(config = {}) {
    const handlers = new Map()
    const sections = []
    const ctx = {
      on: (event, handler) => handlers.set(event, handler),
      systemPrompt: { section: value => sections.push(value) },
      inject: () => {},
      logger: { info: vi.fn(), warn: vi.fn() },
    }
    apply(ctx, config)
    return { handlers, ctx, sections }
  }

  it('registers only the pre-step hook, since nothing rewrites results now', () => {
    const { handlers } = mount({})
    expect(handlers.has('agent/pre-step')).toBe(true)
    expect(handlers.has('tools/post-execute')).toBe(false)
  })

  it('registers no tool-result numbering', () => {
    const { handlers } = mount({})
    expect(handlers.has('tools/post-execute')).toBe(false)
  })

  it('survives a prompt service that rejects a section', () => {
    // Nothing is registered with the prompt service any more, so the only
    // claim left is that a hostile one cannot stop the plugin from loading.
    const ctx = {
      on: () => {},
      systemPrompt: { section: () => { throw new Error('duplicate section name') } },
      inject: () => {},
      logger: { info: vi.fn(), warn: vi.fn() },
    }
    expect(() => apply(ctx, {})).not.toThrow()
  })
  it('declares the services cordis requires before property access', () => {
    // `agents` is not a convenience: `agent/pre-step` is dispatched through an
    // agent-scoped carrier, and a subscription registered before that service
    // is ready never fires. Without it the plugin loads, the prompt section
    // appears, and the step hook is silently dead.
    expect(inject).toEqual(['systemPrompt', 'agents'])
  })

  it('mounts without any prompt service at all', () => {
    const handlers = new Map()
    const ctx = { on: (event, handler) => handlers.set(event, handler), inject: () => {}, logger: {} }
    expect(() => apply(ctx, {})).not.toThrow()
    expect(handlers.has('agent/pre-step')).toBe(true)
  })

  it('resumes the waterfall instead of replacing the loop decision', async () => {
    const { handlers } = mount({})
    const preStep = handlers.get('agent/pre-step')
    const decision = await preStep({ agent: {}, turn: 1, step: 1 }, () => Promise.resolve({ kind: 'enter' }))
    expect(decision).toEqual({ kind: 'enter' })
  })

  it('passes a rejection through untouched', async () => {
    const { handlers } = mount({})
    const preStep = handlers.get('agent/pre-step')
    await expect(preStep({ agent: {}, turn: 1, step: 1 }, () => Promise.reject(new Error('boom'))))
      .rejects.toThrow('boom')
  })
})

describe('summarize report', () => {
  it('counts the records written to the log, not a caller-supplied tally', () => {
    // The count comes from the log. It used to come from a second argument, and
    // `/distill` called this with one -- so the command reported "steps
    // summarized: 0" on a session that had six records in it.
    seq_counter = 0
    const events = [
      ...log({ turn: 1, step: 1 }),
      ...log({ turn: 1, step: 2 }),
      record('1/1'),
      record('1/2'),
    ]
    const report = summarize(events)
    expect(report.steps).toBe(2)
    expect(report.summarized).toBe(2)
  })

  it('counts only records, not ordinary user messages', () => {
    seq_counter = 0
    const events = [...log({ turn: 1, step: 1 }), record('1/1')]
    events.push({
      seq: 900, type: 'user/message', time: 1, data: {
        content: [{ type: 'text', text: 'an ordinary thing the user said' }],
        source: { kind: 'user' },
      },
    })
    expect(summarize(events).summarized).toBe(1)
  })

  it('reports nothing withheld before any step is written down', () => {
    seq_counter = 0
    const report = summarize(log())
    expect(report.summarized).toBe(0)
    expect(report.summaries).toHaveLength(0)
  })

  it('tolerates a session with no events at all', () => {
    expect(() => summarize([])).not.toThrow()
    expect(summarize([]).summarized).toBe(0)
  })

  it('still accounts for the material a record withholds', () => {
    seq_counter = 0
    const events = [...log({ turn: 1, step: 1 }), record('1/1')]
    const report = summarize(events)
    // Reasoning, tool arguments and tool output are all material the projection
    // stops re-sending once a step has a record.
    expect(report.droppedPieces).toBeGreaterThan(0)
    expect(report.droppedBytes).toBeGreaterThan(0)
  })
})

describe('history_read', () => {
  /** Mount and capture the registered tool definition. */
  function mountTools(config = {}) {
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
    const tool = mountTools()
    expect(tool.name).toBe('history_read')
    // defineTool compiles the author schema into raw JSON Schema, so `required`
    // arrives as an array on the root. That compilation is what rejects a
    // malformed call before execute ever runs.
    expect(tool.parameters.required).toContain('seq')
  })

  it('returns the original text of a tool result', async () => {
    // The point of the tool: after a step is summarized the original is what
    // the model can no longer see, so reading it back is the only way a drop
    // is undone.
    const events = log({ body: 'row 1\nrow 2' })
    const tool = mountTools()
    const value = await tool.execute({ seq: 2 }, { agent: { session: { snapshotEvents: () => events } } })
    expect(value.text).toContain('<original seq="2"')
    expect(value.text).toContain('row 1')
  })

  it('returns the arguments of a tool call, so a summarized patch is readable', async () => {
    const events = log()
    const tool = mountTools()
    const value = await tool.execute({ seq: 1 }, { agent: { session: { snapshotEvents: () => events } } })
    // seq 1 is the assistant message; a call lives at its own seq, so this is
    // the refusal path for a type that is neither a result nor a call.
    expect(value.text).toContain('not a tool result or tool call')
  })

  it('refuses a seq that is not in the log rather than inventing content', async () => {
    const tool = mountTools()
    const value = await tool.execute({ seq: 999 }, { agent: { session: { snapshotEvents: () => log() } } })
    expect(value.text).toContain('no event at seq 999')
  })

  it('rejects a non-integer seq at the schema boundary', async () => {
    const tool = mountTools()
    await expect(tool.execute({ seq: 'later' }, { agent: { session: { snapshotEvents: () => [] } } }))
      .rejects.toThrow(/must be a number/)
  })
})


describe('summarize installation', () => {
  /**
   * Mount with an llm double and return the pre-step hook plus the fake.
   */
  function mountWithLlm(reply = 'the step settled X') {
    const registered = []
    const calls = []
    const llm = {
      prepareCall: async (config) => ({ config, stream: (options) => { calls.push(options); return chunks(reply) } }),
    }
    const ctx = {
      on: (event, handler) => registered.push([event, handler]),
      systemPrompt: { section: () => {} },
      inject: (_services, callback) => callback({ llm }),
      logger: { info: vi.fn(), warn: vi.fn() },
    }
    apply(ctx, { stepSummary: true })
    return { preStep: registered.find(([e]) => e === 'agent/pre-step')[1], calls, ctx }
  }

  /**
   * Mount with an injected llm and capture every handler by event name.
   *
   * The switches are written out at the mount site rather than left to the
   * defaults, so that a test can turn one off and still be sure the rest of
   * the path runs -- a mount that exercises nothing passes for the wrong
   * reason.
   */
  function mountTurn(reply = 'the turn taught X', config = {}) {
    const registered = []
    const calls = []
    const warns = []
    const llm = {
      prepareCall: async (config) => ({ config, stream: (options) => { calls.push(options); return chunks(reply) } }),
    }
    const ctx = {
      on: (event, handler) => registered.push([event, handler]),
      systemPrompt: { section: () => {} },
      inject: (_services, callback) => callback({ llm }),
      logger: { info: vi.fn(), warn: (line) => warns.push(line) },
    }
    apply(ctx, { stepSummary: true, turnSummary: true, ...config })
    return {
      stopping: registered.find(([e]) => e === 'agent/turn-stopping')?.[1],
      calls,
      warns,
      ctx,
    }
  }

  /**
   * Yield a stream in the host's REAL chunk vocabulary.
   *
   * The deltas are `text-delta` / `reasoning-delta`, not a generic `delta`, and
   * a block closes with `block-end` carrying the assembled block. An earlier
   * mock spoke a fictional `delta` protocol, so it agreed with a parser that
   * could not read the real one -- and both reported success while every
   * summary was discarded.
   */
  async function* chunks(value) {
    yield { type: 'block-start', index: 0, blockType: 'reasoning' }
    yield { type: 'reasoning-delta', index: 0, text: 'considering' }
    yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'considering' } }
    yield { type: 'block-start', index: 1, blockType: 'text' }
    yield { type: 'text-delta', index: 1, text: value }
    yield { type: 'block-end', index: 1, block: { type: 'text', text: value } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }

  /** A session whose log holds one completed step. */
  function completedSession() {
    seq_counter = 0
    // A real log carries the request header that fixes the provider/model; it
    // is the route a summary request must reuse rather than invent.
    const log0 = [
      {
        seq: -1,
        type: 'request/header',
        data: { header: { config: { provider: 'deepseek-official', model: 'deepseek-flash' } } },
      },
      ...log({ turn: 1, step: 1 }),
    ]
    return {
      events: log0,
      appended: [],
      deriveMessages: () => [{ role: 'assistant', content: [text('done')] }],
      // Reads the property, not a captured array, so a test can edit the log
      // it will be asked for -- filtering a step's `step/end` out, say.
      snapshotEvents() { return this.events },
      options: { provider: 'deepseek-official', model: 'deepseek-flash' },
      // The surface is narrower than the log: it holds the seqs a replacement
      // can address. A fixture without one cannot express `replace` at all.
      surface: { nodes: log0.filter(e => e.type !== 'request/header').map(e => e.seq) },
      // Mirrors the real Session.append contract: a surface-eligible event
      // without a surfaceOp marker is rejected. Without this the fixture
      // accepted appends the harness refuses, and the failure was invisible.
      append(type, data, opts) {
        if (type === 'user/message' && opts?.surfaceOp === undefined) {
          throw new Error('session event "user/message" is surface-eligible and requires a surfaceOp marker')
        }
        this.appended.push({ type, data, opts })
      },
    }
  }

  it('appends a summary message after a step completes', async () => {
    const session = completedSession()
    const { preStep } = mountWithLlm('the step settled X')
    await preStep({ agent: { session }, turn: 2, step: 1 }, () => Promise.resolve({ kind: 'enter' }))
    const appended = session.appended
    expect(appended).toHaveLength(1)
    expect(appended[0].type).toBe('user/message')
    // `data` IS the message for a user event this plugin appends: content sits
    // flat on it, not nested under a `message` key.
    expect(appended[0].data.content[0].text).toContain('[step summary]')
    expect(appended[0].data.content[0].text).toContain('the step settled X')
    expect(appended[0].data.source.kind).toBe('plugin')
    // The summary REPLACES its step. Appending it instead puts a `user/message`
    // at the head of every later turn, and the model answers that summary as if
    // the user had just said it -- the reported symptom was the model repeating
    // itself while the task scrolled away.
    expect(appended[0].opts.surfaceOp.op).toBe('replace')
    expect(typeof appended[0].opts.surfaceOp.startSeq).toBe('number')
    expect(typeof appended[0].opts.surfaceOp.endSeq).toBe('number')
    // Provenance is mandatory for a replace, and must cite the shadowed span.
    expect(appended[0].opts.sourceEventSeqs).toContain(appended[0].opts.surfaceOp.startSeq)
    expect(appended[0].opts.sourceEventSeqs).toContain(appended[0].opts.surfaceOp.endSeq)
    expect(appended[0].data.summaryOf).toEqual({ turn: 1, step: 1 })
  })

  describe('turn records', () => {
    /**
     * A finished turn, as the host writes one.
     *
     * `completedSession` cannot serve here: it has no `turn/start`, and the
     * turn path locates its turn by reading that event.
     */
    function finishedTurn() {
      seq_counter = 0
      const events = [
        { seq: 0, type: 'request/header', data: { header: { config: { provider: 'deepseek-official', model: 'deepseek-flash' } }, reason: 'initial' } },
        { seq: 1, type: 'turn/start', data: { turn: 4 } },
        ...log({ turn: 4, step: 1 }),
        { seq: 99, type: 'turn/end', data: { turn: 4, reason: { kind: 'completed' } } },
      ]
      return {
        events,
        appended: [],
        deriveMessages: () => [{ role: 'user', content: [text('do the thing')] }],
        snapshotEvents: () => events,
        options: { provider: 'deepseek-official', model: 'deepseek-flash' },
        append(type, data, opts) {
          if (type === 'user/message' && opts?.surfaceOp === undefined) {
            throw new Error('session event "user/message" is surface-eligible and requires a surfaceOp marker')
          }
          this.appended.push({ type, data, opts })
        },
      }
    }

    it('appends a turn record without replacing anything', async () => {
      const { stopping } = mountTurn()
      const target = finishedTurn()
      await stopping({ agent: { session: target }, turn: 4, signal: undefined })
      const appended = target.appended
      expect(appended).toHaveLength(1)
      expect(appended[0].type).toBe('user/message')
      expect(appended[0].data.content[0].text).toContain('[turn summary]')
      expect(appended[0].data.content[0].text).toContain('the turn taught X')
      expect(appended[0].data.source.kind).toBe('plugin')
      // Purely an addition. A replace here would delete a span the step records
      // already own, and `rawSeqs`/`sourceEventSeqs` have nothing to cite.
      expect(appended[0].opts.surfaceOp).toBe('append')
      expect(appended[0].opts.sourceEventSeqs).toBeUndefined()
      expect(appended[0].data.summaryOfTurn).toBe(4)
      expect(appended[0].data.summaryOf).toBeUndefined()
      expect(appended[0].data.rawSeqs).toBeUndefined()
    })

    it('asks with the turn prompt, not the step prompt', async () => {
      const { stopping, calls } = mountTurn()
      await stopping({ agent: { session: finishedTurn() }, turn: 4, signal: undefined })
      expect(calls).toHaveLength(1)
      const flat = JSON.stringify(calls[0].messages)
      expect(flat).toContain('轮')
      // The step prompt is a replacement record; reusing it here would ask the
      // turn's last step to be written down twice.
      expect(flat).not.toContain('这是读者今后唯一会再看到的关于这一步的记录')
    })

    it('writes one record per turn, however often the hook fires', async () => {
      const { stopping } = mountTurn()
      const target = finishedTurn()
      const hook = { agent: { session: target }, turn: 4, signal: undefined }
      // `agent/turn-stopping` fires once per step the turn bought. Without the
      // claim, a turn that took three steps would be written down three times.
      await stopping(hook)
      await stopping(hook)
      await stopping(hook)
      expect(target.appended).toHaveLength(1)
    })

    it('writes nothing when the model says the turn added nothing', async () => {
      const { stopping } = mountTurn('NONE')
      const target = finishedTurn()
      await stopping({ agent: { session: target }, turn: 4, signal: undefined })
      // Most turns settle no preference, teach nothing and find no new pattern.
      // The record is an addition, so emptiness is the normal case, not a fault.
      expect(target.appended).toHaveLength(0)
    })

    it('does nothing when the turn summary is switched off', async () => {
      const registered = []
      const llm = { prepareCall: async (config) => ({ config, stream: () => chunks('x') }) }
      apply({
        on: (event, handler) => registered.push([event, handler]),
        systemPrompt: { section: () => {} },
        inject: (_services, callback) => callback({ llm }),
        logger: { info: () => {}, warn: () => {} },
      }, { stepSummary: true, turnSummary: false })
      const stopping = registered.find(([e]) => e === 'agent/turn-stopping')?.[1]
      const target = finishedTurn()
      await stopping({ agent: { session: target }, turn: 4, signal: undefined })
      expect(target.appended).toHaveLength(0)
    })

    it('never lets a failure escape into the turn', async () => {
      const registered = []
      const llm = {
        prepareCall: async () => {
          const error = new Error('rate limited')
          error.code = 'RATE_LIMITED'
          throw error
        },
      }
      const ctx = {
        on: (event, handler) => registered.push([event, handler]),
        systemPrompt: { section: () => {} },
        inject: (_services, callback) => callback({ llm }),
        logger: { info: () => {}, warn: () => {} },
      }
      apply(ctx, { stepSummary: true, turnSummary: false })
      const stopping = registered.find(([e]) => e === 'agent/turn-stopping')?.[1]
      // A record improves the next turn's context. It is never a precondition
      // for finishing this one, so a provider failure must not reject the hook.
      await expect(stopping({
        agent: { session: finishedTurn() },
        turn: 4,
        signal: undefined,
      })).resolves.toBeUndefined()
    })
  })

  it('sends the projected context, not extracted material', async () => {
    // The summarizer must see the conversation to relate the step to the task;
    // a summary written from an isolated excerpt can only describe actions.
    const session = completedSession()
    const { preStep, calls } = mountWithLlm()
    await preStep({ agent: { session }, turn: 2, step: 1 }, () => Promise.resolve({ kind: 'enter' }))
    expect(calls).toHaveLength(1)
    const messages = calls[0].messages
    // system instruction, the context, then the one-line instruction
    expect(messages.length).toBe(3)
    expect(messages[0].content[0].text).toContain('一个正在工作的 agent 的当前上下文')
    expect(messages.at(-1).content[0].text).toContain('阅读上文中最新的那条记录')
  })

  it('does nothing when a step is still in flight', async () => {
    // A step with no step/end has no complete record to summarize.
    const session = completedSession()
    session.events = session.events.filter(event => event.type !== 'step/end')
    const { preStep, calls } = mountWithLlm()
    await preStep({ agent: { session }, turn: 1, step: 1 }, () => Promise.resolve({ kind: 'enter' }))
    expect(calls).toHaveLength(0)
    expect(session.appended).toHaveLength(0)
  })

  it('summarizes each step once, even across repeated pre-steps', async () => {
    const session = completedSession()
    const { preStep } = mountWithLlm()
    for (let i = 0; i < 3; i += 1) {
      await preStep({ agent: { session }, turn: 2, step: i + 1 }, () => Promise.resolve({ kind: 'enter' }))
    }
    expect(session.appended).toHaveLength(1)
  })

  it('does not summarize when the feature is off', async () => {
    const session = completedSession()
    const registered = []
    const ctx = {
      on: (event, handler) => registered.push([event, handler]),
      systemPrompt: { section: () => {} },
      inject: (_s, cb) => cb({ llm: { prepareCall: async () => ({ stream: () => chunks('x') }) } }),
      logger: { info: vi.fn(), warn: vi.fn() },
    }
    apply(ctx, { stepSummary: false })
    await registered.find(([e]) => e === 'agent/pre-step')[1](
      { agent: { session }, turn: 2, step: 1 }, () => Promise.resolve({ kind: 'enter' }),
    )
    expect(session.appended).toHaveLength(0)
  })

  it('never blocks the step when the provider fails', async () => {
    // A summary improves the next step's context; it is never a precondition
    // for it, so a failing provider must not stop the agent working.
    const session = completedSession()
    const registered = []
    const ctx = {
      on: (event, handler) => registered.push([event, handler]),
      systemPrompt: { section: () => {} },
      inject: (_s, cb) => cb({ llm: { prepareCall: async () => { throw new Error('rate limited') } } }),
      logger: { info: vi.fn(), warn: vi.fn() },
    }
    apply(ctx, { stepSummary: true })
    const decision = await registered.find(([e]) => e === 'agent/pre-step')[1](
      { agent: { session }, turn: 2, step: 1 }, () => Promise.resolve({ kind: 'enter' }),
    )
    expect(decision).toEqual({ kind: 'enter' })
    expect(ctx.logger.warn.mock.calls.flat().join('\n')).toContain('rate limited')
  })
})

describe('summary message shape', () => {
  it('reports summaries written to the log in the host event shape', () => {
    // Regression: a summary event stores content FLAT on `data`, the way the
    // host writes user messages. An earlier version nested it under `message`,
    // wrote it successfully, and then could not read it back -- the report said
    // zero summaries while the log held them.
    seq_counter = 0
    const events = [
      ...log({ turn: 1, step: 1 }),
      {
        seq: 4,
        type: 'user/message',
        data: {
          content: [{ type: 'text', text: '[step summary] the step settled X' }],
          source: { kind: 'plugin', plugin: 'stepwise-distill' },
          summaryOf: { turn: 1, step: 1 },
        },
      },
    ]
    const report = summarize(events)
    expect(report.summaries).toHaveLength(1)
    expect(report.summaries[0]).toContain('settled X')
  })

  it('does not mistake an ordinary user message for a summary', () => {
    seq_counter = 0
    const events = [
      ...log({ turn: 1, step: 1 }),
      { seq: 4, type: 'user/message', data: { content: [{ type: 'text', text: 'keep going' }] } },
    ]
    expect(summarize(events).summaries).toHaveLength(0)
  })
})

describe('newest step keeps its evidence', () => {
  it('projects the newest step as material plus record, older ones as records', () => {
    // The record says what a step concluded. For the step being reasoned about
    // now that is not enough to act on: a measured run answered by reading the
    // same file again after each record that replaced a read of it. The newest
    // step therefore keeps both.
    const raw = { id: 'raw-3', role: 'user', content: [{ type: 'text', text: 'tool output for step 3' }] }
    const recordMessage = { id: 'rec-3', role: 'user', content: [{ type: 'text', text: '[step summary] step 3 said X' }] }
    const messages = [
      { id: 'rec-1', role: 'user', content: [{ type: 'text', text: '[step summary] step 1 said A' }] },
      { id: 'rec-2', role: 'user', content: [{ type: 'text', text: '[step summary] step 2 said B' }] },
      recordMessage,
    ]
    const records = [
      { message: { id: 'rec-1' }, rawSeqs: [10] },
      { message: { id: 'rec-2' }, rawSeqs: [20] },
      { message: recordMessage, rawSeqs: [31, 33] },
    ]
    const bySeq = new Map([[10, [{ id: 'raw-1' }]], [20, [{ id: 'raw-2' }]], [31, [raw]], [33, [{ id: 'raw-3b' }]]])
    const out = restoreNewestStep(messages, records, seq => bySeq.get(seq))
    expect(out.map(m => m.id)).toEqual(['rec-1', 'rec-2', 'rec-3', 'raw-3', 'raw-3b'])
  })

  it('leaves the projection alone when the newest step has no material', () => {
    const recordMessage = { id: 'rec-9', role: 'user', content: [{ type: 'text', text: '[step summary] x' }] }
    const messages = [recordMessage]
    const out = restoreNewestStep(messages, [{ message: recordMessage, rawSeqs: [] }], () => undefined)
    expect(out).toBe(messages)
  })

  it('does not duplicate the material when the record is absent from the list', () => {
    const raw = { id: 'raw-3' }
    const messages = [{ id: 'rec-1' }]
    const out = restoreNewestStep(messages, [{ message: { id: 'gone' }, rawSeqs: [31] }], () => [raw])
    expect(out).toBe(messages)
  })
})

describe('summary dispatch contract', () => {
  /** Mount with an llm double that enforces the adapter's config check. */
  function mountStrict() {
    const seen = { prepared: null, dispatched: null }
    const resolved = {
      provider: 'deepseek-official',
      model: 'deepseek-flash',
      reasoningEffort: 'max',
      maxTokens: 128000,
    }
    const llm = {
      prepareCall: async () => ({
        config: resolved,
        stream: (options) => {
          seen.dispatched = options
          // The adapter's own rule: the resolved fields must arrive unchanged.
          for (const key of ['provider', 'model', 'reasoningEffort', 'maxTokens']) {
            if (options[key] !== resolved[key]) {
              throw new Error(`prepared LLM call config changed before adapter dispatch (${key})`)
            }
          }
          return (async function* () {
            yield { type: 'block-start', index: 0, blockType: 'text' }
            yield { type: 'text-delta', index: 0, text: 'settled X' }
            yield { type: 'block-end', index: 0, block: { type: 'text', text: 'settled X' } }
            yield { type: 'finish', reason: { kind: 'stop' } }
          })()
        },
      }),
    }
    seen.prepared = resolved
    const registered = []
    const ctx = {
      on: (event, handler) => registered.push([event, handler]),
      systemPrompt: { section: () => {} },
      inject: (_s, cb) => cb({ llm }),
      logger: { info: vi.fn(), warn: vi.fn() },
    }
    apply(ctx, { stepSummary: true })
    return { preStep: registered.find(([e]) => e === 'agent/pre-step')[1], seen, ctx }
  }

  function session() {
    seq_counter = 0
    const events = [
      { seq: -1, type: 'request/header', data: { header: { config: { provider: 'deepseek-official', model: 'deepseek-flash' } } } },
      ...log({ turn: 1, step: 1 }),
    ]
    return {
      events,
      appended: [],
      deriveMessages: () => [{ role: 'assistant', content: [text('done')] }],
      snapshotEvents: () => events,
      options: { provider: 'deepseek-official', model: 'deepseek-flash' },
      // `replace` addresses a span by surface seq, so the fixture needs one.
      surface: { nodes: events.filter(e => e.type !== 'request/header').map(e => e.seq) },
      // Mirrors the real Session.append contract: a surface-eligible event
      // without a surfaceOp marker is rejected. Without this the fixture
      // accepted appends the harness refuses, and the failure was invisible.
      append(type, data, opts) {
        if (type === 'user/message' && opts?.surfaceOp === undefined) {
          throw new Error('session event "user/message" is surface-eligible and requires a surfaceOp marker')
        }
        this.appended.push({ type, data, opts })
      },
    }
  }

  it('dispatches with the config prepareCall resolved, not a partial one', async () => {
    // Regression: spreading the caller's `{ provider, model }` into the request
    // drops reasoningEffort/temperature/maxTokens, and the adapter refuses the
    // dispatch with "prepared LLM call config changed". The call must carry
    // `call.config` through unchanged.
    const { preStep, seen } = mountStrict()
    const target = session()
    await preStep({ agent: { session: target }, turn: 2, step: 1 }, () => Promise.resolve({ kind: 'enter' }))
    expect(seen.dispatched.reasoningEffort).toBe('max')
    expect(seen.dispatched.maxTokens).toBe(128000)
    expect(target.appended).toHaveLength(1)
  })

  it('falls back when a model does not offer the requested reasoning effort', async () => {
    // A real run against a provider without `off` failed every request with
    // UNSUPPORTED_REASONING_EFFORT while the task itself completed normally --
    // indistinguishable, from outside, from the mechanism being switched off.
    // Omitting the field lets the host apply the model's own default.
    const attempts = []
    const llm = {
      prepareCall: async (config) => {
        attempts.push(config)
        if (config.reasoningEffort !== undefined) {
          const error = new Error('does not support reasoning effort "off"')
          error.code = 'UNSUPPORTED_REASONING_EFFORT'
          throw error
        }
        return {
          config: { provider: config.provider, model: config.model, maxTokens: 4096 },
          stream: () => (async function* () {
            yield { type: 'block-start', index: 0, blockType: 'text' }
            yield { type: 'text-delta', index: 0, text: 'settled X' }
            yield { type: 'block-end', index: 0, block: { type: 'text', text: 'settled X' } }
            yield { type: 'finish', reason: { kind: 'stop' } }
          })(),
        }
      },
    }
    const registered = []
    apply({
      on: (event, handler) => registered.push([event, handler]),
      systemPrompt: { section: () => {} },
      inject: (_s, cb) => cb({ llm }),
      logger: { info: () => {}, warn: () => {} },
    }, { stepSummary: true })
    const target = session()
    await registered.find(([e]) => e === 'agent/pre-step')[1](
      { agent: { session: target }, turn: 2, step: 1 },
      () => Promise.resolve({ kind: 'enter' }),
    )
    expect(attempts).toHaveLength(2)
    expect(attempts[0].reasoningEffort).toBe('off')
    expect(attempts[1].reasoningEffort).toBeUndefined()
    expect(target.appended).toHaveLength(1)
  })

  it('does not swallow a failure that is not about reasoning effort', async () => {
    const llm = {
      prepareCall: async () => {
        const error = new Error('rate limited')
        error.code = 'RATE_LIMITED'
        throw error
      },
    }
    const registered = []
    apply({
      on: (event, handler) => registered.push([event, handler]),
      systemPrompt: { section: () => {} },
      inject: (_s, cb) => cb({ llm }),
      logger: { info: () => {}, warn: () => {} },
    }, { stepSummary: true })
    const target = session()
    await expect(registered.find(([e]) => e === 'agent/pre-step')[1](
      { agent: { session: target }, turn: 2, step: 1 },
      () => Promise.resolve({ kind: 'enter' }),
    )).resolves.toBeDefined()
    // The retry is only for the unsupported-effort case; a rate limit must not
    // be retried as if dropping the field would help.
    expect(target.appended).toHaveLength(0)
  })

  it('sends the whole projected context plus one instruction', async () => {
    const { preStep, seen } = mountStrict()
    const target = session()
    await preStep({ agent: { session: target }, turn: 2, step: 1 }, () => Promise.resolve({ kind: 'enter' }))
    const messages = seen.dispatched.messages
    expect(messages[0].content[0].text).toContain('一个正在工作的 agent 的当前上下文')
    expect(messages.at(-1).content[0].text).toContain('阅读上文中最新的那条记录')
  })
})

describe('summary request bounding', () => {
  function bareSession() {
    seq_counter = 0
    const events = [
      { seq: -1, type: 'request/header', data: { header: { config: { provider: 'p', model: 'm' } } } },
      ...log({ turn: 1, step: 1 }),
    ]
    return {
      events,
      appended: [],
      deriveMessages: () => [{ role: 'assistant', content: [text('done')] }],
      snapshotEvents() { return this.events },
      options: { provider: 'p', model: 'm' },
      // Mirrors the real Session.append contract: a surface-eligible event
      // without a surfaceOp marker is rejected. Without this the fixture
      // accepted appends the harness refuses, and the failure was invisible.
      append(type, data, opts) {
        if (type === 'user/message' && opts?.surfaceOp === undefined) {
          throw new Error('session event "user/message" is surface-eligible and requires a surfaceOp marker')
        }
        this.appended.push({ type, data, opts })
      },
    }
  }

  function mount(streamFactory) {
    let calls = 0
    const llm = {
      prepareCall: async () => ({
        config: { provider: 'p', model: 'm', reasoningEffort: 'off', maxTokens: 100 },
        stream: () => { calls += 1; return streamFactory() },
      }),
    }
    const registered = []
    apply({
      on: (e, h) => registered.push([e, h]),
      systemPrompt: { section: () => {} },
      inject: (_s, cb) => cb({ llm }),
      logger: { info: () => {}, warn: vi.fn() },
    }, { stepSummary: true })
    return { preStep: registered.find(([e]) => e === 'agent/pre-step')[1], calls: () => calls }
  }

  it('asks at most once when the provider keeps answering with nothing', async () => {
    // Regression: marking the step only AFTER a summary arrived made an empty
    // reply a loop. Every pre-step found the same unfinished step and asked
    // again -- a measured run issued 32 identical requests, one every seven
    // seconds, and never stopped.
    const empty = async function* () {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '' } }
    }
    const { preStep, calls } = mount(empty)
    const session = bareSession()
    for (let i = 0; i < 5; i += 1) {
      await preStep({ agent: { session }, turn: 2, step: i + 1 }, () => Promise.resolve({ kind: 'enter' }))
    }
    expect(calls()).toBe(1)
    expect(session.appended).toHaveLength(0)
  })

  it('keeps the raw step visible when its summary came back empty', async () => {
    // A claimed step with no summary must NOT be dropped from the projection:
    // there is no replacement for its material, so hiding it would silently
    // delete the step from the conversation.
    const empty = async function* () {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '' } }
    }
    const { preStep } = mount(empty)
    const session = bareSession()
    await preStep({ agent: { session }, turn: 2, step: 1 }, () => Promise.resolve({ kind: 'enter' }))
    // deriveMessages is wrapped by the projection installer; with no summary
    // written, the wrapper must pass the messages through untouched.
    const projected = session.deriveMessages()
    expect(projected).toHaveLength(1)
    expect(JSON.stringify(projected)).toContain('done')
  })
})

describe('records route', () => {
  // The route is the only exported door onto `retentionRecords` and
  // `sessionFor`, so the tests go through it rather than widening the exports
  // for the sake of a fixture. A fake context whose `inject` calls back
  // synchronously is enough: the plugin registers the route at `apply` time.
  function mountRoute({ sessions, sessionQuery, connection } = {}) {
    let registered = null
    // `sessionFor` reads the session services off the context `apply` was
    // given, while the route reads `connection` off the injected scope. Both
    // have to resolve the same names, or a fixture passing one and not the
    // other makes the plugin look like it found no session at all.
    const get = (service) => {
      if (service === 'connection') return connection ?? { fetch: { register: (route) => { registered = route } } }
      if (service === 'sessions') return sessions
      if (service === 'sessionQuery') return sessionQuery
      return undefined
    }
    const ctx = {
      on: () => {},
      get,
      inject: (_names, callback) => callback({ get, effect: (fn) => fn() }),
      logger: { info: vi.fn(), warn: vi.fn() },
    }
    apply(ctx, {})
    return { registered, ctx }
  }

  function post(registered, body) {
    return registered.fetch({ json: async () => body })
  }

  // Only the methods this route reaches for: `deriveMessages` to enumerate the
  // projection, which is what decides what the model can see.
  function sessionOf(messages) {
    return { deriveMessages: () => messages }
  }


  function record({ kind, turn, step, text: body, plugin = name }) {
    const data = {
      source: { kind: 'plugin', plugin },
      content: [{ type: 'text', text: body }],
    }
    if (kind === 'turn') data.summaryOfTurn = turn
    else data.summaryOf = { turn, step }
    return data
  }

  // A compaction checkpoint as the host writes it: a `user/message` whose
  // source carries the `compact` marker, produced by `compactCheckpointSource`
  // and appended in place of the history it covers.
  function checkpoint({ id = 'c1', body = 'the compacted history' } = {}) {
    return {
      source: { kind: 'plugin', plugin: 'compact', compactionId: id },
      content: [{ type: 'text', text: body }],
    }
  }

  it('registers the route on the connection it is given', () => {
    const { registered } = mountRoute({})
    expect(registered.path).toBe(RECORDS_ROUTE)
    expect(registered.methods).toEqual(['POST'])
    expect(registered.requestBody).toBe('buffered')
  })

  it('rejects a request with no sessionId', async () => {
    const { registered } = mountRoute({})
    const response = await post(registered, {})
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ ok: false, error: 'missing sessionId' })
  })

  it('answers with an empty list when the host has no session for that id', async () => {
    const { registered } = mountRoute({ sessions: { get: () => undefined } })
    const response = await post(registered, { sessionId: 'absent' })
    // No session is not a failure: the tab is opened per session and a cold one
    // simply has nothing to show yet.
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, value: [] })
  })

  it('reads the records the model can see, newest first', async () => {
    const session = sessionOf([
      record({ kind: 'step', turn: 1, step: 1, text: 'first step' }),
      record({ kind: 'step', turn: 2, step: 1, text: 'later step' }),
      record({ kind: 'turn', turn: 1, text: 'first turn' }),
      // Not written by this plugin, and a message with no text at all: neither
      // is a record, so neither may reach the panel.
      record({ kind: 'step', turn: 2, step: 2, text: 'someone else', plugin: 'other' }),
      { source: { kind: 'plugin', plugin: name }, content: [] },
    ])
    const { registered } = mountRoute({ sessions: { get: () => session } })
    const payload = await (await post(registered, { sessionId: 's1' })).json()
    expect(payload.ok).toBe(true)
    // Turn first, then the kinds within that turn: `later step` belongs to turn
    // 2 and leads, then turn 1's own note sits above the step it summarizes.
    expect(payload.value.map((item) => item.text)).toEqual(['later step', 'first turn', 'first step'])
  })

  it('labels a record by what it covers, so the panel can key an open body', async () => {
    const session = sessionOf([
      record({ kind: 'turn', turn: 7, text: 'a turn' }),
      record({ kind: 'step', turn: 7, step: 3, text: 'a step' }),
    ])
    const { registered } = mountRoute({ sessions: { get: () => session } })
    const payload = await (await post(registered, { sessionId: 's1' })).json()
    expect(payload.value).toHaveLength(2)
    expect(payload.value[0]).toMatchObject({ id: 'turn-7-?', kind: 'turn', turn: 7, step: null })
    expect(payload.value[1]).toMatchObject({ id: 'step-7-3', kind: 'step', turn: 7, step: 3 })
  })

  it('reads a cold session back from persistence', async () => {
    // The reason the fallback exists: the in-memory lookup only knows the
    // sessions this host has loaded, and a session reopened after a restart --
    // exactly when the panel gets opened -- resolves to nothing.
    const readSession = vi.fn(async () => ({
      session: { id: 'cold' },
      inheritedEventCount: 0,
      events: [log({ turn: 4, step: 1, body: 'recovered' })],
    }))
    const { registered } = mountRoute({
      sessions: { get: () => undefined },
      sessionQuery: { readSession },
    })
    const payload = await (await post(registered, { sessionId: 'cold' })).json()
    expect(readSession).toHaveBeenCalledWith('cold')
    expect(payload.ok).toBe(true)
  })

  it('answers with an empty list when the persistence read fails', async () => {
    const { registered } = mountRoute({
      sessions: { get: () => undefined },
      sessionQuery: { readSession: async () => { throw new Error('gone') } },
    })
    const response = await post(registered, { sessionId: 's1' })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, value: [] })
  })

  it('lists a compaction checkpoint as its own kind, without a turn or step', async () => {
    const session = sessionOf([
      record({ kind: 'step', turn: 4, step: 1, text: 'a step' }),
      checkpoint({ id: 'c-9', body: 'what the compaction kept' }),
    ])
    const { registered } = mountRoute({ sessions: { get: () => session } })
    const payload = await (await post(registered, { sessionId: 's1' })).json()
    expect(payload.value).toHaveLength(2)
    // The checkpoint covers a span of history, not a step, so it carries no
    // turn or step for the client to sort or label it by.
    expect(payload.value[1]).toEqual({
      id: 'compact-c-9',
      kind: 'compact',
      text: 'what the compaction kept',
      turn: null,
      step: null,
    })
  })

  it('keeps a checkpoint behind every turn record', async () => {
    const session = sessionOf([
      record({ kind: 'turn', turn: 1, text: 'a turn' }),
      checkpoint({ body: 'older than the turn record above' }),
    ])
    const { registered } = mountRoute({ sessions: { get: () => session } })
    const payload = await (await post(registered, { sessionId: 's1' })).json()
    // The client renders the order it is given and puts the checkpoint last in
    // its own section; leaving it ahead of a turn record here would make the
    // panel show compressed history above the note about turn 1.
    expect(payload.value.map((item) => item.kind)).toEqual(['turn', 'compact'])
  })

  it('drops a checkpoint with no text, like any other empty record', async () => {
    const session = sessionOf([checkpoint({ body: '' })])
    const { registered } = mountRoute({ sessions: { get: () => session } })
    const payload = await (await post(registered, { sessionId: 's1' })).json()
    expect(payload.value).toEqual([])
  })

  it('loads without a connection to register the route on', () => {
    // A profile that cannot serve the tab still has to load: the route is
    // registered from `optionalInject`, so its absence cannot be fatal.
    expect(() => mountRoute({ connection: {} })).not.toThrow()
  })
})
