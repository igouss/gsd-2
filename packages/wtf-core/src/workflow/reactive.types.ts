// Reactive (graph-derived parallel) task execution types.

/** IO signature extracted from a single task plan's Inputs/Expected Output sections. */
export interface TaskIO {
  id: string;        // e.g. "T01"
  title: string;
  inputFiles: string[];
  outputFiles: string[];
  done: boolean;
}

/** A task node with derived dependency edges from input/output intersection. */
export interface DerivedTaskNode extends TaskIO {
  /** IDs of tasks whose outputFiles overlap with this task's inputFiles. */
  dependsOn: string[];
}

/** Configuration for reactive (graph-derived parallel) task execution within a slice. */
export interface ReactiveExecutionConfig {
  enabled: boolean;
  /** Maximum number of tasks to dispatch in parallel. Clamped to 1–8. */
  max_parallel: number;
  /** Isolation mode for parallel tasks within a slice. Currently only "same-tree" is supported. */
  isolation_mode: "same-tree";
  /** Optional model override for subagents spawned during parallel execution. */
  subagent_model?: string;
}

/** Per-slice reactive execution runtime state, persisted to disk. */
export interface ReactiveExecutionState {
  sliceId: string;
  /** Task IDs that have been verified as completed. */
  completed: string[];
  /** Task IDs dispatched in the current/most recent reactive batch. */
  dispatched: string[];
  /** Snapshot of the graph at last dispatch. */
  graphSnapshot: {
    taskCount: number;
    edgeCount: number;
    readySetSize: number;
    ambiguous: boolean;
  };
  updatedAt: string;
}
