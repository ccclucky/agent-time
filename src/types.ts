export type Kind = "start" | "complete" | "abort" | "fail" | "model";
export type Status =
  "completed" | "aborted" | "failed" | "open" | "incomplete" | "invalid";
export interface Event {
  key: string;
  turn_id: string;
  kind: Kind;
  at_ms: number;
  model: string | null;
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
  work_ms: null;
  human_ms: null;
  response_gap_ms: null;
  period_ms?: number | null;
}
export interface Session {
  id: string;
  agent: string;
  project: string;
  issues: string[];
  turns: Turn[];
  imported_at: string;
  period_ms?: number;
  measured_turns?: number;
}
export class ValidationError extends Error {}
