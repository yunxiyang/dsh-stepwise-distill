# Changelog

## 0.2.0

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
