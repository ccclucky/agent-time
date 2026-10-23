/** Adapter ids with an implemented read-only importer — the single list both
 * the CLI/directory surfaces and Store.importFile dispatch on. */
export const ADAPTERS = ["codex", "claude", "pi"] as const;
export type AdapterName = (typeof ADAPTERS)[number];
export const isAdapterName = (v: string): v is AdapterName =>
  (ADAPTERS as readonly string[]).includes(v);

export type Kind =
  | "start"
  | "complete"
  | "abort"
  | "fail"
  | "model"
  | "review_wait_start"
  | "review_wait_end"
  | "tool_use"
  | "tool_result";

export type Status =
  | "completed"
  | "aborted"
  | "failed"
  | "open"
  | "incomplete"
  | "invalid";

export interface ToolExecutionDetail {
  name: string;
  count: number;
  duration_ms: number;
}

export interface TurnBreakdown {
  model_api_ms: number;
  tool_execution_ms: number;
  /** Claude: measured permission wait. Pi: absent (source has no approval events). */
  review_wait_ms?: number;
  /** Pi: positive tool-ready → tool-start gaps the source cannot attribute
   *  (may contain approval waits, scheduling, rate limiting). */
  unclassified_delay_ms?: number;
  tools: ToolExecutionDetail[];
  model_api_breakdown?: { model: string; duration_ms: number }[];
  thinking_breakdown?: { level: string; duration_ms: number }[];
}

export interface TokenUsage {
  input_tokens: number;
  cached_input_tokens: number;
  cache_write_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
  total_tokens: number;
}
export type UsageField = keyof TokenUsage;
export const TOKEN_FIELDS = [
  "input_tokens",
  "cached_input_tokens",
  "cache_write_input_tokens",
  "output_tokens",
  "reasoning_output_tokens",
  "total_tokens",
] as const satisfies readonly UsageField[];
export const zeroUsage = (): TokenUsage => ({
  input_tokens: 0,
  cached_input_tokens: 0,
  cache_write_input_tokens: 0,
  output_tokens: 0,
  reasoning_output_tokens: 0,
  total_tokens: 0,
});
// Named-field usage helpers: field arithmetic (diff, sum, copy) goes through
// mapUsage so consumers never repeat the six-field ladder by hand.
export function mapUsage(
  usage: TokenUsage,
  fn: (value: number, field: UsageField) => number,
): TokenUsage {
  // Build from TOKEN_FIELDS only: callers may pass wider rows (token_usage
  // joins carry session_id/turn_id), and the result must stay a pure
  // TokenUsage so extra columns never leak into API payloads.
  const out = {} as Record<UsageField, number>;
  for (const f of TOKEN_FIELDS) out[f] = fn(usage[f], f);
  return out;
}
export const addUsage = (a: TokenUsage, b: TokenUsage): TokenUsage =>
  mapUsage(a, (v, f) => v + b[f]);
export const diffUsage = (
  end: TokenUsage,
  start: TokenUsage | null,
): TokenUsage => mapUsage(end, (v, f) => Math.max(0, v - (start?.[f] ?? 0)));

export interface SubagentSummary {
  agent_id: string;
  name?: string;
  start_ms: number;
  end_ms: number;
  work_ms: number;
  review_wait_ms: number;
  turns: Turn[];
}

export interface Event {
  key: string;
  turn_id: string;
  kind: Kind;
  at_ms: number;
  model: string | null;
  agent_id?: string | null;
  tool_id?: string | null;
  tool_name?: string | null;
  end_ms?: number | null;
  thinking_level?: string | null;
}

export interface Turn {
  id: string;
  start_ms: number | null;
  end_ms: number | null;
  elapsed_ms: number | null;
  status: Status;
  reason: string | null;
  models: string[];
  events: Event[];
  work_ms: number | null;
  review_wait_ms: number | null;
  standby_ms: number | null;
  human_ms: number | null;
  response_gap_ms: number | null;
  period_ms?: number | null;
  agent_id?: string | null;
  subagents?: SubagentSummary[];
  breakdown?: TurnBreakdown | null;
  tokens?: TokenUsage | null;
}

export interface Session {
  id: string;
  agent: string;
  project: string;
  title?: string | null;
  issues: string[];
  turns: Turn[];
  imported_at: string;
  period_ms?: number;
  measured_turns?: number;
  work_ms?: number | null;
  review_wait_ms?: number | null;
  standby_ms?: number | null;
  subagents?: SubagentSummary[];
  tokens?: TokenUsage | null;
}

/** On-demand per-turn transcript text, extracted from the local source file
 *  when the session detail drawer opens. Never persisted to the store. */
export interface TranscriptToolCall {
  name: string;
  duration_ms: number | null;
}

export interface TranscriptTurn {
  turn_id: string;
  prompt: string | null;
  thinking: string | null;
  models: string[];
  tool_calls: TranscriptToolCall[];
}

export interface SessionTranscript {
  session_id: string;
  turns: TranscriptTurn[];
  missing_fields: string[];
}

export class ValidationError extends Error {}
