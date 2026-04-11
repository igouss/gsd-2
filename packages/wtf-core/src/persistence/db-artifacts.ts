// WTF Database — Artifact CRUD

import { WTFError, WTF_STALE_STATE } from "../domain/errors.ts";
import { logWarning } from "../workflow/workflow-logger.ts";
import { _getCurrentDb } from "./db-core.ts";

export function clearArtifacts(): void {
  const db = _getCurrentDb();
  if (!db) return;
  try { db.exec("DELETE FROM artifacts"); } catch (e) { logWarning("db", `clearArtifacts failed: ${(e as Error).message}`); }
}

export function insertArtifact(a: {
  path: string;
  artifact_type: string;
  milestone_id: string | null;
  slice_id: string | null;
  task_id: string | null;
  full_content: string;
}): void {
  const db = _getCurrentDb();
  if (!db) throw new WTFError(WTF_STALE_STATE, "wtf-db: No database open");
  db.prepare(
    `INSERT OR REPLACE INTO artifacts (path, artifact_type, milestone_id, slice_id, task_id, full_content, imported_at)
     VALUES (:path, :artifact_type, :milestone_id, :slice_id, :task_id, :full_content, :imported_at)`,
  ).run({
    ":path": a.path,
    ":artifact_type": a.artifact_type,
    ":milestone_id": a.milestone_id,
    ":slice_id": a.slice_id,
    ":task_id": a.task_id,
    ":full_content": a.full_content,
    ":imported_at": new Date().toISOString(),
  });
}

export interface ArtifactRow {
  path: string;
  artifact_type: string;
  milestone_id: string | null;
  slice_id: string | null;
  task_id: string | null;
  full_content: string;
  imported_at: string;
}

function rowToArtifact(row: Record<string, unknown>): ArtifactRow {
  return {
    path: row["path"] as string,
    artifact_type: row["artifact_type"] as string,
    milestone_id: (row["milestone_id"] as string) ?? null,
    slice_id: (row["slice_id"] as string) ?? null,
    task_id: (row["task_id"] as string) ?? null,
    full_content: row["full_content"] as string,
    imported_at: row["imported_at"] as string,
  };
}

export function getArtifact(path: string): ArtifactRow | null {
  const db = _getCurrentDb();
  if (!db) return null;
  const row = db.prepare("SELECT * FROM artifacts WHERE path = :path").get({ ":path": path });
  if (!row) return null;
  return rowToArtifact(row);
}
