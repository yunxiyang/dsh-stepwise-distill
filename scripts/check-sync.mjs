/**
 * Verify that every published bundle matches its source.
 *
 * lib/ is what npm publishes and what a profile loads; src/ is what the tests
 * exercise. Nothing derives one from the other at install time, so a forgotten
 * copy would ship stale code behind a green test run.
 */

import { readFileSync } from 'node:fs'

/** Source-to-artifact pairs that must stay byte-identical. */
const PAIRS = [
  ['src/index.js', 'lib/index.js'],
  ['src/distill.js', 'lib/distill.js'],
  ['src/index.d.ts', 'lib/index.d.ts'],
  ['src/distill.d.ts', 'lib/distill.d.ts'],
]

const failures = []

for (const [source, artifact] of PAIRS) {
  let left
  let right
  try {
    left = readFileSync(source)
  } catch {
    failures.push(`${source} is missing`)
    continue
  }
  try {
    right = readFileSync(artifact)
  } catch {
    failures.push(`${artifact} is missing -- run \`npm run build\``)
    continue
  }
  if (!left.equals(right)) {
    failures.push(`${artifact} differs from ${source} -- run \`npm run build\``)
  }
}

if (failures.length > 0) {
  process.stderr.write(`check-sync: ${String(failures.length)} problem(s)\n`)
  for (const line of failures) process.stderr.write(`  ${line}\n`)
  process.exit(1)
}

process.stdout.write(`check-sync: ${String(PAIRS.length)} bundles match their sources\n`)
