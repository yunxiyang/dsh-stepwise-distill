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

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')

/**
 * Shell names the installer has shipped, newest first.
 *
 * `DeepSeek Harness` is the current shell; `DSH NEXT` and `DSH Desktop` are the
 * two that came before it. The order is the preference, and it matters whenever
 * more than one is installed: this script exists to stop the suite validating
 * against a host the plugin no longer targets, and picking the older shell
 * silently does exactly that.
 */
const SHELLS = ['DeepSeek Harness', 'DSH NEXT', 'DSH Desktop']

/**
 * Candidate locations of the installed DSH application.
 *
 * Both layouts of every shell are listed because the installer has shipped
 * each of them: a packed `app.asar`, and an unpacked `app/` directory. Only the
 * first was handled, so an unpacked install silently left whatever host
 * packages were already in `node_modules` -- and the suite then tested against
 * a stale host that accepted shapes the running one rejects.
 */
const APP_CANDIDATES = ['/Applications', join(homedir(), 'Applications')].flatMap(
  directory => SHELLS.flatMap(shell => [
    join(directory, `${shell}.app/Contents/Resources/app.asar`),
    join(directory, `${shell}.app/Contents/Resources/app`),
  ]),
)

/**
 * Where an installed shell keeps the packages, relative to its runtime root.
 *
 * A packed shell nests a whole runtime under `dsh/`, and the packages the
 * plugin imports belong to that runtime rather than to the shell wrapping it --
 * the archive's own top level is the desktop shell's much smaller dependency
 * set. An unpacked `app/` is the runtime itself, so the same packages sit at
 * `node_modules`. Probed in this order rather than assumed, because the layout
 * follows the shell and not the archive format.
 */
const MODULE_PREFIXES = ['dsh/node_modules', 'node_modules']

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
 * Replace host packages that are already present.
 *
 * Off by default so an ordinary install never fights a package manager. A host
 * upgrade is exactly the case the copies have to be replaced: leaving a stale
 * `@deepseek-ai/dsh-session` in place makes the suite validate against the
 * previous format, which is how a source kind the running host refuses stayed
 * green here.
 */
const REFRESH = process.argv.includes('--refresh')

/**
 * First payload byte of an asar archive.
 *
 * The header is a pickle: a field length, the header pickle's own length, then
 * the JSON length at offset 12 and the JSON itself at offset 16. The payload
 * section starts where that JSON ends rounded up to a four-byte boundary -- the
 * current archives pad by three bytes, older and smaller ones by none -- and a
 * file's `offset` names its bytes from that boundary directly, with no
 * per-file framing in front of them.
 */
const HEADER_JSON_START = 16

/**
 * Offset of an archive's payload section.
 *
 * @param headerSize - the JSON length read from offset 12.
 * @returns the first byte a file `offset` is measured from.
 */
function dataStartOf(headerSize) {
  return (HEADER_JSON_START + headerSize + 3) & ~3
}

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
  const jsonStart = HEADER_JSON_START
  const directory = JSON.parse(buffer.subarray(jsonStart, jsonStart + headerSize).toString('utf8'))
  return { directory, dataStart: dataStartOf(headerSize), buffer }
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
      // The payload follows its recorded offset directly: the archive's `size`
      // counts the bytes and nothing frames them.
      const start = archive.dataStart + Number(item.offset)
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
  const start = archive.dataStart + Number(node.offset)
  return JSON.parse(archive.buffer.subarray(start, start + node.size).toString('utf8'))
}

/**
 * Present one installed host layout through a single surface.
 *
 * The packed and unpacked layouts differ only in how bytes are reached, so the
 * chain walk and the copy loop ask these three questions and never branch on
 * the layout themselves.
 *
 * The package directory is located by probing {@link MODULE_PREFIXES} for the
 * first root, so a shell that nests its runtime under `dsh/` is read from the
 * runtime and a shell that does not is read from its top level.
 *
 * @param appPath - the `.asar` archive or the unpacked `app` directory.
 * @returns `{ has, manifest, copy }` over the installed packages.
 */
function openSource(appPath) {
  if (appPath.endsWith('.asar')) {
    const archive = readArchive(appPath)
    const prefix = MODULE_PREFIXES.find(
      candidate => nodeAt(archive, `${candidate}/${ROOTS[0]}`) !== undefined,
    )
    if (prefix === undefined) throw new Error(`${appPath} carries no ${ROOTS[0]}`)
    return {
      has: name => nodeAt(archive, `${prefix}/${name}`) !== undefined,
      manifest: name => manifestAt(archive, `${prefix}/${name}`),
      copy: (name, target) => extract(archive, `${prefix}/${name}`, target),
    }
  }
  const prefix = MODULE_PREFIXES.find(
    candidate => existsSync(join(appPath, candidate, ROOTS[0], 'package.json')),
  )
  if (prefix === undefined) throw new Error(`${appPath} carries no ${ROOTS[0]}`)
  const modules = join(appPath, prefix)
  return {
    has: name => existsSync(join(modules, name, 'package.json')),
    manifest: name => {
      try {
        return JSON.parse(readFileSync(join(modules, name, 'package.json'), 'utf8'))
      } catch {
        return undefined
      }
    },
    copy: (name, target) => {
      cpSync(join(modules, name), target, { recursive: true })
      return countFiles(target)
    },
  }
}

/**
 * Count the regular files under one directory.
 *
 * Only used to keep the script's summary honest; the copy itself is `cpSync`.
 *
 * @param directory - directory to walk.
 * @returns the number of files written.
 */
function countFiles(directory) {
  let total = 0
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const child = join(directory, entry.name)
    total += entry.isDirectory() ? countFiles(child) : 1
  }
  return total
}

/**
 * Walk a package's dependency and peer-dependency chain breadth-first.
 *
 * @param source - an installed host layout, from {@link openSource}.
 * @param roots - package names to start from.
 * @returns every reachable package name, dependencies first.
 */
function resolveChain(source, roots) {
  const seen = new Set()
  const order = []
  const queue = [...roots]
  while (queue.length > 0) {
    const name = queue.shift()
    if (seen.has(name)) continue
    if (!source.has(name)) {
      process.stderr.write(`link-host-deps: ${name} not found in the installation\n`)
      continue
    }
    seen.add(name)
    order.push(name)

    // dsh-tools imports its dependencies at load time, and its peers are the
    // host-provided half of the same graph -- equally unresolvable from a bare
    // clone, so both are followed.
    const manifest = source.manifest(name)
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

  const source = openSource(appPath)
  const chain = resolveChain(source, ROOTS)
  if (chain.length === 0) {
    process.stderr.write('link-host-deps: resolved no packages\n')
    process.exit(1)
  }

  let total = 0
  const skipped = []
  for (const name of chain) {
    const target = join(ROOT, 'node_modules', name)
    // An already-present copy is left alone unless a refresh was asked for: it
    // may be a real install, and overwriting it would fight the user's package
    // manager. `--refresh` exists for the host upgrade that makes the copy stale.
    if (existsSync(join(target, 'package.json'))) {
      if (!REFRESH) {
        skipped.push(name)
        continue
      }
      rmSync(target, { recursive: true, force: true })
    }
    mkdirSync(dirname(target), { recursive: true })
    total += source.copy(name, target)
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
