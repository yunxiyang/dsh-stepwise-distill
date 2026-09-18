import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { deriveEventMessage, foldSurface, loadSession, scanZstdFrames } from '../scripts/lib/events.mjs'

const text = value => ({ type: 'text', text: value })

/**
 * Write one session artifact the way the harness does: a header record plus
 * event rows, compressed into independently decodable frames.
 */
function writeArtifact(header, eventRows, rowsPerFrame = 2) {
  const dir = mkdtempSync(join(tmpdir(), 'distill-'))
  const path = join(dir, 'session.jsonl.zstd')
  const frames = [zstdCompressSync(`${JSON.stringify(header)}\n`)]
  for (let index = 0; index < eventRows.length; index += rowsPerFrame) {
    const batch = eventRows.slice(index, index + rowsPerFrame)
    frames.push(zstdCompressSync(`${batch.map(row => JSON.stringify(row)).join('\n')}\n`))
  }
  writeFileSync(path, Buffer.concat(frames))
  return path
}

const HEADER_V3 = {
  type: 'session', version: 3, id: 'session-test', createdAt: 1, isSeeded: false, delegationDepth: 0,
}

describe('zstd frame scanning', () => {
  it('finds every concatenated frame', () => {
    const buffer = Buffer.concat([zstdCompressSync('a'), zstdCompressSync('b'), zstdCompressSync('c')])
    expect(scanZstdFrames(buffer).frames).toHaveLength(3)
  })

  it('reports an incomplete trailing frame instead of decoding garbage', () => {
    const whole = zstdCompressSync('hello world, a reasonably long payload')
    const buffer = whole.subarray(0, whole.length - 4)
    const scan = scanZstdFrames(buffer)
    expect(scan.frames).toHaveLength(0)
    expect(scan.tornStart).toBe(0)
  })

  it('refuses a buffer that is not an artifact', () => {
    expect(() => scanZstdFrames(Buffer.from('not zstd at all'))).toThrow(/magic/)
  })
})

describe('reading session artifacts', () => {
  it('reads a v3 log whose seqs match their positions', () => {
    const path = writeArtifact(HEADER_V3, [
      { type: 'step/start', seq: 0, data: { turn: 1, step: 1 } },
      { type: 'tool/result', seq: 1, data: { turn: 1, step: 1, message: { content: [text('out')] } } },
    ])
    const session = loadSession(path)
    expect(session.header.id).toBe('session-test')
    expect(session.events.map(event => event.seq)).toEqual([0, 1])
    expect(session.format).toBe(3)
  })

  it('drops v0 replay records, which carry seq0 and project no message', () => {
    const path = writeArtifact({ ...HEADER_V3, version: 0 }, [
      { type: 'step/start', seq: 0, data: { turn: 1, step: 1 } },
      { type: 'reasoning-chunks', seq0: 1, data: { texts: ['a'] } },
      { type: 'tool/result', seq: 2, data: { turn: 1, step: 1, message: { content: [text('out')] } } },
    ])
    const session = loadSession(path)
    expect(session.events.map(event => event.seq)).toEqual([0, 2])
    expect(session.replayRecords).toBe(1)
  })

  it('refuses a log whose numbering goes backwards', () => {
    const path = writeArtifact(HEADER_V3, [
      { type: 'step/start', seq: 5, data: { turn: 1, step: 1 } },
      { type: 'turn/start', seq: 4, data: { turn: 1 } },
    ])
    expect(() => loadSession(path)).toThrow(/does not follow/)
  })

  it('refuses a duplicate seq', () => {
    const path = writeArtifact(HEADER_V3, [
      { type: 'step/start', seq: 3, data: { turn: 1, step: 1 } },
      { type: 'turn/start', seq: 3, data: { turn: 1 } },
    ])
    expect(() => loadSession(path)).toThrow(/does not follow/)
  })

  it('refuses a record that is not a session header', () => {
    const path = writeArtifact({ type: 'nope' }, [])
    expect(() => loadSession(path)).toThrow(/session header/)
  })
})

describe('message projection', () => {
  it('projects the four surface shapes and nothing else', () => {
    const message = { content: [text('x')] }
    expect(deriveEventMessage({ type: 'user/message', data: message })).toBe(message)
    expect(deriveEventMessage({ type: 'tool/result', data: { message } })).toBe(message)
    expect(deriveEventMessage({ type: 'assistant/message', data: { message } })).toBe(message)
    expect(deriveEventMessage({ type: 'step/start', data: message })).toBeNull()
  })

  it('projects an empty message to nothing, matching the harness', () => {
    expect(deriveEventMessage({
      type: 'assistant/message', data: { message: { content: [] } },
    })).toBeNull()
  })
})

describe('surface folding', () => {
  it('appends nodes and records prunes', () => {
    const folded = foldSurface([
      { seq: 0, type: 'system/message', surfaceOp: 'append', data: {} },
      { seq: 1, type: 'tool/result', surfaceOp: 'append', data: {} },
      { seq: 2, type: 'compaction/prune', data: { shadowedSeqs: [1] } },
    ])
    expect(folded.nodes).toEqual([0, 1])
    expect(folded.prunes).toEqual([{ seq: 2, shadowedSeqs: [1] }])
  })

  it('replaces an inclusive node range, as v3 spells it', () => {
    const folded = foldSurface([
      { seq: 0, type: 'system/message', surfaceOp: 'append', data: {} },
      { seq: 1, type: 'tool/result', surfaceOp: 'append', data: {} },
      {
        seq: 2,
        type: 'tool/result',
        surfaceOp: { op: 'replace', startSeq: 1, endSeq: 1 },
        data: {},
      },
    ])
    expect(folded.nodes).toEqual([0, 2])
    expect(folded.replacements).toEqual([{ seq: 2, shadowedSeqs: [1] }])
  })

  it('accepts the v0 range field names', () => {
    const folded = foldSurface([
      { seq: 0, type: 'system/message', surfaceOp: 'append', data: {} },
      { seq: 7, type: 'tool/result', surfaceOp: 'append', data: {} },
      { seq: 9, type: 'tool/result', surfaceOp: { op: 'replace', start: 7, end: 7 }, data: {} },
    ])
    expect(folded.nodes).toEqual([0, 9])
  })

  it('refuses a replace pointing at a node that is not on the surface', () => {
    expect(() => foldSurface([
      { seq: 0, type: 'system/message', surfaceOp: 'append', data: {} },
      { seq: 1, type: 'tool/result', surfaceOp: { op: 'replace', startSeq: 42, endSeq: 42 }, data: {} },
    ])).toThrow(/not on the surface/)
  })

  it('refuses a replace with no range at all', () => {
    expect(() => foldSurface([
      { seq: 0, type: 'system/message', surfaceOp: 'append', data: {} },
      { seq: 1, type: 'tool/result', surfaceOp: { op: 'replace' }, data: {} },
    ])).toThrow(/no range/)
  })
})

describe('measure CLI', () => {
  it('measures a real artifact end to end', () => {
    const path = writeArtifact(HEADER_V3, [
      { type: 'system/message', seq: 0, surfaceOp: 'append', data: { message: { content: [text('sys')] } } },
      { type: 'tool/call', seq: 1, data: { turn: 1, step: 1, callId: 'c1', name: 'exec_command' } },
      {
        type: 'tool/result',
        seq: 2,
        surfaceOp: 'append',
        data: {
          turn: 1,
          step: 1,
          source: { kind: 'tool', callId: 'c1' },
          message: {
            content: [{
              type: 'tool-result',
              toolCallId: 'c1',
              content: [text(Array.from({ length: 25 }, (_, i) => `row ${i}`).join('\n'))],
            }],
          },
        },
      },
      { type: 'turn/end', seq: 3, data: { turn: 1 } },
    ])
    const out = execFileSync('node', ['scripts/measure.mjs', path], { encoding: 'utf8' })
    expect(out).toContain('session  session-test')
    expect(out).toContain('tool result')
    expect(out).toContain('distillation ceiling')
    expect(out).toContain('1 of 1 text leaves are >20 lines')
  })

  it('exits non-zero when there is nothing to measure', () => {
    const empty = mkdtempSync(join(tmpdir(), 'distill-empty-'))
    expect(() => execFileSync('node', ['scripts/measure.mjs', empty], { encoding: 'utf8' }))
      .toThrow()
  })
})
