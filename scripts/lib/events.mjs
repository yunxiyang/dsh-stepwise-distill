/**
 * Read a DSH session log without the harness runtime.
 *
 * The on-disk container is a concatenation of independently decodable
 * Zstandard frames, one per appended batch (see
 * `packages/session/session-persistence-jsonl/src/zstd.ts`). Node's
 * `zstdDecompressSync` refuses a multi-frame buffer, so the frames are located
 * structurally first and decoded one at a time.
 *
 * @module dsh-stepwise-distill/scripts/lib/events
 */

import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

/** Little-endian Zstandard frame magic as it appears on disk. */
const ZSTD_MAGIC = 0xfd2fb528

/**
 * Locate every complete frame in a concatenated Zstandard buffer.
 *
 * This mirrors the harness's own structural scan rather than searching for the
 * magic bytes: frame payloads may contain that byte sequence, and a false hit
 * would silently corrupt the decoded event stream.
 *
 * @param buffer - raw artifact bytes.
 * @returns `{ frames, tornStart }`, where `tornStart` marks an incomplete tail.
 */
export function scanZstdFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`invalid zstd frame magic at byte ${offset}`)
    }
    offset += 4

    if (offset === buffer.length) return { frames, tornStart: start }
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 0x18) !== 0) throw new Error(`reserved frame-header bit at byte ${offset - 1}`)

    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dictionaryFlag = descriptor & 0x03
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0
      ? (singleSegment ? 1 : 0)
      : 1 << contentSizeFlag
    const remaining = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remaining) return { frames, tornStart: start }
    offset += remaining

    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 0x03
      const blockSize = blockHeader >>> 3
      if (blockType === 0x03) throw new Error(`reserved block type at byte ${offset - 3}`)
      const payloadBytes = blockType === 0x01 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }

    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return { frames }
}

/**
 * Decode every frame of a session artifact into its JSONL rows.
 * @param buffer - raw artifact bytes.
 * @returns one array of parsed rows per frame, in file order.
 */
export function decodeRows(buffer) {
  const { frames, tornStart } = scanZstdFrames(buffer)
  const rows = []
  for (const frame of frames) {
    const text = zstdDecompressSync(buffer.subarray(frame.start, frame.end)).toString('utf8')
    const parsed = []
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      parsed.push(JSON.parse(line))
    }
    rows.push(parsed)
  }
  return { frames: rows, tornStart }
}

/**
 * Load one session log as a header plus its contiguous event sequence.
 *
 * The first JSONL record is the physical session header; every later record is
 * an event whose `seq` equals its index in the event array, which is the
 * invariant the surface fold relies on.
 *
 * @param path - path to a `.jsonl.zstd` session artifact.
 * @returns `{ header, events, frameCount, torn }`.
 */
export function loadSession(path) {
  const buffer = readFileSync(path)
  const { frames, tornStart } = decodeRows(buffer)
  const flat = frames.flat()
  if (flat.length === 0) throw new Error(`${path}: no JSONL records`)

  const [header, ...events] = flat
  if (header?.type !== 'session') throw new Error(`${path}: first record is not a session header`)

  // Format v3 numbers every event row by its position. Format v0 interleaves
  // compressed replay records (`reasoning-chunks`, `text-chunks`,
  // `tool-call-chunks`) that carry `seq0` instead of `seq`: they restore native
  // streaming fidelity and never project a message, so they consume no event
  // number. Both formats therefore reduce to the same rule -- keep exactly the
  // rows carrying a `seq`, in log order, and require that numbering to be
  // strictly increasing and unique.
  const numbered = events.filter(event => event.seq !== undefined)
  for (const [index, event] of numbered.entries()) {
    const seq = event.seq
    if (!Number.isSafeInteger(seq) || seq < 0) {
      throw new Error(`${path}: an event carries a non-integer seq ${String(seq)}`)
    }
    if (index > 0 && seq <= numbered[index - 1].seq) {
      throw new Error(
        `${path}: seq ${seq} does not follow ${numbered[index - 1].seq}`,
      )
    }
  }

  return {
    header,
    events: numbered,
    replayRecords: events.length - numbered.length,
    frameCount: frames.length,
    torn: tornStart !== undefined,
    format: header.version ?? 0,
  }
}

/**
 * Derive the model-facing message of one event, mirroring
 * `deriveEventMessage` in `packages/core/session/src/surface.ts`.
 * @param event - a session event.
 * @returns the message the event projects, or null when it produces none.
 */
export function deriveEventMessage(event) {
  switch (event?.type) {
    case 'user/message':
      return event.data
    case 'system/message':
    case 'assistant/message': {
      const message = event.data?.message
      if (!Array.isArray(message?.content) || message.content.length === 0) return null
      return message
    }
    case 'tool/result':
      return event.data?.message ?? null
    default:
      return null
  }
}

/**
 * Fold a full event log into its current surface.
 *
 * A node is appended when its event carries `surfaceOp: 'append'`, and a
 * `replace` shadows the inclusive node range `[startSeq, endSeq]` and takes its
 * place. Events without a `surfaceOp` are trace data and never reach the model.
 *
 * @param events - events in contiguous seq order.
 * @returns `{ nodes, replacements, prunes }` describing the folded surface.
 */
export function foldSurface(events) {
  const nodes = []
  const replacements = []
  const prunes = []

  for (const event of events) {
    const op = event.surfaceOp
    if (op === 'append') {
      nodes.push(event.seq)
      continue
    }
    if (op === undefined || op === null) {
      if (event.type === 'compaction/prune') {
        prunes.push({ seq: event.seq, shadowedSeqs: event.data?.shadowedSeqs ?? [] })
      }
      continue
    }
    if (typeof op !== 'object') throw new Error(`event ${event.seq}: invalid surfaceOp`)

    // Format v0 named the range endpoints `start`/`end`; v3 renamed them to
    // `startSeq`/`endSeq`. Both mean inclusive surface node sequences.
    const start = op.startSeq ?? op.start
    const end = op.endSeq ?? op.end
    if (start === undefined || end === undefined) {
      throw new Error(`event ${event.seq}: replace surfaceOp has no range`)
    }
    const startIdx = nodes.indexOf(start)
    const endIdx = nodes.indexOf(end)
    if (startIdx === -1 || endIdx === -1) {
      throw new Error(`event ${event.seq}: replace range ${start}..${end} is not on the surface`)
    }
    const shadowed = nodes.slice(startIdx, endIdx + 1)
    nodes.splice(startIdx, endIdx - startIdx + 1, event.seq)
    replacements.push({ seq: event.seq, shadowedSeqs: shadowed })
  }

  return { nodes, replacements, prunes }
}
