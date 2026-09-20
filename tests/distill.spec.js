import { describe, expect, it } from 'vitest'
import {
  dropSummarizedSteps,
  reasoningContract,
  renderHistoryRead,
  stripReasoning,
  stripReasoningFrom,
  textLeaves,
} from '../src/distill.js'

const text = value => ({ type: 'text', text: value })
const reasoning = value => ({ type: 'reasoning', text: value })
describe('text leaves', () => {
  it('addresses each text block inside a tool-result', () => {
    const message = {
      content: [
        { type: 'tool-result', toolCallId: 'c1', content: [text('out'), { type: 'image' }] },
      ],
    }
    expect(textLeaves(message)).toEqual([{ outer: 0, index: 0, text: 'out' }])
  })

  it('returns nothing for a malformed message', () => {
    expect(textLeaves({})).toEqual([])
    expect(textLeaves({ content: [{ type: 'tool-result' }] })).toEqual([])
  })

})
describe('reasoning contract', () => {
  const section = reasoningContract()

  it('states the consequence before asking for anything', () => {
    // The consequence is the only leverage a text contract has. Stated as a
    // fact about how the turn works, not as a threat, because the model has to
    // believe it to act on it.
    expect(section).toContain('NOT kept between steps')
    expect(section).toContain('Only what you write in your reply survives')
  })

  it('asks for the conclusion, its reason, and its evidence', () => {
    expect(section).toContain('what you concluded')
    expect(section).toContain('why')
    expect(section).toContain('what evidence')
  })

  it('asks for it every step, including failed ones', () => {
    // A step that found nothing is exactly the step whose conclusion is most
    // expensive to rediscover, and the easiest one for a model to skip.
    expect(section).toContain('every step')
    expect(section).toContain('did or did not work')
  })

  it('asks for the conclusion rather than the path', () => {
    expect(section).toContain('not the path')
    expect(section).toContain('do not narrate the search')
  })

  it('does not ask for a specific number of words', () => {
    // A length target turns into padding, which is the failure this section
    // exists to prevent.
    expect(section).not.toMatch(/\b\d+\s+(words|sentences|lines)\b/)
  })
})

describe('reasoning strip', () => {
  it('removes reasoning and keeps everything else', () => {
    const message = { role: 'assistant', content: [reasoning('churn'), text('the fix landed')] }
    expect(stripReasoning(message)).toEqual({
      role: 'assistant', content: [text('the fix landed')],
    })
  })

  it('returns the same object when there is nothing to strip', () => {
    // Identity, not deep equality: the projection hot path must not allocate
    // for a session that carries no reasoning at all.
    const message = { role: 'assistant', content: [text('done')] }
    expect(stripReasoning(message)).toBe(message)
  })

  it('keeps a tool call even when the message had no prose', () => {
    // Dropping it would orphan the tool result, and a request carrying a
    // result no call produced is rejected outright.
    const message = {
      role: 'assistant',
      content: [reasoning('churn'), { type: 'tool-call', name: 'exec_command' }],
    }
    expect(stripReasoning(message).content).toEqual([{ type: 'tool-call', name: 'exec_command' }])
  })

  it('drops a message that was nothing but reasoning', () => {
    // The host's own rule is that an empty-content message does not join the
    // surface, so `null` here is the same rule applied one step earlier.
    expect(stripReasoning({ role: 'assistant', content: [reasoning('churn')] })).toBeNull()
  })

  it('leaves a malformed message untouched', () => {
    expect(stripReasoning({ role: 'assistant' })).toEqual({ role: 'assistant' })
    expect(stripReasoning({ role: 'assistant', content: 'not an array' }).content).toBe('not an array')
  })

  it('drops emptied messages from a list and keeps the rest in order', () => {
    const messages = [
      { role: 'user', content: [text('do it')] },
      { role: 'assistant', content: [reasoning('only churn')] },
      { role: 'assistant', content: [reasoning('churn'), text('done')] },
    ]
    const out = stripReasoningFrom(messages)
    expect(out).toHaveLength(2)
    expect(out[0].content).toEqual([text('do it')])
    expect(out[1].content).toEqual([text('done')])
  })

  it('returns the original list when nothing changed', () => {
    const messages = [{ role: 'user', content: [text('do it')] }]
    expect(stripReasoningFrom(messages)).toBe(messages)
  })

  it('preserves every non-reasoning block type', () => {
    // tool-call args, text and images all have to survive untouched: the
    // strip must be surgical, not a rebuild of the message.
    const blocks = [
      text('a'),
      { type: 'tool-call', id: 'c1', name: 'read', arguments: '{"path":"x"}' },
      { type: 'image', attachment: { id: 'img-1' } },
    ]
    const out = stripReasoning({ role: 'assistant', content: [reasoning('r'), ...blocks] })
    expect(out.content).toEqual(blocks)
  })
})

describe('tool call retrieval', () => {
  const call = {
    seq: 7,
    type: 'tool/call',
    data: { turn: 1, step: 1, name: 'apply_patch', arguments: '{"input":"*** Begin Patch\\n*** Update File: a.rs\\n*** End Patch"}' },
  }

  it('returns the arguments the model actually wrote', () => {
    // The point of reading a call back: the patch text is what the model
    // produced, and the file it patched has moved on since.
    const out = renderHistoryRead(call, 7)
    expect(out.ok).toBe(true)
    expect(out.text).toContain('type="tool/call"')
    expect(out.text).toContain('name="apply_patch"')
    expect(out.text).toContain('Begin Patch')
  })

  it('reformats escaped JSON so the text is readable', () => {
    // Arguments arrive as a JSON string; returning it raw would hand back a
    // wall of escapes for a call whose only purpose is reading the patch.
    const out = renderHistoryRead(call, 7)
    expect(out.text).toContain('reformatted="json"')
    expect(out.text).toContain('*** Update File: a.rs')
    // The patch arrives as real line breaks, not a single line of `\n`.
    expect(out.text).not.toContain('\\n')
    const body = out.text.split('\n')
    expect(body).toContain('*** Begin Patch')
    expect(body).toContain('*** Update File: a.rs')
    expect(body).toContain('*** End Patch')
  })

  it('unwraps a single-field argument to its value', () => {
    // `{"input": "..."}` is a wrapper, not content: the model asked to read the
    // patch, not the field name around it.
    const out = renderHistoryRead(call, 7)
    expect(out.text).not.toContain('input:')
    expect(out.text.startsWith('<original')).toBe(true)
  })

  it('lists multiple fields each on its own line', () => {
    const multi = {
      seq: 8,
      type: 'tool/call',
      data: { name: 'exec_command', arguments: '{"cmd":"ls -la","timeout":30}' },
    }
    const out = renderHistoryRead(multi, 8)
    expect(out.text).toContain('cmd: ls -la')
    expect(out.text).toContain('timeout: 30')
  })

  it('returns a non-JSON argument string unchanged rather than refusing', () => {
    const bare = { seq: 9, type: 'tool/call', data: { name: 'raw', arguments: 'plain text' } }
    const out = renderHistoryRead(bare, 9)
    expect(out.ok).toBe(true)
    expect(out.text).toContain('plain text')
    expect(out.text).not.toContain('reformatted')
  })

  it('refuses a call with no arguments', () => {
    const empty = { seq: 11, type: 'tool/call', data: { name: 'x', arguments: '' } }
    expect(renderHistoryRead(empty, 11).text).toContain('carries no arguments')
  })

  it('names both readable types in its refusal', () => {
    const out = renderHistoryRead({ seq: 3, type: 'step/start', data: {} }, 3)
    expect(out.ok).toBe(false)
    expect(out.text).toContain('tool call')
  })
})
