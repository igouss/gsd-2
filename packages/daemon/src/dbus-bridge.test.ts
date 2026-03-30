/**
 * Tests for DBusEventBridge.
 *
 * All tests use a mock BusFactory injected via the constructor — no real D-Bus
 * connection is ever attempted.
 *
 * Mock targets org.freedesktop.Notifications (Notify API) — the interface used
 * by the base bridge for plain toasts.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { DBusEventBridge } from './dbus-bridge.js';
import type { DBusEventBridgeOptions, BusFactory } from './dbus-bridge.js';
import type { MessageBus, ProxyObject, ClientInterface } from 'dbus-next';
import type { SessionManager } from './session-manager.js';

// ---------------------------------------------------------------------------
// Minimal Logger stub
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

function makeSessionManager(): SessionManager {
  return new EventEmitter() as unknown as SessionManager;
}

// ---------------------------------------------------------------------------
// Mock helpers — NotifyIface (org.freedesktop.Notifications)
// ---------------------------------------------------------------------------

interface NotifyCall {
  appName: string;
  replacesId: number;
  icon: string;
  summary: string;
  body: string;
  actions: string[];
  hints: Record<string, unknown>;
  expireTimeout: number;
}

function makeNotifyIface(
  overrides: Partial<{
    Notify: (...args: unknown[]) => Promise<number>;
  }> = {},
): ClientInterface & { _calls: NotifyCall[] } {
  const _calls: NotifyCall[] = [];

  const defaults = {
    Notify: async (
      appName: string,
      replacesId: number,
      icon: string,
      summary: string,
      body: string,
      actions: string[],
      hints: Record<string, unknown>,
      expireTimeout: number,
    ): Promise<number> => {
      _calls.push({ appName, replacesId, icon, summary, body, actions, hints, expireTimeout });
      return 1;
    },
    ...overrides,
  };

  const iface = new Proxy(defaults as Record<string, unknown>, {
    get(target, prop: string) {
      if (prop in target) return target[prop];
      if (prop === 'on' || prop === 'once' || prop === 'off' || prop === 'emit') return () => undefined;
      throw new Error(`Unexpected NotifyIface method call: ${prop}`);
    },
  }) as unknown as ClientInterface & { _calls: NotifyCall[] };

  (iface as unknown as Record<string, unknown>)._calls = _calls;
  return iface;
}

// ---------------------------------------------------------------------------
// Mock helpers — MessageBus
// ---------------------------------------------------------------------------

function makeBus(
  proxyMap: Map<string, ClientInterface>,
): MessageBus & { _disconnected: () => boolean } {
  let disconnected = false;

  const bus: Partial<MessageBus> = {
    getProxyObject: async (_name: string, _path: string): Promise<ProxyObject> => {
      return {
        getInterface: (iface: string): ClientInterface => {
          const impl = proxyMap.get(iface);
          if (!impl) throw new Error(`No mock for interface: ${iface}`);
          return impl;
        },
      } as unknown as ProxyObject;
    },
    disconnect: () => { disconnected = true; },
  };

  (bus as Record<string, unknown>)._disconnected = () => disconnected;
  return bus as unknown as MessageBus & { _disconnected: () => boolean };
}

function makeBusFactory(
  notifyOverrides: Parameters<typeof makeNotifyIface>[0] = {},
): {
  factory: BusFactory;
  notifyIface: ReturnType<typeof makeNotifyIface>;
  bus: ReturnType<typeof makeBus>;
} {
  const notifyIface = makeNotifyIface(notifyOverrides);
  const bus = makeBus(new Map([['org.freedesktop.Notifications', notifyIface as unknown as ClientInterface]]));
  return {
    factory: () => bus as unknown as MessageBus,
    notifyIface,
    bus,
  };
}

function throwingBusFactory(msg = 'Failed to connect to D-Bus'): BusFactory {
  return () => { throw new Error(msg); };
}

function rejectingBusFactory(msg = 'D-Bus connection refused'): BusFactory {
  return () => {
    const bus: Partial<MessageBus> = {
      getProxyObject: async () => { throw new Error(msg); },
      disconnect: () => undefined,
    };
    return bus as unknown as MessageBus;
  };
}

// ---------------------------------------------------------------------------
// Convenience builder
// ---------------------------------------------------------------------------

function makeBridge(
  opts: Partial<DBusEventBridgeOptions> & { busFactory?: BusFactory },
): {
  bridge: DBusEventBridge;
  sm: SessionManager;
  logger: ReturnType<typeof makeLogger>;
} {
  const sm = opts.sessionManager ?? makeSessionManager();
  const logger = makeLogger();

  const bridge = new DBusEventBridge({
    sessionManager: sm,
    logger: logger as unknown as import('./logger.js').Logger,
    busFactory: opts.busFactory,
  });

  return { bridge, sm, logger };
}

// ---------------------------------------------------------------------------
// start()
// ---------------------------------------------------------------------------

describe('DBusEventBridge.start()', () => {
  it('connects and sets connected=true on valid bus', async () => {
    const { factory } = makeBusFactory();
    const { bridge } = makeBridge({ busFactory: factory });
    await bridge.start();
    assert.equal(bridge.isConnected, true);
  });

  it('logs info "dbus bridge started" on success', async () => {
    const { factory } = makeBusFactory();
    const { bridge, logger } = makeBridge({ busFactory: factory });
    await bridge.start();
    const msgs = logger.calls.filter(c => c.level === 'info').map(c => c.msg);
    assert.ok(msgs.includes('dbus bridge started'));
  });

  it('stays disconnected and logs warn when BusFactory throws synchronously', async () => {
    const { bridge, logger } = makeBridge({ busFactory: throwingBusFactory('no dbus socket') });
    await assert.doesNotReject(() => bridge.start());
    assert.equal(bridge.isConnected, false);
    const warns = logger.calls.filter(c => c.level === 'warn').map(c => c.msg);
    assert.ok(warns.includes('dbus bridge unavailable'));
  });

  it('stays disconnected and logs warn when getProxyObject rejects', async () => {
    const { bridge, logger } = makeBridge({ busFactory: rejectingBusFactory() });
    await assert.doesNotReject(() => bridge.start());
    assert.equal(bridge.isConnected, false);
    const warns = logger.calls.filter(c => c.level === 'warn').map(c => c.msg);
    assert.ok(warns.includes('dbus bridge unavailable'));
  });

  it('includes error message in warn data when connection fails', async () => {
    const errMsg = 'DBUS_SESSION_BUS_ADDRESS not set';
    const { bridge, logger } = makeBridge({ busFactory: throwingBusFactory(errMsg) });
    await bridge.start();
    const warnCall = logger.calls.find(c => c.level === 'warn' && c.msg === 'dbus bridge unavailable');
    assert.ok(warnCall);
    assert.equal(warnCall!.data?.error, errMsg);
  });
});

// ---------------------------------------------------------------------------
// stop()
// ---------------------------------------------------------------------------

describe('DBusEventBridge.stop()', () => {
  it('calls bus.disconnect() on stop()', async () => {
    const { factory, bus } = makeBusFactory();
    const { bridge } = makeBridge({ busFactory: factory });
    await bridge.start();
    assert.equal(bus._disconnected(), false);
    await bridge.stop();
    assert.equal(bus._disconnected(), true);
  });

  it('sets connected=false after stop()', async () => {
    const { factory } = makeBusFactory();
    const { bridge } = makeBridge({ busFactory: factory });
    await bridge.start();
    await bridge.stop();
    assert.equal(bridge.isConnected, false);
  });

  it('logs info "dbus bridge stopped"', async () => {
    const { factory } = makeBusFactory();
    const { bridge, logger } = makeBridge({ busFactory: factory });
    await bridge.start();
    await bridge.stop();
    const msgs = logger.calls.filter(c => c.level === 'info').map(c => c.msg);
    assert.ok(msgs.includes('dbus bridge stopped'));
  });

  it('stop() without start() does not throw', async () => {
    const { bridge } = makeBridge({});
    await assert.doesNotReject(() => bridge.stop());
  });
});

// ---------------------------------------------------------------------------
// Event mapping helpers
// ---------------------------------------------------------------------------

async function testEvent(
  smEmit: (sm: SessionManager) => void,
  notifyOverrides: Parameters<typeof makeNotifyIface>[0] = {},
): Promise<{ calls: NotifyCall[]; logger: ReturnType<typeof makeLogger> }> {
  const { factory, notifyIface } = makeBusFactory(notifyOverrides);
  const { bridge, sm, logger } = makeBridge({ busFactory: factory });
  await bridge.start();
  smEmit(sm);
  await new Promise<void>(resolve => setImmediate(resolve));
  return { calls: notifyIface._calls, logger };
}

// ---------------------------------------------------------------------------
// session:started
// ---------------------------------------------------------------------------

describe('session:started event', () => {
  it('calls Notify with correct args on session:started', async () => {
    const { calls } = await testEvent(sm => {
      (sm as unknown as EventEmitter).emit('session:started', {
        sessionId: 's1', projectDir: '/home/user/MyProject', projectName: 'MyProject',
      });
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].appName, 'gsd-daemon');
    assert.equal(calls[0].replacesId, 0);
    assert.equal(calls[0].icon, 'dialog-information');
    assert.equal(calls[0].summary, 'GSD: MyProject');
    assert.equal(calls[0].body, 'Session started');
    assert.deepEqual(calls[0].actions, []);
    assert.deepEqual(calls[0].hints, {});
    assert.equal(calls[0].expireTimeout, 5000);
  });
});

// ---------------------------------------------------------------------------
// session:completed
// ---------------------------------------------------------------------------

describe('session:completed event', () => {
  it('calls Notify with correct body on session:completed', async () => {
    const { calls } = await testEvent(sm => {
      (sm as unknown as EventEmitter).emit('session:completed', {
        sessionId: 's2', projectDir: '/home/user/MyProject', projectName: 'MyProject',
      });
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].summary, 'GSD: MyProject');
    assert.equal(calls[0].body, 'Session completed');
  });
});

// ---------------------------------------------------------------------------
// session:error
// ---------------------------------------------------------------------------

describe('session:error event', () => {
  it('calls Notify with error message in body on session:error', async () => {
    const errorMsg = 'agent process exited unexpectedly';
    const { calls } = await testEvent(sm => {
      (sm as unknown as EventEmitter).emit('session:error', {
        sessionId: 's3', projectDir: '/home/user/ErrorProject', projectName: 'ErrorProject',
        error: errorMsg,
      });
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].summary, 'GSD: ErrorProject — Error');
    assert.equal(calls[0].body, errorMsg);
    assert.deepEqual(calls[0].actions, []);
  });
});

// ---------------------------------------------------------------------------
// session:blocked (base class — plain toast, no buttons)
// ---------------------------------------------------------------------------

describe('session:blocked event', () => {
  it('calls Notify with blocker message in body and empty actions on session:blocked', async () => {
    const { calls } = await testEvent(sm => {
      (sm as unknown as EventEmitter).emit('session:blocked', {
        sessionId: 's4', projectDir: '/home/user/BlockedProject', projectName: 'BlockedProject',
        blocker: { id: 'b1', method: 'confirm', message: 'Should I delete all files?', event: {} as never },
      });
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].summary, 'GSD: BlockedProject — Blocked');
    assert.equal(calls[0].body, 'Should I delete all files?');
    assert.deepEqual(calls[0].actions, []);
  });
});

// ---------------------------------------------------------------------------
// session:event must NOT call Notify
// ---------------------------------------------------------------------------

describe('session:event filtering', () => {
  it('does NOT call Notify when session:event is emitted', async () => {
    const { factory, notifyIface } = makeBusFactory();
    const { bridge, sm } = makeBridge({ busFactory: factory });
    await bridge.start();
    (sm as unknown as EventEmitter).emit('session:event', {
      sessionId: 's5', projectDir: '/home/user/Proj', event: { type: 'tool_call', tool: 'bash' },
    });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(notifyIface._calls.length, 0, 'session:event must NOT trigger Notify');
  });
});

// ---------------------------------------------------------------------------
// stop() unsubscribes all handlers
// ---------------------------------------------------------------------------

describe('stop() unsubscribes handlers', () => {
  it('off() called for all four events and disconnect called', async () => {
    const { factory, bus, notifyIface } = makeBusFactory();
    const { bridge, sm } = makeBridge({ busFactory: factory });
    await bridge.start();
    await bridge.stop();

    (sm as unknown as EventEmitter).emit('session:started',   { sessionId: 's6', projectDir: '/p', projectName: 'P' });
    (sm as unknown as EventEmitter).emit('session:completed', { sessionId: 's6', projectDir: '/p', projectName: 'P' });
    (sm as unknown as EventEmitter).emit('session:error',     { sessionId: 's6', projectDir: '/p', projectName: 'P', error: 'err' });
    (sm as unknown as EventEmitter).emit('session:blocked',   {
      sessionId: 's6', projectDir: '/p', projectName: 'P',
      blocker: { id: 'b', method: 'confirm', message: 'q', event: {} as never },
    });

    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(notifyIface._calls.length, 0, 'No Notify calls after stop()');
    assert.equal(bus._disconnected(), true, 'bus.disconnect() must be called');
  });
});

// ---------------------------------------------------------------------------
// sendNotify error handling
// ---------------------------------------------------------------------------

describe('sendNotify error handling', () => {
  it('logs warn but does not throw when Notify rejects', async () => {
    const { factory } = makeBusFactory({
      Notify: async () => { throw new Error('notification daemon crashed'); },
    });
    const { bridge, sm, logger } = makeBridge({ busFactory: factory });
    await bridge.start();

    await assert.doesNotReject(async () => {
      (sm as unknown as EventEmitter).emit('session:started', {
        sessionId: 's7', projectDir: '/p', projectName: 'P',
      });
      await new Promise<void>(resolve => setImmediate(resolve));
    });

    const warns = logger.calls.filter(c => c.level === 'warn').map(c => c.msg);
    assert.ok(warns.includes('dbus notify failed'));
  });
});
