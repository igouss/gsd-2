/**
 * DBusEventBridge — subscribes to SessionManager lifecycle events and sends
 * org.freedesktop.Notifications.Notify desktop notifications via dbus-next.
 *
 * Design constraints:
 * - D-Bus unavailability MUST NOT crash or delay the daemon (R005).
 * - start() swallows all connection errors — logs warn and returns.
 * - stop() always disconnects the bus in a finally block to avoid
 *   ERR_STREAM_WRITE_AFTER_END.
 * - session:event is intentionally NOT subscribed (fires hundreds of times).
 * - notifyIface is protected so DBusBlockerBridge can access it.
 *
 * NOTE: org.freedesktop.Notifications is used for plain toasts because it
 * works from any process without app-id registration. The portal
 * (org.freedesktop.portal.Notification) is used only by the subclass for
 * action-button blocker notifications, since it requires the daemon to be
 * running as a registered systemd service.
 */

import dbus from 'dbus-next'; // default import — NOT named (CJS interop)
import type { MessageBus, ClientInterface } from 'dbus-next';
import type { Logger } from './logger.js';
import type { SessionManager } from './session-manager.js';
import type { PendingBlocker } from './types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Factory function that returns a connected MessageBus. Injectable for testing. */
export type BusFactory = () => MessageBus;

/** Options for creating a DBusEventBridge. */
export interface DBusEventBridgeOptions {
  sessionManager: SessionManager;
  logger: Logger;
  /** Defaults to () => dbus.sessionBus(). Override in tests. */
  busFactory?: BusFactory;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NOTIFICATIONS_SERVICE = 'org.freedesktop.Notifications';
const NOTIFICATIONS_PATH = '/org/freedesktop/Notifications';
const NOTIFICATIONS_IFACE = 'org.freedesktop.Notifications';
const APP_NAME = 'gsd-daemon';
const REPLACES_ID = 0;
const DEFAULT_ICON = 'dialog-information';
const EXPIRE_TIMEOUT_MS = 5000;

// ---------------------------------------------------------------------------
// Internal payload shapes (matching SessionManager emissions)
// ---------------------------------------------------------------------------

interface SessionStartedPayload {
  sessionId: string;
  projectDir: string;
  projectName: string;
}

interface SessionCompletedPayload {
  sessionId: string;
  projectDir: string;
  projectName: string;
}

interface SessionErrorPayload {
  sessionId: string;
  projectDir: string;
  projectName: string;
  error: string;
}

interface SessionBlockedPayload {
  sessionId: string;
  projectDir: string;
  projectName: string;
  blocker: PendingBlocker;
}

// ---------------------------------------------------------------------------
// DBusEventBridge
// ---------------------------------------------------------------------------

export class DBusEventBridge {
  protected readonly sessionManager: SessionManager;
  protected readonly logger: Logger;
  private readonly busFactory: BusFactory;

  private bus: MessageBus | null = null;
  /** protected so DBusBlockerBridge can check connection state */
  protected notifyIface: ClientInterface | null = null;

  private boundHandlers: {
    started: (data: unknown) => void;
    completed: (data: unknown) => void;
    error: (data: unknown) => void;
    blocked: (data: unknown) => void;
  } | null = null;

  constructor(opts: DBusEventBridgeOptions) {
    this.sessionManager = opts.sessionManager;
    this.logger = opts.logger;
    this.busFactory = opts.busFactory ?? (() => dbus.sessionBus());
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Connect to org.freedesktop.Notifications and subscribe to session lifecycle
   * events. All errors are caught — D-Bus unavailability must never crash the daemon.
   */
  async start(): Promise<void> {
    try {
      this.bus = this.busFactory();
      const proxy = await this.bus.getProxyObject(NOTIFICATIONS_SERVICE, NOTIFICATIONS_PATH);
      this.notifyIface = proxy.getInterface(NOTIFICATIONS_IFACE);

      this.boundHandlers = {
        started:   (data: unknown) => { void this.onSessionStarted(data as SessionStartedPayload); },
        completed: (data: unknown) => { void this.onSessionCompleted(data as SessionCompletedPayload); },
        error:     (data: unknown) => { void this.onSessionError(data as SessionErrorPayload); },
        blocked:   (data: unknown) => { void this.handleBlocked(data as SessionBlockedPayload); },
      };

      this.sessionManager.on('session:started',   this.boundHandlers.started);
      this.sessionManager.on('session:completed', this.boundHandlers.completed);
      this.sessionManager.on('session:error',     this.boundHandlers.error);
      this.sessionManager.on('session:blocked',   this.boundHandlers.blocked);

      this.logger.info('dbus bridge started');
    } catch (err) {
      this.logger.warn('dbus bridge unavailable', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async stop(): Promise<void> {
    if (this.boundHandlers) {
      this.sessionManager.off('session:started',   this.boundHandlers.started);
      this.sessionManager.off('session:completed', this.boundHandlers.completed);
      this.sessionManager.off('session:error',     this.boundHandlers.error);
      this.sessionManager.off('session:blocked',   this.boundHandlers.blocked);
      this.boundHandlers = null;
    }

    if (this.bus) {
      try { this.bus.disconnect(); } finally { this.bus = null; }
    }

    this.logger.info('dbus bridge stopped');
  }

  // -------------------------------------------------------------------------
  // Session event handlers
  // -------------------------------------------------------------------------

  private async onSessionStarted(data: SessionStartedPayload): Promise<void> {
    await this.sendNotify(`GSD: ${data.projectName}`, 'Session started');
  }

  private async onSessionCompleted(data: SessionCompletedPayload): Promise<void> {
    await this.sendNotify(`GSD: ${data.projectName}`, 'Session completed');
  }

  private async onSessionError(data: SessionErrorPayload): Promise<void> {
    await this.sendNotify(`GSD: ${data.projectName} — Error`, data.error);
  }

  protected async handleBlocked(data: SessionBlockedPayload): Promise<void> {
    await this.sendNotify(`GSD: ${data.projectName} — Blocked`, data.blocker.message);
  }

  // -------------------------------------------------------------------------
  // Core notification helper
  // -------------------------------------------------------------------------

  /**
   * Send a plain desktop notification via org.freedesktop.Notifications.
   * Errors are caught and logged — never propagated.
   *
   * The base class always sends empty actions[]. DBusBlockerBridge overrides
   * handleBlocked() and uses the portal for action buttons instead.
   */
  protected async sendNotify(summary: string, body: string): Promise<void> {
    if (!this.notifyIface) return;

    try {
      // dbus-next returns the raw uint32 notificationId (not wrapped in an array)
      await (this.notifyIface['Notify'] as Function)(
        APP_NAME, REPLACES_ID, DEFAULT_ICON,
        summary, body,
        [], {}, EXPIRE_TIMEOUT_MS,
      );
    } catch (err) {
      this.logger.warn('dbus notify failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // -------------------------------------------------------------------------
  // Accessors
  // -------------------------------------------------------------------------

  get isConnected(): boolean {
    return this.notifyIface !== null;
  }
}
