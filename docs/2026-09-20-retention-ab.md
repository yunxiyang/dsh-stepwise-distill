# Retention on/off comparison, 2026-09-20

Same model, same task, same machine; two isolated profiles differing only in
`stepSummary`.

Task: fix `calc.py` so `python3 -m unittest -v` passes, then run the tests.

| | tool calls | repeated | task result |
|---|---:|---:|---|
| off | 4 | 0 | tests pass |
| on  | 10 | 4 | tests pass |

The `on` run reads `calc.py` at steps 1, 2, 4 and 6. Each read follows a step
whose tool result was replaced by a record of that step.

Model: `litellm-gpt/openai/gpt-6-astra`, the route this machine currently runs.

## What this establishes

Replacing tool results makes the agent re-read the files it already read. A
record is the model's account of a read; the result is the read. The agent
cannot treat the account as evidence that it holds the file's contents, so it
reads again.

## What it does not establish

Whether a finer-grained replacement avoids the re-reading. The tool result is
the obvious candidate to keep while compressing what surrounds it.
