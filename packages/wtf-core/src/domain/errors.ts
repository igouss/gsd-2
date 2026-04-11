/**
 * WTF Error Types — Typed error hierarchy for diagnostics and crash recovery.
 *
 * All WTF-specific errors extend WTFError, which carries a stable `code`
 * string suitable for programmatic matching. Error codes are defined as
 * constants so callers can switch on them without string-matching.
 */

// ─── Error Codes ──────────────────────────────────────────────────────────────

export const WTF_STALE_STATE = "WTF_STALE_STATE";
export const WTF_LOCK_HELD = "WTF_LOCK_HELD";
export const WTF_ARTIFACT_MISSING = "WTF_ARTIFACT_MISSING";
export const WTF_GIT_ERROR = "WTF_GIT_ERROR";
export const WTF_MERGE_CONFLICT = "WTF_MERGE_CONFLICT";
export const WTF_PARSE_ERROR = "WTF_PARSE_ERROR";
export const WTF_IO_ERROR = "WTF_IO_ERROR";

// ─── Base Error ───────────────────────────────────────────────────────────────

export class WTFError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WTFError";
    this.code = code;
  }
}
