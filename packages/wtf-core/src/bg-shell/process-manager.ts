/**
 * bg-shell/process-manager.ts — Stub for harness-coupled process manager.
 *
 * The real implementation manages background shell processes within
 * the pi-mono extension host. This stub provides the minimal export
 * needed by verification-gate.ts.
 */

export const processes: Map<string, unknown> = new Map<string, unknown>();
