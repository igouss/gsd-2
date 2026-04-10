/**
 * GSD Detection — Core detection orchestrator and GSD state detectors.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { gsdRoot } from "../persistence/paths.js";
import type { ProjectDetection, V1Detection, V2Detection } from "./detection-types.js";
import { detectProjectSignals } from "./detection-signals.js";

const gsdHome = process.env.GSD_HOME || join(homedir(), ".gsd");

// ─── Core Detection ─────────────────────────────────────────────────────────────

/**
 * Detect the full project state for a given directory.
 * This is the main entry point — calls all sub-detectors.
 */
export function detectProjectState(basePath: string): ProjectDetection {
  const v1 = detectV1Planning(basePath);
  const v2 = detectV2Gsd(basePath);
  const projectSignals = detectProjectSignals(basePath);
  const globalSetup = hasGlobalSetup();
  const firstEver = isFirstEverLaunch();

  let state: ProjectDetection["state"];
  if (v2 && v2.milestoneCount > 0) {
    state = "v2-gsd";
  } else if (v2 && v2.milestoneCount === 0) {
    state = "v2-gsd-empty";
  } else if (v1) {
    state = "v1-planning";
  } else {
    state = "none";
  }

  return {
    state,
    isFirstEverLaunch: firstEver,
    hasGlobalSetup: globalSetup,
    v1: v1 ?? undefined,
    v2: v2 ?? undefined,
    projectSignals,
  };
}

// ─── V1 Planning Detection ──────────────────────────────────────────────────────

/**
 * Detect a v1 .planning/ directory with GSD v1 markers.
 * Returns null if no .planning/ directory found.
 */
export function detectV1Planning(basePath: string): V1Detection | null {
  const planningPath = join(basePath, ".planning");

  if (!existsSync(planningPath)) return null;

  try {
    const stat = statSync(planningPath);
    if (!stat.isDirectory()) return null;
  } catch {
    return null;
  }

  const hasRoadmap = existsSync(join(planningPath, "ROADMAP.md"));
  const phasesPath = join(planningPath, "phases");
  const hasPhasesDir = existsSync(phasesPath);

  let phaseCount = 0;
  if (hasPhasesDir) {
    try {
      const entries = readdirSync(phasesPath, { withFileTypes: true });
      phaseCount = entries.filter(e => e.isDirectory()).length;
    } catch {
      // unreadable — report 0
    }
  }

  return {
    path: planningPath,
    hasPhasesDir,
    hasRoadmap,
    phaseCount,
  };
}

// ─── V2 GSD Detection ──────────────────────────────────────────────────────────

function detectV2Gsd(basePath: string): V2Detection | null {
  const gsdPath = gsdRoot(basePath);

  if (!existsSync(gsdPath)) return null;

  const hasPreferences =
    existsSync(join(gsdPath, "PREFERENCES.md")) ||
    existsSync(join(gsdPath, "preferences.md"));

  const hasContext = existsSync(join(gsdPath, "CONTEXT.md"));

  let milestoneCount = 0;
  const milestonesPath = join(gsdPath, "milestones");
  if (existsSync(milestonesPath)) {
    try {
      const entries = readdirSync(milestonesPath, { withFileTypes: true });
      milestoneCount = entries.filter(e => e.isDirectory()).length;
    } catch {
      // unreadable — report 0
    }
  }

  return { milestoneCount, hasPreferences, hasContext };
}

// ─── Global Setup Detection ─────────────────────────────────────────────────────

/**
 * Check if global GSD setup exists (has ~/.gsd/ with preferences).
 */
export function hasGlobalSetup(): boolean {
  return (
    existsSync(join(gsdHome, "PREFERENCES.md")) ||
    existsSync(join(gsdHome, "preferences.md"))
  );
}

/**
 * Check if this is the very first time GSD has been used on this machine.
 * Returns true if ~/.gsd/ doesn't exist or has no preferences or auth.
 */
export function isFirstEverLaunch(): boolean {
  if (!existsSync(gsdHome)) return true;

  if (
    existsSync(join(gsdHome, "PREFERENCES.md")) ||
    existsSync(join(gsdHome, "preferences.md"))
  ) {
    return false;
  }

  if (existsSync(join(gsdHome, "agent", "auth.json"))) return false;

  const legacyPath = join(homedir(), ".pi", "agent", "gsd-preferences.md");
  if (existsSync(legacyPath)) return false;

  return true;
}
