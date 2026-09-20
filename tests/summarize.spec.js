import { describe, expect, it } from 'vitest'
import {
  SUMMARY_MARKER,
  isSummaryText,
  parseSummary,
  renderStepMaterial,
  renderSummaryMessage,
  summarizePrompt,
} from '../src/summarize.js'
import { dropSummarizedSteps } from '../src/distill.js'

const text = value => ({ type: 'text', text: value })
const reasoning = value => ({ type: 'reasoning', text: value })

describe('summary prompt', () => {
  const prompt = summarizePrompt()
  const flat = prompt.replace(/\s+/g, ' ')

  it('asks for a complete record, not a digest', () => {
    // The summary REPLACES its step: raw material stops being replayed, so this
    // is the only record of that step the agent sees again. An earlier version
    // asked for "1-3 sentences" and produced summaries too thin to work from --
    // the agent lost the thread and re-asked what it had already answered.
    expect(flat).toContain('the only record of that step')
    expect(flat).toContain('complete account of what happened')
    expect(flat).toContain('Length follows what the step moved forward')
    expect(flat).not.toContain('1-3 sentences')
  })

  it('names what must survive the step', () => {
    expect(flat).toContain('exact identifiers')
    expect(flat).toContain('what was changed')
    expect(flat).toContain('the evidence behind each conclusion')
    expect(flat).toContain('ruled out')
    expect(flat).toContain('left unfinished')
  })

  it('tells the summarizer the whole context is available to it', () => {
    expect(flat).toContain('You can see the whole context')
    expect(flat).toContain('what the step meant for the task')
  })

  it('scopes the answer to the last step only', () => {
    expect(flat).toContain('If this step continues what that record described')
  })

  it('keeps the reasoning out', () => {
    // Restating the thinking recreates, one level up, the churn this exists to
    // remove -- so what to leave out is as load-bearing as what to keep.
    expect(flat).toContain("the step's outcome, and it belongs in the record")
    expect(flat).toContain('the order things were looked at')
    expect(flat).toContain('Do not restate the task')
  })
})

describe('step material rendering', () => {
  it('labels each piece by kind and keeps their order', () => {
    const out = renderStepMaterial([
      { kind: 'reasoning', text: 'thinking' },
      { kind: 'tool call: apply_patch', text: 'patch body' },
      { kind: 'tool output', text: 'Done!' },
    ])
    expect(out.indexOf('thinking')).toBeLessThan(out.indexOf('patch body'))
    expect(out.indexOf('patch body')).toBeLessThan(out.indexOf('Done!'))
    expect(out).toContain('--- tool call: apply_patch ---')
  })

  it('skips empty pieces rather than emitting empty sections', () => {
    const out = renderStepMaterial([
      { kind: 'reasoning', text: '   ' },
      { kind: 'tool output', text: 'real' },
    ])
    expect(out).not.toContain('reasoning')
    expect(out).toContain('real')
  })

  it('survives a missing piece', () => {
    expect(() => renderStepMaterial([undefined, { kind: 'x', text: 'y' }])).not.toThrow()
  })
})

describe('summary parsing', () => {
  it('returns the text and nothing else', () => {
    expect(parseSummary([text('Changed the cache key to include the tenant.')]))
      .toBe('Changed the cache key to include the tenant.')
  })

  it('discards the summarizer\'s own reasoning', () => {
    // The summarizer may think; that thinking is process too, and carrying it
    // forward recreates the problem at one level up.
    const out = parseSummary([reasoning('let me consider...'), text('The flag is off by default.')])
    expect(out).toBe('The flag is off by default.')
    expect(out).not.toContain('consider')
  })

  it('treats an empty answer as no summary', () => {
    expect(parseSummary([text('')])).toBe('')
    expect(parseSummary([])).toBe('')
    expect(parseSummary(undefined)).toBe('')
  })

  it('keeps a step that says nothing was concluded', () => {
    // "no conclusion" IS a finding -- the step was tried and produced nothing --
    // and dropping it makes the reader repeat work that already failed once.
    expect(parseSummary([{ type: 'text', text: 'no conclusion' }])).toBe('no conclusion')
  })

  it('keeps a sentence that merely starts like an acknowledgement', () => {
    expect(parseSummary([text('Nothing needed later in this file.')]))
      .toBe('Nothing needed later in this file.')
  })
})

describe('stored summary messages', () => {
  it('round-trips through the marker', () => {
    const message = renderSummaryMessage('  The flag is off by default.  ')
    expect(message).toBe(`${SUMMARY_MARKER} The flag is off by default.`)
    expect(isSummaryText(message)).toBe(true)
  })

  it('does not mistake ordinary text for a summary', () => {
    expect(isSummaryText('the step summary says otherwise')).toBe(false)
    expect(isSummaryText(undefined)).toBe(false)
  })
})

describe('dropping summarized material', () => {
  const stepOf = (message) => message.step

  it('drops the raw messages of a summarized step, and not the summary', () => {
    const messages = [
      { id: '1', step: '2/1', text: 'raw assistant' },
      { id: '2', step: '2/1', text: 'raw tool result' },
      { id: '3', text: 'the summary itself' },
      { id: '4', step: '3/1', text: 'later step' },
    ]
    const out = dropSummarizedSteps(messages, new Set(['2/1']), stepOf)
    expect(out.map(m => m.id)).toEqual(['3', '4'])
  })

  it('leaves a message with no known step alone', () => {
    // System prompt and injected context belong to no step; dropping them
    // would strip the request of instructions.
    const messages = [{ id: 'a' }, { id: 'b', step: '1/1' }]
    const out = dropSummarizedSteps(messages, new Set(['1/1']), stepOf)
    expect(out.map(m => m.id)).toEqual(['a'])
  })

  it('returns the original list when nothing is summarized', () => {
    const messages = [{ id: 'a', step: '1/1' }]
    expect(dropSummarizedSteps(messages, new Set(), stepOf)).toBe(messages)
  })

  it('returns the original list when nothing matched', () => {
    const messages = [{ id: 'a', step: '9/9' }]
    expect(dropSummarizedSteps(messages, new Set(['1/1']), stepOf)).toBe(messages)
  })

  it('tolerates a non-list input', () => {
    expect(dropSummarizedSteps(undefined, new Set(['1/1']), stepOf)).toBeUndefined()
  })
})
