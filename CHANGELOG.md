# Changelog

## 0.2.0

- Write records with a producer-owned source kind. Session format v4 refuses the
  retired `{ kind: 'plugin', plugin: name }` wrapper on persist -- "format v4
  message requires a producer-owned source kind" -- and because the record is
  appended from a step hook the refusal failed the whole turn. Records now carry
  `{ kind: 'plugin:stepwise-distill' }`, exactly the kind the v3-to-v4 migration
  derives for this plugin, so history written before the upgrade keeps being
  read. Every read path matches on `kind` again instead of the dropped `plugin`
  field.
- Track the host's compaction checkpoints by their current kind. `compact` was
  renamed to `compact-checkpoint` in v4, so the sidebar tab now recognises a
  checkpoint by `kind` rather than by a `plugin` field the migration removes.
  `compactionId` still rides along.
- Read the host configuration through `volatileForm` on 0.1.7 (`meta.volatile`
  on `Config`) and reach the settings card through `plugins.row.config` when
  `settingsScope` is gone. Both were already live in `lib/`; they are now in
  `src/` as well, so the two stay byte-identical.
- Resolve the settings card's scope instead of trusting the host's `form` prop.
  On 0.1.7 `plugins.row.config` hands the card a `{ state, mutate }` adapter
  rather than the `configForms` controller, so `pageForm ?? form` took the
  adapter and every member the card reads off its scope was missing: the header
  fell back to `全部关闭`, the boxes rendered unchecked, and the body announced
  `当前设置不可写，以下开关为只读。` with each box disabled. Which of the two
  shapes arrives is the host's choice and undocumented -- the slot's own example
  renderer takes no props at all -- so the card now takes the first candidate
  exposing `getSnapshot` and only wraps the adapter (its `state` as the snapshot,
  its `mutate` as the write) when no controller is reachable. The card still
  `void`s its writes, so the wrapper loses nothing but the subscription.
- Let the sidebar tab's list scroll again. The host keeps a tab body at
  `height: 100%` with `overflow: hidden`, and the panel's root was an ordinary
  flex child of it -- `flex: 0 1 auto` with the default `min-height: auto` --
  so it neither filled that body nor shrank below its content. Anything longer
  than the pane was cut off with no scroller left to reach it. The root now
  claims `flex: 1 1 auto`, `min-height: 0` and `overflow-y: auto`, plus
  `box-sizing: border-box` so its 12px padding does not add to that height.
- Point the test suite at the installed host. `scripts/link-host-deps.mjs` only
  looked for a packed `app.asar`, so an unpacked install silently kept the
  previous `node_modules` copies and the suite validated against a host that
  accepted shapes the running one rejects. It now reads both layouts and takes
  `--refresh` to replace stale copies. Against dsh 0.1.7 this surfaced a v4
  change the old copies hid: a `tool/result` derives to a native `tool` message
  with flattened text rather than a `user` message nesting a `tool-result`
  block. The two assertions that depended on that shape now state the real
  contract -- an earlier step's material is withheld, the newest step's is kept
  beside its record.
- Declare the 0.2.0 host line. The plugin's only `dsh` peer read `^0.1.1-rc.2`,
  which for a `0.x` version stops below `0.2.0`, and `dsh-app-boot` denies a
  bundle whose declared peers the runtime does not satisfy -- "Plugin
  dsh-stepwise-distill@0.2.0 is incompatible with dsh 0.2.0-rc.1:
  peerDependencies {...}" -- after which profile startup skips the bundle whole:
  no prompt section, no step hook, no tab. It reads `^0.1.1-rc.2 ||
  ^0.2.0-rc.1` now, checked with the host's own semver and its own
  `includePrerelease` flag, so 0.1.1-rc.2 through 0.1.7-rc.2 and 0.2.0-rc.1
  through 0.2.x all pass. No plugin code had to change for 0.2.0: the session
  format is still v4, `configForms` and `plugins.row.config` are unchanged,
  `settingsScope` was already gone in 0.1.7, the sidebar seats are the same, and
  of the packages the suite imports only `dsh-session` moved -- its tail-repair
  internals, which this plugin never calls.
- Reach the current shell from `link-host-deps`. 0.2.0 ships as `DeepSeek
  Harness.app`, a packed `app.asar` whose runtime -- and so whose
  `@deepseek-ai/*` packages -- sits under `dsh/` rather than at the archive's
  top level. The candidate list named only `DSH Desktop.app`, and the archive
  reader put a one-byte tag in front of every payload while ignoring the
  four-byte alignment of the header, so every payload was read from the wrong
  byte and no manifest inside a packed archive parsed at all. Shells are now
  probed newest first, the module directory is probed (`dsh/node_modules`, then
  `node_modules`), and payloads are read at the aligned offset: the extracted
  0.2.0 bundles parse, and the vendored copies the suite runs against are
  0.2.0-rc.1.

- Time and count the summary call from the stream the host actually delivers. The
  plugin's own call used to be streamed through `BlockAssembler`, which reads no
  timestamps, so the record carried no segment bounds and the panel reported
  `-- t/s` for a call that had visibly streamed an answer. The host's
  `AssistantStreamAccumulator` is the object a stream has to be fed to. Usage had
  three problems of its own on top of that: the provider puts it on the top level
  of its stream element while the plugin read a nested field, `parseUsage`
  accepted only the JSON string the log carries and dropped elements that already
  held an object, and an empty usage object divides into no rate at all -- it
  looks like a count.

- Report nothing for a call the plugin never timed. Each turn and step key had
  two writers: the plugin's own record and the `assistant/message` that closes
  it, and the message wrote last and won while measuring the call the record
  replaced -- a different, smaller one. Only the record writes these keys now,
  and a record with no numbers of its own writes `null` to hold the key, so a
  step summarized before the figures existed reads as blank instead of borrowing
  a number that measures something else.

- Announce the `keep:` contract in a system-prompt section. Numbering alone
  does not tell the model what to do with it, so without this the plugin could
  never distill anything. The section contributes no text while numbering is
  off, and registers through `ctx.systemPrompt.section` when available, through
  `inject` otherwise, and degrades to hooks-only when no prompt service exists.
- Record in `DESIGN.md` that the transport-layer plan (L2) is falsified: the
  harness compares every loop-built request against `session.deriveMessages()`
  and throws on divergence. Reasoning stays on the wire, so the return rests
  entirely on tool results.
- Number the system-prompt contract as the last piece of operating guidance,
  after the harness-source and web-surface notes.
- Document what the plugin costs in `README.md`: the system-prompt contract is
  about 770 characters on every request, and `stepSummary` adds one request per
  step that carries the whole current context and waits for its own round-trip.
  The saving grows with conversation length while these costs stay flat, so a
  single short task spends more than it saves.

## 0.1.0

Initial skeleton and P0 baseline.

- Stepwise tool-result distillation: line numbering, the `keep:` contract, and
  deterministic in-place surface replacement of `tool/result` content.
- Two modes: `observe` (default, numbers and reports) and `distill` (rewrites).
- Safety gates for missing, malformed, empty, and out-of-range `keep:` lines;
  idempotence via a `distilled:` marker; failure isolation around `session.append`.
- Measurement tool (`scripts/measure.mjs`) that decodes concatenated Zstandard
  session frames, folds the surface, and prices history with the harness's own
  estimator.
- First corpus baseline: 76 readable sessions, 46.6 MB of model-facing history,
  50.0% of it tool results; only 182 of 8232 results exceed the shipped pruner's
  8192-character threshold.
