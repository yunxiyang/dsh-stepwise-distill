#!/usr/bin/env node
/**
 * Audit what distillation actually did to real sessions.
 *
 * `measure.mjs` answers "what could be saved"; this answers "what happened".
 * It reads the surface rather than the raw log, so a distilled node shows up as
 * its replacement text, and reports every decision the plugin made alongside
 * the outcome a human can sanity-check:
 *
 *  - how many surface nodes are distilled, and how many bytes that removed,
 *  - which keep: ratios the model actually chose,
 *  - whether any distilled node is missing its retrieval handle, which would
 *    mean the original became unreachable.
 *
 * Usage:
 *   node scripts/audit.mjs [root-or-session-dir ...]
 *
 * @module dsh-stepwise-distill/scripts/audit
 */

import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { loadSession, deriveEventMessage, foldSurface } from './lib/events.mjs'
import { byteLength } from './lib/pricing.mjs'
import { findKeepSource } from '../src/index.js'
import { DISTILL_MARKER, distillMarker, parseKeep, textLeaves } from '../src/distill.js'

const LOG_PATTERNS = [/^session\.v(\d+)\.jsonl\.zstd$/, /^session\.jsonl\.zstd$/]

/**
 * Find session artifacts under the given paths.
 * @param args - files, session directories, or a sessions root.
 * @returns artifact paths.
 */
function collectLogs(args) {
  const found = new Set()
  const walk = (dir, depth) => {
    if (depth > 3) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      const full = join(dir, entry.name)
      if (entry.isFile()) {
        if (LOG_PATTERNS.some(pattern => pattern.test(entry.name))) found.add(full)
      } else if (entry.isDirectory()) walk(full, depth + 1)
    }
  }
  for (const arg of args) {
    if (statSync(arg).isFile()) found.add(arg)
    else walk(arg, 0)
  }
  return [...found].sort()
}

/** Newest format generation per session directory. */
function newestGeneration(logs) {
  const best = new Map()
  for (const path of logs) {
    const key = path.slice(0, path.lastIndexOf('/'))
    const version = Number((path.match(/^.*session\.v(\d+)\./) ?? [null, '0'])[1])
    const seen = best.get(key)
    if (seen === undefined || version > seen.version) best.set(key, { path, version })
  }
  return [...best.values()].map(entry => entry.path)
}

/**
 * Inspect one session's surface for distilled nodes.
 * @param path - artifact path.
 * @returns counts, byte savings, and any integrity problems.
 */
function audit(path) {
  const { header, events } = loadSession(path)
  const { nodes } = foldSurface(events)
  const byNode = new Map(events.map(event => [event.seq, event]))

  const report = {
    id: header.id,
    cwd: header.cwd ?? '<none>',
    path,
    toolResults: 0,
    distilled: 0,
    originalBytes: 0,
    distilledBytes: 0,
    keepRatios: [],
    problems: [],
  }

  for (const seq of nodes) {
    const event = byNode.get(seq)
    if (event?.type !== 'tool/result') continue
    const message = deriveEventMessage(event)
    if (message === null) continue
    report.toolResults += 1

    for (const outer of message.content ?? []) {
      if (outer?.type !== 'tool-result' || Array.isArray(outer.content) === false) continue
      for (const inner of outer.content) {
        if (inner?.type !== 'text' || typeof inner.text !== 'string') continue
        if (distillMarker(inner.text) === undefined) continue

        report.distilled += 1
        report.distilledBytes += byteLength(inner.text)

        // The handle is the only path back to what was dropped; losing it
        // silently makes the rewrite irreversible.
        if (!inner.text.includes('history_read')) {
          report.problems.push(`seq ${seq}: distilled node has no retrieval handle`)
        }
        const declared = distillMarker(inner.text)
        const match = /^(\d+)\/(\d+) lines/.exec(declared)
        if (match === null) {
          report.problems.push(`seq ${seq}: unreadable marker "${declared}"`)
          continue
        }
        const kept = Number(match[1])
        const total = Number(match[2])
        if (total > 0) report.keepRatios.push(kept / total)
        report.originalBytes += Number(
          (/original (\d+) bytes/.exec(inner.text) ?? [null, '0'])[1],
        )
      }
    }
  }

  report.savedBytes = Math.max(0, report.originalBytes - report.distilledBytes)
  return report
}

/**
 * Measure how often the contract is actually answered.
 *
 * The rate is computed through the same path the plugin uses to reach its
 * decision: the answer to a result is the NEXT assistant message
 * ({@link findKeepSource}), parsed by the same parser ({@link parseKeep}).
 * Counting `keep:` lines wherever they appear would credit a reply that merely
 * discusses this plugin, and counting only reasoning blocks -- as an earlier
 * version did -- misses an answer written in the reply's text, which is where
 * most answers have actually been observed. Both mistakes make the number
 * useless for deciding whether the contract is working.
 *
 * @param path - artifact path.
 * @returns node-level counts of numbering and answers.
 */
function cooperation(path) {
  const { events } = loadSession(path)
  const { nodes } = foldSurface(events)
  const byNode = new Map(events.map(event => [event.seq, event]))
  let numbered = 0
  let answered = 0
  let keptAll = 0
  for (const seq of nodes) {
    const event = byNode.get(seq)
    if (event?.type !== 'tool/result') continue
    const leaves = textLeaves(event.data?.message)
    if (!leaves.some(leaf => /^\[\d+\] /.test(leaf.text))) continue
    numbered += 1
    const { found, all } = parseKeep(findKeepSource(events, seq))
    if (!found) continue
    answered += 1
    if (all) keptAll += 1
  }
  return { numbered, answered, keptAll }
}

function main(argv) {
  const inputs = argv.length > 0 ? argv : [join(homedir(), '.dsh', 'sessions')]
  const logs = newestGeneration(collectLogs(inputs))
  if (logs.length === 0) {
    process.stderr.write(`audit: no session logs under ${inputs.join(', ')}\n`)
    process.exit(1)
  }

  let distilled = 0
  let numbered = 0
  let answered = 0
  let keptAll = 0
  let saved = 0
  const ratios = []
  const problems = []
  const touched = []

  for (const path of logs) {
    let report
    let coop
    try {
      report = audit(path)
      coop = cooperation(path)
    } catch (error) {
      process.stderr.write(`audit: skipped ${path}: ${String(error.message ?? error)}\n`)
      continue
    }
    distilled += report.distilled
    saved += report.savedBytes
    ratios.push(...report.keepRatios)
    numbered += coop.numbered
    answered += coop.answered
    keptAll += coop.keptAll
    for (const problem of report.problems) problems.push(`${report.id.slice(0, 18)} ${problem}`)
    if (report.distilled > 0) touched.push(report)
  }

  process.stdout.write(`audited ${String(logs.length)} session(s)\n\n`)
  process.stdout.write(`numbered results         ${numbered}\n`)
  process.stdout.write(`  answered by next reply ${answered}`
    + (numbered > 0 ? ` (${((answered / numbered) * 100).toFixed(1)}%)\n` : '\n'))
  process.stdout.write(`  of which keep: all     ${keptAll}\n`)
  process.stdout.write(`distilled nodes          ${distilled}\n`)
  process.stdout.write(`bytes removed            ${saved} (${(saved / 1024).toFixed(1)} KB)\n`)
  if (ratios.length > 0) {
    const average = ratios.reduce((sum, value) => sum + value, 0) / ratios.length
    process.stdout.write(`kept share of lines     mean ${(average * 100).toFixed(1)}%, `
      + `min ${(Math.min(...ratios) * 100).toFixed(1)}%, `
      + `max ${(Math.max(...ratios) * 100).toFixed(1)}%\n`)
  }
  if (problems.length > 0) {
    process.stdout.write(`\nPROBLEMS (${String(problems.length)})\n`)
    for (const problem of problems) process.stdout.write(`  ${problem}\n`)
  } else {
    process.stdout.write('\nno integrity problems\n')
  }
  if (touched.length > 0) {
    process.stdout.write('\nsessions with distilled nodes\n')
    for (const report of [...touched].sort((a, b) => b.savedBytes - a.savedBytes).slice(0, 10)) {
      process.stdout.write(`  ${String(report.distilled).padStart(3)} nodes, `
        + `${String(report.savedBytes).padStart(7)} B saved  ${report.id.slice(0, 18)}  `
        + `${report.cwd.split('/').pop()}\n`)
    }
  }
  if (numbered > 0 && distilled === 0) {
    process.stdout.write('\nnumbered results exist but nothing was distilled: the answers '
      + 'named lines that did not shrink the result, or none answered at all\n')
  }
}

main(process.argv.slice(2))
