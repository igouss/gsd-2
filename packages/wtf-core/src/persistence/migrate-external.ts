/**
 * WTF External State Migration
 *
 * Migrates legacy in-project `.wtf/` directories to the external
 * `~/.wtf/projects/<hash>/` state directory. After migration, a
 * symlink replaces the original directory so all paths remain valid.
 */

import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, renameSync, cpSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { externalWtfRoot, isInsideWorktree } from "../git/repo-identity.ts";
import { getErrorMessage } from "../domain/error-utils.ts";
import { hasGitTrackedWtfFiles } from "../git/gitignore.ts";
import { GIT_NO_PROMPT_ENV } from "../git/git-constants.ts";
import { PROJECT_DIR_NAME } from "../domain/constants.ts";

export interface MigrationResult {
  migrated: boolean;
  error?: string;
}

/**
 * Migrate a legacy in-project `.wtf/` directory to external storage.
 *
 * Algorithm:
 * 1. If `<project>/.wtf` is a symlink or doesn't exist -> skip
 * 2. If `<project>/.wtf` is a real directory:
 *    a. Compute external path from repoIdentity
 *    b. mkdir -p external dir
 *    c. Rename `.wtf` -> `.wtf.migrating` (atomic on same FS, acts as lock)
 *    d. Copy contents to external dir (skip `worktrees/` subdirectory)
 *    e. Create symlink `.wtf -> external path`
 *    f. Remove `.wtf.migrating`
 * 3. On failure: rename `.wtf.migrating` back to `.wtf` (rollback)
 */
export function migrateToExternalState(basePath: string): MigrationResult {
  // Worktrees get their .wtf via syncWtfStateToWorktree(), not migration.
  // Migration inside a worktree would compute the same external hash as the
  // main repo (externalWtfRoot hashes remoteUrl + gitRoot), creating a broken
  // junction and orphaning .wtf.migrating (#2970).
  if (isInsideWorktree(basePath)) {
    return { migrated: false };
  }

  const localWtf = join(basePath, PROJECT_DIR_NAME);

  // Skip if doesn't exist
  if (!existsSync(localWtf)) {
    return { migrated: false };
  }

  // Skip if already a symlink
  try {
    const stat = lstatSync(localWtf);
    if (stat.isSymbolicLink()) {
      return { migrated: false };
    }
    if (!stat.isDirectory()) {
      return { migrated: false, error: ".wtf exists but is not a directory or symlink" };
    }
  } catch (err) {
    return { migrated: false, error: `Cannot stat .wtf: ${getErrorMessage(err)}` };
  }

  // Skip if .wtf/ contains git-tracked files — the project intentionally
  // keeps .wtf/ in version control and migration would destroy that.
  if (hasGitTrackedWtfFiles(basePath)) {
    return { migrated: false };
  }

  // Skip if .wtf/worktrees/ has active worktree directories (#1337).
  // On Windows, active git worktrees hold OS-level directory handles that
  // prevent rename/delete. Attempting migration causes EBUSY and data loss.
  const worktreesDir = join(localWtf, "worktrees");
  if (existsSync(worktreesDir)) {
    try {
      const entries = readdirSync(worktreesDir, { withFileTypes: true });
      if (entries.some(e => e.isDirectory())) {
        return { migrated: false };
      }
    } catch {
      // Can't read worktrees dir — skip migration to be safe
      return { migrated: false };
    }
  }

  const externalPath = externalWtfRoot(basePath);
  const migratingPath = join(basePath, ".wtf.migrating");

  try {
    // mkdir -p the external dir
    mkdirSync(externalPath, { recursive: true });

    // Rename .wtf -> .wtf.migrating (atomic lock).
    // On Windows, NTFS may reject rename with EPERM if file descriptors are
    // open (VS Code watchers, antivirus on-access scan). Fall back to
    // copy+delete (#1292).
    try {
      renameSync(localWtf, migratingPath);
    } catch (renameErr: any) {
      if (renameErr?.code === "EPERM" || renameErr?.code === "EBUSY") {
        try {
          cpSync(localWtf, migratingPath, { recursive: true, force: true });
          rmSync(localWtf, { recursive: true, force: true });
        } catch (copyErr) {
          return { migrated: false, error: `Migration rename/copy failed: ${copyErr instanceof Error ? copyErr.message : String(copyErr)}` };
        }
      } else {
        throw renameErr;
      }
    }

    // Copy contents to external dir, skipping worktrees/
    const entries = readdirSync(migratingPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === "worktrees") continue; // worktrees stay local

      const src = join(migratingPath, entry.name);
      const dst = join(externalPath, entry.name);

      try {
        if (entry.isDirectory()) {
          cpSync(src, dst, { recursive: true, force: true });
        } else {
          cpSync(src, dst, { force: true });
        }
      } catch {
        // Non-fatal: continue with other files
      }
    }

    // Create symlink .wtf -> external path
    symlinkSync(externalPath, localWtf, "junction");

    // Verify the symlink resolves correctly before removing the backup (#1377).
    // On Windows, junction creation can silently succeed but resolve to the wrong
    // target, or the external dir may not be accessible. If verification fails,
    // restore from the backup.
    try {
      const resolved = realpathSync(localWtf);
      const resolvedExternal = realpathSync(externalPath);
      if (resolved !== resolvedExternal) {
        // Symlink points to wrong target — restore backup
        try { rmSync(localWtf, { force: true }); } catch { /* may not exist */ }
        renameSync(migratingPath, localWtf);
        return { migrated: false, error: `Migration verification failed: symlink resolves to ${resolved}, expected ${resolvedExternal}` };
      }
      // Verify we can read through the symlink
      readdirSync(localWtf);
    } catch (verifyErr) {
      // Symlink broken or unreadable — restore backup
      try { rmSync(localWtf, { force: true }); } catch { /* may not exist */ }
      try { renameSync(migratingPath, localWtf); } catch { /* best-effort restore */ }
      return { migrated: false, error: `Migration verification failed: ${getErrorMessage(verifyErr)}` };
    }

    // Clean the git index — any .wtf/* files tracked before migration now
    // sit behind the symlink and git can't follow it, causing them to show
    // as deleted. Remove them from the index so the working tree stays clean.
    // --ignore-unmatch makes this a no-op on fresh projects with no tracked .wtf/.
    try {
      execFileSync("git", ["rm", "-r", "--cached", "--ignore-unmatch", PROJECT_DIR_NAME], {
        cwd: basePath,
        stdio: ["ignore", "pipe", "ignore"],
        env: GIT_NO_PROMPT_ENV,
        timeout: 10_000,
      });
    } catch {
      // Non-fatal — git may be unavailable or nothing was tracked
    }

    // Remove .wtf.migrating only after symlink is verified and index is clean
    rmSync(migratingPath, { recursive: true, force: true });

    return { migrated: true };
  } catch (err) {
    // Rollback: rename .wtf.migrating back to .wtf
    try {
      if (existsSync(migratingPath) && !existsSync(localWtf)) {
        renameSync(migratingPath, localWtf);
      }
    } catch {
      // Rollback failed -- leave .wtf.migrating for doctor to detect
    }

    return {
      migrated: false,
      error: `Migration failed: ${getErrorMessage(err)}`,
    };
  }
}

/**
 * Recover from a failed migration (`.wtf.migrating` exists).
 * Moves `.wtf.migrating` back to `.wtf` if `.wtf` doesn't exist.
 */
export function recoverFailedMigration(basePath: string): boolean {
  const localWtf = join(basePath, PROJECT_DIR_NAME);
  const migratingPath = join(basePath, ".wtf.migrating");

  if (!existsSync(migratingPath)) return false;
  if (existsSync(localWtf)) return false; // both exist -- ambiguous, don't touch

  try {
    renameSync(migratingPath, localWtf);
    return true;
  } catch {
    return false;
  }
}
