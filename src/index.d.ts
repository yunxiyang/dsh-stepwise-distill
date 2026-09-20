/**
 * Stepwise history solidification for DeepSeek Harness.
 *
 * Keeps a long conversation usable by keeping the PROCESS out of the way and
 * the RESULT in it: the model's own reasoning is stripped at projection, and
 * each completed step is replaced in later turns by a short summary of what it
 * concluded. The raw material stays in the append-only log and is readable
 * back by seq.
 *
 * @module dsh-stepwise-distill
 */

/** Cordis plugin name used by loader diagnostics. */
export declare const name: 'stepwise-distill'

/** Settings namespace the Host serves and the browser card claims. */
export declare const SETTINGS_NAMESPACE: 'stepwise-distill'

/** Services cordis must resolve before the plugin body runs. */
export declare const inject: ['systemPrompt', 'agents']

/** Services read when the running profile provides them. */
export declare const optionalInject: ['commands', 'tools', 'llm']

/** Placeholder used when a result cannot be matched to its call. */
export declare const UNKNOWN_TOOL: '<unknown>'

/**
 * Non-enumerable marker recording that a session's projection is wrapped.
 *
 * Stored on the session rather than in module scope because sessions outlive
 * plugin mounts: a resume, a reload, or a second mount must not wrap twice.
 */
export declare const REASONING_STRIPPED: symbol

/** Non-enumerable marker recording which `turn/step` pairs have a summary. */
export declare const SUMMARIZED_STEPS: symbol

/** Prompt section name carrying the written-conclusion instructions. */
export declare const REASONING_SECTION: 'stepwise-distill:reasoning'

/** Sort order placing the conclusion instructions after the host's own notes. */
export declare const REASONING_SECTION_ORDER: 10250

/** Plugin config, as the loader or the Settings section supplies it. */
export interface PluginConfig {
  /** Ask the model to write a conclusion into its reply at the end of each step. */
  reasoningContract?: boolean
  /** Ask for a step summary and hold the step's raw material out of later turns. */
  stepSummary?: boolean
  /** Emit a diagnostic line for every evaluation. */
  debug?: boolean
}

/** Plugin config with every default applied. */
export interface ResolvedConfig {
  reasoningContract: boolean
  stepSummary: boolean
  debug: boolean
}

/** Apply defaults to one config snapshot. */
export declare function resolveConfig(config?: PluginConfig): ResolvedConfig

/** Read a session's immutable event log across host core versions. */
export declare function readEvents(session: unknown): readonly unknown[]

/** One `/distill` report. */
export interface DistillReport {
  steps: number
  /** Records found in the log. Counted from the log, never from a caller. */
  summarized: number
  summaries: string[]
  droppedBytes: number
  droppedPieces: number
}

/** Report what the plugin is holding back from later turns, read from the log. */
export declare function summarize(events: readonly unknown[]): DistillReport

/** Render a report as the text a `/distill` invocation shows. */
export declare function renderSummary(report: DistillReport, config: ResolvedConfig): string

/** Mount the plugin on a Cordis context. */
export declare function apply(ctx: unknown, config?: PluginConfig): void
