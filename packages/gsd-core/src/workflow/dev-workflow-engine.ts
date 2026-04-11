/**
 * dev-workflow-engine.ts — DevWorkflowEngine implementation.
 *
 * Implements WorkflowEngine by delegating to existing WTF state derivation
 * and dispatch logic. This is the "dev" engine — it wraps the current WTF
 * auto-mode behavior behind the engine-polymorphic interface.
 */

import type { WorkflowEngine } from "./workflow-engine.ts";
import type {
  EngineState,
  EngineDispatchAction,
  CompletedStep,
  ReconcileResult,
  DisplayMetadata,
} from "../routing/engine-types.ts";
import type { WTFState } from "../domain/types.ts";
import type { DispatchAction, DispatchContext } from "../auto/auto-dispatch.ts";

import { deriveState } from "../state/state.ts";
import { resolveDispatch } from "../auto/auto-dispatch.ts";
import { loadEffectiveWTFPreferences } from "../preferences/preferences.ts";

// ─── Bridge: DispatchAction → EngineDispatchAction ────────────────────────

/**
 * Map a WTF-specific DispatchAction (which carries `matchedRule`, `unitType`,
 * etc.) to the engine-generic EngineDispatchAction discriminated union.
 *
 * Exported for unit testing.
 */
export function bridgeDispatchAction(da: DispatchAction): EngineDispatchAction {
  switch (da.action) {
    case "dispatch":
      return {
        action: "dispatch",
        step: {
          unitType: da.unitType,
          unitId: da.unitId,
          prompt: da.prompt,
        },
      };
    case "stop":
      return {
        action: "stop",
        reason: da.reason,
        level: da.level,
      };
    case "skip":
      return { action: "skip" };
  }
}

// ─── DevWorkflowEngine ───────────────────────────────────────────────────

export class DevWorkflowEngine implements WorkflowEngine {
  readonly engineId = "dev" as const;

  async deriveState(basePath: string): Promise<EngineState> {
    const wtf: WTFState = await deriveState(basePath);
    return {
      phase: wtf.phase,
      currentMilestoneId: wtf.activeMilestone?.id ?? null,
      activeSliceId: wtf.activeSlice?.id ?? null,
      activeTaskId: wtf.activeTask?.id ?? null,
      isComplete: wtf.phase === "complete",
      raw: wtf,
    };
  }

  async resolveDispatch(
    state: EngineState,
    context: { basePath: string },
  ): Promise<EngineDispatchAction> {
    const wtf = state.raw as WTFState;
    const mid = wtf.activeMilestone?.id ?? "";
    const midTitle = wtf.activeMilestone?.title ?? "";
    const loaded = loadEffectiveWTFPreferences();
    const prefs = loaded?.preferences ?? undefined;

    const dispatchCtx: DispatchContext = {
      basePath: context.basePath,
      mid,
      midTitle,
      state: wtf,
      prefs,
    };

    const result = await resolveDispatch(dispatchCtx);
    return bridgeDispatchAction(result);
  }

  async reconcile(
    state: EngineState,
    _completedStep: CompletedStep,
  ): Promise<ReconcileResult> {
    return {
      outcome: state.isComplete ? "milestone-complete" : "continue",
    };
  }

  getDisplayMetadata(state: EngineState): DisplayMetadata {
    return {
      engineLabel: "WTF Dev",
      currentPhase: state.phase,
      progressSummary: `${state.currentMilestoneId ?? "no milestone"} / ${state.activeSliceId ?? "—"} / ${state.activeTaskId ?? "—"}`,
      stepCount: null,
    };
  }
}
