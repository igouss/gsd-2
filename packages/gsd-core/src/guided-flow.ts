/**
 * guided-flow.ts — Stub for harness-coupled guided-flow module.
 *
 * The real implementation lives in the pi-mono extension and depends on
 * ExtensionAPI/ExtensionContext. This stub provides the harness-free
 * functions that gsd-core files actually import.
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Scan the milestones directory and return sorted milestone IDs.
 */
export function findMilestoneIds(basePath: string): string[] {
  const milestonesDir = join(basePath, ".gsd", "milestones");
  try {
    return readdirSync(milestonesDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name)
      .sort(milestoneIdSort);
  } catch {
    return [];
  }
}

/**
 * Sort milestone IDs by numeric prefix, falling back to lexicographic.
 */
export function milestoneIdSort(a: string, b: string): number {
  const na = parseInt(a, 10);
  const nb = parseInt(b, 10);
  if (!isNaN(na) && !isNaN(nb)) return na - nb;
  return a.localeCompare(b);
}
