/**
 * Pure distillation logic: what is projected, what is withheld, what is read
 * back. Free of host types, so every decision here is deterministic and
 * testable without a running harness.
 *
 * @module dsh-stepwise-distill/distill
 */

/** Collect the text of one message's content blocks. */
export declare function textOf(blocks: unknown): string

/** Whether a block is reasoning, which the adapter only replays on tool-call turns. */
export declare function isReasoning(block: unknown): boolean

/** Render the system-prompt section asking for a conclusion each step. */

/** Pick the text leaves of one tool-result message, with their positions. */
export declare function textLeaves(message: unknown): Array<{ outer: number; index: number; text: string }>

/** Render the original text of one tool result, for retrieval by seq. */
export declare function renderHistoryRead(event: unknown, seq: number): { ok: boolean; text: string }

/** Render one tool call's arguments, for retrieval by seq. */
export declare function renderToolCallRead(event: unknown, seq: number): { ok: boolean; text: string }

/** Remove reasoning blocks from one projected message, or null when nothing else remains. */


/** Drop the raw material of steps that already have a summary. */
export declare function dropSummarizedSteps(
  messages: unknown,
  summarized: Set<string>,
  stepOf: (message: unknown) => string | undefined,
): unknown
