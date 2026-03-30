# Implementation Plan: Keyring by Default on Linux

Generated: 2026-03-29

## Goal

When `pi` runs standalone on Linux (not spawned by daemon), read API keys from
the system keyring (`org.freedesktop.secrets`) before auth.json. When keys are
saved via `AuthStorage.set()`, write them to the keyring too. One-time migration
of existing auth.json / env keys into keyring on first run.

Non-Linux platforms: zero behavior change. Keyring unavailable: silent fallback,
never crash.

## Existing Codebase Analysis

### Key files

| File | Role |
|------|------|
| `packages/pi-coding-agent/src/core/auth-storage.ts` | `AuthStorage` class. `getApiKey()` priority: runtime override > auth.json > env > fallback. `set()` writes to auth.json. |
| `packages/pi-coding-agent/src/main.ts:391` | `AuthStorage.create()` — no injection, no async init. |
| `packages/daemon/src/secret-service.ts` | `SecretServiceAdapter` — dbus-next, `getCredential(key)` returns `string|null`, `storeCredential(key, value)` throws on failure. Attributes: `{ service: 'gsd-daemon', key: '<key>' }`. |
| `packages/pi-coding-agent/package.json` | Does NOT have `dbus-next` dep. |

### Design constraints from existing code

1. `AuthStorage` constructor is sync. `getApiKey()` is async. `set()` is sync.
2. `SecretServiceAdapter` methods are all async (D-Bus IPC).
3. The daemon stores keys under `service: 'gsd-daemon'`. The `pi` adapter MUST use the same attributes to share the same keyring entries.
4. `AuthStorageBackend` interface is sync read/write of auth.json only — keyring is orthogonal, not a replacement for the file backend.
5. `InMemoryAuthStorageBackend` is used in tests — keyring must be injectable/mockable.

## Architecture Decision: Composition, Not Inheritance

The keyring is NOT a replacement for `AuthStorageBackend`. It's a supplementary
credential source with different semantics:

- `AuthStorageBackend`: sync, file-locked JSON read/write (auth.json)
- Keyring: async, D-Bus IPC, may fail, may not exist

The right pattern: **inject an optional `KeyringAdapter` into `AuthStorage`**.
AuthStorage already has `runtimeOverrides` and `fallbackResolver` as injected
credential sources. The keyring is the same pattern.

## Interface Design

```typescript
// packages/pi-coding-agent/src/core/keyring-adapter.ts

/**
 * Minimal interface for a system keyring.
 * getCredential returns null on any failure (same contract as SecretServiceAdapter).
 * storeCredential may throw (caller handles).
 */
export interface KeyringAdapter {
  getCredential(key: string): Promise<string | null>;
  storeCredential(key: string, value: string): Promise<void>;
}
```

This is deliberately identical to `SecretServiceAdapter`'s public API. We don't
import from the daemon package — we define the interface in pi-coding-agent and
provide a Linux implementation that duplicates the dbus-next logic.

Wait, no. That's stupid. The `SecretServiceAdapter` is 185 lines of non-trivial
D-Bus plumbing. Duplicating it is NIH syndrome. Better option:

**Extract `SecretServiceAdapter` into a shared location**, or more practically:
just copy the file. It's self-contained (single import: `dbus-next`). The daemon
can keep its copy, pi-coding-agent gets its own. They share the same keyring
attributes, same D-Bus protocol. No cross-package dependency.

Actually, the cleanest approach: **move SecretServiceAdapter to a shared package
or just add dbus-next to pi-coding-agent and create a thin wrapper**. Since the
constraint says "no new workspace packages needed" and "dbus-next can be added
to pi-coding-agent", we copy the adapter.

### Final call: Copy the adapter

Copy `SecretServiceAdapter` from daemon into pi-coding-agent as
`linux-keyring.ts`. It's 185 lines, well-tested, and the D-Bus protocol won't
change. The daemon keeps its copy. Both use the same keyring attributes.

## New Key Priority in `getApiKey()`

```
1. Runtime override (--api-key CLI flag)           [unchanged]
2. Keyring (Linux only, cached after first read)   [NEW]
3. auth.json credentials                           [unchanged]
4. Environment variable                            [unchanged]
5. Fallback resolver                               [unchanged]
```

Keyring sits at #2 because:
- It's more secure than auth.json (encrypted at rest, session-locked)
- It's the same priority the daemon uses (keyring > env)
- CLI flag still wins (explicit user intent)

## Caching Strategy

D-Bus roundtrip is ~2-20ms. `getApiKey()` is called on every API request.
Solution: **cache keyring reads in memory for the process lifetime**, same as
`resolveConfigValue` does for shell commands.

```typescript
// In AuthStorage:
private keyringCache: Map<string, string | null> = new Map();

// On getApiKey():
if (this.keyringAdapter && !this.keyringCache.has(providerId)) {
  const keyName = providerToKeyringKey(providerId); // 'anthropic' → 'ANTHROPIC_API_KEY'
  this.keyringCache.set(providerId, await this.keyringAdapter.getCredential(keyName));
}
const keyringValue = this.keyringCache.get(providerId);
if (keyringValue) return keyringValue;
```

Cache is invalidated on `set()` (after writing to keyring) and on `reload()`.

## Implementation Phases

### Phase 1: KeyringAdapter interface + Linux implementation

**Files to create:**
- `packages/pi-coding-agent/src/core/keyring-adapter.ts` — interface + `LinuxKeyringAdapter` class

**Steps:**
1. Define `KeyringAdapter` interface: `getCredential(key): Promise<string|null>`, `storeCredential(key, value): Promise<void>`
2. Implement `LinuxKeyringAdapter` — copy the D-Bus logic from `SecretServiceAdapter` (same `dbus-next` calls, same attributes `{ service: 'gsd-daemon', key }`, same 2000ms timeout)
3. Export a factory: `createKeyringAdapter(): KeyringAdapter | null` — returns `LinuxKeyringAdapter` on Linux, `null` elsewhere. Catches dbus-next import failure gracefully.
4. Add `dbus-next` to `packages/pi-coding-agent/package.json` dependencies

**Acceptance criteria:**
- [ ] `LinuxKeyringAdapter.getCredential('ANTHROPIC_API_KEY')` returns the stored value or null
- [ ] `LinuxKeyringAdapter.storeCredential('ANTHROPIC_API_KEY', 'sk-...')` stores to keyring
- [ ] `createKeyringAdapter()` returns null on non-Linux platforms
- [ ] dbus-next import failure returns null (not throw)

### Phase 2: Inject keyring into AuthStorage + modify getApiKey()

**Files to modify:**
- `packages/pi-coding-agent/src/core/auth-storage.ts`

**Steps:**

1. Add optional `keyringAdapter` field to `AuthStorage`:
```typescript
private keyringAdapter: KeyringAdapter | null = null;
private keyringCache: Map<string, string | null> = new Map();
```

2. Add setter (called at construction time):
```typescript
setKeyringAdapter(adapter: KeyringAdapter): void {
  this.keyringAdapter = adapter;
}
```

3. Add provider-to-keyring-key mapping:
```typescript
// Maps provider ID to the key name used in the keyring.
// Must match daemon's convention: 'ANTHROPIC_API_KEY', 'DISCORD_TOKEN', etc.
function providerToKeyringKey(provider: string): string {
  const MAP: Record<string, string> = {
    anthropic: 'ANTHROPIC_API_KEY',
    // Add more as needed
  };
  return MAP[provider] ?? `${provider.toUpperCase()}_API_KEY`;
}
```

4. Modify `getApiKey()` — insert keyring lookup after runtime override, before auth.json:
```typescript
// After runtime override check, before credential lookup:
if (this.keyringAdapter) {
  const keyringKey = providerToKeyringKey(providerId);
  if (!this.keyringCache.has(keyringKey)) {
    try {
      this.keyringCache.set(keyringKey, await this.keyringAdapter.getCredential(keyringKey));
    } catch {
      this.keyringCache.set(keyringKey, null);
    }
  }
  const keyringValue = this.keyringCache.get(keyringKey);
  if (keyringValue) return keyringValue;
}
```

5. Invalidate keyring cache on `reload()`:
```typescript
reload(): void {
  this.keyringCache.clear();
  // ... existing logic
}
```

**Acceptance criteria:**
- [ ] `getApiKey('anthropic')` reads from keyring before auth.json (when adapter is set)
- [ ] Keyring failure silently falls through to auth.json
- [ ] Second call for same provider uses cache (no D-Bus roundtrip)
- [ ] `reload()` clears the cache
- [ ] No keyring adapter = zero behavior change (all existing tests pass unchanged)

### Phase 3: Modify set() to write to keyring

**Files to modify:**
- `packages/pi-coding-agent/src/core/auth-storage.ts`

**Steps:**

1. In `set()`, after writing to auth.json, fire-and-forget write to keyring:
```typescript
set(provider: string, credential: AuthCredential): void {
  // ... existing auth.json logic ...

  // Write to keyring (best-effort, async fire-and-forget)
  if (this.keyringAdapter && credential.type === 'api_key') {
    const keyringKey = providerToKeyringKey(provider);
    this.keyringAdapter.storeCredential(keyringKey, credential.key)
      .then(() => {
        this.keyringCache.set(keyringKey, credential.key);
      })
      .catch((err) => {
        this.recordError(err);
      });
  }
}
```

Note: `set()` is sync. Keyring write is async. We fire-and-forget because:
- auth.json is the authoritative write (sync, reliable)
- keyring is best-effort (may fail on locked session, no D-Bus, etc.)
- Next `getApiKey()` will read from auth.json if keyring write failed

2. Invalidate keyring cache for the provider on `set()`:
```typescript
// Before the fire-and-forget write:
this.keyringCache.delete(providerToKeyringKey(provider));
```

**Acceptance criteria:**
- [ ] `set('anthropic', { type: 'api_key', key: 'sk-new' })` writes to both auth.json AND keyring
- [ ] Keyring write failure doesn't break `set()` — auth.json still written
- [ ] OAuth credentials are NOT written to keyring (only api_key type)

### Phase 4: One-time migration

**Files to create:**
- `packages/pi-coding-agent/src/core/keyring-migration.ts`

**Files to modify:**
- `packages/pi-coding-agent/src/main.ts`

**Steps:**

1. Create migration module:
```typescript
// keyring-migration.ts

import type { KeyringAdapter } from './keyring-adapter.js';
import type { AuthStorage } from './auth-storage.js';
import { getAgentDir } from '../config.js';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const MIGRATION_MARKER = '.keyring-migrated';

/**
 * One-time migration of API keys from auth.json and env to keyring.
 * Idempotent: writes a marker file after successful migration.
 * Non-destructive: keys remain in auth.json (user can manually remove later).
 */
export async function migrateToKeyring(
  authStorage: AuthStorage,
  keyring: KeyringAdapter,
): Promise<void> {
  const markerPath = join(getAgentDir(), MIGRATION_MARKER);
  if (existsSync(markerPath)) return;

  const migrated: string[] = [];

  // Migrate auth.json api_key credentials
  for (const provider of authStorage.list()) {
    const cred = authStorage.get(provider);
    if (cred?.type === 'api_key') {
      const keyringKey = providerToKeyringKey(provider);
      try {
        // Only migrate if not already in keyring
        const existing = await keyring.getCredential(keyringKey);
        if (!existing) {
          await keyring.storeCredential(keyringKey, cred.key);
          migrated.push(keyringKey);
        }
      } catch {
        // Best effort — don't fail the whole migration
      }
    }
  }

  // Migrate ANTHROPIC_API_KEY from env (if not already in keyring or auth.json)
  const envKey = process.env['ANTHROPIC_API_KEY'];
  if (envKey) {
    try {
      const existing = await keyring.getCredential('ANTHROPIC_API_KEY');
      if (!existing) {
        await keyring.storeCredential('ANTHROPIC_API_KEY', envKey);
        migrated.push('ANTHROPIC_API_KEY (from env)');
      }
    } catch {
      // Best effort
    }
  }

  // Write marker (even if some migrations failed — they'll be picked up
  // by normal set() flow on next login)
  try {
    writeFileSync(markerPath, JSON.stringify({
      migrated_at: new Date().toISOString(),
      keys: migrated,
    }), 'utf-8');
  } catch {
    // If we can't write the marker, migration will run again next time.
    // That's fine — storeCredential with replace=true is idempotent.
  }
}
```

2. Wire migration in `main.ts` after AuthStorage creation:
```typescript
// main.ts, after line 391 (authStorage creation):
const keyringAdapter = createKeyringAdapter();
if (keyringAdapter) {
  authStorage.setKeyringAdapter(keyringAdapter);
  // Fire-and-forget migration — don't block startup
  migrateToKeyring(authStorage, keyringAdapter).catch(() => {});
}
```

**Acceptance criteria:**
- [ ] First run: migrates auth.json keys + env key to keyring
- [ ] Second run: marker file exists, migration skipped (idempotent)
- [ ] Migration failure doesn't block startup
- [ ] Non-Linux: `createKeyringAdapter()` returns null, no migration runs

### Phase 5: Tests

**Files to create:**
- `packages/pi-coding-agent/src/core/keyring-adapter.test.ts`
- `packages/pi-coding-agent/src/core/keyring-migration.test.ts`

**Files to modify:**
- `packages/pi-coding-agent/src/core/auth-storage.test.ts`

**Steps:**

1. **keyring-adapter.test.ts**: Test `createKeyringAdapter()` returns null on non-Linux (mock `process.platform`). Test `LinuxKeyringAdapter` with a mock bus factory (same pattern as `packages/daemon/src/secret-service.test.ts`).

2. **keyring-migration.test.ts**: Test migration with `InMemoryKeyringAdapter`:
   - Migrates auth.json keys to keyring
   - Migrates env key to keyring
   - Writes marker file
   - Skips when marker exists
   - Doesn't overwrite existing keyring entries

3. **auth-storage.test.ts additions**:
   - Test keyring priority: keyring value returned before auth.json
   - Test keyring failure: falls through to auth.json
   - Test keyring caching: second call doesn't invoke adapter
   - Test `set()` writes to keyring
   - Test `set()` keyring failure doesn't break auth.json write

For testing, create an `InMemoryKeyringAdapter`:
```typescript
export class InMemoryKeyringAdapter implements KeyringAdapter {
  private store = new Map<string, string>();

  async getCredential(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async storeCredential(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }
}
```

**Acceptance criteria:**
- [ ] All existing tests pass (zero regressions)
- [ ] Keyring priority verified
- [ ] Keyring failure fallback verified
- [ ] Migration idempotency verified
- [ ] `set()` dual-write verified

## Complete File List

| Action | File |
|--------|------|
| CREATE | `packages/pi-coding-agent/src/core/keyring-adapter.ts` |
| CREATE | `packages/pi-coding-agent/src/core/keyring-adapter.test.ts` |
| CREATE | `packages/pi-coding-agent/src/core/keyring-migration.ts` |
| CREATE | `packages/pi-coding-agent/src/core/keyring-migration.test.ts` |
| MODIFY | `packages/pi-coding-agent/src/core/auth-storage.ts` |
| MODIFY | `packages/pi-coding-agent/src/core/auth-storage.test.ts` |
| MODIFY | `packages/pi-coding-agent/src/main.ts` |
| MODIFY | `packages/pi-coding-agent/package.json` |

## Risks and Considerations

1. **Shared keyring attributes**: Both daemon and pi use `{ service: 'gsd-daemon', key: 'ANTHROPIC_API_KEY' }`. If daemon changes its attribute format, pi breaks. Mitigation: document the contract, consider extracting attribute constants to a shared package later.

2. **D-Bus unavailable in headless/SSH**: `getCredential` returns null, falls through to auth.json. This is the correct behavior — keyring is a bonus, not a requirement.

3. **Keyring locked (screen locked)**: `SecretServiceAdapter` checks for locked items and returns null. Falls through to auth.json. Correct.

4. **dbus-next in pi-coding-agent increases bundle size**: `dbus-next` is ~300KB. Acceptable. It's already in the workspace root.

5. **fire-and-forget in set()**: The keyring write in `set()` is fire-and-forget because `set()` is sync. If the process exits immediately after `set()`, the keyring write may not complete. Mitigation: the migration will catch it on next run.

6. **Multiple pi instances**: Two pi instances calling `set()` simultaneously won't corrupt the keyring — `SecretServiceAdapter.storeCredential` uses `replace=true` (D-Bus `CreateItem` with replace flag).

7. **NOT removing keys from auth.json**: Migration is non-destructive. Users who want to clean up auth.json can do so manually. A future phase could add a `pi auth cleanup` command.

## Estimated Complexity

- Phase 1 (adapter): Small. Mostly copy from daemon. ~1 hour.
- Phase 2 (getApiKey): Medium. Core logic change, must be precise. ~1 hour.
- Phase 3 (set): Small. Fire-and-forget. ~30 min.
- Phase 4 (migration): Medium. Marker file, idempotency. ~1 hour.
- Phase 5 (tests): Medium. Mock adapters, test priority chain. ~2 hours.

Total: ~5-6 hours implementation time.
