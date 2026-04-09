// State derivation helper functions — query predicates and title extraction.

import type {
  Roadmap,
  SlicePlan,
} from '../domain/types.js';

import {
  resolveMilestoneFile,
  gsdRoot,
} from '../persistence/paths.js';

import { isClosedStatus } from '../domain/status-guards.js';
import { extractVerdict } from '../analysis/verdict-parser.js';

import {
  isDbAvailable,
  getMilestone,
} from '../persistence/gsd-db.js';

import { join } from 'path';
import { existsSync } from 'node:fs';

// ─── Ghost Milestone Detection ───────────────────────────────────────────

/**
 * A "ghost" milestone directory contains only META.json (and no substantive
 * files like CONTEXT, CONTEXT-DRAFT, ROADMAP, or SUMMARY).  These appear when
 * a milestone is created but never initialised.  Treating them as active causes
 * auto-mode to stall or falsely declare completion.
 *
 * However, a milestone is NOT a ghost if:
 * - It has a DB row with a meaningful status (queued, active, etc.) — the DB
 *   knows about it even if content files haven't been created yet.
 * - It has a worktree directory — a worktree proves the milestone was
 *   legitimately created and is expected to be populated.
 *
 * Fixes #2921: queued milestones with worktrees were incorrectly classified
 * as ghosts, causing auto-mode to skip them entirely.
 */
export function isGhostMilestone(basePath: string, mid: string): boolean {
  // If the milestone has a DB row, it's usually a known milestone — not a ghost.
  // Exception: a "queued" row with no disk artifacts is a phantom from
  // gsd_milestone_generate_id that was never planned (#3645).
  if (isDbAvailable()) {
    const dbRow = getMilestone(mid);
    if (dbRow) {
      if (dbRow.status === 'queued') {
        const hasContent = resolveMilestoneFile(basePath, mid, "CONTEXT")
          || resolveMilestoneFile(basePath, mid, "ROADMAP")
          || resolveMilestoneFile(basePath, mid, "SUMMARY");
        return !hasContent;
      }
      return false;
    }
  }

  // If a worktree exists for this milestone, it was legitimately created.
  const root = gsdRoot(basePath);
  const wtPath = join(root, 'worktrees', mid);
  if (existsSync(wtPath)) return false;

  // Fall back to content-file check: no substantive files means ghost.
  const context   = resolveMilestoneFile(basePath, mid, "CONTEXT");
  const draft     = resolveMilestoneFile(basePath, mid, "CONTEXT-DRAFT");
  const roadmap   = resolveMilestoneFile(basePath, mid, "ROADMAP");
  const summary   = resolveMilestoneFile(basePath, mid, "SUMMARY");
  return !context && !draft && !roadmap && !summary;
}

// ─── Query Functions ───────────────────────────────────────────────────────

/**
 * Check if all tasks in a slice plan are done.
 */
export function isSliceComplete(plan: SlicePlan): boolean {
  return plan.tasks.length > 0 && plan.tasks.every(t => t.done);
}

/**
 * Check if all slices in a roadmap are done.
 */
export function isMilestoneComplete(roadmap: Roadmap): boolean {
  return roadmap.slices.length > 0 && roadmap.slices.every(s => s.done);
}

/**
 * Check whether a VALIDATION file's verdict is terminal.
 * Any successfully extracted verdict (pass, needs-attention, needs-remediation,
 * fail, etc.) means validation completed. Only return false when no verdict
 * could be parsed — i.e. extractVerdict() returns undefined (#2769).
 */
export function isValidationTerminal(validationContent: string): boolean {
  return extractVerdict(validationContent) != null;
}

// ─── Title Helpers ───────────────────────────────────────────────────────

/**
 * Strip the "M001: " prefix from a milestone title to get the human-readable name.
 * Used by both DB and filesystem paths for consistency.
 */
export function stripMilestonePrefix(title: string): string {
  return title.replace(/^M\d+(?:-[a-z0-9]{6})?[^:]*:\s*/, '') || title;
}

export function extractContextTitle(content: string | null, fallback: string): string {
  if (!content) return fallback;
  const h1 = content.split('\n').find(line => line.startsWith('# '));
  if (!h1) return fallback;
  // Extract title from "# M005: Platform Foundation & Separation" format
  return stripMilestonePrefix(h1.slice(2).trim()) || fallback;
}

// ─── Status Alias ────────────────────────────────────────────────────────

// isStatusDone replaced by isClosedStatus from status-guards.ts (single source of truth).
// Alias kept for backward compatibility within state derivation files.
export const isStatusDone = isClosedStatus;
