/** Marker prefixing a summary message, so it can be recognized later. */
export declare const SUMMARY_MARKER: '[step summary]'

/** System prompt for the summarization call. */
export declare function summarizePrompt(): string

/** Render one step's raw material into the user message of a summary request. */
export declare function renderStepMaterial(parts: Array<{ kind: string; text: unknown }>): string

/** Extract the summary text from a summarization reply, or empty when none. */
export declare function parseSummary(blocks: unknown): string

/** Render a stored summary as the message the next step will see. */
export declare function renderSummaryMessage(summary: string): string

/** Whether a message text is a stored step summary. */
export declare function isSummaryText(text: unknown): boolean
