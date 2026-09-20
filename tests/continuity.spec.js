/**
 * Does a step's retained information actually reach the next request?
 *
 * The tests here run against the host's real `Session`, because the question is
 * about the projection the harness asks for -- a hand-written stand-in answers
 * whatever the stand-in was written to answer. Everything else (the LLM, the
 * clock) is deterministic on purpose: this checks the plumbing that carries
 * information forward, not the quality of any particular retention.
 *
 * @module dsh-stepwise-distill/tests/continuity
 */
import { describe, expect, it } from 'vitest'
import { Session } from '@deepseek-ai/dsh-session'
import {
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
} from '@deepseek-ai/dsh-llm'
import { apply } from '../src/index.js'

/** A fresh host session with the route a retention request has to reuse. */
function newSession() {
  const id = `continuity-${Math.random().toString(36).slice(2)}`
  const session = Session.create(id, [], {
    version: 3, id, createdAt: Date.now(), cwd: '/tmp', isSeeded: false,
  })
  session.append(
    'request/header',
    { header: { config: { provider: 'deepseek-official', model: 'deepseek-flash' } } },
  )
  return session
}

/**
 * Record one agent step in the shape the harness writes.
 *
 * `toolOutput` is the step's own fact: it is the material a retention request
 * reads and the thing that has to survive into the next request.
 */
function writeStep(session, { turn, task, note, toolOutput }) {
  session.append(
    'user/message',
    createUserMessage({ content: [{ type: 'text', text: task }], source: { kind: 'user' } }),
    { surfaceOp: 'append' },
  )
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

/** Text of every message, joined, for substring checks. */
function textOf(messages) {
  return messages
    .flatMap(message => (Array.isArray(message?.content) ? message.content : []))
    .filter(block => block?.type === 'text')
    .map(block => block.text)
    .join('\n')
}

/**
 * A retention responder that echoes the newest fact it was shown.
 *
 * Deterministic by design: the test asserts that what the responder was shown
 * reaches the next request. Variable answers would make a failure
 * unattributable between the plumbing and the model.
 *
 * It deliberately receives only the request messages, so the assertion also
 * covers that the retention call is shown the step it is summarizing.
 */
function echoingLlm() {
  const requests = []
  return {
    requests,
    prepareCall: async config => ({
      config: { ...config, maxTokens: 4096 },
      stream: options => {
        const shown = JSON.stringify(options.messages ?? [])
        requests.push(shown)
        // The newest fact, so a later step is recognized by its own finding
        // rather than by an earlier step's retention that also mentions one.
        const facts = shown.match(/FACT-[A-Z]/g) ?? []
        const fact = facts[facts.length - 1] ?? 'nothing'
        return (async function* () {
          yield { type: 'block-start', index: 0, blockType: 'text' }
          yield { type: 'text-delta', index: 0, text: `retained ${fact}` }
          yield { type: 'block-end', index: 0, block: { type: 'text', text: `retained ${fact}` } }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      },
    }),
  }
}

/** Mount the plugin and return its pre-step handler. */
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
  expect(typeof preStep).toBe('function')
  return key => preStep({ agent: { session }, turn: key.turn, step: key.step },
    () => Promise.resolve({ kind: 'enter' }))
}

describe('history continuity', () => {
  it('keeps the task the agent was given', async () => {
    const session = newSession()
    const preStep = mount(session, echoingLlm())
    writeStep(session, { turn: 1, task: 'TASK: find the port', note: 'Looking.', toolOutput: 'FACT-X: port is 8080' })
    await preStep({ turn: 1, step: 2 })
    expect(textOf(session.deriveMessages())).toContain('TASK: find the port')
  })

  it('records the retained information for the step that finished', async () => {
    const session = newSession()
    const preStep = mount(session, echoingLlm())
    writeStep(session, { turn: 1, task: 'TASK: find the port', note: 'Looking.', toolOutput: 'FACT-X: port is 8080' })
    await preStep({ turn: 1, step: 2 })
    const written = session.snapshotEvents?.().filter(
      event => event.type === 'user/message' && event.data?.source?.plugin === 'stepwise-distill',
    ) ?? []
    expect(written.length).toBe(1)
    expect(written[0].data.summaryOf).toEqual({ turn: 1, step: 1 })
  })

  it('shows the retention call the step it is writing down', async () => {
    const session = newSession()
    const llm = echoingLlm()
    const preStep = mount(session, llm)
    writeStep(session, { turn: 1, task: 'TASK: find the port', note: 'Looking.', toolOutput: 'FACT-X: port is 8080' })
    await preStep({ turn: 1, step: 2 })
    expect(llm.requests.length).toBe(1)
    expect(llm.requests[0]).toContain('FACT-X')
  })

  it('carries what the step established into the next request', async () => {
    // The retained text replaces the step's raw material, so it is the only
    // record of that step the agent sees again. If it does not carry the step's
    // finding, the agent re-derives the step from scratch -- which is the
    // repetition this mechanism exists to prevent.
    const session = newSession()
    const preStep = mount(session, echoingLlm())
    writeStep(session, { turn: 1, task: 'TASK: find the port', note: 'Looking.', toolOutput: 'FACT-X: port is 8080' })
    await preStep({ turn: 1, step: 2 })
    const text = textOf(session.deriveMessages())
    expect(text).toContain('retained FACT-X')
    expect(text).not.toContain('port is 8080')
  })

  it('keeps earlier steps intact when a later step is written down', async () => {
    const session = newSession()
    const preStep = mount(session, echoingLlm())
    writeStep(session, { turn: 1, task: 'TASK: find the port', note: 'Looking.', toolOutput: 'FACT-X: port is 8080' })
    await preStep({ turn: 1, step: 2 })
    writeStep(session, { turn: 2, task: 'TASK: use the port', note: 'Using.', toolOutput: 'FACT-Y: client on 8080' })
    await preStep({ turn: 2, step: 2 })
    const text = textOf(session.deriveMessages())
    // The second request must carry both findings: history that does not
    // accumulate is history the agent cannot rely on.
    expect(text).toContain('retained FACT-X')
    expect(text).toContain('retained FACT-Y')
  })
})
