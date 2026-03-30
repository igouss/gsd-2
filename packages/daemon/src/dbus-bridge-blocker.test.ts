/**
 * Tests for DBusBlockerBridge.
 *
 * Architecture change (vs old ActionInvoked design):
 * - Buttons now carry a "target" encoding "sessionId:response" — no pendingBlockerMap.
 * - Response routing goes through GApplicationService.onActivateAction() instead of
 *   the portal's ActionInvoked signal.
 * - MockGApplicationService captures the onActivateAction handler and exposes
 *   triggerActivateAction() for tests to invoke.
 *
 * Portal button shape:
 *   { label: 'Yes', action: 'app.resolve-blocker', target: 'sess-1:true' }
 *
 * MockNotifyIface.AddNotification unwraps the outer Variant layers so test
 * assertions compare plain strings, not Variant objects.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import dbus from 'dbus-next';
const { Variant } = dbus;
import { DBusBlockerBridge } from './dbus-bridge-blocker.js';
import type { DBusEventBridgeOptions, BusFactory } from './dbus-bridge.js';
import type { MessageBus, ProxyObject, ClientInterface } from 'dbus-next';
import type { IGApplicationService } from './gapplication-service.js';
import type { SessionManager } from './session-manager.js';
import type { Logger } from './logger.js';

// ---------------------------------------------------------------------------
// Logger stub
// ---------------------------------------------------------------------------

interface LogCall {
  level: 'info' | 'warn' | 'error' | 'debug';
  msg: string;
  data?: Record<string, unknown>;
}

function makeLogger() {
  const calls: LogCall[] = [];
  return {
    calls,
    debug(msg: string, data?: Record<string, unknown>) { calls.push({ level: 'debug', msg, data }); },
    info(msg: string, data?: Record<string, unknown>)  { calls.push({ level: 'info',  msg, data }); },
    warn(msg: string, data?: Record<string, unknown>)  { calls.push({ level: 'warn',  msg, data }); },
    error(msg: string, data?: Record<string, unknown>) { calls.push({ level: 'error', msg, data }); },
  };
}

// ---------------------------------------------------------------------------
// SessionManager stub
// ---------------------------------------------------------------------------

function makeSessionManager() {
  const ee = new EventEmitter();
  let resolveBlockerImpl: (sessionId: string, value: string) => Promise<void> = async () => {};
  (ee as unknown as Record<string, unknown>).resolveBlocker = (sessionId: string, value: string) =>
    resolveBlockerImpl(sessionId, value);
  return {
    sm: ee as unknown as SessionManager,
    setResolveBlocker: (fn: typeof resolveBlockerImpl) => {
      resolveBlockerImpl = fn;
    },
  };
}

// ---------------------------------------------------------------------------
// MockGApplicationService
//
// Replaces GApplicationService for tests. Captures the onActivateAction
// handler and exposes triggerActivateAction() so tests can simulate button
// clicks without a real D-Bus bus.
// ---------------------------------------------------------------------------

export class MockGApplicationService implements IGApplicationService {
  private _handler: ((action: string, params: unknown[]) => void) | null = null;
  startCalled = false;
  stopCalled = false;

  async start(_bus: MessageBus): Promise<void> {
    this.startCalled = true;
  }

  async stop(): Promise<void> {
    this.stopCalled = true;
    this._handler = null;
  }

  onActivateAction(handler: (action: string, params: unknown[]) => void): void {
    this._handler = handler;
  }

  /** Test helper — simulate GNOME calling ActivateAction with these params */
  triggerActivateAction(action: string, params: unknown[]): void {
    this._handler?.(action, params);
  }
}

// ---------------------------------------------------------------------------
// MockNotifyIface — portal AddNotification (NOT org.freedesktop.Notifications)
//
// Unwraps Variant layers for button assertions so tests compare plain strings.
// ---------------------------------------------------------------------------

interface AddNotifCall {
  id: string;
  title: string;
  body: string;
  buttons: Array<{ label: string; action: string; target?: string }>;
}

class MockNotifyIface extends EventEmitter {
  notifyCalls: AddNotifCall[] = [];

  async AddNotification(id: string, notification: Record<string, InstanceType<typeof Variant>>): Promise<void> {
    const titleV = notification['title'];
    const bodyV = notification['body'];
    const buttonsV = notification['buttons'];

    const buttons: Array<{ label: string; action: string; target?: string }> = [];
    if (buttonsV?.value) {
      for (const btn of buttonsV.value as Array<Record<string, InstanceType<typeof Variant>>>) {
        const labelStr  = btn['label']?.value as string ?? '';
        const actionStr = btn['action']?.value as string ?? '';
        // target is Variant('v', Variant('s', rawStr)) — unwrap two layers
        let targetStr: string | undefined;
        const outerTarget = btn['target'];
        if (outerTarget?.value) {
          // outerTarget.value is Variant('s', rawStr)
          const inner = outerTarget.value as InstanceType<typeof Variant>;
          targetStr = inner?.value as string ?? String(inner ?? '');
        }
        buttons.push({ label: labelStr, action: actionStr, ...(targetStr !== undefined ? { target: targetStr } : {}) });
      }
    }

    this.notifyCalls.push({
      id,
      title: titleV?.value as string ?? '',
      body: bodyV?.value as string ?? '',
      buttons,
    });
  }
}

// ---------------------------------------------------------------------------
// Mock bus helpers
// ---------------------------------------------------------------------------

function makeBus(
  notifyIface: MockNotifyIface,
): MessageBus & { _disconnected: () => boolean } {
  let disconnected = false;
  const methodHandlers: Set<Function> = new Set();

  const bus: Partial<MessageBus> = {
    getProxyObject: async (_name: string, _path: string): Promise<ProxyObject> => {
      return {
        getInterface: (_iface: string): ClientInterface => {
          return notifyIface as unknown as ClientInterface;
        },
      } as unknown as ProxyObject;
    },
    disconnect: () => { disconnected = true; },
    requestName: async () => dbus.RequestNameReply.PRIMARY_OWNER,
    releaseName: async () => 0,
    addMethodHandler: (h: Function) => { methodHandlers.add(h); },
    removeMethodHandler: (h: Function) => { methodHandlers.delete(h); },
  };

  (bus as Record<string, unknown>)._disconnected = () => disconnected;
  return bus as unknown as MessageBus & { _disconnected: () => boolean };
}

function makeBusFactory(): {
  factory: BusFactory;
  notifyIface: MockNotifyIface;
  bus: ReturnType<typeof makeBus>;
} {
  const notifyIface = new MockNotifyIface();
  const bus = makeBus(notifyIface);
  return { factory: () => bus as unknown as MessageBus, notifyIface, bus };
}

function throwingBusFactory(): BusFactory {
  return () => { throw new Error('Failed to connect to D-Bus'); };
}

// ---------------------------------------------------------------------------
// No-op base-class bus factory
// ---------------------------------------------------------------------------

function makeNoopBusFactory(): BusFactory {
  return () => {
    const bus: Partial<MessageBus> = {
      getProxyObject: async () => ({
        getInterface: () => ({
          Notify: async () => 1,
          on: () => undefined,
          off: () => undefined,
        } as unknown as ClientInterface),
      } as unknown as ProxyObject),
      disconnect: () => undefined,
    };
    return bus as unknown as MessageBus;
  };
}

// ---------------------------------------------------------------------------
// MockGApplicationService factory — injects mock into DBusBlockerBridge
//
// DBusBlockerBridge is tested here with GApplicationService replaced.
// We expose the mock via a factory pattern by monkey-patching the module.
// The cleanest approach: subclass DBusBlockerBridge in tests to inject mock.
// ---------------------------------------------------------------------------

/**
 * TestableDBusBlockerBridge — subclass that injects a MockGApplicationService
 * so tests can trigger ActivateAction without real D-Bus.
 */
class TestableDBusBlockerBridge extends DBusBlockerBridge {
  readonly mockGapp: MockGApplicationService;

  constructor(opts: DBusEventBridgeOptions & { portalBusFactory?: BusFactory }) {
    super(opts);
    this.mockGapp = new MockGApplicationService();
  }

  // Override createGApplicationService so DBusBlockerBridge.start() uses the mock
  protected createGApplicationService(): IGApplicationService {
    return this.mockGapp;
  }
}

// ---------------------------------------------------------------------------
// Bridge builder
// ---------------------------------------------------------------------------

function makeBridge(
  portalBusFactory: BusFactory,
  opts: { baseBusFactory?: BusFactory } = {},
): {
  bridge: TestableDBusBlockerBridge;
  sm: SessionManager;
  setSm: (fn: (sessionId: string, value: string) => Promise<void>) => void;
  logger: ReturnType<typeof makeLogger>;
} {
  const { sm, setResolveBlocker } = makeSessionManager();
  const logger = makeLogger();

  const bridge = new TestableDBusBlockerBridge({
    sessionManager: sm,
    logger: logger as unknown as Logger,
    busFactory: opts.baseBusFactory ?? makeNoopBusFactory(),
    portalBusFactory,
  } as unknown as DBusEventBridgeOptions & { portalBusFactory?: BusFactory });

  return { bridge, sm, setSm: setResolveBlocker, logger };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emitBlocked(
  sm: SessionManager,
  opts: {
    sessionId?: string;
    projectName?: string;
    method?: string;
    message?: string;
    event?: unknown;
  } = {},
): void {
  (sm as unknown as EventEmitter).emit('session:blocked', {
    sessionId: opts.sessionId ?? 'sess-1',
    projectDir: '/home/user/Proj',
    projectName: opts.projectName ?? 'Proj',
    blocker: {
      id: 'blocker-1',
      method: opts.method ?? 'confirm',
      message: opts.message ?? 'Should I proceed?',
      event: opts.event ?? {},
    },
  });
}

function flush(): Promise<void> {
  return new Promise<void>(resolve => setImmediate(resolve));
}

// ---------------------------------------------------------------------------
// Test 1: start() when portal bus fails — isPortalConnected false
// ---------------------------------------------------------------------------

describe('DBusBlockerBridge.start() — no bus', () => {
  it('no throw when portal bus fails, isPortalConnected=false', async () => {
    const { bridge } = makeBridge(throwingBusFactory());
    await assert.doesNotReject(() => bridge.start());
    assert.equal(bridge.isPortalConnected, false);
  });

  it('GApplicationService.start() NOT called when portal unavailable', async () => {
    const { bridge } = makeBridge(throwingBusFactory());
    await bridge.start();
    assert.equal(bridge.mockGapp.startCalled, false);
  });
});

// ---------------------------------------------------------------------------
// Test 2: start() happy path — GApplicationService.start() called
// ---------------------------------------------------------------------------

describe('DBusBlockerBridge.start() — happy path', () => {
  it('calls GApplicationService.start() with portal bus after successful start()', async () => {
    const { factory } = makeBusFactory();
    const { bridge } = makeBridge(factory);

    await bridge.start();

    assert.equal(bridge.mockGapp.startCalled, true, 'GApplicationService.start() must be called');
    assert.equal(bridge.isPortalConnected, true);
  });
});

// ---------------------------------------------------------------------------
// Test 3: session:blocked with method='confirm'
// ---------------------------------------------------------------------------

describe('session:blocked with method=confirm', () => {
  it('calls AddNotification with buttons=[Yes/true, No/false] and target encoding (R006, R007)', async () => {
    const { factory, notifyIface } = makeBusFactory();
    const { bridge, sm } = makeBridge(factory);

    await bridge.start();
    emitBlocked(sm, { sessionId: 'sess-1', method: 'confirm', projectName: 'MyProj', message: 'Are you sure?' });
    await flush();

    assert.equal(notifyIface.notifyCalls.length, 1);
    const call = notifyIface.notifyCalls[0];
    assert.equal(call.title, 'GSD: MyProj — Blocked');
    assert.equal(call.body, 'Are you sure?');
    assert.deepEqual(call.buttons, [
      { label: 'Yes', action: 'app.resolve-blocker', target: 'sess-1:true' },
      { label: 'No',  action: 'app.resolve-blocker', target: 'sess-1:false' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Test 4: session:blocked with method='select', 3 options
// ---------------------------------------------------------------------------

describe('session:blocked with method=select (3 options)', () => {
  it('calls AddNotification with one button per option, targets encode index (R007)', async () => {
    const { factory, notifyIface } = makeBusFactory();
    const { bridge, sm } = makeBridge(factory);

    await bridge.start();
    emitBlocked(sm, {
      sessionId: 'sess-2',
      method: 'select',
      event: { options: ['Alpha', 'Beta', 'Gamma'] },
    });
    await flush();

    assert.equal(notifyIface.notifyCalls.length, 1);
    const call = notifyIface.notifyCalls[0];
    assert.deepEqual(call.buttons, [
      { label: 'Alpha', action: 'app.resolve-blocker', target: 'sess-2:0' },
      { label: 'Beta',  action: 'app.resolve-blocker', target: 'sess-2:1' },
      { label: 'Gamma', action: 'app.resolve-blocker', target: 'sess-2:2' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Test 5: session:blocked with method='select', 0 options
// ---------------------------------------------------------------------------

describe('session:blocked with method=select (0 options)', () => {
  it('calls AddNotification with empty buttons when no options provided', async () => {
    const { factory, notifyIface } = makeBusFactory();
    const { bridge, sm } = makeBridge(factory);

    await bridge.start();
    emitBlocked(sm, { method: 'select', event: { options: [] } });
    await flush();

    assert.equal(notifyIface.notifyCalls.length, 1);
    assert.deepEqual(notifyIface.notifyCalls[0].buttons, []);
  });
});

// ---------------------------------------------------------------------------
// Test 6: ActivateAction 'app.resolve-blocker' → resolveBlocker called (R006)
// ---------------------------------------------------------------------------

describe('ActivateAction — app.resolve-blocker (R006)', () => {
  it('calls resolveBlocker with sessionId and response extracted from target', async () => {
    const { factory } = makeBusFactory();
    const { bridge, sm, setSm } = makeBridge(factory);

    const resolveCalls: Array<{ sessionId: string; value: string }> = [];
    setSm(async (sessionId, value) => { resolveCalls.push({ sessionId, value }); });

    await bridge.start();
    emitBlocked(sm, { sessionId: 'sess-42', method: 'confirm' });
    await flush();

    // Simulate GNOME calling ActivateAction with encoded target
    bridge.mockGapp.triggerActivateAction(
      'app.resolve-blocker',
      [new Variant('s', 'sess-42:true')],
    );
    await flush();

    assert.equal(resolveCalls.length, 1);
    assert.equal(resolveCalls[0].sessionId, 'sess-42');
    assert.equal(resolveCalls[0].value, 'true');
  });

  it('handles plain string params (not wrapped in Variant)', async () => {
    const { factory } = makeBusFactory();
    const { bridge, sm, setSm } = makeBridge(factory);

    const resolveCalls: Array<{ sessionId: string; value: string }> = [];
    setSm(async (sessionId, value) => { resolveCalls.push({ sessionId, value }); });

    await bridge.start();
    emitBlocked(sm, { sessionId: 'sess-10', method: 'confirm' });
    await flush();

    bridge.mockGapp.triggerActivateAction('app.resolve-blocker', ['sess-10:false']);
    await flush();

    assert.equal(resolveCalls.length, 1);
    assert.equal(resolveCalls[0].sessionId, 'sess-10');
    assert.equal(resolveCalls[0].value, 'false');
  });
});

// ---------------------------------------------------------------------------
// Test 7: ActivateAction with unknown action name → resolveBlocker NOT called
// ---------------------------------------------------------------------------

describe('ActivateAction — unknown action name', () => {
  it('does NOT call resolveBlocker for unrecognised action names', async () => {
    const { factory } = makeBusFactory();
    const { bridge, setSm } = makeBridge(factory);

    let resolveCalled = false;
    setSm(async () => { resolveCalled = true; });

    await bridge.start();

    bridge.mockGapp.triggerActivateAction('app.some-other-action', [new Variant('s', 'sess-1:true')]);
    await flush();

    assert.equal(resolveCalled, false);
  });
});

// ---------------------------------------------------------------------------
// Test 8: malformed target → warn logged, no resolveBlocker
// ---------------------------------------------------------------------------

describe('ActivateAction — malformed target', () => {
  it('logs warn for malformed target (no colon separator)', async () => {
    const { factory } = makeBusFactory();
    const { bridge, setSm, logger } = makeBridge(factory);

    let resolveCalled = false;
    setSm(async () => { resolveCalled = true; });

    await bridge.start();

    bridge.mockGapp.triggerActivateAction('app.resolve-blocker', [new Variant('s', 'noseparator')]);
    await flush();

    assert.equal(resolveCalled, false);
    const warnCalls = logger.calls.filter(c => c.level === 'warn' && c.msg === 'dbus blocker: malformed ActivateAction target');
    assert.equal(warnCalls.length, 1);
  });
});

// ---------------------------------------------------------------------------
// Test 9: stale click → "No pending blocker" silently swallowed (R008)
// ---------------------------------------------------------------------------

describe('ActivateAction — stale click (R008)', () => {
  it('silently swallows "No pending blocker" without logging warn', async () => {
    const { factory } = makeBusFactory();
    const { bridge, setSm, logger } = makeBridge(factory);

    setSm(async () => { throw new Error('No pending blocker for session sess-1'); });

    await bridge.start();

    bridge.mockGapp.triggerActivateAction('app.resolve-blocker', [new Variant('s', 'sess-1:true')]);
    await flush();

    const warnCalls = logger.calls.filter(c => c.level === 'warn' && c.msg === 'dbus blocker resolve failed');
    assert.equal(warnCalls.length, 0, 'No warn for stale click');
  });
});

// ---------------------------------------------------------------------------
// Test 10: unexpected resolveBlocker error → warn logged
// ---------------------------------------------------------------------------

describe('ActivateAction — unexpected resolve error', () => {
  it('logs warn for unexpected resolveBlocker errors', async () => {
    const { factory } = makeBusFactory();
    const { bridge, setSm, logger } = makeBridge(factory);

    setSm(async () => { throw new Error('database connection lost'); });

    await bridge.start();

    bridge.mockGapp.triggerActivateAction('app.resolve-blocker', [new Variant('s', 'sess-2:true')]);
    await flush();

    const warnCalls = logger.calls.filter(c => c.level === 'warn' && c.msg === 'dbus blocker resolve failed');
    assert.equal(warnCalls.length, 1);
    assert.equal(warnCalls[0].data?.error, 'database connection lost');
  });
});

// ---------------------------------------------------------------------------
// Test 11: stop() calls GApplicationService.stop() and disconnects portal bus
// ---------------------------------------------------------------------------

describe('DBusBlockerBridge.stop()', () => {
  it('stops GApplicationService, disconnects portal bus, reports not connected', async () => {
    const { factory, bus } = makeBusFactory();
    const { bridge, setSm } = makeBridge(factory);

    let resolveCalled = false;
    setSm(async () => { resolveCalled = true; });

    await bridge.start();
    assert.equal(bridge.mockGapp.startCalled, true);

    await bridge.stop();
    assert.equal(bridge.mockGapp.stopCalled, true, 'GApplicationService.stop() called');
    assert.equal(bus._disconnected(), true, 'portal bus.disconnect() called');
    assert.equal(bridge.isConnected, false);

    // Trigger after stop — must be ignored
    bridge.mockGapp.triggerActivateAction('app.resolve-blocker', ['sess-1:true']);
    await flush();
    assert.equal(resolveCalled, false);
  });
});

// ---------------------------------------------------------------------------
// Test 12: stop() before start() → no throw
// ---------------------------------------------------------------------------

describe('stop() before start()', () => {
  it('does not throw when stop() called without prior start()', async () => {
    const { factory } = makeBusFactory();
    const { bridge } = makeBridge(factory);
    await assert.doesNotReject(() => bridge.stop());
  });
});

// ---------------------------------------------------------------------------
// Test 13: select blocker — sessionId with colon in it (edge case)
// ---------------------------------------------------------------------------

describe('ActivateAction — sessionId containing colons', () => {
  it('uses lastIndexOf so colons in sessionId are handled correctly', async () => {
    const { factory } = makeBusFactory();
    const { bridge, setSm } = makeBridge(factory);

    const resolveCalls: Array<{ sessionId: string; value: string }> = [];
    setSm(async (sessionId, value) => { resolveCalls.push({ sessionId, value }); });

    await bridge.start();

    // Session ID with colons — only the last colon is the separator
    bridge.mockGapp.triggerActivateAction(
      'app.resolve-blocker',
      [new Variant('s', 'proj:sess:42:true')],
    );
    await flush();

    assert.equal(resolveCalls.length, 1);
    assert.equal(resolveCalls[0].sessionId, 'proj:sess:42');
    assert.equal(resolveCalls[0].value, 'true');
  });
});
