# dsh-stepwise-distill

[中文](README.zh.md)

Spend roughly twice the money and twice the time to make the context denser, so
that what reaches the model is worth attending to.

A long conversation decays into its own history. The agent re-reads thinking it
has already finished with, patches it has already written to a file, output it
has already drawn a conclusion from -- and the one thing it needs, the request
it was given, is a small part of a large prompt. This plugin pays to invert
that: the same conversation, carrying less of what it did and more of what it
knows.

It takes two steps: the newest step keeps its own raw material, and every
earlier step is replaced by a record. Neither one deletes anything -- the event
log is append-only, only what the model is shown changes, and `history_read`
returns any raw byte by seq. [How it works](#how-it-works) has the detail.

## Why, exactly

The goal is not a smaller bill -- this plugin spends tokens and time, see
[What it costs](#what-it-costs). It is that the same token budget carries more
of what the model needs and less of what it has already dealt with.

So the question is which part of a long conversation is worth its tokens. The
answer is not the part that looks biggest. Measured across sessions, an
assistant's own output breaks down roughly as:

| | share of assistant content |
|---|---|
| reasoning | 17% |
| reply text | 28% |
| tool-call arguments (patches, script bodies) | 55% |

Reasoning is rarely spread evenly. In one session it was **zero for most turns
and 143 KB in the first four** -- the exploration phase, where the model worked
out what the task even was. In other words the material being removed is not
just the largest part, it is the least dense: a lot of text carrying very few
decisions.

A tool-call argument is usually a patch or a script body: content that has
already landed in a file. Re-sending its full text every turn buys nothing --
the conclusion it produced is in the record, and the text itself is one
`history_read` away. What is left in the projection is what the next step
cannot reconstruct on its own.

## How it works

**1. Put the newest step's own material back into the projection.**

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

This is a trade, and the price is known up front: roughly twice the input
tokens, and one extra model round trip per step. What it buys is a context whose
useful content is not diluted by what the agent has already dealt with.

**`stepSummary` is on by default.** The extra request is not a digest of the
step: it carries the summary system prompt, the full projected context, and a
short instruction. So its input cost is on the order of the request you were
about to send anyway -- roughly twice the input tokens for
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
time than without the plugin. Turn `stepSummary` and `turnSummary` off when you
are only doing short tasks.

## Configuration

```yaml
- id: stepwise-distill
  config:
    stepSummary: true         # summarize each completed step (default: true)
    turnSummary: true         # write one note at the end of each turn (default: true)
    debug: false
```

Both are on by default: they are what the plugin is for, so installing it should
be enough to get them. Both cost what [What it costs](#what-it-costs) describes
-- one extra request per step, carrying the whole current context, plus one more
model round-trip before the next step can start, and the same once per turn for
`turnSummary`. Set either to `false` when that price is not one you want to pay.

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
