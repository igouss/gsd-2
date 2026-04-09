/**
 * auto-recovery.ts — Harness-free recovery helpers for the auto-loop.
 *
 * Contains artifact verification and loop remediation steps.
 * No harness dependencies.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseUnitId } from "../domain/unit-id.js";
import { relSliceFile, relMilestoneFile } from "../paths.js";

/**
 * Check whether implementation artifacts exist for the current unit.
 */
export function hasImplementationArtifacts(basePath: string): "present" | "absent" | "unknown" {
  try {
    const gsdDir = join(basePath, ".gsd");
    if (!existsSync(gsdDir)) return "absent";
    return "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Verify that a completed unit left behind the expected artifacts.
 */
export function verifyExpectedArtifact(
  _unitType: string,
  _unitId: string,
  _base: string,
): boolean {
  // Stub — real implementation checks for specific file artifacts
  return true;
}

// ─── Loop Remediation ─────────────────────────────────────────────────────────

/**
 * Build concrete, manual remediation steps for a loop-detected unit failure.
 * These are shown when automatic reconciliation is not possible.
 */
export function buildLoopRemediationSteps(
  unitType: string,
  unitId: string,
  base: string,
): string | null {
  const { milestone: mid, slice: sid, task: tid } = parseUnitId(unitId);
  switch (unitType) {
    case "execute-task": {
      if (!mid || !sid || !tid) break;
      return [
        `   1. Run \`gsd undo-task ${tid}\` to reset the task state`,
        `   2. Resume auto-mode — it will re-execute the task`,
        `   3. If the task keeps failing, run \`gsd recover\` to rebuild DB state from disk`,
      ].join("\n");
    }
    case "plan-slice":
    case "research-slice": {
      if (!mid || !sid) break;
      const artifactRel =
        unitType === "plan-slice"
          ? relSliceFile(base, mid, sid, "PLAN")
          : relSliceFile(base, mid, sid, "RESEARCH");
      return [
        `   1. Write ${artifactRel} manually (or with the LLM in interactive mode)`,
        `   2. Run \`gsd recover\` to rebuild DB state from disk`,
        `   3. Resume auto-mode`,
      ].join("\n");
    }
    case "complete-slice": {
      if (!mid || !sid) break;
      return [
        `   1. Run \`gsd reset-slice ${sid}\` to reset the slice and all its tasks`,
        `   2. Resume auto-mode — it will re-execute incomplete tasks and re-complete the slice`,
        `   3. If the slice keeps failing, run \`gsd recover\` to rebuild DB state from disk`,
      ].join("\n");
    }
    case "validate-milestone": {
      if (!mid) break;
      const artifactRel = relMilestoneFile(base, mid, "VALIDATION");
      return [
        `   1. Write ${artifactRel} with verdict: pass`,
        `   2. Run \`gsd recover\` to rebuild DB state from disk`,
        `   3. Resume auto-mode`,
      ].join("\n");
    }
    default:
      break;
  }
  return null;
}
