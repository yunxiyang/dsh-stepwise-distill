/**
 * Stepwise history solidification for DeepSeek Harness.
 *
 * @module dsh-stepwise-distill
 */

/** Cordis plugin name used by loader diagnostics. */
export declare const name: 'stepwise-distill'

/** Settings namespace the Host serves and the browser card claims. */
export declare const SETTINGS_NAMESPACE: 'stepwise-distill'

/** Default line threshold above which a tool result is numbered. */
export declare const DEFAULT_MIN_LINES: 20

/** Default operating mode: measure before mutating. */
export declare const DEFAULT_MODE: 'observe'

/** Prompt section name carrying the keep-contract instructions. */
export declare const PROMPT_SECTION: 'stepwise-distill:contract'

/** Sort order placing the contract after the harness-source and web-surface notes. */
export declare const PROMPT_SECTION_ORDER: 10250

/** Services read when the running profile provides them. */
export declare const optionalInject: ['commands']

/** Tools whose output already carries authoritative line numbers. */
export declare const SELF_NUMBERED_TOOLS: string[]

/** Placeholder for a result whose tool/call is missing from the log. */
export declare const UNKNOWN_TOOL: '<unknown>'

/** Totals one session's numbering and distillation. */
export interface DistillSummary {
  numbered: number
  distilled: number
  originalBytes: number
  distilledBytes: number
  savedBytes: number
  keptShares: number[]
  problems: string[]
}

/** Summarize what distillation has done to one event log. */
export declare function summarize(events: readonly unknown[]): DistillSummary

/** Render the summary as `/distill` output. */
export declare function renderSummary(summary: DistillSummary, config: ResolvedConfig): string

/** Resolve the callId pairing one result with its call. */
export declare function resultCallId(event: unknown): string | undefined

/** Whether a tool's results are outside this plugin's scope. */
export declare function shouldSkip(toolName: unknown, config: ResolvedConfig): boolean

/** Distillation policy; every field has a default, so all are optional. */
export interface Config {
  /** `observe` numbers and reports; `distill` also rewrites the surface. */
  mode?: 'observe' | 'distill'
  /** Only results longer than this many lines are numbered. */
  minLines?: number
  /** Tool names whose results may be distilled; empty means every tool. */
  tools?: string[]
  /** Emit a diagnostic line for every hook evaluation. */
  debug?: boolean
}

/** Resolved plugin policy with every default applied. */
export interface ResolvedConfig {
  mode: 'observe' | 'distill'
  minLines: number
  tools: string[]
  debug: boolean
}

/** Why one node was left untouched. */
export type SkipReason =
  | 'ineligible'
  | 'no-long-leaf'
  | 'already-distilled'
  | 'no-keep-source'
  | 'no-keep-line'
  | 'malformed-keep-line'
  | 'empty-keep-line'
  | 'index-out-of-range'
  | 'not-smaller'

/** A committed distillation plan for one tool result. */
export interface DistillPlan {
  /** Sequence number of the surface node to replace. */
  seq: number
  /** Index of the outer tool-result block holding the text. */
  outer: number
  /** Index of the text leaf inside that block. */
  index: number
  /** Byte length of the text being replaced. */
  originalBytes: number
  /** The distilled replacement text. */
  replacement: string
  /** Line numbers the model asked to keep. */
  keptIndices: number[]
  /** Total number of numbered lines in the original. */
  totalLines: number
}

/** A plan, or the reason no plan was produced. */
export type PlanResult = DistillPlan | { skip: SkipReason }

/** Resolve one config snapshot with every default applied. */
export declare function resolveConfig(config?: Config): ResolvedConfig

/** Read a session's immutable event log across host core versions. */
export declare function readEvents(session: unknown): unknown[]

/** Resolve the tool name behind one result event by pairing its callId. */
export declare function toolNameOf(event: unknown, events: readonly unknown[]): string

/** Whether one tool result is eligible for numbering and distillation. */
export declare function isEligible(
  event: unknown,
  config: ResolvedConfig,
  events: readonly unknown[],
): boolean

/** Collect the blocks of every assistant message between a result and the next human turn. */
export declare function findKeepSource(events: readonly unknown[], seq: number): unknown[]

/** Plan the distillation of one result event; pure and deterministic. */
export declare function planDistillation(
  event: unknown,
  events: readonly unknown[],
  config: ResolvedConfig,
): PlanResult

/** Register the numbering and solidification hooks on a Cordis context. */
export declare function apply(ctx: unknown, config: Config): void
