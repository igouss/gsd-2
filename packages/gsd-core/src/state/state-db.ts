// DB-backed state derivation — primary path for migrated projects.

import type {
  GSDState,
  ActiveRef,
  MilestoneRegistryEntry,
} from '../domain/types.js';

import {
  parseRoadmap,
  parsePlan,
} from './parsers-legacy.js';

import {
  parseSummary,
  loadFile,
  parseRequirementCounts,
} from '../persistence/files.js';

import {
  resolveMilestoneFile,
  resolveSlicePath,
  resolveSliceFile,
  resolveTaskFile,
  resolveTasksDir,
  resolveGsdRootFile,
} from '../persistence/paths.js';

import { findMilestoneIds } from '../milestone/milestone-ids.js';
import { loadQueueOrder, sortByQueueOrder } from './queue-order.js';
import { isDeferredStatus } from '../domain/status-guards.js';

import { join } from 'path';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { logWarning, logError } from '../workflow/workflow-logger.js';
import { extractVerdict } from '../analysis/verdict-parser.js';

import {
  isDbAvailable,
  getAllMilestones,
  getMilestoneSlices,
  getSliceTasks,
  getReplanHistory,
  getSlice,
  insertMilestone,
  insertSlice,
  insertTask,
  updateTaskStatus,
  getPendingSliceGateCount,
  type MilestoneRow,
  type SliceRow,
} from '../persistence/gsd-db.js';

import {
  isGhostMilestone,
  isValidationTerminal,
  stripMilestonePrefix,
  extractContextTitle,
  isStatusDone,
} from './state-helpers.js';

/**
 * Derive GSD state from the milestones/slices/tasks DB tables.
 * Flag files (PARKED, VALIDATION, CONTINUE, REPLAN, REPLAN-TRIGGER, CONTEXT-DRAFT)
 * are still checked on the filesystem since they aren't in DB tables.
 * Requirements also stay file-based via parseRequirementCounts().
 *
 * Must produce field-identical GSDState to _deriveStateImpl() for the same project.
 */
export async function deriveStateFromDb(basePath: string): Promise<GSDState> {
  const requirements = parseRequirementCounts(await loadFile(resolveGsdRootFile(basePath, "REQUIREMENTS")));

  let allMilestones = getAllMilestones();

  // Incremental disk→DB sync: milestone directories created outside the DB
  // write path (via /gsd queue, manual mkdir, or complete-milestone writing the
  // next CONTEXT.md) are never inserted by the initial migration guard in
  // auto-start.ts because that guard only runs when gsd.db doesn't exist yet.
  // Reconcile here so deriveStateFromDb never silently misses queued milestones.
  // insertMilestone uses INSERT OR IGNORE, so this is safe to call every time.
  const dbIdSet = new Set(allMilestones.map(m => m.id));
  const diskIds = findMilestoneIds(basePath);
  let synced = false;
  for (const diskId of diskIds) {
    if (!dbIdSet.has(diskId) && !isGhostMilestone(basePath, diskId)) {
      insertMilestone({ id: diskId, status: 'active' });
      synced = true;
    }
  }
  if (synced) allMilestones = getAllMilestones();

  // Disk→DB slice reconciliation (#2533): slices defined in ROADMAP.md but
  // missing from the DB cause permanent "No slice eligible" blocks because
  // the dependency resolver only sees DB rows. Parse each milestone's roadmap
  // and insert any missing slices, checking SUMMARY files to set correct status.
  // insertSlice uses INSERT OR IGNORE, so existing rows are never overwritten.
  for (const mid of diskIds) {
    if (isGhostMilestone(basePath, mid)) continue;
    const roadmapPath = resolveMilestoneFile(basePath, mid, "ROADMAP");
    if (!roadmapPath) continue;

    const dbSlices = getMilestoneSlices(mid);
    const dbSliceIds = new Set(dbSlices.map(s => s.id));

    let roadmapContent: string;
    try { roadmapContent = readFileSync(roadmapPath, "utf-8"); }
    catch { continue; }

    const parsed = parseRoadmap(roadmapContent);
    for (const s of parsed.slices) {
      if (dbSliceIds.has(s.id)) continue;
      const summaryPath = resolveSliceFile(basePath, mid, s.id, "SUMMARY");
      const sliceStatus = (s.done || summaryPath) ? "complete" : "pending";
      insertSlice({
        id: s.id, milestoneId: mid, title: s.title,
        status: sliceStatus, risk: s.risk,
        depends: s.depends, demo: s.demo,
      });
    }
  }

  // Reconcile: discover milestones that exist on disk but are missing from
  // the DB. This happens when milestones were created before the DB migration
  // or were manually added to the filesystem. Without this, disk-only
  // milestones are invisible after migration (#2416).
  const dbMilestoneIds = new Set(allMilestones.map(m => m.id));
  const diskMilestoneIds = findMilestoneIds(basePath);
  for (const diskId of diskMilestoneIds) {
    if (!dbMilestoneIds.has(diskId)) {
      // Synthesize a minimal MilestoneRow for the disk-only milestone.
      // Title and status will be resolved from disk files in the loop below.
      allMilestones.push({
        id: diskId,
        title: diskId,
        status: 'active',
        depends_on: [] as string[],
        created_at: new Date().toISOString(),
      } as MilestoneRow);
    }
  }
  // Re-sort so milestones follow queue order (same as dispatch guard) (#2556)
  const customOrder = loadQueueOrder(basePath);
  const sortedIds = sortByQueueOrder(allMilestones.map(m => m.id), customOrder);
  const byId = new Map(allMilestones.map(m => [m.id, m]));
  allMilestones.length = 0;
  for (const id of sortedIds) allMilestones.push(byId.get(id)!);

  // Parallel worker isolation: when locked, filter to just the locked milestone
  const milestoneLock = process.env.GSD_MILESTONE_LOCK;
  const milestones = milestoneLock
    ? allMilestones.filter(m => m.id === milestoneLock)
    : allMilestones;

  if (milestones.length === 0) {
    return {
      activeMilestone: null,
      activeSlice: null,
      activeTask: null,
      phase: 'pre-planning',
      recentDecisions: [],
      blockers: [],
      nextAction: 'No milestones found. Run /gsd to create one.',
      registry: [],
      requirements,
      progress: { milestones: { done: 0, total: 0 } },
    };
  }

  // Phase 1: Build completeness set (which milestones count as "done" for dep resolution)
  const completeMilestoneIds = new Set<string>();
  const parkedMilestoneIds = new Set<string>();

  for (const m of milestones) {
    // Check disk for PARKED flag (not stored in DB status reliably — disk is truth for flag files)
    const parkedFile = resolveMilestoneFile(basePath, m.id, "PARKED");
    if (parkedFile || m.status === 'parked') {
      parkedMilestoneIds.add(m.id);
      continue;
    }

    if (isStatusDone(m.status)) {
      completeMilestoneIds.add(m.id);
      continue;
    }

    // Check if milestone has a summary on disk (terminal artifact per #864)
    const summaryFile = resolveMilestoneFile(basePath, m.id, "SUMMARY");
    if (summaryFile) {
      completeMilestoneIds.add(m.id);
      continue;
    }

    // Milestones with all slices done but no SUMMARY file are in
    // validating/completing state — intentionally NOT added to
    // completeMilestoneIds.  The SUMMARY file (checked above) is the
    // terminal artifact that proves completion per #864.
  }

  // Phase 2: Build registry and find active milestone
  const registry: MilestoneRegistryEntry[] = [];
  let activeMilestone: ActiveRef | null = null;
  let activeMilestoneSlices: SliceRow[] = [];
  let activeMilestoneFound = false;
  let activeMilestoneHasDraft = false;
  // Queued shells (DB row, no slices, no content files) are deferred during
  // the main loop so they don't eclipse real active milestones (#3470).
  // If no real active milestone is found, the first deferred shell is promoted.
  let firstDeferredQueuedShell: { id: string; title: string; deps: string[] } | null = null;

  for (const m of milestones) {
    if (parkedMilestoneIds.has(m.id)) {
      registry.push({ id: m.id, title: stripMilestonePrefix(m.title) || m.id, status: 'parked' });
      continue;
    }

    // Ghost milestone check: no slices in DB AND no substantive files on disk.
    // Skip queued milestones — they are handled by the deferred-shell logic below (#3470).
    const slices = getMilestoneSlices(m.id);
    if (slices.length === 0 && !isStatusDone(m.status) && m.status !== 'queued') {
      // Check disk for ghost detection
      if (isGhostMilestone(basePath, m.id)) continue;
    }

    const summaryFile = resolveMilestoneFile(basePath, m.id, "SUMMARY");

    // Determine if this milestone is complete
    if (completeMilestoneIds.has(m.id) || (summaryFile !== null)) {
      // Get title from DB or summary
      let title = stripMilestonePrefix(m.title) || m.id;
      if (summaryFile && !m.title) {
        const summaryContent = await loadFile(summaryFile);
        if (summaryContent) {
          title = parseSummary(summaryContent).title || m.id;
        }
      }
      registry.push({ id: m.id, title, status: 'complete' });
      completeMilestoneIds.add(m.id); // ensure it's in the set
      continue;
    }

    // Not complete — determine if it should be active
    const allSlicesDone = slices.length > 0 && slices.every(s => isStatusDone(s.status));

    // Get title — prefer DB, fall back to context file extraction
    let title = stripMilestonePrefix(m.title) || m.id;
    if (title === m.id) {
      const contextFile = resolveMilestoneFile(basePath, m.id, "CONTEXT");
      const draftFile = resolveMilestoneFile(basePath, m.id, "CONTEXT-DRAFT");
      const contextContent = contextFile ? await loadFile(contextFile) : null;
      const draftContent = draftFile && !contextContent ? await loadFile(draftFile) : null;
      title = extractContextTitle(contextContent || draftContent, m.id);
    }

    if (!activeMilestoneFound) {
      // Check milestone-level dependencies
      const deps = m.depends_on;
      const depsUnmet = deps.some(dep => !completeMilestoneIds.has(dep));

      if (depsUnmet) {
        registry.push({ id: m.id, title, status: 'pending', dependsOn: deps });
        continue;
      }

      // Defer queued shell milestones with no substantive content (#3470).
      // A queued milestone with no slices and no context/draft file is a
      // placeholder that should not block later real active milestones.
      // If no real active milestone is found after the loop, the first
      // deferred shell is promoted to active (#2921).
      if (m.status === 'queued' && slices.length === 0) {
        const contextFile = resolveMilestoneFile(basePath, m.id, "CONTEXT");
        const draftFile = resolveMilestoneFile(basePath, m.id, "CONTEXT-DRAFT");
        if (!contextFile && !draftFile) {
          if (!firstDeferredQueuedShell) {
            firstDeferredQueuedShell = { id: m.id, title, deps };
          }
          registry.push({ id: m.id, title, status: 'pending', ...(deps.length > 0 ? { dependsOn: deps } : {}) });
          continue;
        }
      }

      // Handle all-slices-done case (validating/completing)
      if (allSlicesDone) {
        const validationFile = resolveMilestoneFile(basePath, m.id, "VALIDATION");
        const validationContent = validationFile ? await loadFile(validationFile) : null;
        const validationTerminal = validationContent ? isValidationTerminal(validationContent) : false;

        if (!validationTerminal || (validationTerminal && !summaryFile)) {
          // Validating or completing — still active
          activeMilestone = { id: m.id, title };
          activeMilestoneSlices = slices;
          activeMilestoneFound = true;
          registry.push({ id: m.id, title, status: 'active', ...(deps.length > 0 ? { dependsOn: deps } : {}) });
          continue;
        }
      }

      // Check for context draft (needs-discussion phase)
      const contextFile = resolveMilestoneFile(basePath, m.id, "CONTEXT");
      const draftFile = resolveMilestoneFile(basePath, m.id, "CONTEXT-DRAFT");
      if (!contextFile && draftFile) activeMilestoneHasDraft = true;

      activeMilestone = { id: m.id, title };
      activeMilestoneSlices = slices;
      activeMilestoneFound = true;
      registry.push({ id: m.id, title, status: 'active', ...(deps.length > 0 ? { dependsOn: deps } : {}) });
    } else {
      // After active milestone found — rest are pending
      const deps = m.depends_on;
      registry.push({ id: m.id, title, status: 'pending', ...(deps.length > 0 ? { dependsOn: deps } : {}) });
    }
  }

  // Promote deferred queued shell if no real active milestone was found (#3470/#2921).
  if (!activeMilestoneFound && firstDeferredQueuedShell) {
    const shell = firstDeferredQueuedShell;
    activeMilestone = { id: shell.id, title: shell.title };
    activeMilestoneSlices = [];
    const entry = registry.find(e => e.id === shell.id);
    if (entry) entry.status = 'active';
  }

  const milestoneProgress = {
    done: registry.filter(e => e.status === 'complete').length,
    total: registry.length,
  };

  // ── No active milestone ──────────────────────────────────────────────
  if (!activeMilestone) {
    const pendingEntries = registry.filter(e => e.status === 'pending');
    const parkedEntries = registry.filter(e => e.status === 'parked');

    if (pendingEntries.length > 0) {
      const blockerDetails = pendingEntries
        .filter(e => e.dependsOn && e.dependsOn.length > 0)
        .map(e => `${e.id} is waiting on unmet deps: ${e.dependsOn!.join(', ')}`);
      return {
        activeMilestone: null, activeSlice: null, activeTask: null,
        phase: 'blocked',
        recentDecisions: [], blockers: blockerDetails.length > 0
          ? blockerDetails
          : ['All remaining milestones are dep-blocked but no deps listed — check CONTEXT.md files'],
        nextAction: 'Resolve milestone dependencies before proceeding.',
        registry, requirements,
        progress: { milestones: milestoneProgress },
      };
    }

    if (parkedEntries.length > 0) {
      const parkedIds = parkedEntries.map(e => e.id).join(', ');
      return {
        activeMilestone: null, activeSlice: null, activeTask: null,
        phase: 'pre-planning',
        recentDecisions: [], blockers: [],
        nextAction: `All remaining milestones are parked (${parkedIds}). Run /gsd unpark <id> or create a new milestone.`,
        registry, requirements,
        progress: { milestones: milestoneProgress },
      };
    }

    if (registry.length === 0) {
      return {
        activeMilestone: null, activeSlice: null, activeTask: null,
        phase: 'pre-planning',
        recentDecisions: [], blockers: [],
        nextAction: 'No milestones found. Run /gsd to create one.',
        registry: [], requirements,
        progress: { milestones: { done: 0, total: 0 } },
      };
    }

    // All milestones complete
    const lastEntry = registry[registry.length - 1];
    const activeReqs = requirements.active ?? 0;
    const completionNote = activeReqs > 0
      ? `All milestones complete. ${activeReqs} active requirement${activeReqs === 1 ? '' : 's'} in REQUIREMENTS.md ${activeReqs === 1 ? 'has' : 'have'} not been mapped to a milestone.`
      : 'All milestones complete.';
    return {
      activeMilestone: null,
      lastCompletedMilestone: lastEntry ? { id: lastEntry.id, title: lastEntry.title } : null,
      activeSlice: null, activeTask: null,
      phase: 'complete',
      recentDecisions: [], blockers: [],
      nextAction: completionNote,
      registry, requirements,
      progress: { milestones: milestoneProgress },
    };
  }

  // ── Active milestone has no slices or no roadmap ────────────────────
  const hasRoadmap = resolveMilestoneFile(basePath, activeMilestone.id, "ROADMAP") !== null;

  if (activeMilestoneSlices.length === 0) {
    if (!hasRoadmap) {
      const phase = activeMilestoneHasDraft ? 'needs-discussion' as const : 'pre-planning' as const;
      const nextAction = activeMilestoneHasDraft
        ? `Discuss draft context for milestone ${activeMilestone.id}.`
        : `Plan milestone ${activeMilestone.id}.`;
      return {
        activeMilestone, activeSlice: null, activeTask: null,
        phase, recentDecisions: [], blockers: [],
        nextAction, registry, requirements,
        progress: { milestones: milestoneProgress },
      };
    }

    // Has roadmap file but zero slices in DB — pre-planning (zero-slice roadmap guard)
    return {
      activeMilestone, activeSlice: null, activeTask: null,
      phase: 'pre-planning',
      recentDecisions: [], blockers: [],
      nextAction: `Milestone ${activeMilestone.id} has a roadmap but no slices defined. Add slices to the roadmap.`,
      registry, requirements,
      progress: {
        milestones: milestoneProgress,
        slices: { done: 0, total: 0 },
      },
    };
  }

  // ── All slices done → validating/completing ─────────────────────────
  const allSlicesDone = activeMilestoneSlices.every(s => isStatusDone(s.status));
  if (allSlicesDone) {
    const validationFile = resolveMilestoneFile(basePath, activeMilestone.id, "VALIDATION");
    const validationContent = validationFile ? await loadFile(validationFile) : null;
    const validationTerminal = validationContent ? isValidationTerminal(validationContent) : false;
    const verdict = validationContent ? extractVerdict(validationContent) : undefined;
    const sliceProgress = {
      done: activeMilestoneSlices.length,
      total: activeMilestoneSlices.length,
    };

    // Force re-validation when verdict is needs-remediation — remediation slices
    // may have completed since the stale validation was written (#3596).
    if (!validationTerminal || verdict === 'needs-remediation') {
      return {
        activeMilestone, activeSlice: null, activeTask: null,
        phase: 'validating-milestone',
        recentDecisions: [], blockers: [],
        nextAction: `Validate milestone ${activeMilestone.id} before completion.`,
        registry, requirements,
        progress: { milestones: milestoneProgress, slices: sliceProgress },
      };
    }

    return {
      activeMilestone, activeSlice: null, activeTask: null,
      phase: 'completing-milestone',
      recentDecisions: [], blockers: [],
      nextAction: `All slices complete in ${activeMilestone.id}. Write milestone summary.`,
      registry, requirements,
      progress: { milestones: milestoneProgress, slices: sliceProgress },
    };
  }

  // ── Find active slice (first incomplete with deps satisfied) ─────────
  const sliceProgress = {
    done: activeMilestoneSlices.filter(s => isStatusDone(s.status)).length,
    total: activeMilestoneSlices.length,
  };

  const doneSliceIds = new Set(
    activeMilestoneSlices.filter(s => isStatusDone(s.status)).map(s => s.id)
  );

  let activeSlice: ActiveRef | null = null;
  let activeSliceRow: SliceRow | null = null;

  // ── Slice-level parallel worker isolation ─────────────────────────────
  // When GSD_SLICE_LOCK is set, this process is a parallel worker scoped
  // to a single slice. Override activeSlice to only the locked slice ID.
  const sliceLock = process.env.GSD_SLICE_LOCK;
  if (sliceLock) {
    const lockedSlice = activeMilestoneSlices.find(s => s.id === sliceLock);
    if (lockedSlice) {
      activeSlice = { id: lockedSlice.id, title: lockedSlice.title };
      activeSliceRow = lockedSlice;
    } else {
      logWarning("state", `GSD_SLICE_LOCK=${sliceLock} not found in active slices — worker has no assigned work`);
      // Don't silently continue — this is a dispatch error
      return {
        activeMilestone, activeSlice: null, activeTask: null,
        phase: 'blocked',
        recentDecisions: [], blockers: [`GSD_SLICE_LOCK=${sliceLock} not found in active milestone slices`],
        nextAction: 'Slice lock references a non-existent slice — check orchestrator dispatch.',
        registry, requirements,
        progress: { milestones: milestoneProgress, slices: sliceProgress },
      };
    }
  } else {
    for (const s of activeMilestoneSlices) {
      if (isStatusDone(s.status)) continue;
      // #2661: Skip deferred slices — a decision explicitly deferred this work.
      // Without this guard the dispatcher would keep dispatching deferred slices
      // because DECISIONS.md is only contextual, not authoritative for dispatch.
      if (isDeferredStatus(s.status)) continue;
      if (s.depends.every(dep => doneSliceIds.has(dep))) {
        activeSlice = { id: s.id, title: s.title };
        activeSliceRow = s;
        break;
      }
    }
  }

  if (!activeSlice) {
    return {
      activeMilestone, activeSlice: null, activeTask: null,
      phase: 'blocked',
      recentDecisions: [], blockers: ['No slice eligible — check dependency ordering'],
      nextAction: 'Resolve dependency blockers or plan next slice.',
      registry, requirements,
      progress: { milestones: milestoneProgress, slices: sliceProgress },
    };
  }

  // ── Check for slice plan file on disk ────────────────────────────────
  const planFile = resolveSliceFile(basePath, activeMilestone.id, activeSlice.id, "PLAN");
  if (!planFile) {
    return {
      activeMilestone, activeSlice, activeTask: null,
      phase: 'planning',
      recentDecisions: [], blockers: [],
      nextAction: `Plan slice ${activeSlice.id} (${activeSlice.title}).`,
      registry, requirements,
      progress: { milestones: milestoneProgress, slices: sliceProgress },
    };
  }

  // ── Get tasks from DB ────────────────────────────────────────────────
  let tasks = getSliceTasks(activeMilestone.id, activeSlice.id);

  // ── Reconcile missing tasks: plan file has tasks but DB is empty (#3600) ──
  // When the planning agent writes S##-PLAN.md with task entries but never
  // calls the gsd_plan_slice persistence tool, the DB has zero task rows
  // even though the plan file contains valid tasks. Without this reconciliation,
  // deriveState returns phase='planning' forever — the dispatcher re-dispatches
  // plan-slice in an infinite loop.
  if (tasks.length === 0 && planFile) {
    try {
      const planContent = await loadFile(planFile);
      if (planContent) {
        const diskPlan = parsePlan(planContent);
        if (diskPlan.tasks.length > 0) {
          for (let i = 0; i < diskPlan.tasks.length; i++) {
            const t = diskPlan.tasks[i];
            try {
              insertTask({
                id: t.id,
                sliceId: activeSlice.id,
                milestoneId: activeMilestone.id,
                title: t.title,
                status: t.done ? 'complete' : 'pending',
                sequence: i + 1,
              });
            } catch (insertErr) {
              // Task may already exist from a partial previous import — skip
              logWarning("reconcile", `failed to insert task ${t.id} from plan file: ${insertErr instanceof Error ? insertErr.message : String(insertErr)}`);
            }
          }
          tasks = getSliceTasks(activeMilestone.id, activeSlice.id);
          logWarning("reconcile", `imported ${tasks.length} tasks from plan file for ${activeMilestone.id}/${activeSlice.id} — DB was empty (#3600)`, { mid: activeMilestone.id, sid: activeSlice.id });
        }
      }
    } catch (err) {
      // Non-fatal — fall through to the existing "empty plan" logic
      logError("reconcile", `plan-file task import failed for ${activeMilestone.id}/${activeSlice.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── Reconcile stale task status (#2514) ──────────────────────────────
  // When a session disconnects after the agent writes SUMMARY + VERIFY
  // artifacts but before postUnitPostVerification updates the DB, tasks
  // remain "pending" in the DB despite being complete on disk. Without
  // reconciliation, deriveState keeps returning the stale task as active,
  // causing the dispatcher to re-dispatch the same completed task forever.
  let reconciled = false;
  for (const t of tasks) {
    if (isStatusDone(t.status)) continue;
    const summaryPath = resolveTaskFile(basePath, activeMilestone.id, activeSlice.id, t.id, "SUMMARY");
    if (summaryPath && existsSync(summaryPath)) {
      try {
        updateTaskStatus(activeMilestone.id, activeSlice.id, t.id, "complete");
        logWarning("reconcile", `task ${activeMilestone.id}/${activeSlice.id}/${t.id} status reconciled from "${t.status}" to "complete" (#2514)`, { mid: activeMilestone.id, sid: activeSlice.id, tid: t.id });
        reconciled = true;
      } catch (e) {
        // DB write failed — continue with stale status rather than crash
        logError("reconcile", `failed to update task ${t.id}`, { tid: t.id, error: (e as Error).message });
      }
    }
  }
  // Re-fetch tasks if any were reconciled so downstream logic sees fresh status
  if (reconciled) {
    tasks = getSliceTasks(activeMilestone.id, activeSlice.id);
  }

  const taskProgress = {
    done: tasks.filter(t => isStatusDone(t.status)).length,
    total: tasks.length,
  };

  const activeTaskRow = tasks.find(t => !isStatusDone(t.status));

  if (!activeTaskRow && tasks.length > 0) {
    // All tasks done but slice not marked complete → summarizing
    return {
      activeMilestone, activeSlice, activeTask: null,
      phase: 'summarizing',
      recentDecisions: [], blockers: [],
      nextAction: `All tasks done in ${activeSlice.id}. Write slice summary and complete slice.`,
      registry, requirements,
      progress: { milestones: milestoneProgress, slices: sliceProgress, tasks: taskProgress },
    };
  }

  // Empty plan — no tasks defined yet
  if (!activeTaskRow) {
    return {
      activeMilestone, activeSlice, activeTask: null,
      phase: 'planning',
      recentDecisions: [], blockers: [],
      nextAction: `Slice ${activeSlice.id} has a plan file but no tasks. Add tasks to the plan.`,
      registry, requirements,
      progress: { milestones: milestoneProgress, slices: sliceProgress, tasks: taskProgress },
    };
  }

  const activeTask: ActiveRef = { id: activeTaskRow.id, title: activeTaskRow.title };

  // ── Task plan file check (#909) ─────────────────────────────────────
  const tasksDir = resolveTasksDir(basePath, activeMilestone.id, activeSlice.id);
  if (tasksDir && existsSync(tasksDir) && tasks.length > 0) {
    const allFiles = readdirSync(tasksDir).filter(f => f.endsWith(".md"));
    if (allFiles.length === 0) {
      return {
        activeMilestone, activeSlice, activeTask: null,
        phase: 'planning',
        recentDecisions: [], blockers: [],
        nextAction: `Task plan files missing for ${activeSlice.id}. Run plan-slice to generate task plans.`,
        registry, requirements,
        progress: { milestones: milestoneProgress, slices: sliceProgress, tasks: taskProgress },
      };
    }
  }

  // ── Quality gate evaluation check ──────────────────────────────────
  // If slice-scoped gates (Q3/Q4) are still pending, pause before execution
  // so the gate-evaluate dispatch rule can run parallel sub-agents.
  // Slices with zero gate rows (pre-feature or simple) skip straight through.
  const pendingGateCount = getPendingSliceGateCount(activeMilestone.id, activeSlice.id);
  if (pendingGateCount > 0) {
    return {
      activeMilestone, activeSlice, activeTask: null,
      phase: 'evaluating-gates',
      recentDecisions: [], blockers: [],
      nextAction: `Evaluate ${pendingGateCount} quality gate(s) for ${activeSlice.id} before execution.`,
      registry, requirements,
      progress: { milestones: milestoneProgress, slices: sliceProgress, tasks: taskProgress },
    };
  }

  // ── Blocker detection: check completed tasks for blocker_discovered ──
  const completedTasks = tasks.filter(t => isStatusDone(t.status));
  let blockerTaskId: string | null = null;
  for (const ct of completedTasks) {
    if (ct.blocker_discovered) {
      blockerTaskId = ct.id;
      break;
    }
    // Also check disk summary in case DB doesn't have the flag
    const summaryFile = resolveTaskFile(basePath, activeMilestone.id, activeSlice.id, ct.id, "SUMMARY");
    if (!summaryFile) continue;
    const summaryContent = await loadFile(summaryFile);
    if (!summaryContent) continue;
    const summary = parseSummary(summaryContent);
    if (summary.frontmatter.blocker_discovered) {
      blockerTaskId = ct.id;
      break;
    }
  }

  if (blockerTaskId) {
    // Loop protection: if replan_history has entries for this slice, a replan
    // was already performed — don't re-enter replanning phase.
    const replanHistory = getReplanHistory(activeMilestone.id, activeSlice.id);
    if (replanHistory.length === 0) {
      return {
        activeMilestone, activeSlice, activeTask,
        phase: 'replanning-slice',
        recentDecisions: [],
        blockers: [`Task ${blockerTaskId} discovered a blocker requiring slice replan`],
        nextAction: `Task ${blockerTaskId} reported blocker_discovered. Replan slice ${activeSlice.id} before continuing.`,
        activeWorkspace: undefined,
        registry, requirements,
        progress: { milestones: milestoneProgress, slices: sliceProgress, tasks: taskProgress },
      };
    }
  }

  // ── REPLAN-TRIGGER detection ─────────────────────────────────────────
  if (!blockerTaskId) {
    const sliceRow = getSlice(activeMilestone.id, activeSlice.id);
    // Check DB column first, fall back to disk trigger file when DB write
    // was best-effort and failed (triage-resolution.ts dual-write gap).
    const dbTriggered = !!sliceRow?.replan_triggered_at;
    const diskTriggered = !dbTriggered &&
      !!resolveSliceFile(basePath, activeMilestone.id, activeSlice.id, "REPLAN-TRIGGER");
    if (dbTriggered || diskTriggered) {
      // Loop protection: if replan_history has entries, replan was already done
      const replanHistory = getReplanHistory(activeMilestone.id, activeSlice.id);
      if (replanHistory.length === 0) {
        return {
          activeMilestone, activeSlice, activeTask,
          phase: 'replanning-slice',
          recentDecisions: [],
          blockers: ['Triage replan trigger detected — slice replan required'],
          nextAction: `Triage replan triggered for slice ${activeSlice.id}. Replan before continuing.`,
          activeWorkspace: undefined,
          registry, requirements,
          progress: { milestones: milestoneProgress, slices: sliceProgress, tasks: taskProgress },
        };
      }
    }
  }

  // ── Check for interrupted work ───────────────────────────────────────
  const sDir = resolveSlicePath(basePath, activeMilestone.id, activeSlice.id);
  const continueFile = sDir ? resolveSliceFile(basePath, activeMilestone.id, activeSlice.id, "CONTINUE") : null;
  const hasInterrupted = !!(continueFile && await loadFile(continueFile)) ||
    !!(sDir && await loadFile(join(sDir, "continue.md")));

  return {
    activeMilestone, activeSlice, activeTask,
    phase: 'executing',
    recentDecisions: [], blockers: [],
    nextAction: hasInterrupted
      ? `Resume interrupted work on ${activeTask.id}: ${activeTask.title} in slice ${activeSlice.id}. Read continue.md first.`
      : `Execute ${activeTask.id}: ${activeTask.title} in slice ${activeSlice.id}.`,
    registry, requirements,
    progress: { milestones: milestoneProgress, slices: sliceProgress, tasks: taskProgress },
  };
}
