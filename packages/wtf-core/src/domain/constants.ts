/**
 * WTF Extension — Shared Constants
 *
 * Centralized timeout and cache-size constants used across the WTF extension.
 */

// ─── Project Directory ───────────────────────────────────────────────────────

/** The project-local directory name used for all WTF state and artifacts. */
export const PROJECT_DIR_NAME = ".wtf";

// ─── Timeouts ─────────────────────────────────────────────────────────────────

/** Default timeout for verification-gate commands (ms). */
export const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;

/** Default timeout for the dynamic bash tool (seconds). */
export const DEFAULT_BASH_TIMEOUT_SECS = 120;

// ─── Cache Sizes ──────────────────────────────────────────────────────────────

/** Max directory-listing cache entries before eviction (#611). */
export const DIR_CACHE_MAX = 200;

/** Max parse-cache entries before eviction. */
export const CACHE_MAX = 50;

// ─── Tool Scoping ─────────────────────────────────────────────────────────────

/**
 * WTF tools allowed during discuss flows (#2949).
 *
 * xAI/Grok (and potentially other providers with grammar-based constrained
 * decoding) return "Grammar is too complex" (HTTP 400) when the combined
 * tool schemas exceed their internal grammar limit. The full WTF tool set
 * registers ~33 tools with deeply nested schemas; discuss flows only need
 * a small subset.
 *
 * By scoping tools to this allowlist during discuss dispatches, the grammar
 * sent to the provider stays well under provider limits.
 *
 * Included tools and why:
 *   - wtf_summary_save: writes CONTEXT.md artifacts (all discuss prompts)
 *   - wtf_save_summary: alias for above
 *   - wtf_decision_save: records decisions (discuss.md output phase)
 *   - wtf_save_decision: alias for above
 *   - wtf_plan_milestone: writes roadmap (discuss.md single/multi milestone)
 *   - wtf_milestone_plan: alias for above
 *   - wtf_milestone_generate_id: generates milestone IDs (discuss.md multi-milestone)
 *   - wtf_generate_milestone_id: alias for above
 *   - wtf_requirement_update: updates requirements during discuss
 *   - wtf_update_requirement: alias for above
 */
export const DISCUSS_TOOLS_ALLOWLIST: readonly string[] = [
  // Context / summary writing
  "wtf_summary_save",
  "wtf_save_summary",
  // Decision recording
  "wtf_decision_save",
  "wtf_save_decision",
  // Milestone planning (needed for discuss.md output phase)
  "wtf_plan_milestone",
  "wtf_milestone_plan",
  // Milestone ID generation (multi-milestone flow)
  "wtf_milestone_generate_id",
  "wtf_generate_milestone_id",
  // Requirement updates
  "wtf_requirement_update",
  "wtf_update_requirement",
];
