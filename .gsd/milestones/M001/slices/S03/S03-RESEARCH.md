# S03 — Research

**Date:** 2026-03-23
**Status:** Ready for planning

## Summary

S03 delivers two new tool handlers — `handleReplanSlice` and `handleReassessRoadmap` — that structurally enforce preservation of completed work. The core novelty is **structural rejection**: the replan handler queries the DB for completed tasks and refuses to accept mutations to them, while the reassess handler queries for completed slices and refuses mutations to them. Both write to the existing `replan_history` and `assessments` tables created in S01's schema v8 migration. Both render markdown artifacts (REPLAN.md, ASSESSMENT.md, and re-rendered PLAN.md/ROADMAP.md) from DB state.

This is straightforward application of the S01/S02 handler pattern (validate → check completed state → transaction → render → invalidate) with one meaningful new dimension: the structural enforcement logic that inspects task/slice status before accepting writes. The schema tables already exist. The rendering infrastructure already exists. The prompt templates already have placeholder language about DB-backed tools. The registration pattern is established in `db-tools.ts`.

## Recommendation

Follow the exact handler pattern from `plan-slice.ts` and `plan-task.ts`. The two tools have different shapes but identical control flow:

1. **`handleReplanSlice`** — accepts milestoneId, sliceId, blockerTaskId, blockerDescription, whatChanged, updatedTasks (array), removedTaskIds (array). Queries `getSliceTasks()` to find completed tasks. Rejects if any `updatedTasks[].taskId` matches a completed task. Rejects if any `removedTaskIds` element matches a completed task. Writes `replan_history` row. Applies task mutations (upsert updated, delete removed, insert new). Re-renders PLAN.md and task plans. Renders REPLAN.md. Invalidates caches.

2. **`handleReassessRoadmap`** — accepts milestoneId, completedSliceId, verdict, assessment, sliceChanges (modified/added/removed/reordered arrays). Queries `getMilestoneSlices()` to find completed slices. Rejects if any modified/removed/reordered slice is completed. Writes `assessments` row. Applies slice mutations (upsert modified, insert added, delete removed, reorder). Re-renders ROADMAP.md. Renders ASSESSMENT.md. Invalidates caches.

Build order: DB helpers first (insert functions for replan_history and assessments, plus a `deleteTask` function), then handlers, then renderers for REPLAN.md and ASSESSMENT.md, then prompt updates, then tests. Tests are the primary proof surface — they must demonstrate structural rejection of completed-work mutations.

## Implementation Landscape

### Key Files

- `src/resources/extensions/gsd/gsd-db.ts` (1505 lines) — Needs new functions: `insertReplanHistory()`, `insertAssessment()`, `deleteTask()`, `deleteSlice()`, and `updateSliceSequence()` (for reordering). The `replan_history` and `assessments` tables already exist (created in S01 schema v8 migration at lines 321–347). Current exports include `getSliceTasks()`, `getTask()`, `getSlice()`, `getMilestoneSlices()` which provide the completed-state queries. `upsertTaskPlanning()` and `upsertSlicePlanning()` handle mutations to existing rows. `insertTask()` and `insertSlice()` use `INSERT OR IGNORE` — safe for idempotent reruns.

- `src/resources/extensions/gsd/tools/plan-slice.ts` — Reference handler pattern for replan. Shows validate → parent check → transaction → render → cache invalidation flow. The replan handler follows this pattern but adds: (a) completed-task enforcement before writes, (b) task deletion for removedTaskIds, (c) REPLAN.md rendering.

- `src/resources/extensions/gsd/tools/plan-milestone.ts` — Reference handler pattern for reassess. Shows how milestone-level mutations work through `upsertMilestonePlanning()` and `upsertSlicePlanning()`, followed by `renderRoadmapFromDb()`.

- `src/resources/extensions/gsd/markdown-renderer.ts` (currently ~840 lines) — Needs two new renderers: `renderReplanFromDb()` for REPLAN.md and `renderAssessmentFromDb()` for ASSESSMENT.md. Both use the existing `writeAndStore()` helper. Also needs a `renderReplanedPlanFromDb()` or can reuse `renderPlanFromDb()` directly since it reads from DB state (which will already reflect the mutations). The existing `renderPlanFromDb()` already handles completed vs incomplete tasks correctly in its checkbox rendering (`task.status === "done" || task.status === "complete"` → `[x]`).

- `src/resources/extensions/gsd/tools/replan-slice.ts` — **New file.** Handler for `gsd_replan_slice`. Flat params, structural enforcement, DB writes, render, cache invalidation.

- `src/resources/extensions/gsd/tools/reassess-roadmap.ts` — **New file.** Handler for `gsd_reassess_roadmap`. Flat params, structural enforcement, DB writes, render, cache invalidation.

- `src/resources/extensions/gsd/bootstrap/db-tools.ts` — Register both new tools following the exact pattern used for `gsd_plan_slice` (lines 386–461). Each gets a canonical name (`gsd_replan_slice`, `gsd_reassess_roadmap`) and an alias (`gsd_slice_replan`, `gsd_roadmap_reassess`).

- `src/resources/extensions/gsd/prompts/replan-slice.md` — Currently instructs direct file writes to `{{replanPath}}` and `{{planPath}}`. Must be updated to instruct `gsd_replan_slice` tool call as canonical path, with direct writes as degraded fallback. The prompt already has a line about DB-backed planning tools (from S01 updates) but doesn't name the specific tool yet.

- `src/resources/extensions/gsd/prompts/reassess-roadmap.md` — Currently instructs direct writes to `{{assessmentPath}}` and optionally `{{roadmapPath}}`. Must be updated to instruct `gsd_reassess_roadmap` tool call as canonical path. Already has "Do not bypass state with manual roadmap-only edits" language.

- `src/resources/extensions/gsd/tests/replan-slice.test.ts` — **New file.** Must prove: validation failures, structural rejection of completed task mutations, DB write correctness, REPLAN.md rendering, PLAN.md re-rendering, cache invalidation, idempotent reruns.

- `src/resources/extensions/gsd/tests/reassess-roadmap.test.ts` — **New file.** Must prove: validation failures, structural rejection of completed slice mutations, DB write correctness, ASSESSMENT.md rendering, ROADMAP.md re-rendering, cache invalidation, idempotent reruns.

- `src/resources/extensions/gsd/tests/prompt-contracts.test.ts` — Extend with assertions for replan-slice and reassess-roadmap prompts referencing the new tool names.

### Build Order

1. **DB helpers first** — `insertReplanHistory()`, `insertAssessment()`, `deleteTask()`, `deleteSlice()` in `gsd-db.ts`. These are pure DB functions with no rendering dependency. They unblock the handlers.

2. **Renderers** — `renderReplanFromDb()` and `renderAssessmentFromDb()` in `markdown-renderer.ts`. These are simple markdown generators that write REPLAN.md and ASSESSMENT.md via `writeAndStore()`. They don't need the handlers to exist. Note: PLAN.md and ROADMAP.md re-rendering already works via existing `renderPlanFromDb()` and `renderRoadmapFromDb()`.

3. **Handlers** — `handleReplanSlice` and `handleReassessRoadmap` in new tool files. These combine the DB helpers and renderers with the structural enforcement logic. This is where the core proof logic lives.

4. **Registration + Prompts** — Register in `db-tools.ts`, update prompt templates to name the tools.

5. **Tests** — Can be written alongside handlers or after. They are the primary proof surface for R005 and R006.

### Verification Approach

```bash
# Primary proof — replan handler: validation, structural enforcement, DB writes, rendering
node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/replan-slice.test.ts

# Primary proof — reassess handler: validation, structural enforcement, DB writes, rendering
node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/reassess-roadmap.test.ts

# Prompt contracts — verify prompts reference new tool names
node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/prompt-contracts.test.ts

# Full regression — existing tests still pass
node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/plan-milestone.test.ts src/resources/extensions/gsd/tests/plan-slice.test.ts src/resources/extensions/gsd/tests/plan-task.test.ts src/resources/extensions/gsd/tests/markdown-renderer.test.ts src/resources/extensions/gsd/tests/rogue-file-detection.test.ts
```

Key test scenarios to prove:

- **R005 structural enforcement**: seed a slice with T01 (complete), T02 (complete), T03 (pending). Call replan with an updatedTask targeting T01. Assert error containing "completed task" or similar. Call replan with removedTaskIds including T02. Assert error. Call replan modifying only T03 and adding T04. Assert success.

- **R006 structural enforcement**: seed a milestone with S01 (complete), S02 (pending), S03 (pending). Call reassess with a modified slice targeting S01. Assert error. Call reassess modifying only S02 and adding S04. Assert success.

- **Replan history persistence**: after successful replan, query `replan_history` table and verify a row exists with correct milestone_id, slice_id, summary.

- **Assessment persistence**: after successful reassess, query `assessments` table and verify a row exists with correct path, milestone_id, status, full_content.

- **Re-rendering correctness**: after replan, read the rendered PLAN.md back from disk, parse it, confirm completed tasks still show `[x]` and new/modified tasks appear correctly.

- **Cache invalidation**: use parse-visible state assertions (read roadmap/plan before and after handler execution, confirm the parse results reflect the mutations).

## Constraints

- `replan_history` schema has columns: `id` (autoincrement), `milestone_id`, `slice_id`, `task_id`, `summary`, `previous_artifact_path`, `replacement_artifact_path`, `created_at`. The handler must populate these — `previous_artifact_path` is the old PLAN.md artifact path and `replacement_artifact_path` is the new one.
- `assessments` schema has columns: `path` (PK), `milestone_id`, `slice_id`, `task_id`, `status`, `scope`, `full_content`, `created_at`. The `path` is the ASSESSMENT.md artifact path, used as primary key — idempotent rewrites via INSERT OR REPLACE.
- No existing `deleteTask()` or `deleteSlice()` function in `gsd-db.ts` — these must be added. Must be careful with foreign key constraints (verification_evidence references tasks).
- `insertSlice()` uses `INSERT OR IGNORE` — safe for idempotent runs but won't update existing slice data. For reassess modifications to existing slices, use `upsertSlicePlanning()` plus a new `updateSliceMetadata()` or similar for title/risk/depends/demo changes.
- The resolver-based TypeScript test harness (`resolve-ts.mjs`) is required — bare `node --test` may fail on `.js` sibling specifiers.
- Cache invalidation must use parse-visible state assertions, not ESM monkey-patching (per KNOWLEDGE.md).

## Common Pitfalls

- **Foreign key cascading on task deletion** — The `verification_evidence` table has a foreign key referencing `tasks(milestone_id, slice_id, id)`. Deleting a task without handling this will fail. Use `DELETE FROM verification_evidence WHERE ...` before `DELETE FROM tasks WHERE ...`, or set up CASCADE in the FK (but the schema is already created without CASCADE, so the handler must delete evidence first).
- **Slice deletion vs slice reordering** — Reassess needs to distinguish between removing a slice entirely (DELETE from DB) and reordering slices (no deletion, just update sequence). The current schema doesn't have a `sequence` column — ordering is by `id` (`ORDER BY id`). If reassess reorders, it must either rename slice IDs (risky — breaks references) or add a sequence column. The simpler approach: don't support arbitrary reordering in V1 — just support add/remove/modify. Reordering can be deferred or handled by deleting and re-inserting with new IDs. But since task completions reference slice IDs, deleting completed slices is forbidden anyway, so reordering of completed slices is moot.
- **REPLAN.md path resolution** — The current `buildReplanPrompt` in `auto-prompts.ts` constructs `replanPath` as `join(base, relSlicePath(base, mid, sid) + "/" + sid + "-REPLAN.md")`. The renderer must use the same path construction pattern, or better, use `resolveSliceFile()` with the "REPLAN" suffix if it's supported — check `paths.ts` for supported suffixes.
- **Assessment path as PK** — The `assessments` table uses `path TEXT PRIMARY KEY`, which means the path must be deterministic and consistent. The current `buildReassessPrompt` uses `relSliceFile(base, mid, completedSliceId, "ASSESSMENT")` — the handler must compute the same path.

## Open Risks

- The `replan_history.task_id` column is nullable — it's not clear from the schema whether this tracks a specific blocker task or the entire replan event. R005 specifies `blockerTaskId` as a parameter, so this maps to `task_id` in the replan_history row. The handler should populate it.
- Reassess `sliceChanges.reordered` may be complex to implement without a sequence column. The pragmatic choice is to accept reorder directives but only apply them as metadata (not changing actual query ordering since `ORDER BY id` is used throughout). If the planner decides to skip reordering support in V1, this is acceptable since the milestone DoD says "replan and reassess structurally enforce preservation" — it doesn't mandate reordering support.
