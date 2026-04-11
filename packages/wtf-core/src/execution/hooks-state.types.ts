// Hook runtime and persistence state types.

export interface HookExecutionState {
  /** Hook name. */
  hookName: string;
  /** The unit type that triggered this hook. */
  triggerUnitType: string;
  /** The unit ID that triggered this hook. */
  triggerUnitId: string;
  /** Current cycle (1-based). */
  cycle: number;
  /** Whether the hook completed with a retry signal (retry_on artifact found). */
  pendingRetry: boolean;
}

export interface PersistedHookState {
  /** Cycle counts keyed as "hookName/triggerUnitType/triggerUnitId". */
  cycleCounts: Record<string, number>;
  /** Timestamp of last state save. */
  savedAt: string;
}

export interface HookStatusEntry {
  /** Hook name. */
  name: string;
  /** Hook type: "post" or "pre". */
  type: "post" | "pre";
  /** Whether hook is enabled. */
  enabled: boolean;
  /** What unit types it targets. */
  targets: string[];
  /** Current cycle counts for active triggers. */
  activeCycles: Record<string, number>;
}
