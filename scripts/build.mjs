/**
 * Publish src/ as lib/.
 *
 * The plugin ships as plain ESM, so the build step is a byte-for-byte copy and
 * lib/ stays readable in a profile's node_modules. scripts/check-sync.mjs fails
 * the publish if the two ever drift.
 */

import { copyFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

/** Source-to-artifact pairs. */
const PAIRS = [
  ['src/index.js', 'lib/index.js'],
  ['src/distill.js', 'lib/distill.js'],
  ['src/summarize.js', 'lib/summarize.js'],
  ['src/index.d.ts', 'lib/index.d.ts'],
  ['src/distill.d.ts', 'lib/distill.d.ts'],
  ['src/summarize.d.ts', 'lib/summarize.d.ts'],
]

for (const [source, artifact] of PAIRS) {
  mkdirSync(dirname(artifact), { recursive: true })
  copyFileSync(source, artifact)
}
process.stdout.write(`build: copied ${String(PAIRS.length)} files into lib/\n`)
