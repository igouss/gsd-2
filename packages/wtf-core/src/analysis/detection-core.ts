/**
 * WTF Detection — Core detection orchestrator and WTF state detectors.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { wtfRoot } from "../persistence/paths.ts";
import type { ProjectDetection, V1Detection, V2Detection } from "./detection-types.ts";
import { detectProjectSignals } from "./detection-signals.ts";
import { PROJECT_DIR_NAME } from "../domain/constants.ts";

const wtfHome = process.env.WTF_HOME || join(homedir(), PROJECT_DIR_NAME);

// ─── Core Detection ─────────────────────────────────────────────────────────────

/**
 * Detect the full project state for a given directory.
 * This is the main entry point — calls all sub-detectors.
 */
export function detectProjectState(basePath: string): ProjectDetection {
  const v1 = detectV1Planning(basePath);
  const v2 = detectV2Wtf(basePath);
  const projectSignals = detectProjectSignals(basePath);
  const globalSetup = hasGlobalSetup();
  const firstEver = isFirstEverLaunch();

  let state: ProjectDetection["state"];
  if (v2 && v2.milestoneCount > 0) {
    state = "v2-wtf";
  } else if (v2 && v2.milestoneCount === 0) {
    state = "v2-wtf-empty";
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
 * Detect a v1 .planning/ directory with WTF v1 markers.
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

// ─── V2 WTF Detection ──────────────────────────────────────────────────────────

function detectV2Wtf(basePath: string): V2Detection | null {
  const wtfPath = wtfRoot(basePath);

  if (!existsSync(wtfPath)) return null;

  const hasPreferences =
    existsSync(join(wtfPath, "PREFERENCES.md")) ||
    existsSync(join(wtfPath, "preferences.md"));

  const hasContext = existsSync(join(wtfPath, "CONTEXT.md"));

  let milestoneCount = 0;
  const milestonesPath = join(wtfPath, "milestones");
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
 * Check if global WTF setup exists (has ~/.wtf/ with preferences).
 */
export function hasGlobalSetup(): boolean {
  return (
    existsSync(join(wtfHome, "PREFERENCES.md")) ||
    existsSync(join(wtfHome, "preferences.md"))
  );
}

/**
 * Check if this is the very first time WTF has been used on this machine.
 * Returns true if ~/.wtf/ doesn't exist or has no preferences or auth.
 */
export function isFirstEverLaunch(): boolean {
  if (!existsSync(wtfHome)) return true;

  if (
    existsSync(join(wtfHome, "PREFERENCES.md")) ||
    existsSync(join(wtfHome, "preferences.md"))
  ) {
    return false;
  }

  if (existsSync(join(wtfHome, "agent", "auth.json"))) return false;

  const legacyPath = join(homedir(), ".pi", "agent", "wtf-preferences.md");
  if (existsSync(legacyPath)) return false;

  return true;
}
