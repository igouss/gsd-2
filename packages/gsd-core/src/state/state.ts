// GSD Extension — State Derivation
// Barrel module: orchestrator + re-exports from split files.

import type { GSDState } from '../domain/types.js';

import {
  loadFile,
  parseRequirementCounts,
} from '../persistence/files.js';

import {
  resolveMilestoneFile,
  resolveGsdRootFile,
} from '../persistence/paths.js';

import { findMilestoneIds } from '../milestone/milestone-ids.js';
import { loadQueueOrder, sortByQueueOrder } from './queue-order.js';
import { isClosedStatus } from '../domain/status-guards.js';

import { parseRoadmap } from './parsers-legacy.js';

import { debugCount, debugTime } from '../reporting/debug-logger.js';
import { logWarning } from '../workflow/workflow-logger.js';

import {
  isDbAvailable,
  getAllMilestones,
  insertMilestone,
} from '../persistence/gsd-db.js';

import { isGhostMilestone, isMilestoneComplete } from './state-helpers.js';
import { CACHE_TTL_MS, getStateCache, setStateCache } from './state-cache.js';
import { deriveStateFromDb } from './state-db.js';
import { _deriveStateImpl } from './state-legacy.js';

// ─── Re-exports (barrel) ─────────────────────────────────────────────────

export { isGhostMilestone, isSliceComplete, isMilestoneComplete, isValidationTerminal } from './state-helpers.js';
export { invalidateStateCache } from './state-cache.js';
export { deriveStateFromDb } from './state-db.js';
export { _deriveStateImpl } from './state-legacy.js';

// ─── getActiveMilestoneId ─────────────────────────────────────────────────

/**
 * Returns the ID of the first incomplete milestone, or null if all are complete.
 */
export async function getActiveMilestoneId(basePath: string): Promise<string | null> {
  // Parallel worker isolation
  const milestoneLock = process.env.GSD_MILESTONE_LOCK;
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
      // Respect queue-order.json so /gsd queue reordering is honored (#2556).
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
 * Reconstruct GSD state from DB (primary) or filesystem (fallback).
 * STATE.md is a rendered cache of this output.
 *
 * When DB is available, queries milestone/slice/task tables directly.
 * Falls back to filesystem parsing for unmigrated projects or when DB
 * has zero milestones (e.g. first run before migration).
 */
export async function deriveState(basePath: string): Promise<GSDState> {
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
  let result: GSDState;

  // Dual-path: try DB-backed derivation first when hierarchy tables are populated
  if (isDbAvailable()) {
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
      // DB open but no milestones on disk either — use filesystem path
      result = await _deriveStateImpl(basePath);
    }
  } else {
    logWarning("state", "DB unavailable — using filesystem state derivation (degraded mode)");
    result = await _deriveStateImpl(basePath);
  }

  stopTimer({ phase: result.phase, milestone: result.activeMilestone?.id });
  debugCount("deriveStateCalls");
  setStateCache(basePath, result);
  return result;
}
