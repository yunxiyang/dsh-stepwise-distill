# dsh-stepwise-distill

Solidify DeepSeek Harness history between steps: keep the facts a tool result
actually contributed, and replace everything else with a handle that reads it
back on demand.

This is not compaction. Compaction folds N history nodes into one summary under
token pressure; this plugin rewrites individual nodes **in place**, keeping the
node count, roles, `callId`s, and tool-call/result pairing intact. The original
text stays in the append-only log, so replay and audit remain complete.

## The problem it targets

Long sessions re-send almost everything they ever produced. Measuring the local
session corpus (119 of 120 artifacts, 71.0 MB of model-facing history):

| Category | Share of re-sent volume |
|---|---|
| tool results | 50.0% |
| assistant text | 31.6% |
| reasoning | 10.6% |
| tool-call arguments | 7.8% |

The cost is accumulation, not explosion. Of 11383 tool results, only 303 exceed
the shipped pruner's 8192-character threshold, and the median result is 548
bytes. That is why `dsh-compaction-tool-result-pruner` and the spill policy
leave these sessions alone: nothing is oversized, there is simply a lot of it.
Reasoning is the other axis, and it varies sharply by session -- 98 of 119
sessions carry reasoning at all, and in one session it is 35.7% of the total
while another carries none.

The same measurement sizes the opportunity: 39.9% of text leaves are long enough
to number, and they hold 84.3% of all result bytes. On one representative
session, keeping 20% of numbered lines would leave 0.12 MB of the 0.45 MB of
eligible content -- a 72% reduction in result volume.

The one unmeasured artifact is corrupt: its event numbering goes backwards at a
single append boundary. The reader refuses it rather than reporting numbers it
cannot trust.

## How it works

**Number.** Long tool results (default: more than 20 lines) are numbered as they
are produced, and a short contract is appended telling the model how to answer.
Numbering happens once, at execution time, so indices stay stable.

**Keep.** When the model decides a result does not need to survive in full, it
ends its reply with one line:

```
keep: 3,7,12
```

Reasoning is the preferred place for that line, because reasoning is stripped
from later requests anyway. A reply with no `keep:` line keeps the result
verbatim.

**Solidify.** Before the next step's request is built, each named result is
rewritten to its kept lines plus a retrieval handle:

```
[exec_command] ok, 42 lines -> kept 3: 3: src exists; 7: tests/ exists; 12: package.json v2.0.9
distilled: 3/42 lines, 39 dropped, original 1420 bytes
full: session seq 8412 (history_read)
```

## Modes

`mode: 'observe'` (default) numbers results and logs what it *would* have
distilled, deleting nothing. `mode: 'distill'` performs the replacement. Ship in
observe mode first: the design's own cost rule is that a phase is only adopted
once it is shown to save tokens **without** lowering task success.

## Safety rules

Every rule below exists because the alternative silently destroys information:

- A missing, malformed, or out-of-range `keep:` line leaves the node untouched.
  A malformed list is never read as "keep nothing".
- An empty selection (`keep: none`) is legal but never useful, so the node is
  left alone -- it is indistinguishable from a misread contract.
- A replacement that would not be smaller than the original is abandoned.
- A node already carrying the `distilled:` marker is never distilled twice, so
  replay and resume are idempotent.
- Results from the turn still in progress are excluded.
- A failed `session.append` is logged and dropped; it never blocks a step.

Distillation only ever touches a `tool/result`'s **content**. The harness
requires `callId`, `isError`, `turn`, and `step` to match byte-for-byte after
the content is removed, and the plugin rebuilds nothing else.

## Install

```
dsh plugin --profile <name> add dsh-stepwise-distill
```

The bundle patch is a plain insert with no frozen config, so a profile or
Settings-UI change applies on the next step without a restart.

## Measuring

The repository ships the measurement tool that produced the table above. It
decodes the session log's concatenated Zstandard frames, folds the surface the
way the harness does, and prices messages with the harness's own estimator so
the numbers reconcile with the context breakdown.

```
node scripts/measure.mjs <session.jsonl.zstd | session-dir | sessions-root>
node scripts/measure.mjs --json ~/.dsh/sessions
```

The reader is deliberately strict: it refuses a log whose event sequence numbers
disagree with their positions, and skips such a file with a reason rather than
reporting numbers it cannot trust.

## Development

```
npm run build   # src/ -> lib/
npm test        # vitest
npm run check   # lib/ must match src/
```

`DESIGN.md` holds the full design, the code evidence for each harness
constraint, and the phased plan.
