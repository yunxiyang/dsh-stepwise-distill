#!/usr/bin/env node
/**
 * Make the host packages this plugin imports resolvable in node_modules.
 *
 * The plugin calls `tools.register(defineTool({...}))`, exactly as every host
 * tool does, so `@deepseek-ai/dsh-tools` is a real import. It is not on npm at
 * the version the host ships, and it pulls a deep peer-dependency chain, so the
 * modules are copied out of the installed DSH application instead of installed.
 *
 * The chain is resolved from package manifests rather than a fixed list: a host
 * upgrade adds or renames packages, and a hardcoded list would silently rot.
 *
 * Nothing here is needed at runtime inside DSH, where the host resolves its own
 * modules. This exists so tests and type checking run from a fresh clone.
 *
 * @module dsh-stepwise-distill/scripts/link-host-deps
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')

/** Candidate locations of the installed DSH application. */
const APP_CANDIDATES = [
  '/Applications/DSH Desktop.app/Contents/Resources/app.asar',
  join(homedir(), 'Applications/DSH Desktop.app/Contents/Resources/app.asar'),
]

/** Packages the plugin imports directly; their chains are walked from here. */
const ROOTS = ['@deepseek-ai/dsh-tools']

/**
 * Exit code used when no DSH installation is present.
 *
 * `postinstall` runs this automatically, and a missing host must not fail an
 * install: contributors without DSH Desktop installed can still edit and lint,
 * they just cannot run the suite. Passing `--optional` turns the hard failure
 * into a warning for exactly that case.
 */
const OPTIONAL = process.argv.includes('--optional')

/**
 * Bytes of pickle framing before each payload.
 *
 * Asar stores file bodies with a 1-byte type tag in front, and the archive's
 * `size` field counts the payload alone, so reads start one byte past the
 * recorded offset.
 */
const PICKLE_TAG_BYTES = 1

/**
 * Read the file table out of an asar archive.
 *
 * The format is a size-prefixed pickle header followed by the directory as
 * JSON, so it parses without the `asar` tool and without network access.
 *
 * @param path - path to the `.asar` file.
 * @returns the parsed archive, ready for `extract` and `locatePackage`.
 */
function readArchive(path) {
  const buffer = readFileSync(path)
  if (buffer.readUInt32LE(0) === 0) {
    throw new Error(`${path} is not an asar archive`)
  }
  const headerSize = buffer.readUInt32LE(12)
  const jsonStart = 16
  const directory = JSON.parse(buffer.subarray(jsonStart, jsonStart + headerSize).toString('utf8'))
  return { directory, dataStart: jsonStart + headerSize, buffer }
}

/**
 * Resolve a slash-separated archive path to its directory node.
 *
 * @param archive - the parsed archive.
 * @param entryPath - path inside the archive.
 * @returns the node, or undefined when absent.
 */
function nodeAt(archive, entryPath) {
  return entryPath.split('/').reduce(
    (current, part) => current?.files?.[part],
    archive.directory,
  )
}

/**
 * Copy one entry (file or directory) out of an archive.
 *
 * @param archive - the parsed archive.
 * @param entryPath - slash-separated path inside the archive.
 * @param destination - absolute filesystem path to write.
 * @returns the number of files written.
 */
function extract(archive, entryPath, destination) {
  const root = nodeAt(archive, entryPath)
  if (root === undefined) return 0

  let written = 0
  const walk = (item, target) => {
    if (item.files === undefined) {
      // Each payload is pickle-framed: a 1-byte type tag precedes the bytes,
      // and `size` counts only the payload itself.
      const start = archive.dataStart + Number(item.offset) + PICKLE_TAG_BYTES
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, archive.buffer.subarray(start, start + item.size))
      written += 1
      return
    }
    mkdirSync(target, { recursive: true })
    for (const [childName, child] of Object.entries(item.files)) {
      walk(child, join(target, childName))
    }
  }
  walk(root, destination)
  return written
}

/**
 * Read one package's manifest from inside the archive.
 *
 * @param archive - the parsed archive.
 * @param location - archive path of the package root.
 * @returns the parsed manifest, or undefined when unreadable.
 */
function manifestAt(archive, location) {
  const node = nodeAt(archive, `${location}/package.json`)
  if (node === undefined || node.files !== undefined) return undefined
  const start = archive.dataStart + Number(node.offset) + PICKLE_TAG_BYTES
  return JSON.parse(archive.buffer.subarray(start, start + node.size).toString('utf8'))
}

/**
 * Walk a package's dependency and peer-dependency chain breadth-first.
 *
 * @param archive - the parsed archive.
 * @param roots - package names to start from.
 * @returns every reachable package name, dependencies first.
 */
function resolveChain(archive, roots) {
  const seen = new Set()
  const order = []
  const queue = [...roots]
  while (queue.length > 0) {
    const name = queue.shift()
    if (seen.has(name)) continue
    const location = `node_modules/${name}`
    if (nodeAt(archive, location) === undefined) {
      process.stderr.write(`link-host-deps: ${name} not found in the archive\n`)
      continue
    }
    seen.add(name)
    order.push(name)

    // dsh-tools imports its dependencies at load time, and its peers are the
    // host-provided half of the same graph -- equally unresolvable from a bare
    // clone, so both are followed.
    const manifest = manifestAt(archive, location)
    if (manifest === undefined) continue
    for (const field of ['dependencies', 'peerDependencies']) {
      for (const dependency of Object.keys(manifest[field] ?? {})) {
        if (!seen.has(dependency)) queue.push(dependency)
      }
    }
  }
  return order
}

function main() {
  const appPath = APP_CANDIDATES.find(candidate => existsSync(candidate))
  if (appPath === undefined) {
    const message = 'link-host-deps: no DSH installation found. Looked in:\n'
      + APP_CANDIDATES.map(path => `  ${path}`).join('\n') + '\n'
    if (OPTIONAL) {
      // Tests cannot run without the host packages, but an install must not
      // fail over it: the plugin is loaded by DSH, which brings its own.
      process.stdout.write(`${message}  continuing without them (--optional)\n`)
      return
    }
    process.stderr.write(message)
    process.exit(1)
  }

  const archive = readArchive(appPath)
  const chain = resolveChain(archive, ROOTS)
  if (chain.length === 0) {
    process.stderr.write('link-host-deps: resolved no packages\n')
    process.exit(1)
  }

  let total = 0
  const skipped = []
  for (const name of chain) {
    const target = join(ROOT, 'node_modules', name)
    // An already-present copy is left alone: it may be a real install, and
    // overwriting it would fight the user's package manager.
    if (existsSync(join(target, 'package.json'))) {
      skipped.push(name)
      continue
    }
    total += extract(archive, `node_modules/${name}`, target)
  }

  process.stdout.write(
    `link-host-deps: ${chain.length} package(s) in the chain, `
    + `${total} file(s) written, ${skipped.length} already present\n`,
  )
  if (skipped.length > 0) {
    // Listing every package buries the count under a wall of names once the
    // install is already complete, which is the common case.
    const shown = skipped.slice(0, 3).join(', ')
    const rest = skipped.length > 3 ? `, +${skipped.length - 3} more` : ''
    process.stdout.write(`  skipped: ${shown}${rest}\n`)
  }
  process.stdout.write(`  source: ${appPath}\n`)
}

main()
