# Retention on/off comparison, 2026-09-20

Same model, same task, same machine; isolated profiles differing only in how the
newest step is projected.

Task: fix `calc.py` so `python3 -m unittest -v` passes, then run the tests.

| projection | tool calls | repeated | task result |
|---|---:|---:|---|
| retention off | 4 | 0 | tests pass |
| newest step: record only | 10 | 4 | tests pass |
| newest step: material + record | 4 | 0 | tests pass |

Model: `litellm-gpt/openai/gpt-6-astra`.

## Reading

Replacing a step's material with a record of it costs the agent its evidence.
A record states what a step concluded; it is not something the agent can check a
conclusion against. The `record only` run read `calc.py` at steps 1, 2, 4 and 6,
each read following a step whose result had just been replaced.

Projecting the newest step as its material plus its record removes that: the
step being reasoned about keeps its evidence, earlier steps keep their
conclusions, and the window advances on its own as the session progresses.

## Scope

One task, one model, three runs. The measurement is tool-call count and repeated
arguments, not a judgement of the final answer. `record only` and `material +
record` both produced a working fix; what differs is how much work the agent did
to get there.
