// Quality gate types: gate evaluation, status tracking, and configuration.

export type GateId = "Q3" | "Q4" | "Q5" | "Q6" | "Q7" | "Q8" | "MV01" | "MV02" | "MV03" | "MV04";
export type GateScope = "slice" | "task" | "milestone";
export type GateStatus = "pending" | "complete" | "omitted";
export type GateVerdict = "pass" | "flag" | "omitted" | "";

export interface GateRow {
  milestone_id: string;
  slice_id: string;
  gate_id: GateId;
  scope: GateScope;
  task_id: string;
  status: GateStatus;
  verdict: GateVerdict;
  rationale: string;
  findings: string;
  evaluated_at: string | null;
}

/** Configuration for parallel quality gate evaluation during slice planning. */
export interface GateEvaluationConfig {
  enabled: boolean;
  /** Which slice-scoped gates to evaluate in parallel. Default: ['Q3', 'Q4']. */
  slice_gates?: string[];
  /** Whether to evaluate task-level gates (Q5/Q6/Q7) via reactive-execute. Default: true when enabled. */
  task_gates?: boolean;
}
