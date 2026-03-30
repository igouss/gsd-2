/**
 * Manual integration test for D-Bus support.
 *
 * Tests three things against the live session bus:
 *   1. DBusEventBridge — plain notifications for session:started / completed / error
 *   2. DBusBlockerBridge — portal action-button notification + ActionInvoked → resolveBlocker
 *   3. SecretServiceAdapter — store and retrieve a credential from the keyring
 *
 * Usage:
 *   node dist/integration-test-dbus.js [--skip-keyring] [--test=<1|2|3>]
 *
 * Flags:
 *   --skip-keyring   Skip SecretService test (useful if no unlocked keyring)
 *   --test=N         Run only test N (1, 2, or 3)
 *
 * Expected results (visible in your notification area):
 *   Test 1: Three toast notifications — "started", "completed", "error"
 *   Test 2: One portal notification with [Yes]/[No] buttons — click one
 *            (uses org.freedesktop.portal.Notification / AddNotification)
 *   Test 3: Console output confirming credential round-trip
 *
 * Requirements for test 2:
 *   - A ~/.local/share/applications/gsd-daemon.desktop file must exist with
 *     DBusActivatable=true. Run `gsd-daemon install` first, or create manually:
 *       [Desktop Entry]
 *       Type=Application
 *       Name=GSD Daemon
 *       Exec=/bin/true
 *       NoDisplay=true
 *       DBusActivatable=true
 *       X-DBus-AppId=gsd-daemon
 *   - The daemon must NOT be running as gsd-daemon.service (name conflict).
 *     Run: systemctl --user stop gsd-daemon.service
 *
 * Architecture: DBusBlockerBridge registers as "gsd-daemon" via
 * GApplicationService so GNOME calls ActivateAction('app.resolve-blocker',
 * [Variant('s', 'sessionId:response')], {}) when a button is clicked.
 * No ActionInvoked signal — response routing is stateless via button targets.
 */

import { EventEmitter } from 'node:events';
import { DBusEventBridge } from './dbus-bridge.js';
import { DBusBlockerBridge } from './dbus-bridge-blocker.js';
import { SecretServiceAdapter } from './secret-service.js';
import type { Logger } from './logger.js';
import type { SessionManager } from './session-manager.js';
import type { PendingBlocker } from './types.js';

// ---------------------------------------------------------------------------
// Minimal stubs
// ---------------------------------------------------------------------------

function makeLogger(prefix: string): Logger {
  return {
    info: (msg: string, ctx?: unknown) => console.log(`[${prefix}] INFO  ${msg}`, ctx ?? ''),
    warn: (msg: string, ctx?: unknown) => console.warn(`[${prefix}] WARN  ${msg}`, ctx ?? ''),
    error: (msg: string, ctx?: unknown) => console.error(`[${prefix}] ERROR ${msg}`, ctx ?? ''),
    debug: (msg: string, ctx?: unknown) => console.debug(`[${prefix}] DEBUG ${msg}`, ctx ?? ''),
    close: async () => {},
  } as unknown as Logger;
}

class FakeSessionManager extends EventEmitter {
  private blockerResolvedWith: string | null = null;

  async resolveBlocker(sessionId: string, response: string): Promise<void> {
    this.blockerResolvedWith = response;
    console.log(`\n  ✅  resolveBlocker called — sessionId=${sessionId} response=${response}\n`);
  }

  getLastResolvedResponse(): string | null {
    return this.blockerResolvedWith;
  }

  // Unused SessionManager methods — satisfy interface structurally
  getAllSessions() { return []; }
  getSession(_id: string) { return undefined; }
  async cleanup() {}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function parseArgs(): { skipKeyring: boolean; only: number | null } {
  const args = process.argv.slice(2);
  const skipKeyring = args.includes('--skip-keyring');
  const testArg = args.find((a) => a.startsWith('--test='));
  const only = testArg ? parseInt(testArg.split('=')[1], 10) : null;
  return { skipKeyring, only };
}

// ---------------------------------------------------------------------------
// Test 1 — plain notifications via DBusEventBridge
// ---------------------------------------------------------------------------

async function test1PlainNotifications(): Promise<void> {
  console.log('\n━━━ Test 1: Plain notifications (DBusEventBridge) ━━━');
  const logger = makeLogger('T1');
  const sm = new FakeSessionManager();
  const bridge = new DBusEventBridge({
    sessionManager: sm as unknown as SessionManager,
    logger,
  });

  await bridge.start();

  if (!bridge.isConnected) {
    console.error('  ❌  Bridge not connected — D-Bus unavailable?');
    return;
  }
  console.log('  ✅  Bridge connected');

  const base = { sessionId: 'test-1', projectDir: '/tmp/test', projectName: 'gsd-dbus-test' };

  console.log('  → Emitting session:started ...');
  sm.emit('session:started', base);
  await sleep(300);

  console.log('  → Emitting session:completed ...');
  sm.emit('session:completed', base);
  await sleep(300);

  console.log('  → Emitting session:error ...');
  sm.emit('session:error', { ...base, error: 'integration test error message' });
  await sleep(300);

  await bridge.stop();
  console.log('  ✅  Bridge stopped. Check your notification area for 3 toasts.');
}

// ---------------------------------------------------------------------------
// Test 2 — action-button blocker notification via DBusBlockerBridge
// ---------------------------------------------------------------------------

async function test2BlockerNotification(): Promise<void> {
  console.log('\n━━━ Test 2: Blocker notification with actions (DBusBlockerBridge) ━━━');
  const logger = makeLogger('T2');
  const sm = new FakeSessionManager();
  const bridge = new DBusBlockerBridge({
    sessionManager: sm as unknown as SessionManager,
    logger,
  });

  await bridge.start();

  if (!bridge.isConnected) {
    console.error('  ❌  Bridge not connected — D-Bus unavailable?');
    return;
  }
  console.log('  ✅  Bridge connected');

  const blocker: PendingBlocker = {
    id: 'blocker-1',
    method: 'confirm',
    message: 'Integration test: should the daemon proceed? (click Yes or No)',
    event: { type: 'extension_ui_request', id: 'blocker-1', method: 'confirm', title: 'GSD Test', message: 'Integration test: should the daemon proceed?' },
  };

  const payload = {
    sessionId: 'test-2',
    projectDir: '/tmp/test',
    projectName: 'gsd-dbus-test',
    blocker,
  };

  console.log('  → Emitting session:blocked (confirm) ...');
  console.log('     Uses org.freedesktop.portal.Notification / AddNotification.');
  console.log('     Watch for a portal notification with [Yes] / [No] buttons.');
  console.log('     Waiting up to 15s for you to click a button...');
  sm.emit('session:blocked', payload);

  // Wait for ActionInvoked to fire — up to 15s
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    if (sm.getLastResolvedResponse() !== null) break;
  }

  const resp = sm.getLastResolvedResponse();
  if (resp !== null) {
    console.log(`  ✅  ActionInvoked received and resolved with: "${resp}"`);
  } else {
    console.log('  ⚠️   No button clicked within 15s — continuing without resolution.');
  }

  // Also test a select-style blocker
  console.log('\n  → Emitting session:blocked (select) ...');
  const selectBlocker: PendingBlocker = {
    id: 'blocker-2',
    method: 'select',
    message: 'Pick a test option:',
    event: { type: 'extension_ui_request', id: 'blocker-2', method: 'select', title: 'Pick one', options: ['Option A', 'Option B', 'Option C'] },
  };
  sm.emit('session:blocked', { ...payload, sessionId: 'test-2b', blocker: selectBlocker });
  await sleep(2000); // brief window — don't wait long for this one

  await bridge.stop();
  console.log('  ✅  Bridge stopped.');
}

// ---------------------------------------------------------------------------
// Test 3 — SecretServiceAdapter round-trip
// ---------------------------------------------------------------------------

async function test3SecretService(): Promise<void> {
  console.log('\n━━━ Test 3: SecretService credential round-trip ━━━');

  const adapter = new SecretServiceAdapter();
  const testKey = 'GSD_INTEGRATION_TEST_KEY';
  const testValue = `test-value-${Date.now()}`;

  console.log(`  → Storing credential: ${testKey}=${testValue}`);
  try {
    await adapter.storeCredential(testKey, testValue);
    console.log('  ✅  storeCredential succeeded');
  } catch (err) {
    console.error('  ❌  storeCredential failed:', err instanceof Error ? err.message : err);
    console.log('     If you see "No such interface", your keyring daemon may be locked or absent.');
    return;
  }

  console.log(`  → Retrieving credential: ${testKey}`);
  const retrieved = await adapter.getCredential(testKey);

  if (retrieved === testValue) {
    console.log(`  ✅  getCredential returned correct value: "${retrieved}"`);
  } else if (retrieved === null) {
    console.log('  ❌  getCredential returned null — item may be locked or in wrong collection');
  } else {
    console.log(`  ❌  getCredential returned unexpected value: "${retrieved}" (expected "${testValue}")`);
  }

  // Clean-up note — we can't delete via our adapter, leave it
  console.log(`  ℹ️   Test credential "${testKey}" left in keyring. Remove manually if desired.`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { skipKeyring, only } = parseArgs();

  console.log('GSD D-Bus Integration Test');
  console.log(`DBUS_SESSION_BUS_ADDRESS = ${process.env.DBUS_SESSION_BUS_ADDRESS ?? '(not set)'}`);
  console.log(`Platform                  = ${process.platform}`);
  console.log('');

  if (!process.env.DBUS_SESSION_BUS_ADDRESS) {
    console.error('ERROR: DBUS_SESSION_BUS_ADDRESS is not set. Run this in a desktop session.');
    process.exit(1);
  }

  const run = (n: number) => only === null || only === n;

  if (run(1)) await test1PlainNotifications();
  if (run(2)) await test2BlockerNotification();
  if (run(3) && !skipKeyring) await test3SecretService();
  if (run(3) && skipKeyring) console.log('\n━━━ Test 3: Skipped (--skip-keyring) ━━━');

  console.log('\n━━━ Done ━━━\n');
}

main().catch((err) => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
