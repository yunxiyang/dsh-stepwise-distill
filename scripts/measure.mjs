#!/usr/bin/env node
/**
 * P0 baseline: measure what a session actually re-sends every turn.
 *
 * The design rests on one claim -- that long sessions accumulate volume with
 * no single oversized result, so the shipped pruner and spill policies never
 * fire. This script tests that claim on real logs and produces the numbers the
 * later phases are judged against:
 *
 *  - per-surface-category share (tool result / call args / assistant text / reasoning),
 *  - the distribution of individual tool results (is anything over the pruner's
 *    8192-character default?),
 *  - model usage actually reported by the provider (the ground truth the
 *    heuristic estimate is calibrated against).
 *
 * Usage:
 *   node scripts/measure.mjs <session.jsonl.zstd | sessdir | root-dir> [...]
 *   node scripts/measure.mjs --json <root-dir>
 *
 * @module dsh-stepwise-distill/scripts/measure
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { homedir } from 'node:os'
import { loadSession, deriveEventMessage, foldSurface } from './lib/events.mjs'
import { estimateMessage, estimateSystem, weighMessage, byteLength } from './lib/pricing.mjs'
import { shouldNumber, splitLines } from '../src/distill.js'

/** The pruner's shipped threshold, above which it rewrites a tool result. */
const PRUNER_THRESHOLD_CHARS = 8192

/** Line threshold above which a tool result is considered numbering-worthy. */
const MIN_NUMBER_LINES = 20

/** Longest session filename generation, newest format first. */
const LOG_PATTERNS = [/^session\.v(\d+)\.jsonl\.zstd$/, /^session\.jsonl\.zstd$/]

/**
 * Expand CLI arguments into session artifact paths.
 * @param args - paths to files, session directories, or project directories.
 * @returns sorted artifact paths.
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
      } else if (entry.isDirectory()) {
        walk(full, depth + 1)
      }
    }
  }
  for (const arg of args) {
    if (statSync(arg).isFile()) found.add(arg)
    else walk(arg, 0)
  }
  return [...found].sort()
}

/** Newest generation wins when a session directory holds several log formats. */
function pickNewest(logs) {
  const best = new Map()
  for (const path of logs) {
    const key = path.slice(0, path.lastIndexOf('/'))
    const version = (basename(path).match(/^session\.v(\d+)\./) ?? [null, '0'])[1]
    const previous = best.get(key)
    if (previous === undefined || Number(version) > previous.version) {
      best.set(key, { path, version: Number(version) })
    }
  }
  return [...best.values()].map(entry => entry.path).sort()
}

/**
 * Measure one session artifact.
 * @param path - artifact path.
 * @returns the per-session report.
 */
function measure(path) {
  const { header, events, frameCount, torn } = loadSession(path)
  const { nodes } = foldSurface(events)

  const byNode = new Map(events.map(event => [event.seq, event]))
  const totals = { text: 0, reasoning: 0, toolCallArgs: 0, toolResult: 0, other: 0, total: 0 }
  const tokens = { system: 0, messages: 0 }
  const toolResults = []
  const reasoningByNode = []
  const usage = { input: 0, output: 0, cacheRead: 0, samples: 0 }
  const turns = new Set()
  const steps = new Set()

  for (const seq of nodes) {
    const event = byNode.get(seq)
    if (event === undefined) throw new Error(`${path}: surface node ${seq} is missing from the log`)
    if (event.data?.turn !== undefined) turns.add(event.data.turn)
    if (event.data?.turn !== undefined && event.data?.step !== undefined) {
      steps.add(`${event.data.turn}/${event.data.step}`)
    }

    if (event.type === 'assistant/message') {
      const block = event.data?.usage
      if (block !== undefined) {
        usage.input += block.inputTokens ?? 0
        usage.output += block.outputTokens ?? 0
        usage.cacheRead += block.cacheReadTokens ?? 0
        usage.samples += 1
      }
    }

    const message = deriveEventMessage(event)
    if (message === null) continue

    if (event.type === 'system/message') {
      tokens.system += estimateSystem(message)
      continue
    }
    tokens.messages += estimateMessage(message)

    const weight = weighMessage(message)
    for (const key of Object.keys(totals)) totals[key] += weight[key]

    if (event.type === 'tool/result') {
      const leaves = []
      for (const outer of message.content ?? []) {
        if (outer?.type !== 'tool-result') continue
        for (const inner of outer.content ?? []) {
          if (inner?.type === 'text') leaves.push(byteLength(inner.text))
        }
      }
      toolResults.push({
        seq,
        turn: event.data?.turn,
        step: event.data?.step,
        bytes: leaves.reduce((sum, value) => sum + value, 0),
        blocks: leaves.length,
      })
    }

    if (event.type === 'assistant/message') {
      const own = (message.content ?? [])
        .filter(block => block?.type === 'reasoning')
        .reduce((sum, block) => sum + byteLength(block.text), 0)
      if (own > 0) reasoningByNode.push({ seq, bytes: own })
    }
  }

  const sortedResults = [...toolResults].sort((a, b) => b.bytes - a.bytes)
  const bytes = sortedResults.map(entry => entry.bytes)
  const sum = bytes.reduce((acc, value) => acc + value, 0)

  const ceiling = distillCeiling(nodes, byNode)

  return {
    path,
    id: header.id,
    cwd: header.cwd ?? '<none>',
    createdAt: header.createdAt,
    frames: frameCount,
    torn,
    eventCount: events.length,
    surfaceNodes: nodes.length,
    shadowedNodes: events.length - nodes.length,
    turns: turns.size,
    steps: steps.size,
    totals,
    tokens,
    usage,
    toolResults: {
      count: bytes.length,
      totalBytes: sum,
      meanBytes: bytes.length === 0 ? 0 : Math.round(sum / bytes.length),
      medianBytes: bytes.length === 0 ? 0 : bytes[Math.floor(bytes.length / 2)],
      maxBytes: bytes[0] ?? 0,
      overPrunerThreshold: bytes.filter(value => value > PRUNER_THRESHOLD_CHARS).length,
      p90Bytes: bytes.length === 0 ? 0 : bytes[Math.floor(bytes.length * 0.1)] ?? 0,
    },
    reasoning: {
      nodes: reasoningByNode.length,
      bytes: reasoningByNode.reduce((acc, entry) => acc + entry.bytes, 0),
      maxBytes: reasoningByNode.reduce((acc, entry) => Math.max(acc, entry.bytes), 0),
    },
    ceiling,
  }
}

/** Per-result footer cost of a distilled result, which bounds the savings. */
const DISTILL_FOOTER_BYTES = 140

/**
 * Estimate what distillation could save, without needing model cooperation.
 *
 * This is the P2 question -- "is any of this worth doing?" -- answered from
 * real content: how much of the result volume is long enough to be numbered,
 * and what each plausible keep ratio would leave behind. The estimate assumes
 * kept lines average the same size as all lines in that result, which makes it
 * a guide to the ceiling rather than a prediction.
 *
 * @param nodes - the folded surface sequence numbers.
 * @param byNode - event lookup by sequence number.
 * @returns eligible volume plus savings per keep ratio.
 */
function distillCeiling(nodes, byNode) {
  let leaves = 0
  let totalBytes = 0
  let eligibleCount = 0
  let eligibleBytes = 0
  let eligibleLines = 0

  for (const seq of nodes) {
    const event = byNode.get(seq)
    if (event?.type !== 'tool/result') continue
    for (const outer of event.data?.message?.content ?? []) {
      if (outer?.type !== 'tool-result') continue
      for (const inner of outer.content ?? []) {
        if (inner?.type !== 'text' || typeof inner.text !== 'string') continue
        leaves += 1
        totalBytes += byteLength(inner.text)
        if (!shouldNumber(inner.text, MIN_NUMBER_LINES)) continue
        eligibleCount += 1
        eligibleBytes += byteLength(inner.text)
        eligibleLines += splitLines(inner.text).length
      }
    }
  }

  const averageLine = eligibleLines === 0 ? 0 : eligibleBytes / eligibleLines
  const ratios = [0.05, 0.1, 0.2, 0.3].map((ratio) => {
    const keptBytes = Math.round(eligibleLines * ratio) * averageLine
    const projected = keptBytes + eligibleCount * DISTILL_FOOTER_BYTES
    return {
      ratio,
      projectedBytes: Math.round(projected),
      savedBytes: Math.round(eligibleBytes - projected),
      savedPct: eligibleBytes === 0 ? 0 : (eligibleBytes - projected) / eligibleBytes,
    }
  })

  return {
    leaves,
    totalBytes,
    eligibleCount,
    eligibleBytes,
    eligibleLines,
    eligiblePct: totalBytes === 0 ? 0 : eligibleBytes / totalBytes,
    averageLineBytes: Math.round(averageLine),
    ratios,
  }
}

/** Render one report as a fixed-width table row set. */
function render(report) {
  const share = (value) => report.totals.total === 0
    ? '0.0%'
    : `${((value / report.totals.total) * 100).toFixed(1)}%`
  const mb = (value) => `${(value / 1024 / 1024).toFixed(2)} MB`
  const lines = [
    `session  ${report.id}`,
    `cwd      ${report.cwd}`,
    `log      ${report.path}`,
    `frames   ${report.frames}${report.torn ? ' (torn tail ignored)' : ''}`,
    `surface  ${report.surfaceNodes} nodes, ${report.shadowedNodes} shadowed, `
      + `${report.turns} turns, ${report.steps} steps, ${report.eventCount} events`,
    '',
    're-sent volume by category',
    `  tool result      ${mb(report.totals.toolResult).padStart(9)}  ${share(report.totals.toolResult)}`,
    `  tool call args   ${mb(report.totals.toolCallArgs).padStart(9)}  ${share(report.totals.toolCallArgs)}`,
    `  assistant text   ${mb(report.totals.text).padStart(9)}  ${share(report.totals.text)}`,
    `  reasoning        ${mb(report.totals.reasoning).padStart(9)}  ${share(report.totals.reasoning)}`,
    `  other            ${mb(report.totals.other).padStart(9)}  ${share(report.totals.other)}`,
    `  total            ${mb(report.totals.total).padStart(9)}`,
    '',
    'tool results',
    `  count ${report.toolResults.count}, mean ${report.toolResults.meanBytes} B, `
      + `median ${report.toolResults.medianBytes} B, max ${report.toolResults.maxBytes} B`,
    `  over pruner threshold (${PRUNER_THRESHOLD_CHARS} chars): `
      + `${report.toolResults.overPrunerThreshold}`,
    '',
    'reasoning',
    `  ${report.reasoning.nodes} nodes, ${mb(report.reasoning.bytes)} total, `
      + `max ${report.reasoning.maxBytes} B`,
    '',
    'distillation ceiling',
    `  ${report.ceiling.eligibleCount} of ${report.ceiling.leaves} text leaves are `
      + `>${MIN_NUMBER_LINES} lines, holding ${mb(report.ceiling.eligibleBytes)} `
      + `(${(report.ceiling.eligiblePct * 100).toFixed(1)}% of result bytes)`,
    `  average eligible line ${report.ceiling.averageLineBytes} B`,
    ...report.ceiling.ratios.map(entry => `  keep ${String(Math.round(entry.ratio * 100)).padStart(2)}% `
      + `of lines -> ${mb(entry.projectedBytes).padStart(9)} left, `
      + `saves ${(entry.savedPct * 100).toFixed(0)}% of eligible volume`),
    '',
    'heuristic tokens (harness estimator)',
    `  system prompt ${report.tokens.system}, surface messages ${report.tokens.messages}`,
    'provider usage totals',
    `  samples ${report.usage.samples}, input ${report.usage.input}, `
      + `output ${report.usage.output}, cache read ${report.usage.cacheRead}`,
  ]
  return lines.join('\n')
}

function main(argv) {
  const asJson = argv.includes('--json')
  const args = argv.filter(arg => arg !== '--json')
  const inputs = args.length > 0 ? args : [join(homedir(), '.dsh', 'sessions')]
  const logs = pickNewest(collectLogs(inputs))
  if (logs.length === 0) {
    process.stderr.write(`measure: no session logs under ${inputs.join(', ')}\n`)
    process.exit(1)
  }

  const reports = []
  const failures = []
  for (const path of logs) {
    try {
      reports.push(measure(path))
    } catch (error) {
      // One unreadable artifact must not hide the rest of the corpus; the
      // failing path and reason are reported so the corpus stays auditable.
      failures.push({ path, reason: String(error.message ?? error) })
    }
  }
  for (const failure of failures) {
    process.stderr.write(`measure: skipped ${failure.path}: ${failure.reason}\n`)
  }
  if (reports.length === 0) {
    process.stderr.write('measure: every candidate session log failed to load\n')
    process.exit(1)
  }
  if (asJson) {
    process.stdout.write(`${JSON.stringify(reports, null, 2)}\n`)
    return
  }
  for (const report of reports) {
    process.stdout.write(`${render(report)}\n\n`)
  }
}

main(process.argv.slice(2))
