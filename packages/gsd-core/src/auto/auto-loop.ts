/**
 * auto-loop.ts — Barrel re-export for the auto-loop pipeline modules.
 *
 * The implementation has been split into focused modules under auto/.
 * This file preserves the original public API so external consumers
 * continue to work without changes.
 */

export { autoLoop } from "../auto/loop.ts";
export { isInfrastructureError, INFRA_ERROR_CODES } from "../auto/infra-errors.ts";
export { resolveAgentEnd, resolveAgentEndCancelled, isSessionSwitchInFlight, _resetPendingResolve, _setActiveSession } from "../auto/resolve.ts";
export { detectStuck } from "../auto/detect-stuck.ts";
export type { CoreLoopDeps, CloseoutOptions, PreVerificationOpts, AutoVerificationResult } from "../auto/loop-deps.ts";
export type { AgentEndEvent, ErrorContext, UnitResult } from "../auto/types.ts";
