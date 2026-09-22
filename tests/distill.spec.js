import { describe, expect, it } from 'vitest'
import {
  dropSummarizedSteps,
  renderHistoryRead,
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
