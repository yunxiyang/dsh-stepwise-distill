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
import { apply, SOURCE_KIND } from '../src/index.js'

/** A fresh host session with the route a retention request has to reuse. */
function newSession() {
  const id = `continuity-${Math.random().toString(36).slice(2)}`
  const session = Session.create(id, [], {
    version: 4, id, createdAt: Date.now(), cwd: '/tmp', isSeeded: false,
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
    { stepSummary: true },
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
      event => event.type === 'user/message' && event.data?.source?.kind === SOURCE_KIND,
    ) ?? []
    expect(written.length).toBe(1)
    expect(written[0].data.summaryOf).toEqual({ turn: 1, step: 1 })
  })

  it('writes only producer-owned source kinds, as session format v4 demands', async () => {
    // Regression. The record was written as `{ kind: 'plugin', plugin: name }`,
    // the v3 wrapper. A v4 reader refuses it on persist -- "format v4 message
    // requires a producer-owned source kind" -- and since the record is appended
    // from a step hook, the refusal failed the whole turn.
    //
    // Checked over every message in the log rather than over the one record, so
    // the rule stands wherever a future record is written from.
    const session = newSession()
    const preStep = mount(session, echoingLlm())
    writeStep(session, { turn: 1, task: 'TASK: find the port', note: 'Looking.', toolOutput: 'FACT-X: port is 8080' })
    await preStep({ turn: 1, step: 2 })
    writeStep(session, { turn: 2, task: 'TASK: use the port', note: 'Using.', toolOutput: 'FACT-Y: client on 8080' })
    await preStep({ turn: 2, step: 2 })

    const messages = (session.snapshotEvents?.() ?? []).flatMap((event) => {
      if (event.type === 'user/message') return [event.data]
      const message = event.data?.message
      return message === undefined ? [] : [message]
    })
    expect(messages.length).toBeGreaterThan(0)
    for (const message of messages) {
      const source = message?.source
      if (source === undefined) continue
      // The host's own admission rule, restated: a producer-owned source kind is
      // a non-empty string, and the retired `plugin` wrapper is not one.
      expect(typeof source.kind).toBe('string')
      expect(source.kind).not.toBe('')
      expect(source.kind).not.toBe('plugin')
      expect(source).not.toHaveProperty('plugin')
    }
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
    // The conclusion reaches the next request; that is what the mechanism
    // exists to carry. If it does not, the agent re-derives the step from
    // scratch -- the repetition this exists to prevent.
    const session = newSession()
    const preStep = mount(session, echoingLlm())
    writeStep(session, { turn: 1, task: 'TASK: find the port', note: 'Looking.', toolOutput: 'FACT-X: port is 8080' })
    await preStep({ turn: 1, step: 2 })
    const text = textOf(session.deriveMessages())
    expect(text).toContain('retained FACT-X')
    // Step 1 is the newest record here, and the newest step deliberately keeps
    // its material beside its conclusion -- a concluded record was measurably
    // not enough to act on. So the material is expected, and what the next test
    // pins down is that it stops arriving once a newer step supersedes it.
    //
    // This only became visible on v4: a `tool/result` now derives to a native
    // `tool` message with flattened text, where v3 nested it under a
    // `tool-result` block that this file's top-level `textOf` could not see.
    expect(text).toContain('FACT-X: port is 8080')
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
    // And the earlier step's raw material is the thing actually dropped: turn 1
    // is no longer the newest record, so only its conclusion is left.
    expect(text).not.toContain('FACT-X: port is 8080')
  })
})
