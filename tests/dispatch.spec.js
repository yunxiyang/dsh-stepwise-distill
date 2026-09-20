/**
 * What does the main request actually carry?
 *
 * `dsh-agent-loop` builds a request as `{ ...config, messages: session
 * .deriveMessages(), tools, sessionId }` and freezes it at the dispatch
 * boundary. These tests take the same value at the same point and assert on it,
 * so a failure names the request rather than an intermediate representation.
 *
 * The LLM here is deterministic: the task under test is whether information
 * reaches the next request, not whether any particular model writes well.
 *
 * @module dsh-stepwise-distill/tests/dispatch
 */
import { describe, expect, it } from 'vitest'
import { Session } from '@deepseek-ai/dsh-session'
import {
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
} from '@deepseek-ai/dsh-llm'
import { apply } from '../src/index.js'

/** A host session carrying the route a retention request has to reuse. */
function newSession() {
  const id = `dispatch-${Math.random().toString(36).slice(2)}`
  const session = Session.create(id, [], {
    version: 3, id, createdAt: Date.now(), cwd: '/tmp', isSeeded: false,
  })
  session.append(
    'request/header',
    { header: { config: { provider: 'deepseek-official', model: 'deepseek-flash' } } },
  )
  return session
}

/** Append agent-turn material for one step, in the host's own shapes. */
function writeStep(session, { turn, note, toolOutput }) {
  session.append(
    'assistant/message',
    {
      message: createAssistantMessage({
        content: [
          { type: 'text', text: note },
          { type: 'tool-call', toolCallId: `c-${turn}`, toolName: 'bash', args: { command: 'cat' } },
        ],
        source: { provider: 'deepseek-official', model: 'deepseek-flash' },
      }),
      turn,
      step: 1,
    },
    { surfaceOp: 'append' },
  )
  session.append(
    'tool/result',
    {
      message: createToolResultMessage({
        callId: `c-${turn}`,
        content: [{ type: 'text', text: toolOutput }],
        isError: false,
      }),
      turn,
      step: 1,
    },
    { surfaceOp: 'append' },
  )
  session.append('step/end', { turn, step: 1 })
}

/** Every text block across a message list, joined. */
function textOf(messages) {
  return messages
    .flatMap(message => (Array.isArray(message?.content) ? message.content : []))
    .filter(block => block?.type === 'text')
    .map(block => block.text)
    .join('\n')
}

/**
 * The dispatch boundary as `dsh-agent-loop` builds it.
 *
 * Kept in one place so every test reads the same request the harness would
 * send, including the freeze the loop applies before dispatch.
 */
function dispatch(session) {
  const messages = session.deriveMessages()
  for (const message of messages) Object.freeze(message)
  return Object.freeze({ messages: Object.freeze(messages), sessionId: session.id })
}

/**
 * A responder that writes down the newest fact it was shown.
 *
 * Seeing the fact at all is part of what is asserted: the retention request
 * has to receive the step it is writing about.
 */
function recordingLlm() {
  const requests = []
  return {
    requests,
    prepareCall: async config => ({
      config: { ...config, maxTokens: 4096 },
      stream: options => {
        const shown = JSON.stringify(options.messages ?? [])
        requests.push(shown)
        const facts = shown.match(/FACT-[A-Z]/g) ?? []
        const fact = facts[facts.length - 1] ?? 'nothing'
        return (async function* () {
          yield { type: 'block-start', index: 0, blockType: 'text' }
          yield { type: 'text-delta', index: 0, text: `established ${fact}` }
          yield { type: 'block-end', index: 0, block: { type: 'text', text: `established ${fact}` } }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      },
    }),
  }
}

/** Mount the plugin and return a function that runs one step boundary. */
function mount(session, llm) {
  const handlers = new Map()
  apply(
    {
      on: (event, handler) => handlers.set(event, handler),
      systemPrompt: { section: () => {} },
      inject: (_services, callback) => callback({ llm }),
      logger: { info: () => {}, warn: () => {} },
    },
    { stepSummary: true, reasoningContract: true },
  )
  const preStep = handlers.get('agent/pre-step')
  return key => preStep(
    { agent: { session }, turn: key.turn, step: key.step },
    () => Promise.resolve({ kind: 'enter' }),
  )
}

describe('main request at the dispatch boundary', () => {
  it('carries a role on every message it sends', async () => {
    // `deriveMessages` returns a user/message's data verbatim, so a message
    // written without a role reaches the provider without one.
    const session = newSession()
    const preStep = mount(session, recordingLlm())
    session.append(
      'user/message',
      createUserMessage({ content: [{ type: 'text', text: 'TASK: find the port' }], source: { kind: 'user' } }),
      { surfaceOp: 'append' },
    )
    writeStep(session, { turn: 1, note: 'Looking.', toolOutput: 'FACT-X: port is 8080' })
    await preStep({ turn: 1, step: 2 })

    for (const message of dispatch(session).messages) {
      expect(typeof message.role).toBe('string')
      expect(typeof message.id).toBe('string')
    }
  })

  it('keeps one task across three steps and accumulates every finding', async () => {
    // A single task, three steps. The point is that request 3 can see what
    // steps 1 and 2 established, on a task it was given once.
    const session = newSession()
    const llm = recordingLlm()
    const preStep = mount(session, llm)
    session.append(
      'user/message',
      createUserMessage({ content: [{ type: 'text', text: 'TASK: find the port' }], source: { kind: 'user' } }),
      { surfaceOp: 'append' },
    )

    writeStep(session, { turn: 1, note: 'Looking.', toolOutput: 'FACT-X: port is 8080' })
    await preStep({ turn: 1, step: 2 })
    const afterFirst = textOf(dispatch(session).messages)
    expect(afterFirst).toContain('TASK: find the port')
    expect(afterFirst).toContain('established FACT-X')

    writeStep(session, { turn: 2, note: 'Using.', toolOutput: 'FACT-Y: client wants 8080' })
    await preStep({ turn: 2, step: 2 })
    const afterSecond = textOf(dispatch(session).messages)
    expect(afterSecond).toContain('established FACT-X')
    expect(afterSecond).toContain('established FACT-Y')
    expect(afterSecond).toContain('TASK: find the port')

    writeStep(session, { turn: 3, note: 'Confirming.', toolOutput: 'FACT-Z: config matches' })
    await preStep({ turn: 3, step: 2 })
    const afterThird = textOf(dispatch(session).messages)
    for (const fact of ['established FACT-X', 'established FACT-Y', 'established FACT-Z']) {
      expect(afterThird).toContain(fact)
    }
  })

  it('replaces each step instead of letting the log grow into the request', async () => {
    const session = newSession()
    const preStep = mount(session, recordingLlm())
    session.append(
      'user/message',
      createUserMessage({ content: [{ type: 'text', text: 'TASK: find the port' }], source: { kind: 'user' } }),
      { surfaceOp: 'append' },
    )

    writeStep(session, { turn: 1, note: 'Looking.', toolOutput: 'FACT-X: port is 8080' })
    await preStep({ turn: 1, step: 2 })
    writeStep(session, { turn: 2, note: 'Using.', toolOutput: 'FACT-Y: client wants 8080' })
    await preStep({ turn: 2, step: 2 })

    const text = textOf(dispatch(session).messages)
    // Raw material is what the mechanism removes; the findings it produced are
    // what it keeps. Both halves matter -- dropping the material without
    // keeping the finding loses the step entirely.
    expect(text).not.toContain('FACT-X: port is 8080')
    expect(text).not.toContain('FACT-Y: client wants 8080')
    expect(text).toContain('established FACT-X')
    expect(text).toContain('established FACT-Y')
  })

  it('keeps the retention instruction out of the main request', async () => {
    const session = newSession()
    const preStep = mount(session, recordingLlm())
    session.append(
      'user/message',
      createUserMessage({ content: [{ type: 'text', text: 'TASK: find the port' }], source: { kind: 'user' } }),
      { surfaceOp: 'append' },
    )
    writeStep(session, { turn: 1, note: 'Looking.', toolOutput: 'FACT-X: port is 8080' })
    await preStep({ turn: 1, step: 2 })

    const text = textOf(dispatch(session).messages)
    expect(text).not.toContain('Summarize the last step')
    expect(text).not.toContain('You are given the current context')
  })

  it('asks for each step exactly once', async () => {
    const session = newSession()
    const llm = recordingLlm()
    const preStep = mount(session, llm)
    session.append(
      'user/message',
      createUserMessage({ content: [{ type: 'text', text: 'TASK: find the port' }], source: { kind: 'user' } }),
      { surfaceOp: 'append' },
    )
    writeStep(session, { turn: 1, note: 'Looking.', toolOutput: 'FACT-X: port is 8080' })
    await preStep({ turn: 1, step: 2 })
    await preStep({ turn: 1, step: 3 })
    await preStep({ turn: 1, step: 4 })
    expect(llm.requests.length).toBe(1)
  })
})

describe('surface replacement constraints found in a real session', () => {
  it('cites every surface node its span covers', async () => {
    // A real session rejects a citation that leaves a shadowed node out:
    // "sourceEventSeqs must include every shadowed surface node". A step's span
    // covers the messages the loop wrote around it, not only the events that
    // carry turn/step.
    const session = newSession()
    const preStep = mount(session, recordingLlm())
    session.append(
      'user/message',
      createUserMessage({ content: [{ type: 'text', text: 'TASK: find the port' }], source: { kind: 'user' } }),
      { surfaceOp: 'append' },
    )
    writeStep(session, { turn: 1, note: 'Looking.', toolOutput: 'FACT-X: port is 8080' })
    await preStep({ turn: 1, step: 2 })

    const written = session.snapshotEvents().filter(
      event => event.surfaceOp?.op === 'replace',
    )
    expect(written.length).toBe(1)
    const { startSeq, endSeq } = written[0].surfaceOp
    const cited = new Set(written[0].sourceEventSeqs)
    const covered = session.surface.nodes.filter(seq => seq >= startSeq && seq <= endSeq)
    for (const seq of covered) expect(cited.has(seq)).toBe(true)
  })

  it('leaves the system prompt out of the span it replaces', async () => {
    // The surface allows the prompt node to be rewritten only by another
    // `system/message` covering exactly it, so a step's span must start after.
    // A real session rejected the alternative with "node 0 holds the system
    // prompt".
    const session = newSession()
    const preStep = mount(session, recordingLlm())
    session.append(
      'system/message',
      { message: { id: 'sys-1', role: 'system', content: [{ type: 'text', text: 'You are an agent.' }] } },
      { surfaceOp: 'append' },
    )
    session.append(
      'user/message',
      createUserMessage({ content: [{ type: 'text', text: 'TASK: find the port' }], source: { kind: 'user' } }),
      { surfaceOp: 'append' },
    )
    writeStep(session, { turn: 1, note: 'Looking.', toolOutput: 'FACT-X: port is 8080' })
    await preStep({ turn: 1, step: 2 })

    const written = session.snapshotEvents().filter(event => event.surfaceOp?.op === 'replace')
    expect(written.length).toBe(1)
    const promptSeq = session.snapshotEvents().find(event => event.type === 'system/message').seq
    expect(written[0].surfaceOp.startSeq).toBeGreaterThan(promptSeq)
    expect(written[0].sourceEventSeqs).not.toContain(promptSeq)
  })
})

describe('the task survives its step being written down', () => {
  /**
   * The order a real session writes, taken from a recorded run.
   *
   * Only `system/message`, `assistant/message`, `tool/call` and `tool/result`
   * carry the step's turn/step. The user's task and any plugin-injected message
   * carry neither, so they sit BETWEEN the step's own events while belonging to
   * the task rather than to the step.
   */
  function realOrderSession() {
    const session = newSession()
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append(
      'system/message',
      { message: { id: 'sys-1', role: 'system', content: [{ type: 'text', text: 'You are an agent.' }] }, turn: 1, step: 1 },
      { surfaceOp: 'append' },
    )
    session.append(
      'user/message',
      createUserMessage({ content: [{ type: 'text', text: 'TASK: find the port' }], source: { kind: 'user' } }),
      { surfaceOp: 'append' },
    )
    session.append(
      'user/message',
      createUserMessage({
        content: [{ type: 'text', text: 'loop-continue instruction' }],
        source: { kind: 'plugin', plugin: 'loop-continue' },
      }),
      { surfaceOp: 'append' },
    )
    session.append('request/header', { header: { config: { provider: 'deepseek-official', model: 'deepseek-flash' } } })
    return session
  }

  it('keeps the user task in the request after its step is written down', async () => {
    const session = realOrderSession()
    const preStep = mount(session, recordingLlm())
    writeStep(session, { turn: 1, note: 'Looking.', toolOutput: 'FACT-X: port is 8080' })
    await preStep({ turn: 1, step: 2 })

    const text = textOf(dispatch(session).messages)
    expect(text).toContain('TASK: find the port')
  })

  it('keeps the system instruction in the request', async () => {
    const session = realOrderSession()
    const preStep = mount(session, recordingLlm())
    writeStep(session, { turn: 1, note: 'Looking.', toolOutput: 'FACT-X: port is 8080' })
    await preStep({ turn: 1, step: 2 })

    const text = textOf(dispatch(session).messages)
    expect(text).toContain('You are an agent.')
  })

  it('still records what the step established', async () => {
    const session = realOrderSession()
    const preStep = mount(session, recordingLlm())
    writeStep(session, { turn: 1, note: 'Looking.', toolOutput: 'FACT-X: port is 8080' })
    await preStep({ turn: 1, step: 2 })

    const text = textOf(dispatch(session).messages)
    expect(text).toContain('established FACT-X')
  })
})
