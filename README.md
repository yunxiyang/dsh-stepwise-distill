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

**Keep.** Every numbered result ends with an unfilled slot, and filling it is
part of reading that result:

```
keep: ???
```

The model completes that line at the end of its reply, naming the lines worth
keeping. Presenting the answer as a slot to fill, rather than a line to produce,
is deliberate: an empty field on screen is harder to skip than a standing
request to write something.

When the whole result is worth keeping, that is itself an answer -- a different
payload, saying so explicitly, and nothing is distilled:

```
keep: all
```

Reasoning is the preferred place for that line: the DeepSeek adapter passes
`reasoning_content` back only on tool-call turns and the API ignores it
elsewhere, so a control signal there is naturally one-shot. A line in the reply's
text is read too.

The contract is announced in a system-prompt section -- the only way the model
can learn it, since numbering alone does not say what to do with it -- and it
states an obligation rather than a permission. That wording is deliberate:
across 150 measured sessions, while the line was merely optional, the model
answered 2 of 56 numbered results. The section contributes no text when
numbering is off, so an observing profile pays nothing for it.

**Solidify.** Before the next step's request is built, each result is rewritten
to its kept lines plus a retrieval handle. Under the default-drop contract a
result the model said nothing about keeps only the handle:

```
[exec_command] ok, 42 lines -> kept 3: 3: src exists; 7: tests/ exists; 12: package.json v2.0.9
distilled: 3/42 lines, 39 dropped, original 1420 bytes
full: session seq 8412 (history_read)
```

**The default is drop.** The model names what is still needed; everything else
goes, and saying nothing is not an exemption. That inversion is deliberate: with
silence meaning "keep everything", a model that never answers is never wrong,
and in 150 measured sessions it answered 2 of 56 numbered results. Asking it to
weigh deletion is asking it to take a risk; asking it to name what it needs is
not.

**Read back.** Every distilled result carries a `full: session seq N` handle, and
`history_read` returns that seq's original text:

```
history_read(seq: 8412)
```

Distillation only appends a surface projection -- the event log is append-only,
so the original is always still there. This tool is what makes a drop
recoverable, and it is why the default-drop contract is safe to run at all.

## Modes

`mode: 'observe'` (default) numbers results and logs what it *would* have
distilled, deleting nothing. `mode: 'distill'` performs the replacement. Ship in
observe mode first: the design's own cost rule is that a phase is only adopted
once it is shown to save tokens **without** lowering task success.

## Safety rules

The governing rule is the inversion described above: **silence means drop.** What
remains here are the edges that inversion creates.

- An unanswered result, a malformed answer, and `keep: none` all resolve the
  same way: the content goes and the handle stays. That is the default, not a
  failure mode, and it is why every distilled node carries its seq.
- An out-of-range index voids the whole answer rather than applying the part
  that fits. A model naming a line it never saw has lost track of which result
  it is answering, and executing its literal answer would act on that confusion.
- `keep: all` is an answer, not a missing one: it keeps the result whole and
  distils nothing. Without it, a model that wants a result kept whole is pushed
  into dropping lines it never judged.
- A replacement that would not be smaller than the original is abandoned.
- A node already carrying the `distilled:` marker is never distilled twice, so
  replay and resume are idempotent.
- A result that was never numbered -- short output, or a self-numbered `read` --
  never enters this path at all. The default applies to numbered results only,
  or the plugin would be deleting history at large.
- A failed `session.append` is logged and dropped; it never blocks a step.

Distillation only ever touches a `tool/result`'s **content**. The harness
requires `callId`, `isError`, `turn`, and `step` to match byte-for-byte after
the content is removed, and the plugin rebuilds nothing else.

## What this cannot do

An earlier design also planned to strip reasoning and `keep:` lines from the
outgoing request at the transport layer. The harness forbids it, with a runtime
check rather than a convention: `agent-loop`'s invariant compares every
loop-built request against `session.deriveMessages()` and throws on any
divergence, and `llm/stream` documents its request as deep-frozen
("listeners read it, never rewrite it"). There is no extension point in the
surface projection either.

Reasoning therefore stays in the log and on the wire. Its cost is bounded by
adapter behaviour rather than by this plugin, which is why the design puts its
entire return on tool results. See `DESIGN.md` section 8 for the evidence.

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

### Host packages

`history_read` is registered through `defineTool` from `@deepseek-ai/dsh-tools`,
the same call every host tool uses. That package is not published to npm at the
version DSH ships, and it carries a deep peer-dependency chain, so it cannot be
declared as an ordinary dependency. It is provided by DSH at runtime, and for
local development `npm run link-host-deps` copies it -- and everything in its
chain -- out of the installed application:

```
npm run link-host-deps          # from /Applications/DSH Desktop.app
npm run link-host-deps -- --optional   # warn instead of fail when DSH is absent
```

`postinstall` runs it with `--optional`, so `npm install` restores the packages
automatically and still succeeds on a machine without DSH Desktop (tests just
cannot run there). The copy parses the asar archive directly -- no `asar`
package, no network. The chain is walked from package manifests rather than a
fixed list, so a DSH upgrade does not silently invalidate it.
