// GSD Database Core — provider management, schema, migrations, transaction support.
// Module-level state (currentDb, currentPath) lives here.
// All other db-*.ts modules import _getCurrentDb() to access the adapter.

import { createRequire } from "node:module";
import { existsSync, copyFileSync } from "node:fs";
import { GSDError, GSD_STALE_STATE } from "../domain/errors.js";
import { logWarning } from "../workflow/workflow-logger.js";

const _require = createRequire(import.meta.url);

export interface DbStatement {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Record<string, unknown>[];
}

export interface DbAdapter {
  exec(sql: string): void;
  prepare(sql: string): DbStatement;
  close(): void;
}

type ProviderName = "node:sqlite" | "better-sqlite3";

let providerName: ProviderName | null = null;
let providerModule: unknown = null;
let loadAttempted = false;

function suppressSqliteWarning(): void {
  const origEmit = process.emit;
  // @ts-expect-error overriding process.emit for warning filter
  process.emit = function (event: string, ...args: unknown[]): boolean {
    if (
      event === "warning" &&
      args[0] &&
      typeof args[0] === "object" &&
      "name" in args[0] &&
      (args[0] as { name: string }).name === "ExperimentalWarning" &&
      "message" in args[0] &&
      typeof (args[0] as { message: string }).message === "string" &&
      (args[0] as { message: string }).message.includes("SQLite")
    ) {
      return false;
    }
    return origEmit.apply(process, [event, ...args] as Parameters<typeof process.emit>) as unknown as boolean;
  };
}

function loadProvider(): void {
  if (loadAttempted) return;
  loadAttempted = true;

  try {
    suppressSqliteWarning();
    const mod = _require("node:sqlite");
    if (mod.DatabaseSync) {
      providerModule = mod;
      providerName = "node:sqlite";
      return;
    }
  } catch {
    // unavailable
  }

  try {
    const mod = _require("better-sqlite3");
    if (typeof mod === "function" || (mod && mod.default)) {
      providerModule = mod.default || mod;
      providerName = "better-sqlite3";
      return;
    }
  } catch {
    // unavailable
  }

  const nodeMajor = parseInt(process.versions.node.split(".")[0], 10);
  const versionHint = nodeMajor < 22
    ? ` GSD requires Node >= 22.0.0 (current: v${process.versions.node}). Upgrade Node to fix this.`
    : "";
  process.stderr.write(
    `gsd-db: No SQLite provider available (tried node:sqlite, better-sqlite3).${versionHint}\n`,
  );
}

function normalizeRow(row: unknown): Record<string, unknown> | undefined {
  if (row == null) return undefined;
  if (Object.getPrototypeOf(row) === null) {
    return { ...(row as Record<string, unknown>) };
  }
  return row as Record<string, unknown>;
}

function normalizeRows(rows: unknown[]): Record<string, unknown>[] {
  return rows.map((r) => normalizeRow(r)!);
}

function createAdapter(rawDb: unknown): DbAdapter {
  const db = rawDb as {
    exec(sql: string): void;
    prepare(sql: string): {
      run(...args: unknown[]): unknown;
      get(...args: unknown[]): unknown;
      all(...args: unknown[]): unknown[];
    };
    close(): void;
  };

  const stmtCache = new Map<string, DbStatement>();

  function wrapStmt(raw: { run(...a: unknown[]): unknown; get(...a: unknown[]): unknown; all(...a: unknown[]): unknown[] }): DbStatement {
    return {
      run(...params: unknown[]): unknown {
        return raw.run(...params);
      },
      get(...params: unknown[]): Record<string, unknown> | undefined {
        return normalizeRow(raw.get(...params));
      },
      all(...params: unknown[]): Record<string, unknown>[] {
        return normalizeRows(raw.all(...params));
      },
    };
  }

  return {
    exec(sql: string): void {
      db.exec(sql);
    },
    prepare(sql: string): DbStatement {
      let cached = stmtCache.get(sql);
      if (cached) return cached;
      cached = wrapStmt(db.prepare(sql));
      stmtCache.set(sql, cached);
      return cached;
    },
    close(): void {
      stmtCache.clear();
      db.close();
    },
  };
}

function openRawDb(path: string): unknown {
  loadProvider();
  if (!providerModule || !providerName) return null;

  if (providerName === "node:sqlite") {
    const { DatabaseSync } = providerModule as {
      DatabaseSync: new (path: string) => unknown;
    };
    return new DatabaseSync(path);
  }

  const Database = providerModule as new (path: string) => unknown;
  return new Database(path);
}

const SCHEMA_VERSION = 14;

function initSchema(db: DbAdapter, fileBacked: boolean): void {
  if (fileBacked) db.exec("PRAGMA journal_mode=WAL");
  if (fileBacked) db.exec("PRAGMA busy_timeout = 5000");
  if (fileBacked) db.exec("PRAGMA synchronous = NORMAL");
  if (fileBacked) db.exec("PRAGMA auto_vacuum = INCREMENTAL");
  if (fileBacked) db.exec("PRAGMA cache_size = -8000");   // 8 MB page cache
  if (fileBacked) db.exec("PRAGMA mmap_size = 67108864");  // 64 MB mmap
  db.exec("PRAGMA temp_store = MEMORY");
  db.exec("PRAGMA foreign_keys = ON");

  db.exec("BEGIN");
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER NOT NULL,
        applied_at TEXT NOT NULL
      )
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS decisions (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        when_context TEXT NOT NULL DEFAULT '',
        scope TEXT NOT NULL DEFAULT '',
        decision TEXT NOT NULL DEFAULT '',
        choice TEXT NOT NULL DEFAULT '',
        rationale TEXT NOT NULL DEFAULT '',
        revisable TEXT NOT NULL DEFAULT '',
        made_by TEXT NOT NULL DEFAULT 'agent',
        superseded_by TEXT DEFAULT NULL
      )
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS requirements (
        id TEXT PRIMARY KEY,
        class TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL DEFAULT '',
        why TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL DEFAULT '',
        primary_owner TEXT NOT NULL DEFAULT '',
        supporting_slices TEXT NOT NULL DEFAULT '',
        validation TEXT NOT NULL DEFAULT '',
        notes TEXT NOT NULL DEFAULT '',
        full_content TEXT NOT NULL DEFAULT '',
        superseded_by TEXT DEFAULT NULL
      )
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS artifacts (
        path TEXT PRIMARY KEY,
        artifact_type TEXT NOT NULL DEFAULT '',
        milestone_id TEXT DEFAULT NULL,
        slice_id TEXT DEFAULT NULL,
        task_id TEXT DEFAULT NULL,
        full_content TEXT NOT NULL DEFAULT '',
        imported_at TEXT NOT NULL DEFAULT ''
      )
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        category TEXT NOT NULL,
        content TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 0.8,
        source_unit_type TEXT,
        source_unit_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        superseded_by TEXT DEFAULT NULL,
        hit_count INTEGER NOT NULL DEFAULT 0
      )
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS memory_processed_units (
        unit_key TEXT PRIMARY KEY,
        activity_file TEXT,
        processed_at TEXT NOT NULL
      )
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS milestones (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'active',
        depends_on TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL DEFAULT '',
        completed_at TEXT DEFAULT NULL,
        vision TEXT NOT NULL DEFAULT '',
        success_criteria TEXT NOT NULL DEFAULT '[]',
        key_risks TEXT NOT NULL DEFAULT '[]',
        proof_strategy TEXT NOT NULL DEFAULT '[]',
        verification_contract TEXT NOT NULL DEFAULT '',
        verification_integration TEXT NOT NULL DEFAULT '',
        verification_operational TEXT NOT NULL DEFAULT '',
        verification_uat TEXT NOT NULL DEFAULT '',
        definition_of_done TEXT NOT NULL DEFAULT '[]',
        requirement_coverage TEXT NOT NULL DEFAULT '',
        boundary_map_markdown TEXT NOT NULL DEFAULT ''
      )
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS slices (
        milestone_id TEXT NOT NULL,
        id TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'pending',
        risk TEXT NOT NULL DEFAULT 'medium',
        depends TEXT NOT NULL DEFAULT '[]',
        demo TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT '',
        completed_at TEXT DEFAULT NULL,
        full_summary_md TEXT NOT NULL DEFAULT '',
        full_uat_md TEXT NOT NULL DEFAULT '',
        goal TEXT NOT NULL DEFAULT '',
        success_criteria TEXT NOT NULL DEFAULT '',
        proof_level TEXT NOT NULL DEFAULT '',
        integration_closure TEXT NOT NULL DEFAULT '',
        observability_impact TEXT NOT NULL DEFAULT '',
        sequence INTEGER DEFAULT 0, -- Ordering hint: tools may set this to control execution order
        replan_triggered_at TEXT DEFAULT NULL,
        PRIMARY KEY (milestone_id, id),
        FOREIGN KEY (milestone_id) REFERENCES milestones(id)
      )
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        milestone_id TEXT NOT NULL,
        slice_id TEXT NOT NULL,
        id TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'pending',
        one_liner TEXT NOT NULL DEFAULT '',
        narrative TEXT NOT NULL DEFAULT '',
        verification_result TEXT NOT NULL DEFAULT '',
        duration TEXT NOT NULL DEFAULT '',
        completed_at TEXT DEFAULT NULL,
        blocker_discovered INTEGER DEFAULT 0,
        deviations TEXT NOT NULL DEFAULT '',
        known_issues TEXT NOT NULL DEFAULT '',
        key_files TEXT NOT NULL DEFAULT '[]',
        key_decisions TEXT NOT NULL DEFAULT '[]',
        full_summary_md TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL DEFAULT '',
        estimate TEXT NOT NULL DEFAULT '',
        files TEXT NOT NULL DEFAULT '[]',
        verify TEXT NOT NULL DEFAULT '',
        inputs TEXT NOT NULL DEFAULT '[]',
        expected_output TEXT NOT NULL DEFAULT '[]',
        observability_impact TEXT NOT NULL DEFAULT '',
        full_plan_md TEXT NOT NULL DEFAULT '',
        sequence INTEGER DEFAULT 0, -- Ordering hint: tools may set this to control execution order
        PRIMARY KEY (milestone_id, slice_id, id),
        FOREIGN KEY (milestone_id, slice_id) REFERENCES slices(milestone_id, id)
      )
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS verification_evidence (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL DEFAULT '',
        slice_id TEXT NOT NULL DEFAULT '',
        milestone_id TEXT NOT NULL DEFAULT '',
        command TEXT NOT NULL DEFAULT '',
        exit_code INTEGER DEFAULT 0,
        verdict TEXT NOT NULL DEFAULT '',
        duration_ms INTEGER DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT '',
        FOREIGN KEY (milestone_id, slice_id, task_id) REFERENCES tasks(milestone_id, slice_id, id)
      )
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS replan_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        milestone_id TEXT NOT NULL DEFAULT '',
        slice_id TEXT DEFAULT NULL,
        task_id TEXT DEFAULT NULL,
        summary TEXT NOT NULL DEFAULT '',
        previous_artifact_path TEXT DEFAULT NULL,
        replacement_artifact_path TEXT DEFAULT NULL,
        created_at TEXT NOT NULL DEFAULT '',
        FOREIGN KEY (milestone_id) REFERENCES milestones(id)
      )
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS assessments (
        path TEXT PRIMARY KEY,
        milestone_id TEXT NOT NULL DEFAULT '',
        slice_id TEXT DEFAULT NULL,
        task_id TEXT DEFAULT NULL,
        status TEXT NOT NULL DEFAULT '',
        scope TEXT NOT NULL DEFAULT '',
        full_content TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT '',
        FOREIGN KEY (milestone_id) REFERENCES milestones(id)
      )
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS quality_gates (
        milestone_id TEXT NOT NULL,
        slice_id TEXT NOT NULL,
        gate_id TEXT NOT NULL,
        scope TEXT NOT NULL DEFAULT 'slice',
        task_id TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'pending',
        verdict TEXT NOT NULL DEFAULT '',
        rationale TEXT NOT NULL DEFAULT '',
        findings TEXT NOT NULL DEFAULT '',
        evaluated_at TEXT DEFAULT NULL,
        PRIMARY KEY (milestone_id, slice_id, gate_id, task_id),
        FOREIGN KEY (milestone_id, slice_id) REFERENCES slices(milestone_id, id)
      )
    `);

    // Slice dependency junction table (v14)
    db.exec(`
      CREATE TABLE IF NOT EXISTS slice_dependencies (
        milestone_id TEXT NOT NULL,
        slice_id TEXT NOT NULL,
        depends_on_slice_id TEXT NOT NULL,
        PRIMARY KEY (milestone_id, slice_id, depends_on_slice_id),
        FOREIGN KEY (milestone_id, slice_id) REFERENCES slices(milestone_id, id),
        FOREIGN KEY (milestone_id, depends_on_slice_id) REFERENCES slices(milestone_id, id)
      )
    `);

    db.exec("CREATE INDEX IF NOT EXISTS idx_memories_active ON memories(superseded_by)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_replan_history_milestone ON replan_history(milestone_id, created_at)");

    // v13 indexes — hot-path dispatch queries
    db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_active ON tasks(milestone_id, slice_id, status)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_slices_active ON slices(milestone_id, status)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_milestones_status ON milestones(status)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_quality_gates_pending ON quality_gates(milestone_id, slice_id, status)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_verification_evidence_task ON verification_evidence(milestone_id, slice_id, task_id)");
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_verification_evidence_dedup ON verification_evidence(task_id, slice_id, milestone_id, command, verdict)");

    // v14 index — slice dependency lookups
    db.exec("CREATE INDEX IF NOT EXISTS idx_slice_deps_target ON slice_dependencies(milestone_id, depends_on_slice_id)");

    db.exec(`CREATE VIEW IF NOT EXISTS active_decisions AS SELECT * FROM decisions WHERE superseded_by IS NULL`);
    db.exec(`CREATE VIEW IF NOT EXISTS active_requirements AS SELECT * FROM requirements WHERE superseded_by IS NULL`);
    db.exec(`CREATE VIEW IF NOT EXISTS active_memories AS SELECT * FROM memories WHERE superseded_by IS NULL`);

    const existing = db.prepare("SELECT count(*) as cnt FROM schema_version").get();
    if (existing && (existing["cnt"] as number) === 0) {
      db.prepare(
        "INSERT INTO schema_version (version, applied_at) VALUES (:version, :applied_at)",
      ).run({
        ":version": SCHEMA_VERSION,
        ":applied_at": new Date().toISOString(),
      });
    }

    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  migrateSchema(db);
}

function columnExists(db: DbAdapter, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  return rows.some((row) => row["name"] === column);
}

function ensureColumn(db: DbAdapter, table: string, column: string, ddl: string): void {
  if (!columnExists(db, table, column)) db.exec(ddl);
}

function migrateSchema(db: DbAdapter): void {
  const row = db.prepare("SELECT MAX(version) as v FROM schema_version").get();
  const currentVersion = row ? (row["v"] as number) : 0;
  if (currentVersion >= SCHEMA_VERSION) return;

  // Backup database before migration so a mid-migration crash doesn't
  // leave a partially-migrated DB with no recovery path.
  // WAL-safe: checkpoint first to flush WAL into the main DB file, then copy.
  if (currentPath && currentPath !== ":memory:" && existsSync(currentPath)) {
    try {
      const backupPath = `${currentPath}.backup-v${currentVersion}`;
      if (!existsSync(backupPath)) {
        // Flush WAL to main DB file before copying — without this, the backup
        // may be missing committed data that only exists in the -wal file.
        try { db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch { /* checkpoint is best-effort */ }
        copyFileSync(currentPath, backupPath);
      }
    } catch (backupErr) {
      // Log but proceed — blocking migration leaves the DB stuck at an old
      // schema version permanently on read-only or full filesystems.
      logWarning("db", `Pre-migration backup failed: ${backupErr instanceof Error ? backupErr.message : String(backupErr)}`);
    }
  }

  db.exec("BEGIN");
  try {
    if (currentVersion < 2) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS artifacts (
          path TEXT PRIMARY KEY,
          artifact_type TEXT NOT NULL DEFAULT '',
          milestone_id TEXT DEFAULT NULL,
          slice_id TEXT DEFAULT NULL,
          task_id TEXT DEFAULT NULL,
          full_content TEXT NOT NULL DEFAULT '',
          imported_at TEXT NOT NULL DEFAULT ''
        )
      `);
      db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (:version, :applied_at)").run({
        ":version": 2,
        ":applied_at": new Date().toISOString(),
      });
    }

    if (currentVersion < 3) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS memories (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          id TEXT NOT NULL UNIQUE,
          category TEXT NOT NULL,
          content TEXT NOT NULL,
          confidence REAL NOT NULL DEFAULT 0.8,
          source_unit_type TEXT,
          source_unit_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          superseded_by TEXT DEFAULT NULL,
          hit_count INTEGER NOT NULL DEFAULT 0
        )
      `);
      db.exec(`
        CREATE TABLE IF NOT EXISTS memory_processed_units (
          unit_key TEXT PRIMARY KEY,
          activity_file TEXT,
          processed_at TEXT NOT NULL
        )
      `);
      db.exec("CREATE INDEX IF NOT EXISTS idx_memories_active ON memories(superseded_by)");
      db.exec("DROP VIEW IF EXISTS active_memories");
      db.exec("CREATE VIEW active_memories AS SELECT * FROM memories WHERE superseded_by IS NULL");
      db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (:version, :applied_at)").run({
        ":version": 3,
        ":applied_at": new Date().toISOString(),
      });
    }

    if (currentVersion < 4) {
      ensureColumn(db, "decisions", "made_by", `ALTER TABLE decisions ADD COLUMN made_by TEXT NOT NULL DEFAULT 'agent'`);
      db.exec("DROP VIEW IF EXISTS active_decisions");
      db.exec("CREATE VIEW active_decisions AS SELECT * FROM decisions WHERE superseded_by IS NULL");
      db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (:version, :applied_at)").run({
        ":version": 4,
        ":applied_at": new Date().toISOString(),
      });
    }

    if (currentVersion < 5) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS milestones (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'active',
          created_at TEXT NOT NULL,
          completed_at TEXT DEFAULT NULL
        )
      `);
      db.exec(`
        CREATE TABLE IF NOT EXISTS slices (
          milestone_id TEXT NOT NULL,
          id TEXT NOT NULL,
          title TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'pending',
          risk TEXT NOT NULL DEFAULT 'medium',
          created_at TEXT NOT NULL DEFAULT '',
          completed_at TEXT DEFAULT NULL,
          PRIMARY KEY (milestone_id, id),
          FOREIGN KEY (milestone_id) REFERENCES milestones(id)
        )
      `);
      db.exec(`
        CREATE TABLE IF NOT EXISTS tasks (
          milestone_id TEXT NOT NULL,
          slice_id TEXT NOT NULL,
          id TEXT NOT NULL,
          title TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'pending',
          one_liner TEXT NOT NULL DEFAULT '',
          narrative TEXT NOT NULL DEFAULT '',
          verification_result TEXT NOT NULL DEFAULT '',
          duration TEXT NOT NULL DEFAULT '',
          completed_at TEXT DEFAULT NULL,
          blocker_discovered INTEGER DEFAULT 0,
          deviations TEXT NOT NULL DEFAULT '',
          known_issues TEXT NOT NULL DEFAULT '',
          key_files TEXT NOT NULL DEFAULT '[]',
          key_decisions TEXT NOT NULL DEFAULT '[]',
          full_summary_md TEXT NOT NULL DEFAULT '',
          PRIMARY KEY (milestone_id, slice_id, id),
          FOREIGN KEY (milestone_id, slice_id) REFERENCES slices(milestone_id, id)
        )
      `);
      db.exec(`
        CREATE TABLE IF NOT EXISTS verification_evidence (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id TEXT NOT NULL DEFAULT '',
          slice_id TEXT NOT NULL DEFAULT '',
          milestone_id TEXT NOT NULL DEFAULT '',
          command TEXT NOT NULL DEFAULT '',
          exit_code INTEGER DEFAULT 0,
          verdict TEXT NOT NULL DEFAULT '',
          duration_ms INTEGER DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT '',
          FOREIGN KEY (milestone_id, slice_id, task_id) REFERENCES tasks(milestone_id, slice_id, id)
        )
      `);
      db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (:version, :applied_at)").run({
        ":version": 5,
        ":applied_at": new Date().toISOString(),
      });
    }

    if (currentVersion < 6) {
      ensureColumn(db, "slices", "full_summary_md", `ALTER TABLE slices ADD COLUMN full_summary_md TEXT NOT NULL DEFAULT ''`);
      ensureColumn(db, "slices", "full_uat_md", `ALTER TABLE slices ADD COLUMN full_uat_md TEXT NOT NULL DEFAULT ''`);
      db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (:version, :applied_at)").run({
        ":version": 6,
        ":applied_at": new Date().toISOString(),
      });
    }

    if (currentVersion < 7) {
      ensureColumn(db, "slices", "depends", `ALTER TABLE slices ADD COLUMN depends TEXT NOT NULL DEFAULT '[]'`);
      ensureColumn(db, "slices", "demo", `ALTER TABLE slices ADD COLUMN demo TEXT NOT NULL DEFAULT ''`);
      ensureColumn(db, "milestones", "depends_on", `ALTER TABLE milestones ADD COLUMN depends_on TEXT NOT NULL DEFAULT '[]'`);
      db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (:version, :applied_at)").run({
        ":version": 7,
        ":applied_at": new Date().toISOString(),
      });
    }

    if (currentVersion < 8) {
      ensureColumn(db, "milestones", "vision", `ALTER TABLE milestones ADD COLUMN vision TEXT NOT NULL DEFAULT ''`);
      ensureColumn(db, "milestones", "success_criteria", `ALTER TABLE milestones ADD COLUMN success_criteria TEXT NOT NULL DEFAULT '[]'`);
      ensureColumn(db, "milestones", "key_risks", `ALTER TABLE milestones ADD COLUMN key_risks TEXT NOT NULL DEFAULT '[]'`);
      ensureColumn(db, "milestones", "proof_strategy", `ALTER TABLE milestones ADD COLUMN proof_strategy TEXT NOT NULL DEFAULT '[]'`);
      ensureColumn(db, "milestones", "verification_contract", `ALTER TABLE milestones ADD COLUMN verification_contract TEXT NOT NULL DEFAULT ''`);
      ensureColumn(db, "milestones", "verification_integration", `ALTER TABLE milestones ADD COLUMN verification_integration TEXT NOT NULL DEFAULT ''`);
      ensureColumn(db, "milestones", "verification_operational", `ALTER TABLE milestones ADD COLUMN verification_operational TEXT NOT NULL DEFAULT ''`);
      ensureColumn(db, "milestones", "verification_uat", `ALTER TABLE milestones ADD COLUMN verification_uat TEXT NOT NULL DEFAULT ''`);
      ensureColumn(db, "milestones", "definition_of_done", `ALTER TABLE milestones ADD COLUMN definition_of_done TEXT NOT NULL DEFAULT '[]'`);
      ensureColumn(db, "milestones", "requirement_coverage", `ALTER TABLE milestones ADD COLUMN requirement_coverage TEXT NOT NULL DEFAULT ''`);
      ensureColumn(db, "milestones", "boundary_map_markdown", `ALTER TABLE milestones ADD COLUMN boundary_map_markdown TEXT NOT NULL DEFAULT ''`);

      ensureColumn(db, "slices", "goal", `ALTER TABLE slices ADD COLUMN goal TEXT NOT NULL DEFAULT ''`);
      ensureColumn(db, "slices", "success_criteria", `ALTER TABLE slices ADD COLUMN success_criteria TEXT NOT NULL DEFAULT ''`);
      ensureColumn(db, "slices", "proof_level", `ALTER TABLE slices ADD COLUMN proof_level TEXT NOT NULL DEFAULT ''`);
      ensureColumn(db, "slices", "integration_closure", `ALTER TABLE slices ADD COLUMN integration_closure TEXT NOT NULL DEFAULT ''`);
      ensureColumn(db, "slices", "observability_impact", `ALTER TABLE slices ADD COLUMN observability_impact TEXT NOT NULL DEFAULT ''`);

      ensureColumn(db, "tasks", "description", `ALTER TABLE tasks ADD COLUMN description TEXT NOT NULL DEFAULT ''`);
      ensureColumn(db, "tasks", "estimate", `ALTER TABLE tasks ADD COLUMN estimate TEXT NOT NULL DEFAULT ''`);
      ensureColumn(db, "tasks", "files", `ALTER TABLE tasks ADD COLUMN files TEXT NOT NULL DEFAULT '[]'`);
      ensureColumn(db, "tasks", "verify", `ALTER TABLE tasks ADD COLUMN verify TEXT NOT NULL DEFAULT ''`);
      ensureColumn(db, "tasks", "inputs", `ALTER TABLE tasks ADD COLUMN inputs TEXT NOT NULL DEFAULT '[]'`);
      ensureColumn(db, "tasks", "expected_output", `ALTER TABLE tasks ADD COLUMN expected_output TEXT NOT NULL DEFAULT '[]'`);
      ensureColumn(db, "tasks", "observability_impact", `ALTER TABLE tasks ADD COLUMN observability_impact TEXT NOT NULL DEFAULT ''`);

      db.exec(`
        CREATE TABLE IF NOT EXISTS replan_history (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          milestone_id TEXT NOT NULL DEFAULT '',
          slice_id TEXT DEFAULT NULL,
          task_id TEXT DEFAULT NULL,
          summary TEXT NOT NULL DEFAULT '',
          previous_artifact_path TEXT DEFAULT NULL,
          replacement_artifact_path TEXT DEFAULT NULL,
          created_at TEXT NOT NULL DEFAULT '',
          FOREIGN KEY (milestone_id) REFERENCES milestones(id)
        )
      `);
      db.exec(`
        CREATE TABLE IF NOT EXISTS assessments (
          path TEXT PRIMARY KEY,
          milestone_id TEXT NOT NULL DEFAULT '',
          slice_id TEXT DEFAULT NULL,
          task_id TEXT DEFAULT NULL,
          status TEXT NOT NULL DEFAULT '',
          scope TEXT NOT NULL DEFAULT '',
          full_content TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL DEFAULT '',
          FOREIGN KEY (milestone_id) REFERENCES milestones(id)
        )
      `);
      db.exec("CREATE INDEX IF NOT EXISTS idx_replan_history_milestone ON replan_history(milestone_id, created_at)");

      db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (:version, :applied_at)").run({
        ":version": 8,
        ":applied_at": new Date().toISOString(),
      });
    }

    if (currentVersion < 9) {
      ensureColumn(db, "slices", "sequence", `ALTER TABLE slices ADD COLUMN sequence INTEGER DEFAULT 0`);
      ensureColumn(db, "tasks", "sequence", `ALTER TABLE tasks ADD COLUMN sequence INTEGER DEFAULT 0`);

      db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (:version, :applied_at)").run({
        ":version": 9,
        ":applied_at": new Date().toISOString(),
      });
    }

    if (currentVersion < 10) {
      ensureColumn(db, "slices", "replan_triggered_at", `ALTER TABLE slices ADD COLUMN replan_triggered_at TEXT DEFAULT NULL`);

      db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (:version, :applied_at)").run({
        ":version": 10,
        ":applied_at": new Date().toISOString(),
      });
    }

    if (currentVersion < 11) {
      ensureColumn(db, "tasks", "full_plan_md", `ALTER TABLE tasks ADD COLUMN full_plan_md TEXT NOT NULL DEFAULT ''`);
      // Add unique constraint to replan_history for idempotency:
      // one replan record per blocker task per slice per milestone.
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_replan_history_unique
        ON replan_history(milestone_id, slice_id, task_id)
        WHERE slice_id IS NOT NULL AND task_id IS NOT NULL
      `);

      db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (:version, :applied_at)").run({
        ":version": 11,
        ":applied_at": new Date().toISOString(),
      });
    }

    if (currentVersion < 12) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS quality_gates (
          milestone_id TEXT NOT NULL,
          slice_id TEXT NOT NULL,
          gate_id TEXT NOT NULL,
          scope TEXT NOT NULL DEFAULT 'slice',
          task_id TEXT DEFAULT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          verdict TEXT NOT NULL DEFAULT '',
          rationale TEXT NOT NULL DEFAULT '',
          findings TEXT NOT NULL DEFAULT '',
          evaluated_at TEXT DEFAULT NULL,
          PRIMARY KEY (milestone_id, slice_id, gate_id, COALESCE(task_id, '')),
          FOREIGN KEY (milestone_id, slice_id) REFERENCES slices(milestone_id, id)
        )
      `);
      db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (:version, :applied_at)").run({
        ":version": 12,
        ":applied_at": new Date().toISOString(),
      });
    }

    if (currentVersion < 13) {
      // Hot-path indexes for auto-loop dispatch queries
      db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_active ON tasks(milestone_id, slice_id, status)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_slices_active ON slices(milestone_id, status)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_milestones_status ON milestones(status)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_quality_gates_pending ON quality_gates(milestone_id, slice_id, status)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_verification_evidence_task ON verification_evidence(milestone_id, slice_id, task_id)");
      db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_verification_evidence_dedup ON verification_evidence(task_id, slice_id, milestone_id, command, verdict)");
      db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (:version, :applied_at)").run({
        ":version": 13,
        ":applied_at": new Date().toISOString(),
      });
    }

    if (currentVersion < 14) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS slice_dependencies (
          milestone_id TEXT NOT NULL,
          slice_id TEXT NOT NULL,
          depends_on_slice_id TEXT NOT NULL,
          PRIMARY KEY (milestone_id, slice_id, depends_on_slice_id),
          FOREIGN KEY (milestone_id, slice_id) REFERENCES slices(milestone_id, id),
          FOREIGN KEY (milestone_id, depends_on_slice_id) REFERENCES slices(milestone_id, id)
        )
      `);
      db.exec("CREATE INDEX IF NOT EXISTS idx_slice_deps_target ON slice_dependencies(milestone_id, depends_on_slice_id)");
      db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (:version, :applied_at)").run({
        ":version": 14,
        ":applied_at": new Date().toISOString(),
      });
    }

    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

// ─── Module State ───────────────────────────────────────────────────────

let currentDb: DbAdapter | null = null;
let currentPath: string | null = null;
let _exitHandlerRegistered = false;

/** Accessor for module-level DB adapter. Used by all db-*.ts sub-modules. */
export function _getCurrentDb(): DbAdapter | null {
  return currentDb;
}

/** Accessor for the current DB file path. Used by migration backup logic. */
export function _getCurrentPath(): string | null {
  return currentPath;
}

export function isDbAvailable(): boolean {
  return currentDb !== null;
}

export function openDatabase(path: string): boolean {
  if (currentDb && currentPath !== path) closeDatabase();
  if (currentDb && currentPath === path) return true;

  const rawDb = openRawDb(path);
  if (!rawDb) return false;

  const adapter = createAdapter(rawDb);
  const fileBacked = path !== ":memory:";
  try {
    initSchema(adapter, fileBacked);
  } catch (err) {
    // Corrupt freelist: DDL fails with "malformed" but VACUUM can rebuild.
    // Attempt VACUUM recovery before giving up (see #2519).
    if (fileBacked && err instanceof Error && err.message?.includes("malformed")) {
      try {
        adapter.exec("VACUUM");
        initSchema(adapter, fileBacked);
        process.stderr.write("gsd-db: recovered corrupt database via VACUUM\n");
      } catch (retryErr) {
        try { adapter.close(); } catch (e) { logWarning("db", `close after VACUUM failed: ${(e as Error).message}`); }
        throw retryErr;
      }
    } else {
      try { adapter.close(); } catch (e) { logWarning("db", `close after VACUUM failed: ${(e as Error).message}`); }
      throw err;
    }
  }

  currentDb = adapter;
  currentPath = path;

  if (!_exitHandlerRegistered) {
    _exitHandlerRegistered = true;
    process.on("exit", () => { try { closeDatabase(); } catch (e) { logWarning("db", `exit handler close failed: ${(e as Error).message}`); } });
  }

  return true;
}

export function closeDatabase(): void {
  if (currentDb) {
    try {
      currentDb.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch (e) { logWarning("db", `WAL checkpoint failed: ${(e as Error).message}`); }
    try {
      // Incremental vacuum to reclaim space without blocking
      currentDb.exec('PRAGMA incremental_vacuum(64)');
    } catch (e) { logWarning("db", `incremental vacuum failed: ${(e as Error).message}`); }
    try {
      currentDb.close();
    } catch (e) { logWarning("db", `database close failed: ${(e as Error).message}`); }
    currentDb = null;
    currentPath = null;
  }
}

let _txDepth = 0;

export function transaction<T>(fn: () => T): T {
  if (!currentDb) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");

  // Re-entrant: if already inside a transaction, just run fn() without
  // starting a new one. SQLite does not support nested BEGIN/COMMIT.
  if (_txDepth > 0) {
    _txDepth++;
    try {
      return fn();
    } finally {
      _txDepth--;
    }
  }

  _txDepth++;
  currentDb.exec("BEGIN");
  try {
    const result = fn();
    currentDb.exec("COMMIT");
    return result;
  } catch (err) {
    currentDb.exec("ROLLBACK");
    throw err;
  } finally {
    _txDepth--;
  }
}

/** Legacy accessor — used by modules that need raw adapter access. */
export function _getAdapter(): DbAdapter | null {
  return currentDb;
}
