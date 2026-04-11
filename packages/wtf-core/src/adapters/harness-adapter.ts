/**
 * harness-adapter.ts — The minimal contract between WTF orchestrator and
 * any execution harness (Claude Code, pi-mono, or anything with MCP).
 *
 * The orchestrator owns the loop, state machine, prompts, and dispatch logic.
 * The adapter owns "run this prompt and tell me when it's done."
 */

// ---------------------------------------------------------------------------
// Unit dispatch — what flows between orchestrator and harness
// ---------------------------------------------------------------------------

/**
 * Request to execute a single unit of work (task, slice completion, etc.).
 * The prompt is self-contained — the adapter doesn't need to understand it.
 */
export interface UnitDispatchRequest {
  /** Unit type: research-milestone, plan-milestone, plan-slice, execute-task, complete-slice, complete-milestone, etc. */
  unitType: string;

  /** Scoped identifier: milestone ID, slice ID, or task ID */
  unitId: string;

  /** The full prompt to send to the LLM. Self-contained — includes all context. */
  prompt: string;

  /** Requested model ID (e.g. "claude-sonnet-4-20250514"). Adapter maps to its own model system. */
  modelId?: string;

  /** Path to MCP config JSON pointing to WTF's unit-tools server. The harness should load this so the agent has access to WTF state mutation tools. */
  mcpConfigPath: string;

  /** Working directory for execution. The agent should operate in this directory. */
  cwd: string;

  /** Optional system prompt additions (e.g. project context, codebase summary). */
  systemPrompt?: string;
}

/**
 * Structured error context from a failed or cancelled unit.
 * Category informs the orchestrator's retry/recovery strategy.
 */
export interface UnitErrorContext {
  message: string;
  category: "provider" | "timeout" | "idle" | "network" | "aborted" | "session-failed" | "unknown";
  stopReason?: string;
  isTransient?: boolean;
  retryAfterMs?: number;
}

/**
 * Result of a single unit execution.
 */
export interface UnitDispatchResult {
  status: "completed" | "cancelled" | "error";

  /** Error context when status is "cancelled" or "error". */
  errorContext?: UnitErrorContext;

  /** Cost tracking, if the adapter can report it. */
  cost?: {
    totalCost: number;
    tokens: {
      input: number;
      output: number;
      cacheRead?: number;
      cacheWrite?: number;
    };
  };
}

// ---------------------------------------------------------------------------
// The adapter interface — what a harness must implement
// ---------------------------------------------------------------------------

/**
 * A harness adapter translates WTF's dispatch requests into harness-specific
 * execution. This is the only integration point between WTF core and any
 * external LLM execution environment.
 *
 * Lifecycle: init() → dispatchUnit() (repeated) → shutdown()
 */
export interface HarnessAdapter {
  /** Human-readable adapter name (e.g. "claude-code", "pi-mono") */
  readonly name: string;

  /**
   * Initialize the adapter for a given project directory.
   * Called once before any units are dispatched.
   * Validates prerequisites (e.g. CLI exists, API keys configured).
   */
  init(projectDir: string): Promise<void>;

  /**
   * Dispatch a single unit of work. Returns when the agent finishes.
   * The adapter is responsible for:
   * - Starting a fresh session/process
   * - Sending the prompt
   * - Waiting for completion
   * - Returning the result
   *
   * The promise should only reject on unrecoverable adapter-level failures.
   * Agent-level failures should return { status: "error", errorContext }.
   */
  dispatchUnit(request: UnitDispatchRequest): Promise<UnitDispatchResult>;

  /**
   * Cancel the currently running unit, if any.
   * Should be idempotent — safe to call when no unit is running.
   */
  cancelUnit(): Promise<void>;

  /**
   * Shutdown the adapter. Cleans up processes, connections, temp files.
   * Called once when the orchestrator stops.
   */
  shutdown(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Orchestrator event sink — how the orchestrator communicates status
// ---------------------------------------------------------------------------

/**
 * Event sink for orchestrator status updates. The adapter layer (or a
 * standalone UI) can subscribe to these to show progress.
 *
 * In pi-mono: wired to ctx.ui.notify() and TUI widgets.
 * In standalone: logged to stderr or exposed via MCP notifications.
 */
export interface OrchestratorEventSink {
  /** General notification — info, warnings, errors, success. */
  notify(message: string, level?: "info" | "warning" | "error" | "success"): void;

  /** Progress update — emitted at phase transitions within the loop. */
  progress(data: {
    unitType: string;
    unitId: string;
    phase: string;
    iteration: number;
  }): void;

  /** Metric event — budget usage, timing, cost. */
  metric(data: Record<string, unknown>): void;
}

/**
 * No-op event sink — for testing or headless operation where nobody's listening.
 */
export const nullEventSink: OrchestratorEventSink = {
  notify() {},
  progress() {},
  metric() {},
};
