// Parallel worker orchestration types.

export type ContextSelectionMode = "full" | "smart";

export type MergeStrategy = "per-slice" | "per-milestone";
export type AutoMergeMode = "auto" | "confirm" | "manual";

export interface ParallelConfig {
  enabled: boolean;
  max_workers: number;
  budget_ceiling?: number;
  merge_strategy: MergeStrategy;
  auto_merge: AutoMergeMode;
  /** Optional model override for parallel milestone workers (e.g. "claude-haiku-4-5"). */
  worker_model?: string;
}
