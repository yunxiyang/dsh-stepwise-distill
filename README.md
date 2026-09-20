# dsh-stepwise-distill

Keep a long agent conversation usable by keeping the PROCESS out of the way and
the RESULT in it.

Two mechanisms, both running between steps:

- **Reasoning is stripped at projection.** It is 17% of assistant content on
  average and up to 77% on exploratory tasks, and every later turn re-sends all
  of it. The model then reads its own churn, its own abandoned attempts, and its
  own circling -- and continues it.
- **Each completed step is written down**, and its raw material stops being
  replayed. A step's reasoning, tool arguments, and tool output are replaced in
  later turns by the information worth keeping from it: what it did, what it
  found, what it decided and why.

Neither one deletes anything. The event log is append-only, so every raw byte
stays where it was; only what the model is shown changes, and `history_read`
returns any of it by seq.

## Why, exactly

The goal is not a smaller bill -- this plugin spends tokens and time, see
[What it costs](#what-it-costs). It is that an agent asked to do something can
still find that request in its own context an hour later.

Measured across sessions, an assistant's own output breaks down roughly as:

| | share of assistant content |
|---|---|
| reasoning | 17% |
| reply text | 28% |
| tool-call arguments (patches, script bodies) | 55% |

Reasoning is rarely spread evenly. In one session it was **zero for most turns
and 143 KB in the first four** -- the exploration phase, where the model worked
out what the task even was. That is exactly the stretch whose wrong turns get
re-read forever after.

A tool-call argument is usually a patch or a script body: content that has
already landed in a file. Re-sending its full text every turn buys nothing.

## How it works

**1. Strip reasoning from the projection.**

`Session.deriveMessages()` is the single source of the message list -- the
request is built from it, and the runtime invariant compares the request against
it. Wrapping that one method moves both sides together, so the invariant is
satisfied rather than bypassed.

The pure `deriveEventMessage` is deliberately left alone: eleven subsystems
share it, including the token meter, and they must keep seeing what was logged.

**2. Write down each step.**

After a step completes, one extra request goes out carrying **the current
context** plus a short instruction. It answers for the last step only.

The answer is a **complete record of that step, not a digest of it**. The
written text is the only record of the step the agent sees again, so thinning it
out costs the agent its own task history: an early version asked for "1-3
sentences" and produced descriptions too thin to work from, and the agent
re-derived work it had already done. Length follows the step.

Sending the real context, rather than an excerpt, is the point: an answer that
cannot see the task can only report what the step did ("ran cat on Y"), while
one holding the context can say what it meant ("confirmed X in Y, needed for
Z").

What is deliberately left out is the reasoning itself -- carrying the thinking
forward recreates, one level up, the churn this exists to remove.

The record is written by the model, never synthesized by rule. Deciding what
matters in a step is a judgement about intent, and a pattern cannot make it.

**3. Withhold the summarized material.**

Once a step has been written down, its messages stop being projected. Earlier records
plus the newest step is all the next request carries. The log keeps everything.

## What it costs

This is a trade, not a discount: it spends tokens and wall-clock time to keep a
long conversation readable.

**`reasoningContract: true` (on by default) puts a fixed section in the system
prompt of every request.** The section is about 770 characters (roughly 200
tokens) on every request of every turn, for the whole life of the session. It is
a constant overhead, not a one-off. Set it to `false` to stop paying it.

**`stepSummary: true` (off by default) sends one extra request per step, and
that request carries the whole current context.** It is not a digest of the
step: the request is the summary system prompt, plus the full projected
context, plus a short instruction. So its input cost is on the order of the
request you were about to send anyway -- roughly twice the input tokens for
that step, plus the record it writes.

**It also makes every step slower.** The summary goes out before the next
request is built, because deciding what that request contains is its whole
purpose. Each step therefore waits for two model round-trips instead of one,
which on a long task is a visible increase in total task time.

With `stepSummary: false` no extra request is made at all, and `debug: false`
(the default) returns before it touches the log file. Nothing is deleted or
rewritten in either case: what changes is only what the model is shown.

The saving grows with conversation length while these costs stay flat, so the
crossover is a long session. On a single short task, expect more tokens and more
time than without the plugin. Turn `stepSummary` on when replay has become the
problem, not before.

## Configuration

```yaml
- id: stepwise-distill
  config:
    reasoningContract: true   # ask for a written conclusion each step (default: true)
    stepSummary: false        # summarize each completed step (default: false)
    debug: false
```

`stepSummary` is off by default because of what it costs -- one extra request
per step, carrying the whole current context, plus one more model round-trip
before the next step can start. See [What it costs](#what-it-costs).

## Install

```
dsh plugin --profile <name> add dsh-stepwise-distill
```

The bundle patch is a plain insert with no frozen config, so a profile or
Settings-UI change applies on the next step without a restart.

## Measuring

Inside a session, `/distill` reports what the plugin is holding back: how many
steps exist, how many are summarized, and how many bytes of raw material later
turns no longer carry.

```
/distill
```

The pure logic under `src/` is exercised by `npm test`; nothing there needs a
running harness.

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
