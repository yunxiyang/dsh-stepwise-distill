import { describe, expect, it } from 'vitest'
import {
  DISTILL_MARKER,
  buildDistilledText,
  contractSection,
  isDistilled,
  isNumbered,
  numberLines,
  parseIndices,
  parseKeep,
  shouldNumber,
  splitLines,
  stripNumberPrefix,
  textLeaves,
} from '../src/distill.js'

const text = value => ({ type: 'text', text: value })
const reasoning = value => ({ type: 'reasoning', text: value })

describe('line numbering', () => {
  it('numbers every line from one', () => {
    expect(numberLines('a\nb\nc')).toBe('[1] a\n[2] b\n[3] c')
  })

  it('treats a trailing newline as a terminator, not an empty line', () => {
    expect(splitLines('a\nb\n')).toEqual(['a', 'b'])
    expect(numberLines('a\nb\n')).toBe('[1] a\n[2] b')
  })

  it('keeps interior blank lines numbered so indices stay aligned', () => {
    expect(numberLines('a\n\nb')).toBe('[1] a\n[2] \n[3] b')
  })

  it('passes short results through unnumbered', () => {
    expect(shouldNumber('a\nb\nc', 20)).toBe(false)
    expect(shouldNumber(Array.from({ length: 21 }, () => 'x').join('\n'), 20)).toBe(true)
  })

  it('never numbers empty content', () => {
    expect(shouldNumber('', 1)).toBe(false)
    expect(shouldNumber(undefined, 1)).toBe(false)
  })

  it('never numbers a result that already carries numbering', () => {
    // The rewrite is durable: it lands in the session log, so the next pass
    // reads the numbers as part of the text. Numbering again would stack
    // prefixes and shift every index the model refers to.
    const once = numberLines(Array.from({ length: 30 }, (_, i) => `row ${i}`).join('\n'))
    expect(isNumbered(once)).toBe(true)
    expect(shouldNumber(once, 20)).toBe(false)
  })

  it('does not mistake content that merely starts with a bracket', () => {
    expect(isNumbered('[note] first\nplain second\nplain third')).toBe(false)
    expect(isNumbered('[1] only one line')).toBe(false)
  })
})

describe('keep contract', () => {
  it('reads a plain index list', () => {
    expect(parseKeep([text('done\nkeep: 3,7,12')])).toEqual({
      found: true, indices: [3, 7, 12], malformed: false,
    })
  })

  it('sorts and de-duplicates so output is deterministic', () => {
    expect(parseIndices('12, 3, 7, 3')).toEqual([3, 7, 12])
  })

  it('prefers reasoning, which the transport layer strips anyway', () => {
    expect(parseKeep([reasoning('thinking\nkeep: 1'), text('answer')])).toEqual({
      found: true, indices: [1], malformed: false,
    })
  })

  it('reads a keep line from reasoning when no text block exists', () => {
    expect(parseKeep([reasoning('keep: 2,4')])).toEqual({
      found: true, indices: [2, 4], malformed: false,
    })
  })

  it('reports absence rather than an empty selection', () => {
    expect(parseKeep([text('all done, nothing to keep')])).toEqual({
      found: false, indices: [], malformed: false,
    })
  })

  it('reports a malformed list as null, never as an empty selection', () => {
    // Reading "3, 7x" as "keep nothing" would delete a whole result on a typo.
    expect(parseIndices('3, 7x, 12')).toBeNull()
    expect(parseIndices('3, -7')).toBeNull()
    expect(parseIndices('0')).toBeNull()
    expect(parseIndices('three')).toBeNull()
  })

  it('flags a malformed line so the node keeps its original text', () => {
    expect(parseKeep([text('keep: three')])).toEqual({
      found: true, indices: [], malformed: true,
    })
  })

  it('treats an explicit empty selection as keeping nothing', () => {
    expect(parseKeep([text('keep: none')])).toEqual({
      found: true, indices: [], malformed: false,
    })
    expect(parseKeep([text('keep:')])).toEqual({
      found: true, indices: [], malformed: false,
    })
  })

  it('is case-insensitive about the prefix', () => {
    expect(parseKeep([text('Keep: 5')]).indices).toEqual([5])
  })
})

describe('distilled text', () => {
  const RAW = Array.from({ length: 42 }, (_, i) => `line ${i + 1}`).join('\n')
  const NUMBERED = numberLines(RAW)
  const distilled = buildDistilledText({
    toolName: 'exec_command',
    isError: false,
    totalLines: 42,
    keptLines: NUMBERED.split('\n'),
    keptIndices: [3, 7, 12],
    originalText: 'x'.repeat(900),
    seq: 8412,
  })

  it('states the tool, outcome, and line counts', () => {
    expect(distilled).toContain('[exec_command] ok, 42 lines -> kept 3')
  })

  it('strips the counter prefix from kept facts', () => {
    expect(distilled).toContain('3: line 3; 7: line 7; 12: line 12')
  })

  it('carries the retrieval handle for everything it drops', () => {
    expect(distilled).toContain('full: session seq 8412 (history_read)')
  })

  it('is marked so replay cannot distill it twice', () => {
    expect(isDistilled(distilled)).toBe(true)
    expect(isDistilled('plain output')).toBe(false)
  })

  it('is deterministic', () => {
    const again = buildDistilledText({
      toolName: 'exec_command',
      isError: false,
      totalLines: 42,
      keptLines: NUMBERED.split('\n'),
      keptIndices: [3, 7, 12],
      originalText: 'x'.repeat(900),
      seq: 8412,
    })
    expect(again).toBe(distilled)
  })

  it('reports an error result distinctly', () => {
    const failed = buildDistilledText({
      toolName: 'exec_command',
      isError: true,
      totalLines: 3,
      keptLines: ['[1] a', '[2] b', '[3] c'],
      keptIndices: [2],
      originalText: 'abc',
      seq: 9,
    })
    expect(failed).toContain('[exec_command] ERROR, 3 lines')
  })

  it('is smaller than the original it replaces', () => {
    expect(distilled.length).toBeLessThan(RAW.length)
  })
})

  describe('marker parsing', () => {
  it('ignores a marker-looking substring quoted mid-line', () => {
    // A raw result may quote the word; treating that as distilled would
    // permanently exempt the node from distillation.
    expect(isDistilled('output mentions distilled: but is not marked')).toBe(false)
  })

  it('recognizes the marker only on a line of its own', () => {
    expect(isDistilled('line one\ndistilled: 2/9 lines, 7 dropped')).toBe(true)
    expect(isDistilled('prefix distilled: 2/9 lines')).toBe(false)
  })

  it('tolerates a missing number prefix', () => {
    expect(stripNumberPrefix('plain line')).toBe('plain line')
  })
})

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

  it('exports its marker for the host to recognize', () => {
    expect(DISTILL_MARKER).toBe('distilled:')
  })
})

describe('prompt contract', () => {
  const section = contractSection(20)

  it('states the exact line syntax the parser accepts', () => {
    expect(section).toContain('keep: 3,7,12')
  })

  it('names the threshold the plugin numbers at', () => {
    expect(section).toContain('longer than 20 lines')
  })

  it('makes the silent default explicit', () => {
    // A model that omits the line must know that omission keeps everything;
    // otherwise it may believe silence means "drop it all".
    expect(section).toContain('without that line keeps every result of that step verbatim')
  })

  it('says dropping a line is recoverable, so the choice is not destructive', () => {
    expect(section).toContain('read the original back on demand')
  })

  it('is deterministic', () => {
    expect(contractSection(20)).toBe(section)
  })
})
