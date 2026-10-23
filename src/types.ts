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
  review_wait_ms: number;
  tools: ToolExecutionDetail[];
  model_api_breakdown?: { model: string; duration_ms: number }[];
  thinking_breakdown?: { level: string; duration_ms: number }[];
}

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
}

export class ValidationError extends Error {}
