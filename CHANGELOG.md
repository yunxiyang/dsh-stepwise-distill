# Changelog

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
