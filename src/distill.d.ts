/**
 * Pure distillation logic for stepwise history solidification.
 *
 * @module dsh-stepwise-distill/distill
 */

/** Marker opening the machine-readable line in a distilled result. */
export declare const DISTILL_MARKER: 'distilled:'

/** Prefix of the `keep:` contract line the model emits. */
export declare const KEEP_PREFIX: 'keep:'

/** First line number assigned to a numbered tool result. */
export declare const FIRST_LINE_NUMBER: 1

/** Split result text into lines, without a trailing empty element. */
export declare function splitLines(text: unknown): string[]

/** Number every line of one tool result from one. */
export declare function numberLines(text: unknown): string

/** Whether a result is long enough to be worth numbering. */
export declare function shouldNumber(text: unknown, minLines: number): boolean

/** Whether a result is long enough to be worth distilling, numbered or not. */
export declare function isLongEnough(text: unknown, minLines: number): boolean

/** Whether a result already carries this plugin's numbering. */
export declare function isNumbered(text: unknown): boolean

/** Remove one numbering pass from a whole result, for measurement. */
export declare function stripNumbering(text: unknown): string

/** Flatten a message's text blocks to plain text. */
export declare function textOf(blocks: unknown): string

/** Whether a block is reasoning the transport layer is expected to strip. */
export declare function isReasoning(block: unknown): boolean

/** Parsed `keep:` contract state for one assistant message. */
export interface KeepSelection {
  /** Whether a contract line was present at all. */
  found: boolean
  /** Requested line numbers, sorted and unique; empty when malformed or empty. */
  indices: number[]
  /** Whether a line was present but unreadable. */
  malformed: boolean
}

/** Extract the kept line numbers from one assistant message. */
export declare function parseKeep(blocks: unknown): KeepSelection

/** Parse a comma-separated index list; null when malformed. */
export declare function parseIndices(raw: unknown): number[] | null

/** Read the marker payload of a distilled result, or undefined. */
export declare function distillMarker(text: unknown): string | undefined

/** Whether a tool result already carries the distillation marker. */
export declare function isDistilled(text: unknown): boolean

/** Inputs for one distilled result's text. */
export interface DistillTextOptions {
  toolName: string
  isError: boolean
  totalLines: number
  keptLines: string[]
  keptIndices: number[]
  originalText: string
  seq: number
}

/** Build the distilled text of one numbered tool result. */
export declare function buildDistilledText(options: DistillTextOptions): string

/** Remove a numbered line's own counter prefix. */
export declare function stripNumberPrefix(line: unknown): string

/** Render the numbering contract appended to one tool result. */
export declare function numberingContract(eligibleCount: number): string

/** Render the system-prompt section announcing the contract. */
export declare function contractSection(minLines: number): string

/** Whether a leaf text is worth keeping in the distilled form. */
export declare function isSubstantive(text: unknown): boolean

/** One text leaf inside a tool-result message. */
export interface TextLeaf {
  outer: number
  index: number
  text: string
}

/** Pick the text leaves of one tool-result message. */
export declare function textLeaves(message: unknown): TextLeaf[]
