/**
 * WTF bootstrappers for .gitignore and PREFERENCES.md
 *
 * Ensures baseline .gitignore exists with universally-correct patterns.
 * Creates an empty PREFERENCES.md template if it doesn't exist.
 * Both idempotent — non-destructive if already present.
 */

import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { nativeRmCached, nativeLsFiles } from "./native-git-bridge.ts";
import { wtfRoot } from "../persistence/paths.ts";
import { GIT_NO_PROMPT_ENV } from "./git-constants.ts";
import { PROJECT_DIR_NAME } from "../domain/constants.ts";

/**
 * WTF runtime patterns for git index cleanup.
 * With external state (symlink), these are a no-op in most cases,
 * but retained for backwards compatibility during migration.
 */
const WTF_RUNTIME_PATTERNS = [
  ".wtf/activity/",
  ".wtf/forensics/",
  ".wtf/runtime/",
  ".wtf/worktrees/",
  ".wtf/parallel/",
  ".wtf/auto.lock",
  ".wtf/metrics.json",
  ".wtf/completed-units.json",
  ".wtf/STATE.md",
  ".wtf/wtf.db",
  ".wtf/wtf.db-shm",   // SQLite WAL sidecar — always created alongside wtf.db (#2296)
  ".wtf/wtf.db-wal",   // SQLite WAL sidecar — always created alongside wtf.db (#2296)
  ".wtf/journal/",     // daily-rotated JSONL event journal (#2296)
  ".wtf/doctor-history.jsonl", // doctor run history (#2296)
  ".wtf/DISCUSSION-MANIFEST.json",
  ".wtf/milestones/**/*-CONTINUE.md",
  ".wtf/milestones/**/continue.md",
] as const;

const BASELINE_PATTERNS = [
  // ── WTF state directory (symlink to external storage) ──
  PROJECT_DIR_NAME,
  ".wtf-id",
  ".bg-shell/",

  // ── OS junk ──
  ".DS_Store",
  "Thumbs.db",

  // ── Editor / IDE ──
  "*.swp",
  "*.swo",
  "*~",
  ".idea/",
  ".vscode/",
  "*.code-workspace",

  // ── Environment / secrets ──
  ".env",
  ".env.*",
  "!.env.example",

  // ── Node / JS / TS ──
  "node_modules/",
  ".next/",
  "dist/",
  "build/",

  // ── Python ──
  "__pycache__/",
  "*.pyc",
  ".venv/",
  "venv/",

  // ── Rust ──
  "target/",

  // ── Go ──
  "vendor/",

  // ── Misc build artifacts ──
  "*.log",
  "coverage/",
  ".cache/",
  "tmp/",
];

/**
 * Check whether `.wtf` is covered by the project's `.gitignore`.
 *
 * Uses `git check-ignore` for accurate evaluation — this respects nested
 * .gitignore files, global gitignore, and negation patterns. Returns true
 * only when git would actually ignore `.wtf/`.
 *
 * Returns false (not ignored) if:
 *   - No `.gitignore` exists
 *   - `.wtf` is not listed in any active ignore rule
 *   - Not a git repo or git is unavailable
 */
export function isWtfGitignored(basePath: string): boolean {
  // Check both `.wtf` and `.wtf/` because `.wtf/` in .gitignore (trailing
  // slash = directory-only pattern) only matches the directory form. Using
  // both paths covers all gitignore pattern variants.
  for (const path of [PROJECT_DIR_NAME, ".wtf/"]) {
    try {
      // git check-ignore exits 0 when the path IS ignored, 1 when it is NOT.
      execFileSync("git", ["check-ignore", "-q", path], {
        cwd: basePath,
        stdio: "pipe",
        env: GIT_NO_PROMPT_ENV,
      });
      return true; // exit 0 → .wtf is ignored
    } catch {
      // exit 1 → this form is NOT ignored, try the other
    }
  }
  return false; // neither form is ignored (or git unavailable)
}

/**
 * Check whether `.wtf/` contains files tracked by git.
 * If so, the project intentionally keeps `.wtf/` in version control
 * and we must NOT add `.wtf` to `.gitignore` or attempt migration.
 *
 * Returns true if git tracks at least one file under `.wtf/`.
 * Returns false (safe to ignore) if:
 *   - Not a git repo
 *   - `.wtf/` is a symlink (external state, should be ignored)
 *   - `.wtf/` doesn't exist
 *   - No tracked files found under `.wtf/`
 */
export function hasGitTrackedWtfFiles(basePath: string): boolean {
  const localWtf = join(basePath, PROJECT_DIR_NAME);

  // If .wtf doesn't exist or is already a symlink, no tracked files concern
  if (!existsSync(localWtf)) return false;
  try {
    if (lstatSync(localWtf).isSymbolicLink()) return false;
  } catch {
    return false;
  }

  // Check if git tracks any files under .wtf/
  try {
    const tracked = nativeLsFiles(basePath, PROJECT_DIR_NAME);
    if (tracked.length > 0) return true;

    // nativeLsFiles swallows git failures and returns []. An empty result
    // could mean "nothing tracked" OR "git failed silently". Verify git is
    // reachable before trusting the empty result — if it isn't, fail safe
    // by assuming files ARE tracked to prevent data loss.
    execFileSync("git", ["rev-parse", "--git-dir"], {
      cwd: basePath,
      stdio: "pipe",
      env: GIT_NO_PROMPT_ENV,
    });

    return false;
  } catch {
    // git unavailable, index locked, or repo corrupt — fail safe
    return true;
  }
}

/**
 * Ensure basePath/.gitignore contains baseline ignore patterns.
 * Creates the file if missing; appends missing patterns.
 * Returns true if the file was created or modified, false if already complete.
 *
 * **Safety check:** If `.wtf/` contains git-tracked files (i.e., the project
 * intentionally keeps `.wtf/` in version control), the `.wtf` ignore pattern
 * is excluded to prevent data loss. Only the `.wtf` pattern is affected —
 * all other baseline patterns are still applied normally.
 */
export function ensureGitignore(
  basePath: string,
  options?: { manageGitignore?: boolean },
): boolean {
  // If manage_gitignore is explicitly false, do not touch .gitignore at all
  if (options?.manageGitignore === false) return false;

  const gitignorePath = join(basePath, ".gitignore");

  let existing = "";
  if (existsSync(gitignorePath)) {
    existing = readFileSync(gitignorePath, "utf-8");
  }

  // Parse existing lines (trimmed, ignoring comments and blanks)
  const existingLines = new Set(
    existing
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#")),
  );

  // Determine which patterns to apply. If .wtf/ has tracked files,
  // exclude the PROJECT_DIR_NAME pattern to prevent deleting tracked state.
  const wtfIsTracked = hasGitTrackedWtfFiles(basePath);
  const patternsToApply = wtfIsTracked
    ? BASELINE_PATTERNS.filter((p) => p !== PROJECT_DIR_NAME)
    : BASELINE_PATTERNS;

  // Find patterns not yet present
  const missing = patternsToApply.filter((p) => !existingLines.has(p));

  if (missing.length === 0) return false;

  // Build the block to append
  const block = [
    "",
    "# ── WTF baseline (auto-generated) ──",
    ...missing,
    "",
  ].join("\n");

  // Ensure existing content ends with a newline before appending
  const prefix = existing && !existing.endsWith("\n") ? "\n" : "";
  writeFileSync(gitignorePath, existing + prefix + block, "utf-8");

  return true;
}

/**
 * Remove BASELINE_PATTERNS runtime paths from the git index if they are
 * currently tracked. This fixes repos that started tracking these files
 * before the .gitignore rule was added — git continues tracking files
 * already in the index even after .gitignore is updated.
 *
 * Only removes from the index (`--cached`), never from disk. Idempotent.
 *
 * Note: These are strictly runtime/ephemeral paths (activity logs, lock files,
 * metrics, STATE.md). They are always safe to untrack, even when the project
 * intentionally keeps other `.wtf/` files (like PROJECT.md, milestones/) in
 * version control.
 */
export function untrackRuntimeFiles(basePath: string): void {
  const runtimePaths = WTF_RUNTIME_PATTERNS;

  for (const pattern of runtimePaths) {
    // Use -r for directory patterns (trailing slash), strip the slash for the command
    const target = pattern.endsWith("/") ? pattern.slice(0, -1) : pattern;
    try {
      nativeRmCached(basePath, [target]);
    } catch {
      // File not tracked or doesn't exist — expected, ignore
    }
  }
}

/**
 * Ensure basePath/.wtf/PREFERENCES.md exists as an empty template.
 * Creates the file with frontmatter only if it doesn't exist.
 * Returns true if created, false if already exists.
 *
 * Checks both uppercase (canonical) and lowercase (legacy) to avoid
 * creating a duplicate when a lowercase file already exists.
 */
export function ensurePreferences(basePath: string): boolean {
  const preferencesPath = join(wtfRoot(basePath), "PREFERENCES.md");
  const legacyPath = join(wtfRoot(basePath), "preferences.md");

  if (existsSync(preferencesPath) || existsSync(legacyPath)) {
    return false;
  }

  const template = `---
version: 1
always_use_skills: []
prefer_skills: []
avoid_skills: []
skill_rules: []
custom_instructions: []
models: {}
skill_discovery: {}
auto_supervisor: {}
---

# WTF Skill Preferences

Project-specific guidance for skill selection and execution preferences.

See \`~/.wtf/agent/extensions/wtf/docs/preferences-reference.md\` for full field documentation and examples.

## Fields

- \`always_use_skills\`: Skills that must be available during all WTF operations
- \`prefer_skills\`: Skills to prioritize when multiple options exist
- \`avoid_skills\`: Skills to minimize or avoid (with lower priority than prefer)
- \`skill_rules\`: Context-specific rules (e.g., "use tool X for Y type of work")
- \`custom_instructions\`: Append-only project guidance (do not override system rules)
- \`models\`: Model preferences for specific task types
- \`skill_discovery\`: Automatic skill detection preferences
- \`auto_supervisor\`: Supervision and gating rules for autonomous modes
- \`git\`: Git preferences — \`main_branch\` (default branch name for new repos, e.g., "main", "master", "trunk"), \`auto_push\`, \`snapshots\`, etc.

## Examples

\`\`\`yaml
prefer_skills:
  - playwright
  - resolve_library
avoid_skills:
  - subagent  # prefer direct execution in this project

custom_instructions:
  - "Always verify with browser_assert before marking UI work done"
  - "Use Context7 for all library/framework decisions"
\`\`\`
`;

  writeFileSync(preferencesPath, template, "utf-8");
  return true;
}

