// WTF Extension — State Derivation
// Barrel module: orchestrator + re-exports from split files.

import type { WTFState } from '../domain/types.ts';

import {
  loadFile,
  parseRequirementCounts,
} from '../persistence/files.ts';

import {
  resolveMilestoneFile,
  resolveWtfRootFile,
} from '../persistence/paths.ts';

import { findMilestoneIds } from '../milestone/milestone-ids.ts';
import { loadQueueOrder, sortByQueueOrder } from './queue-order.ts';
import { isClosedStatus } from '../domain/status-guards.ts';

import { parseRoadmap } from '../persistence/md-parsers.ts';

import { debugCount, debugTime } from '../reporting/debug-logger.ts';
import { logWarning } from '../workflow/workflow-logger.ts';

import {
  isDbAvailable,
  getAllMilestones,
  insertMilestone,
} from '../persistence/wtf-db.ts';

import { isGhostMilestone, isMilestoneComplete } from './state-helpers.ts';
import { CACHE_TTL_MS, getStateCache, setStateCache } from './state-cache.ts';
import { deriveStateFromDb } from './state-db.ts';

// ─── Re-exports (barrel) ─────────────────────────────────────────────────

export { isGhostMilestone, isSliceComplete, isMilestoneComplete, isValidationTerminal } from './state-helpers.ts';
export { invalidateStateCache } from './state-cache.ts';
export { deriveStateFromDb } from './state-db.ts';

// ─── getActiveMilestoneId ─────────────────────────────────────────────────

/**
 * Returns the ID of the first incomplete milestone, or null if all are complete.
 */
export async function getActiveMilestoneId(basePath: string): Promise<string | null> {
  // Parallel worker isolation
  const milestoneLock = process.env.WTF_MILESTONE_LOCK;
  if (milestoneLock) {
    const milestoneIds = findMilestoneIds(basePath);
    if (!milestoneIds.includes(milestoneLock)) return null;
    const lockedParked = resolveMilestoneFile(basePath, milestoneLock, "PARKED");
    if (lockedParked) return null;
    return milestoneLock;
  }

  // DB-first: query milestones table for the first non-complete, non-parked milestone
  if (isDbAvailable()) {
    const allMilestones = getAllMilestones();
    if (allMilestones.length > 0) {
      // Respect queue-order.json so /wtf queue reordering is honored (#2556).
      // Without this, the DB path uses lexicographic sort while the dispatch
      // guard uses queue order — causing a deadlock.
      const customOrder = loadQueueOrder(basePath);
      const sortedIds = sortByQueueOrder(allMilestones.map(m => m.id), customOrder);
      const byId = new Map(allMilestones.map(m => [m.id, m]));
      for (const id of sortedIds) {
        const m = byId.get(id)!;
        if (isClosedStatus(m.status) || m.status === "parked") continue;
        return m.id;
      }
      return null;
    }
  }

  // Filesystem fallback for unmigrated projects or empty DB
  const milestoneIds = findMilestoneIds(basePath);
  for (const mid of milestoneIds) {
    const parkedFile = resolveMilestoneFile(basePath, mid, "PARKED");
    if (parkedFile) continue;

    const roadmapFile = resolveMilestoneFile(basePath, mid, "ROADMAP");
    const content = roadmapFile ? await loadFile(roadmapFile) : null;
    if (!content) {
      const summaryFile = resolveMilestoneFile(basePath, mid, "SUMMARY");
      if (summaryFile) continue;
      if (isGhostMilestone(basePath, mid)) continue;
      return mid;
    }
    const roadmap = parseRoadmap(content);
    if (!isMilestoneComplete(roadmap)) {
      const summaryFile = resolveMilestoneFile(basePath, mid, "SUMMARY");
      if (!summaryFile) return mid;
    }
  }
  return null;
}

// ─── deriveState orchestrator ─────────────────────────────────────────────

/**
 * Reconstruct WTF state from the DB.
 * STATE.md is a rendered cache of this output.
 *
 * Disk→DB reconciliation ensures milestones created outside the DB write
 * path are picked up automatically. When the DB is unavailable or empty
 * (no milestones on disk either), returns a minimal pre-planning state.
 */
export async function deriveState(basePath: string): Promise<WTFState> {
  // Return cached result if within the TTL window for the same basePath
  const cache = getStateCache();
  if (
    cache &&
    cache.basePath === basePath &&
    Date.now() - cache.timestamp < CACHE_TTL_MS
  ) {
    return cache.result;
  }

  const stopTimer = debugTime("derive-state-impl");
  let result: WTFState;

  const requirements = parseRequirementCounts(await loadFile(resolveWtfRootFile(basePath, "REQUIREMENTS")));
  const emptyState: WTFState = {
    activeMilestone: null,
    activeSlice: null,
    activeTask: null,
    phase: 'pre-planning',
    recentDecisions: [],
    blockers: [],
    nextAction: 'No milestones found. Run /wtf to create one.',
    registry: [],
    requirements,
    progress: { milestones: { done: 0, total: 0 } },
  };

  if (!isDbAvailable()) {
    logWarning("state", "DB unavailable — returning empty state (degraded mode)");
    result = emptyState;
  } else {
    let dbMilestones = getAllMilestones();

    // Disk→DB reconciliation when DB is empty but disk has milestones (#2631).
    // deriveStateFromDb() does its own reconciliation, but deriveState() skips
    // it entirely when the DB is empty. Sync here so the DB path is used when
    // disk milestones exist but haven't been migrated yet.
    if (dbMilestones.length === 0) {
      const diskIds = findMilestoneIds(basePath);
      let synced = false;
      for (const diskId of diskIds) {
        if (!isGhostMilestone(basePath, diskId)) {
          insertMilestone({ id: diskId, status: 'active' });
          synced = true;
        }
      }
      if (synced) dbMilestones = getAllMilestones();
    }

    if (dbMilestones.length > 0) {
      const stopDbTimer = debugTime("derive-state-db");
      result = await deriveStateFromDb(basePath);
      stopDbTimer({ phase: result.phase, milestone: result.activeMilestone?.id });
    } else {
      result = emptyState;
    }
  }

  stopTimer({ phase: result.phase, milestone: result.activeMilestone?.id });
  debugCount("deriveStateCalls");
  setStateCache(basePath, result);
  return result;
}
