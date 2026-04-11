// Hook configuration and dispatch types: post-unit and pre-dispatch hook shapes.

// ─── Post-Unit Hooks ─────────────────────────────────────────────────────

export interface PostUnitHookConfig {
  /** Unique hook identifier — used in idempotency keys and logging. */
  name: string;
  /** Unit types that trigger this hook (e.g., ["execute-task"]). */
  after: string[];
  /** Prompt sent to the LLM session. Supports {milestoneId}, {sliceId}, {taskId} substitutions. */
  prompt: string;
  /** Max times this hook can fire for the same trigger unit. Default 1, max 10. */
  max_cycles?: number;
  /** Model override for hook sessions. */
  model?: string;
  /** Expected output file name (relative to task/slice dir). Used for idempotency — skip if exists. */
  artifact?: string;
  /** If this file is produced instead of artifact, re-run the trigger unit then re-run hooks. */
  retry_on?: string;
  /** Agent definition file to use. */
  agent?: string;
  /** Set false to disable without removing config. Default true. */
  enabled?: boolean;
}

export interface HookDispatchResult {
  /** Hook name for display. */
  hookName: string;
  /** The prompt to send. */
  prompt: string;
  /** Model override, if configured. */
  model?: string;
  /** Synthetic unit type, e.g. "hook/code-review". */
  unitType: string;
  /** The trigger unit's ID, reused for the hook. */
  unitId: string;
}

// ─── Pre-Dispatch Hooks ──────────────────────────────────────────────────

export interface PreDispatchHookConfig {
  /** Unique hook identifier. */
  name: string;
  /** Unit types this hook intercepts before dispatch (e.g., ["execute-task"]). */
  before: string[];
  /** Action to take: "modify" mutates the prompt, "skip" skips the unit, "replace" swaps it. */
  action: "modify" | "skip" | "replace";
  /** For "modify": text prepended to the unit prompt. Supports {milestoneId}, {sliceId}, {taskId}. */
  prepend?: string;
  /** For "modify": text appended to the unit prompt. Supports {milestoneId}, {sliceId}, {taskId}. */
  append?: string;
  /** For "replace": the replacement prompt. Supports {milestoneId}, {sliceId}, {taskId}. */
  prompt?: string;
  /** For "replace": override the unit type label. */
  unit_type?: string;
  /** For "skip": optional condition file — only skip if this file exists (relative to unit dir). */
  skip_if?: string;
  /** Model override when this hook fires. */
  model?: string;
  /** Set false to disable without removing config. Default true. */
  enabled?: boolean;
}

export interface PreDispatchResult {
  /** What happened: the unit proceeds with modifications, was skipped, or was replaced. */
  action: "proceed" | "skip" | "replace";
  /** Modified/replacement prompt (for "proceed" and "replace"). */
  prompt?: string;
  /** Override unit type (for "replace"). */
  unitType?: string;
  /** Model override. */
  model?: string;
  /** Names of hooks that fired, for logging. */
  firedHooks: string[];
}
