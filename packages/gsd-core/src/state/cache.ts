// WTF Extension — Unified Cache Invalidation
//
// Three module-scoped caches exist across the WTF extension:
//   1. State cache (state.ts)  — memoized deriveState() result
//   2. Path cache  (paths.ts)  — directory listing results (readdirSync)
//   3. Parse cache (files.ts)  — parsed markdown file results
//
// After any file write that changes .wtf/ contents, all three must be
// invalidated together to prevent stale reads. This module provides a
// single function that clears all three atomically.

import { invalidateStateCache } from './state.ts';
import { clearPathCache } from '../persistence/paths.ts';
import { clearParseCache } from '../persistence/files.ts';
import { clearArtifacts } from '../persistence/wtf-db.ts';

/**
 * Invalidate all WTF runtime caches in one call.
 *
 * Call this after file writes, milestone transitions, merge reconciliation,
 * or any operation that changes .wtf/ contents on disk. Forgetting to clear
 * any single cache causes stale reads (see #431, #793).
 */
export function invalidateAllCaches(): void {
  invalidateStateCache();
  clearPathCache();
  clearParseCache();
  clearArtifacts();
}
