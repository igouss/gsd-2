/**
 * auto-loop.ts — Barrel re-export for the auto-loop pipeline modules.
 *
 * The implementation has been split into focused modules under auto/.
 * This file preserves the original public API so external consumers
 * continue to work without changes.
 */

export { autoLoop } from "./auto/loop.js";
export { isInfrastructureError, INFRA_ERROR_CODES } from "./auto/infra-errors.js";
export { resolveAgentEnd, resolveAgentEndCancelled, isSessionSwitchInFlight, _resetPendingResolve, _setActiveSession } from "./auto/resolve.js";
export { detectStuck } from "./auto/detect-stuck.js";
export type { CoreLoopDeps, CloseoutOptions, PreVerificationOpts, AutoVerificationResult } from "./auto/loop-deps.js";
export type { AgentEndEvent, ErrorContext, UnitResult } from "./auto/types.js";
