// GSD Database — Worktree DB reconciliation

import { existsSync, realpathSync } from "node:fs";
import { logError, logWarning } from "../workflow/workflow-logger.ts";
import { _getCurrentDb, openDatabase } from "./db-core.ts";

export interface ReconcileResult {
  decisions: number;
  requirements: number;
  artifacts: number;
  milestones: number;
  slices: number;
  tasks: number;
  memories: number;
  verification_evidence: number;
  conflicts: string[];
}

export function reconcileWorktreeDb(
  mainDbPath: string,
  worktreeDbPath: string,
): ReconcileResult {
  const zero: ReconcileResult = { decisions: 0, requirements: 0, artifacts: 0, milestones: 0, slices: 0, tasks: 0, memories: 0, verification_evidence: 0, conflicts: [] };
  if (!existsSync(worktreeDbPath)) return zero;
  // Guard: bail when both paths resolve to the same physical file.
  // ATTACHing a WAL-mode DB to itself corrupts the WAL (#2823).
  try {
    if (realpathSync(mainDbPath) === realpathSync(worktreeDbPath)) return zero;
  } catch (e) { logWarning("db", `realpathSync failed: ${(e as Error).message}`); }
  // Sanitize path: reject any characters that could break ATTACH syntax.
  // ATTACH DATABASE doesn't support parameterized paths in all providers,
  // so we use strict allowlist validation instead.
  // eslint-disable-next-line no-control-regex
  if (/['";\x00]/.test(worktreeDbPath)) {
    logError("db", "worktree DB reconciliation failed: path contains unsafe characters");
    return zero;
  }
  let currentDb = _getCurrentDb();
  if (!currentDb) {
    const opened = openDatabase(mainDbPath);
    if (!opened) {
      logError("db", "worktree DB reconciliation failed: cannot open main DB");
      return zero;
    }
    currentDb = _getCurrentDb();
  }
  const adapter = currentDb!;
  const conflicts: string[] = [];
  try {
    adapter.exec(`ATTACH DATABASE '${worktreeDbPath}' AS wt`);
    try {
      const wtInfo = adapter.prepare("PRAGMA wt.table_info('decisions')").all();
      const hasMadeBy = wtInfo.some((col) => col["name"] === "made_by");

      const decConf = adapter.prepare(
        `SELECT m.id FROM decisions m INNER JOIN wt.decisions w ON m.id = w.id WHERE m.decision != w.decision OR m.choice != w.choice OR m.rationale != w.rationale OR ${
          hasMadeBy ? "m.made_by != w.made_by" : "'agent' != 'agent'"
        } OR m.superseded_by IS NOT w.superseded_by`,
      ).all();
      for (const row of decConf) conflicts.push(`decision ${(row as Record<string, unknown>)["id"]}: modified in both`);

      const reqConf = adapter.prepare(
        `SELECT m.id FROM requirements m INNER JOIN wt.requirements w ON m.id = w.id WHERE m.description != w.description OR m.status != w.status OR m.notes != w.notes OR m.superseded_by IS NOT w.superseded_by`,
      ).all();
      for (const row of reqConf) conflicts.push(`requirement ${(row as Record<string, unknown>)["id"]}: modified in both`);

      const merged: Omit<ReconcileResult, "conflicts"> = { decisions: 0, requirements: 0, artifacts: 0, milestones: 0, slices: 0, tasks: 0, memories: 0, verification_evidence: 0 };

      function countChanges(result: unknown): number {
        return typeof result === "object" && result !== null ? ((result as { changes?: number }).changes ?? 0) : 0;
      }

      adapter.exec("BEGIN");
      try {
        merged.decisions = countChanges(adapter.prepare(`
          INSERT OR REPLACE INTO decisions (
            id, when_context, scope, decision, choice, rationale, revisable, made_by, superseded_by
          )
          SELECT id, when_context, scope, decision, choice, rationale, revisable, ${
            hasMadeBy ? "made_by" : "'agent'"
          }, superseded_by FROM wt.decisions
        `).run());

        merged.requirements = countChanges(adapter.prepare(`
          INSERT OR REPLACE INTO requirements (
            id, class, status, description, why, source, primary_owner,
            supporting_slices, validation, notes, full_content, superseded_by
          )
          SELECT id, class, status, description, why, source, primary_owner,
                 supporting_slices, validation, notes, full_content, superseded_by
          FROM wt.requirements
        `).run());

        merged.artifacts = countChanges(adapter.prepare(`
          INSERT OR REPLACE INTO artifacts (
            path, artifact_type, milestone_id, slice_id, task_id, full_content, imported_at
          )
          SELECT path, artifact_type, milestone_id, slice_id, task_id, full_content, imported_at
          FROM wt.artifacts
        `).run());

        // Merge milestones — worktree may have updated status/planning fields
        merged.milestones = countChanges(adapter.prepare(`
          INSERT OR REPLACE INTO milestones (
            id, title, status, depends_on, created_at, completed_at,
            vision, success_criteria, key_risks, proof_strategy,
            verification_contract, verification_integration, verification_operational, verification_uat,
            definition_of_done, requirement_coverage, boundary_map_markdown
          )
          SELECT id, title, status, depends_on, created_at, completed_at,
                 vision, success_criteria, key_risks, proof_strategy,
                 verification_contract, verification_integration, verification_operational, verification_uat,
                 definition_of_done, requirement_coverage, boundary_map_markdown
          FROM wt.milestones
        `).run());

        // Merge slices — preserve worktree progress but never downgrade completed status (#2558).
        // Uses INSERT OR REPLACE with a subquery that picks the best status — if the main DB
        // already has a completed slice, keep that status even if the worktree copy is stale.
        merged.slices = countChanges(adapter.prepare(`
          INSERT OR REPLACE INTO slices (
            milestone_id, id, title, status, risk, depends, demo, created_at, completed_at,
            full_summary_md, full_uat_md, goal, success_criteria, proof_level,
            integration_closure, observability_impact, sequence, replan_triggered_at
          )
          SELECT w.milestone_id, w.id, w.title,
                 CASE
                   WHEN m.status IN ('complete', 'done') AND w.status NOT IN ('complete', 'done')
                   THEN m.status ELSE w.status
                 END,
                 w.risk, w.depends, w.demo, w.created_at,
                 CASE
                   WHEN m.status IN ('complete', 'done') AND w.status NOT IN ('complete', 'done')
                   THEN m.completed_at ELSE w.completed_at
                 END,
                 w.full_summary_md, w.full_uat_md, w.goal, w.success_criteria, w.proof_level,
                 w.integration_closure, w.observability_impact, w.sequence, w.replan_triggered_at
          FROM wt.slices w
          LEFT JOIN slices m ON m.milestone_id = w.milestone_id AND m.id = w.id
        `).run());

        // Merge tasks — preserve execution results, never downgrade completed status (#2558)
        merged.tasks = countChanges(adapter.prepare(`
          INSERT OR REPLACE INTO tasks (
            milestone_id, slice_id, id, title, status, one_liner, narrative,
            verification_result, duration, completed_at, blocker_discovered,
            deviations, known_issues, key_files, key_decisions, full_summary_md,
            description, estimate, files, verify, inputs, expected_output,
            observability_impact, full_plan_md, sequence
          )
          SELECT w.milestone_id, w.slice_id, w.id, w.title,
                 CASE
                   WHEN m.status IN ('complete', 'done') AND w.status NOT IN ('complete', 'done')
                   THEN m.status ELSE w.status
                 END,
                 w.one_liner, w.narrative,
                 w.verification_result, w.duration,
                 CASE
                   WHEN m.status IN ('complete', 'done') AND w.status NOT IN ('complete', 'done')
                   THEN m.completed_at ELSE w.completed_at
                 END,
                 w.blocker_discovered,
                 w.deviations, w.known_issues, w.key_files, w.key_decisions, w.full_summary_md,
                 w.description, w.estimate, w.files, w.verify, w.inputs, w.expected_output,
                 w.observability_impact, w.full_plan_md, w.sequence
          FROM wt.tasks w
          LEFT JOIN tasks m ON m.milestone_id = w.milestone_id AND m.slice_id = w.slice_id AND m.id = w.id
        `).run());

        // Merge memories — keep worktree-learned insights
        merged.memories = countChanges(adapter.prepare(`
          INSERT OR REPLACE INTO memories (
            seq, id, category, content, confidence, source_unit_type, source_unit_id,
            created_at, updated_at, superseded_by, hit_count
          )
          SELECT seq, id, category, content, confidence, source_unit_type, source_unit_id,
                 created_at, updated_at, superseded_by, hit_count
          FROM wt.memories
        `).run());

        // Merge verification evidence — append-only, use INSERT OR IGNORE to avoid duplicates
        merged.verification_evidence = countChanges(adapter.prepare(`
          INSERT OR IGNORE INTO verification_evidence (
            task_id, slice_id, milestone_id, command, exit_code, verdict, duration_ms, created_at
          )
          SELECT task_id, slice_id, milestone_id, command, exit_code, verdict, duration_ms, created_at
          FROM wt.verification_evidence
        `).run());

        adapter.exec("COMMIT");
      } catch (txErr) {
        try { adapter.exec("ROLLBACK"); } catch (e) { logWarning("db", `rollback failed: ${(e as Error).message}`); }
        throw txErr;
      }
      return { ...merged, conflicts };
    } finally {
      try { adapter.exec("DETACH DATABASE wt"); } catch (e) { logWarning("db", `detach worktree DB failed: ${(e as Error).message}`); }
    }
  } catch (err) {
    logError("db", "worktree DB reconciliation failed", { error: (err as Error).message });
    return { ...zero, conflicts };
  }
}
