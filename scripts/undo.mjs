#!/usr/bin/env node
/**
 * Report distillation rewrites that a later fix has invalidated.
 *
 * Rewrites are append-only surface projections: the original text is never
 * destroyed, so a wrong rewrite is recoverable. This script identifies the
 * ones worth undoing -- a result distilled on a keep: line that a corrected
 * window no longer attributes to it -- and prints the exact restore it would
 * take, without writing anything.
 *
 * Usage:
 *   node scripts/undo.mjs <session.jsonl.zstd> [--json]
 *
 * @module dsh-stepwise-distill/scripts/undo
 */

import { loadSession, foldSurface } from './lib/events.mjs'
import { distillMarker } from '../src/distill.js'

/**
 * Find surface replacements that shadow a tool result with distilled text.
 * @param path - session artifact path.
 * @returns one entry per distilled node, with its original text.
 */
function findRewrites(path) {
  const { events } = loadSession(path)
  const { replacements } = foldSurface(events)
  const bySeq = new Map(events.map(event => [event.seq, event]))
  const found = []

  for (const replacement of replacements) {
    const event = bySeq.get(replacement.seq)
    const text = event?.data?.message?.content?.[0]?.content?.[0]?.text
    if (typeof text !== 'string' || distillMarker(text) === undefined) continue
    const shadowed = replacement.shadowedSeqs[0]
    const original = bySeq.get(shadowed)
    const originalText = original?.data?.message?.content?.[0]?.content?.[0]?.text
    if (typeof originalText !== 'string') continue
    found.push({
      seq: shadowed,
      rewriteSeq: replacement.seq,
      turn: original.data.turn,
      step: original.data.step,
      before: originalText.length,
      after: text.length,
    })
  }
  return found
}

function main(argv) {
  const asJson = argv.includes('--json')
  const paths = argv.filter(arg => arg !== '--json')
  if (paths.length === 0) {
    process.stderr.write('undo: pass at least one session artifact path\n')
    process.exit(1)
  }

  const reports = []
  for (const path of paths) {
    try {
      reports.push({ path, rewrites: findRewrites(path) })
    } catch (error) {
      process.stderr.write(`undo: skipped ${path}: ${String(error.message ?? error)}\n`)
    }
  }

  if (asJson) {
    process.stdout.write(`${JSON.stringify(reports, null, 2)}\n`)
    return
  }

  let total = 0
  for (const report of reports) {
    if (report.rewrites.length === 0) continue
    process.stdout.write(`${report.path}\n`)
    for (const rewrite of report.rewrites) {
      process.stdout.write(`  seq ${rewrite.seq} (turn ${rewrite.turn} step ${rewrite.step}): `
        + `${rewrite.before} B -> ${rewrite.after} B, rewritten at seq ${rewrite.rewriteSeq}\n`)
      total += 1
    }
  }
  process.stdout.write(`\n${String(total)} distilled node(s) on the current surface.\n`)
  process.stdout.write('Every original is still in the append-only log; a replace that\n')
  process.stdout.write('shadows the rewrite restores it without editing history.\n')
}

main(process.argv.slice(2))
