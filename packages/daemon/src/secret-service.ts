/**
 * SecretServiceAdapter — stores and retrieves credentials from
 * org.freedesktop.secrets (GNOME Keyring / KDE Wallet) via dbus-next.
 *
 * Design constraints:
 * - getCredential MUST return null on ANY failure — never throw.
 * - storeCredential MAY throw — the CLI caller handles it.
 * - Both methods race against a 2000 ms timeout.
 * - bus.disconnect() always runs in finally to avoid ERR_STREAM_WRITE_AFTER_END.
 * - Locked items are not unlocked (would prompt the user on startup) — return null.
 */

import dbus from 'dbus-next';
import type { MessageBus } from 'dbus-next';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Factory function that returns a connected MessageBus. Injectable for testing. */
export type BusFactory = () => MessageBus;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SERVICE_NAME_DBUS = 'org.freedesktop.secrets';
const SERVICE_PATH = '/org/freedesktop/secrets';
const SERVICE_IFACE = 'org.freedesktop.Secret.Service';
const DEFAULT_COLLECTION_PATH = '/org/freedesktop/secrets/aliases/default';
const CREDENTIAL_SERVICE_ATTR = 'gsd-daemon';
const TIMEOUT_MS = 2000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns a Promise that rejects with a timeout error after `ms` milliseconds. */
function makeTimeout(ms: number): Promise<never> {
  return new Promise<never>((_, reject) => {
    const t = setTimeout(() => reject(new Error(`dbus operation timed out after ${ms}ms`)), ms);
    t.unref();
  });
}

/** Default bus factory using the real session bus. */
const defaultBusFactory: BusFactory = () => dbus.sessionBus();

// ---------------------------------------------------------------------------
// SecretServiceAdapter
// ---------------------------------------------------------------------------

export class SecretServiceAdapter {
  private readonly _busFactory: BusFactory;

  /**
   * @param busFactory - Injectable factory for obtaining a MessageBus. Defaults
   *   to dbus.sessionBus(). Override in tests to avoid real D-Bus connections.
   */
  constructor(busFactory: BusFactory = defaultBusFactory) {
    this._busFactory = busFactory;
  }

  /**
   * Store a credential in the default Secret Service collection.
   *
   * Creates or replaces an item with attributes:
   *   { service: 'gsd-daemon', key: '<key>' }
   *
   * The secret value is stored with 'text/plain; charset=utf-8' content type.
   *
   * @throws if D-Bus is unavailable, the collection is locked, or the
   *         operation times out.
   */
  async storeCredential(key: string, value: string): Promise<void> {
    await Promise.race([this._storeCredential(key, value), makeTimeout(TIMEOUT_MS)]);
  }

  private async _storeCredential(key: string, value: string): Promise<void> {
    const bus = this._busFactory();
    try {
      const obj = await bus.getProxyObject(SERVICE_NAME_DBUS, SERVICE_PATH);
      const svc = obj.getInterface(SERVICE_IFACE);

      // OpenSession with 'plain' algorithm (no encryption needed for local use).
      // Returns: [variant output, object path sessionPath]
      const openResult = await (svc['OpenSession'] as Function)(
        'plain',
        new dbus.Variant('s', ''),
      );
      const sessionPath: string = openResult[1];

      // Get the default collection proxy.
      const collObj = await bus.getProxyObject(SERVICE_NAME_DBUS, DEFAULT_COLLECTION_PATH);
      const coll = collObj.getInterface('org.freedesktop.Secret.Collection');

      // Secret tuple: [session_path, parameters, value_bytes, content_type]
      const secret = [
        sessionPath,
        Buffer.alloc(0), // no parameters for 'plain'
        Buffer.from(value, 'utf-8'),
        'text/plain; charset=utf-8',
      ];

      const properties: Record<string, dbus.Variant> = {
        'org.freedesktop.Secret.Item.Label': new dbus.Variant('s', `gsd-daemon:${key}`),
        'org.freedesktop.Secret.Item.Attributes': new dbus.Variant('a{ss}', {
          service: CREDENTIAL_SERVICE_ATTR,
          key,
        }),
      };

      // CreateItem(properties, secret, replace) → (item_path, prompt_path)
      await (coll['CreateItem'] as Function)(properties, secret, true);
    } finally {
      bus.disconnect();
    }
  }

  /**
   * Retrieve a credential from the default Secret Service collection.
   *
   * Searches for an item with attributes { service: 'gsd-daemon', key: '<key>' },
   * then calls GetSecrets on the first match.
   *
   * Returns null on ANY failure — D-Bus unavailable, item not found, item
   * locked, timeout, or any unexpected error.
   */
  async getCredential(key: string): Promise<string | null> {
    try {
      return await Promise.race([this._getCredential(key), makeTimeout(TIMEOUT_MS)]);
    } catch {
      return null;
    }
  }

  private async _getCredential(key: string): Promise<string | null> {
    const bus = this._busFactory();
    try {
      const obj = await bus.getProxyObject(SERVICE_NAME_DBUS, SERVICE_PATH);
      const svc = obj.getInterface(SERVICE_IFACE);

      // OpenSession → get a session path for GetSecrets calls.
      const openResult = await (svc['OpenSession'] as Function)(
        'plain',
        new dbus.Variant('s', ''),
      );
      const sessionPath: string = openResult[1];

      // SearchItems(attributes) → [unlocked_items, locked_items]
      const searchResult = await (svc['SearchItems'] as Function)({
        service: CREDENTIAL_SERVICE_ATTR,
        key,
      });
      const unlockedItems: string[] = searchResult[0];
      const lockedItems: string[] = searchResult[1];

      if (unlockedItems.length === 0) {
        // Item exists but locked — don't prompt user. Or not found. Either way: null.
        void lockedItems; // intentional no-op
        return null;
      }

      const itemPath = unlockedItems[0];

      // GetSecrets([item_paths], session_path) → dict { item_path: secret_tuple }
      const secretsResult = await (svc['GetSecrets'] as Function)([itemPath], sessionPath);

      const secretTuple = secretsResult[itemPath];
      if (!secretTuple) {
        return null;
      }

      // Secret tuple: [session_path, parameters, value_bytes, content_type]
      const valueBytes: Buffer | Uint8Array = secretTuple[2];
      if (!valueBytes) {
        return null;
      }

      return Buffer.from(valueBytes).toString('utf-8');
    } finally {
      bus.disconnect();
    }
  }
}
