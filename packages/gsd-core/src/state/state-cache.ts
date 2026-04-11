// deriveState() memoization cache.
// Cache the most recent deriveState() result keyed by basePath. Within a single
// dispatch cycle (~100ms window), repeated calls return the cached value instead
// of re-reading the entire .wtf/ tree from disk.

import type { WTFState } from '../domain/types.ts';

interface StateCache {
  basePath: string;
  result: WTFState;
  timestamp: number;
}

export const CACHE_TTL_MS = 100;
let _stateCache: StateCache | null = null;

/**
 * Invalidate the deriveState() cache. Call this whenever planning files on disk
 * may have changed (unit completion, merges, file writes).
 */
export function invalidateStateCache(): void {
  _stateCache = null;
}

export function getStateCache(): StateCache | null {
  return _stateCache;
}

export function setStateCache(basePath: string, result: WTFState): void {
  _stateCache = { basePath, result, timestamp: Date.now() };
}
