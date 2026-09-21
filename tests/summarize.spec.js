import { describe, expect, it } from 'vitest'
import {
  SUMMARY_MARKER,
  TURN_MARKER,
  isNoTurnSummary,
  isSummaryText,
  isTurnText,
  parseSummary,
  renderStepMaterial,
  renderSummaryMessage,
  renderTurnMessage,
  summarizePrompt,
  turnInstruction,
  turnPrompt,
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
    expect(flat).toContain('这是读者今后唯一会再看到的关于这一步的记录')
    expect(flat).toContain('请写下这一步的完整记述')
    expect(flat).toContain('长度取决于这一步推进了什么')
    expect(flat).not.toContain('1-3 sentences')
  })

  it('names what must survive the step', () => {
    expect(flat).toContain('精确的标识符')
    expect(flat).toContain('改了什么、改成了什么')
    expect(flat).toContain('每个结论背后的证据')
    expect(flat).toContain('被排除的做法')
    expect(flat).toContain('尚未完成')
  })

  it('tells the summarizer the whole context is available to it', () => {
    expect(flat).toContain('你能看到全部上下文')
    expect(flat).toContain('这一步对任务意味着什么')
  })

  it('scopes the answer to the last step only', () => {
    expect(flat).toContain('如果这一步延续了那条记录所描述的事')
  })

  it('keeps the reasoning out', () => {
    // Restating the thinking recreates, one level up, the churn this exists to
    // remove -- so what to leave out is as load-bearing as what to keep.
    expect(flat).toContain('那是这一步的产出，属于记录的一部分')
    expect(flat).toContain('查看事物的顺序')
    expect(flat).toContain('不要重述任务或计划')
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

describe('turn records', () => {
  it('carries its own marker, distinct from the step marker', () => {
    // The step scan collects records by prefix. A turn record sharing that
    // prefix would be counted as a step record, reporting work that was never
    // summarized and standing in for a step nobody wrote about.
    const message = renderTurnMessage('  The user wants flags named explicitly.  ')
    expect(message).toBe(`${TURN_MARKER} The user wants flags named explicitly.`)
    expect(isTurnText(message)).toBe(true)
    expect(isSummaryText(message)).toBe(false)
    expect(isTurnText(`${SUMMARY_MARKER} x`)).toBe(false)
  })

  it('recognises the answer that says the turn added nothing', () => {
    // Most turns settle nothing worth keeping. The prompt asks for this word so
    // that "nothing to write" is distinguishable from an empty reply, which is
    // treated as a failure worth reporting.
    // Exact, after trimming and shedding trailing punctuation: the prompt asks
    // for this token, so a sentence merely starting with it does not qualify.
    for (const value of ['NONE', '  NONE  ', 'NONE.', 'NONE。']) {
      expect(isNoTurnSummary(value)).toBe(true)
    }
    expect(isNoTurnSummary('无')).toBe(true)
    expect(isNoTurnSummary('无。')).toBe(true)
    // Case matters: the token is what the prompt asks for, so a sentence
    // starting with a lower-case "none" is content, not a decline.
    expect(isNoTurnSummary('none')).toBe(false)
    expect(isNoTurnSummary('None of the above applies here.')).toBe(false)
    expect(isNoTurnSummary('None of the above applies here.')).toBe(false)
    expect(isNoTurnSummary('')).toBe(false)
  })

  it('asks about the turn, not the step', () => {
    // The two prompts are separate by design: a step record replaces its
    // material, a turn record is added on top. Reusing the step prompt would ask
    // the model to write down the last step a second time.
    const flat = turnPrompt()
    // The marker is added by `renderTurnMessage`, not by the prompt: it labels
    // the message written to the log, and the prompt has no reason to name it.
    expect(flat).not.toContain(TURN_MARKER)
    expect(flat).not.toContain('这是读者今后唯一会再看到的关于这一步的记录')
    expect(turnInstruction()).not.toContain('最后一步')
  })

  it('asks for what outlives the task, not for what the turn did', () => {
    // A real record written before this gate was added spent most of its length
    // on how one specific thing was checked -- the exact cursor timestamps that
    // told the new binary from the old one. Useful that afternoon, worthless on
    // the next task, and it crowded out the two lines that did generalise.
    // "What did this turn learn" invites that; the gate has to be stated.
    const flat = turnPrompt()
    expect(flat).toContain('跨任务')
    // The self-check is what makes the gate mechanical rather than aspirational.
    expect(flat).toContain('换一个完全不同的任务')
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
