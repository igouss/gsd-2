/**
 * GApplicationService — registers the daemon on the D-Bus session bus as
 * org.freedesktop.Application at /gsd/daemon.
 *
 * GNOME action-button notifications require:
 *   1. The daemon holds the D-Bus well-known name matching the .desktop
 *      app-id. The app-id must be a valid reverse-domain string with at
 *      least one dot (D-Bus spec). We use "gsd.daemon"; the desktop file
 *      must be named "gsd.daemon.desktop".
 *   2. It exports org.freedesktop.Application at /gsd/daemon.
 *   3. When a button is clicked, GNOME calls ActivateAction on that service.
 *
 * Note on naming: "gsd-daemon" is NOT a valid D-Bus well-known name —
 * dbus-next and the D-Bus daemon both reject single-element names (no dots).
 * The systemd service is still named "gsd-daemon.service"; the desktop file
 * and D-Bus name are "gsd.daemon".
 *
 * Rather than subclassing dbus-next Interface (which is for properties/signals
 * via decorators), we use bus.addMethodHandler() — one raw handler, filter
 * by path+member, reply immediately, dispatch to registered callback.
 *
 * The bus is shared with DBusBlockerBridge — one connection handles both
 * outbound portal calls and inbound ActivateAction calls. This is correct;
 * a D-Bus connection can do both simultaneously.
 */

import dbus from 'dbus-next';
import type { MessageBus, Message } from 'dbus-next';
import type { Logger } from './logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ActivateActionHandler = (action: string, params: unknown[]) => void;

/**
 * Minimal interface for GApplicationService — used by DBusBlockerBridge
 * so tests can inject a mock without subclassing.
 */
export interface IGApplicationService {
  start(bus: MessageBus): Promise<void>;
  stop(): Promise<void>;
  onActivateAction(handler: ActivateActionHandler): void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * D-Bus well-known name. Must match the .desktop file stem.
 * "gsd-daemon" is invalid (no dots); "gsd.daemon" is the correct form.
 */
const DBUS_NAME = 'gsd.daemon';

/** Object path under which we export org.freedesktop.Application. */
const OBJECT_PATH = '/gsd/daemon';

// ---------------------------------------------------------------------------
// GApplicationService
// ---------------------------------------------------------------------------

export class GApplicationService implements IGApplicationService {
  private readonly logger: Logger;
  private bus: MessageBus | null = null;
  private methodHandler: ((msg: Message) => boolean) | null = null;
  private handler: ActivateActionHandler | null = null;
  private _nameAcquired = false;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Register as DBUS_NAME on the given bus and install a method handler
   * for org.freedesktop.Application.ActivateAction.
   *
   * Failure to acquire the name (e.g. daemon already running) is non-fatal:
   * we log a warning and return. The method handler is still installed so
   * ActivateAction calls routed to us by the bus will still be handled.
   */
  async start(bus: MessageBus): Promise<void> {
    this.bus = bus;

    // Install the method handler before requesting the name so we don't miss
    // any calls that arrive immediately after name acquisition.
    this.methodHandler = (msg: Message): boolean => {
      if (msg.path !== OBJECT_PATH || msg.member !== 'ActivateAction') {
        return false;
      }

      // body: [actionName: s, params: av, platformData: a{sv}]
      const [actionName, params] = msg.body as [string, unknown[], unknown];

      // Acknowledge immediately — GNOME expects a reply or it'll time out
      bus.send(dbus.Message.newMethodReturn(msg));

      this.handler?.(actionName, params as unknown[]);
      return true;
    };

    bus.addMethodHandler(this.methodHandler);

    // Request the D-Bus name — flags=0 means don't queue, don't replace
    try {
      const reply = await bus.requestName(DBUS_NAME, 0);
      if (reply === dbus.RequestNameReply.PRIMARY_OWNER) {
        this._nameAcquired = true;
        this.logger.info('gapplication service: name acquired', { name: DBUS_NAME });
      } else if (reply === dbus.RequestNameReply.ALREADY_OWNER) {
        this._nameAcquired = true;
        this.logger.info('gapplication service: already name owner', { name: DBUS_NAME });
      } else {
        // IN_QUEUE or EXISTS — another process holds the name
        this.logger.warn('gapplication service: name not acquired (daemon already running?)', {
          name: DBUS_NAME,
          reply,
        });
      }
    } catch (err) {
      this.logger.warn('gapplication service: requestName failed', {
        name: DBUS_NAME,
        error: err instanceof Error ? err.message : String(err),
      });
      // Non-fatal — method handler still installed; ActivateAction calls
      // routed to us by address will still be dispatched
    }
  }

  async stop(): Promise<void> {
    if (this.methodHandler && this.bus) {
      this.bus.removeMethodHandler(this.methodHandler);
      this.methodHandler = null;
    }

    if (this._nameAcquired && this.bus) {
      try {
        await this.bus.releaseName(DBUS_NAME);
        this.logger.info('gapplication service: name released', { name: DBUS_NAME });
      } catch (err) {
        this.logger.warn('gapplication service: releaseName failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      this._nameAcquired = false;
    }

    this.bus = null;
    this.handler = null;
  }

  // -------------------------------------------------------------------------
  // Callback registration
  // -------------------------------------------------------------------------

  /**
   * Register a callback for ActivateAction calls.
   * Only one handler is supported — last call wins.
   *
   * @param handler (action, params) where action is e.g. "app.resolve-blocker"
   *   and params is the av array from the D-Bus call body.
   */
  onActivateAction(handler: ActivateActionHandler): void {
    this.handler = handler;
  }

  // -------------------------------------------------------------------------
  // Accessors
  // -------------------------------------------------------------------------

  get nameAcquired(): boolean {
    return this._nameAcquired;
  }
}
