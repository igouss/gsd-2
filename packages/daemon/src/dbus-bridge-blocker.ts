/**
 * DBusBlockerBridge — extends DBusEventBridge to send action-button
 * notifications for session:blocked events via the XDG desktop portal
 * (org.freedesktop.portal.Notification) and resolve blockers when the user
 * clicks a button (via GApplicationService / ActivateAction).
 *
 * Architecture (GNOME 49+):
 * - Base class: plain toasts via org.freedesktop.Notifications — always visible
 *   from any process, no app-id requirement.
 * - Portal (org.freedesktop.portal.Notification): sends notifications with
 *   action buttons. Buttons carry a "target" GVariant that encodes the
 *   sessionId and user response (e.g. "sess-1:true").
 * - GApplicationService: registers as "gsd-daemon" on the session bus and
 *   exports org.freedesktop.Application at /gsd/daemon. GNOME calls
 *   ActivateAction('app.resolve-blocker', [Variant('s', 'sess-1:true')], {})
 *   when the user clicks a button.
 *
 * Why "target" encoding instead of pendingBlockerMap:
 * - GNOME does not pass the notification id back in ActivateAction; it passes
 *   the button's "target" GVariant. Encoding sessionId+response in the target
 *   makes the handler stateless — no map needed.
 *
 * Fallback:
 * - If portal connection fails, handleBlocked() falls back to the base class
 *   plain toast. The blocker message still reaches the user, just without
 *   action buttons.
 * - Silent drop (portal sends nothing on GNOME 49 for non-indexed apps) is
 *   not fatal — plain toast was already sent.
 *
 * Portal API:
 *   dest:   org.freedesktop.portal.Desktop
 *   path:   /org/freedesktop/portal/desktop
 *   iface:  org.freedesktop.portal.Notification
 *   AddNotification(id: string, notification: a{sv}) → void
 *
 * Notification dict keys: title (s), body (s), buttons (aa{sv})
 * Button dict keys:
 *   label  (s)
 *   action (s)  — "app.resolve-blocker"
 *   target (v)  — Variant('v', Variant('s', 'sessionId:response'))
 */

import dbus from 'dbus-next';
const { Variant } = dbus;
import type { MessageBus, ClientInterface } from 'dbus-next';
import type { DBusEventBridgeOptions, BusFactory } from './dbus-bridge.js';
import { DBusEventBridge } from './dbus-bridge.js';
import { GApplicationService } from './gapplication-service.js';
import type { IGApplicationService } from './gapplication-service.js';
import type { PendingBlocker } from './types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface NotificationButton {
  label: string;
  action: string;
  target: string; // the raw "sessionId:response" string encoded in the Variant
}

interface SessionBlockedPayload {
  sessionId: string;
  projectDir: string;
  projectName: string;
  blocker: PendingBlocker;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PORTAL_SERVICE = 'org.freedesktop.portal.Desktop';
const PORTAL_PATH = '/org/freedesktop/portal/desktop';
const PORTAL_IFACE = 'org.freedesktop.portal.Notification';
const ACTIVATE_ACTION = 'app.resolve-blocker';

// ---------------------------------------------------------------------------
// DBusBlockerBridge
// ---------------------------------------------------------------------------

export class DBusBlockerBridge extends DBusEventBridge {
  private readonly portalBusFactory: BusFactory;
  private portalBus: MessageBus | null = null;
  private portalIface: ClientInterface | null = null;
  private gappService: IGApplicationService | null = null;
  private _notifCounter = 0;

  constructor(opts: DBusEventBridgeOptions & { portalBusFactory?: BusFactory }) {
    super(opts);
    this.portalBusFactory = opts.portalBusFactory ?? (() => dbus.sessionBus());
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async start(): Promise<void> {
    // Start the base bridge (plain toasts via org.freedesktop.Notifications)
    await super.start();

    // Connect to the portal separately for action-button blocker notifications.
    // Failure here is non-fatal — handleBlocked() falls back to plain toast.
    try {
      this.portalBus = this.portalBusFactory();
      const proxy = await this.portalBus.getProxyObject(PORTAL_SERVICE, PORTAL_PATH);
      this.portalIface = proxy.getInterface(PORTAL_IFACE);

      // Register as gsd-daemon so GNOME can route ActivateAction back to us.
      // Reuse the portal bus — one connection handles both outbound portal
      // calls and inbound ActivateAction method calls.
      this.gappService = this.createGApplicationService();
      await this.gappService.start(this.portalBus);

      this.gappService.onActivateAction((actionName, params) => {
        if (actionName !== ACTIVATE_ACTION) return;

        // params[0] is a Variant<string> wrapping "sessionId:response"
        // Handle both Variant objects and raw strings defensively.
        const raw = (params[0] != null && typeof params[0] === 'object' && 'value' in params[0])
          ? String((params[0] as { value: unknown }).value)
          : String(params[0] ?? '');

        const colonIdx = raw.lastIndexOf(':');
        if (colonIdx < 1) {
          this.logger.warn('dbus blocker: malformed ActivateAction target', { raw });
          return;
        }

        const sessionId = raw.slice(0, colonIdx);
        const response = raw.slice(colonIdx + 1);

        this.sessionManager.resolveBlocker(sessionId, response).catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes('No pending blocker')) return; // R008 — stale click
          this.logger.warn('dbus blocker resolve failed', { sessionId, error: msg });
        });
      });

      this.logger.info('dbus portal connected');
    } catch (err) {
      this.logger.warn('dbus portal unavailable — blocker notifications will have no buttons', {
        error: err instanceof Error ? err.message : String(err),
      });
      // portal bus is null — handleBlocked() will fall back to plain toast
    }
  }

  async stop(): Promise<void> {
    if (this.gappService) {
      await this.gappService.stop();
      this.gappService = null;
    }

    if (this.portalBus) {
      try { this.portalBus.disconnect(); } finally { this.portalBus = null; }
    }

    this.portalIface = null;
    await super.stop();
  }

  // -------------------------------------------------------------------------
  // handleBlocked override
  // -------------------------------------------------------------------------

  /**
   * Send a blocker notification.
   *
   * Always sends a plain toast via the base class (so the user sees something
   * regardless of portal availability). Additionally attempts the portal for
   * action buttons — when running as gsd-daemon.service with gsd-daemon.desktop
   * installed, the portal notification will appear with clickable buttons.
   * GNOME calls ActivateAction on us with the encoded sessionId+response.
   *
   * When the portal silently drops the notification (GNOME 49 with non-indexed
   * app-id), only the plain toast is shown. This is not an error.
   */
  protected async handleBlocked(data: SessionBlockedPayload): Promise<void> {
    // Always send the plain toast — visible from any process
    await super.handleBlocked(data);

    if (!this.portalIface) return;

    const { sessionId, projectName, blocker } = data;
    const buttons = buildButtons(sessionId, blocker);
    const id = `gsd-blocker-${++this._notifCounter}`;

    try {
      const notification: Record<string, unknown> = {
        title: new Variant('s', `GSD: ${projectName} — Blocked`),
        body:  new Variant('s', blocker.message),
        buttons: new Variant('aa{sv}', buttons.map(b => ({
          label:  new Variant('s', b.label),
          action: new Variant('s', b.action),
          target: new Variant('v', new Variant('s', b.target)),
        }))),
      };

      await (this.portalIface['AddNotification'] as Function)(id, notification);
    } catch (err) {
      this.logger.warn('dbus portal notify failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      // Plain toast already sent above — no further fallback needed
    }
  }

  // -------------------------------------------------------------------------
  // Accessors
  // -------------------------------------------------------------------------

  get isPortalConnected(): boolean {
    return this.portalIface !== null;
  }

  /** Override in tests to inject a mock GApplicationService. */
  protected createGApplicationService(): IGApplicationService {
    return new GApplicationService(this.logger);
  }
}

// ---------------------------------------------------------------------------
// Button builder
// ---------------------------------------------------------------------------

/**
 * Build portal notification buttons for a given blocker.
 * Each button's "target" encodes "sessionId:response" for stateless routing.
 *
 * - confirm: [Yes/true, No/false]
 * - select:  one button per option, response = index string
 * - other:   [OK/ok]
 */
function buildButtons(sessionId: string, blocker: PendingBlocker): NotificationButton[] {
  if (blocker.method === 'confirm') {
    return [
      { label: 'Yes', action: ACTIVATE_ACTION, target: `${sessionId}:true` },
      { label: 'No',  action: ACTIVATE_ACTION, target: `${sessionId}:false` },
    ];
  }

  if (blocker.method === 'select') {
    const event = blocker.event as { options?: string[] };
    const options = event.options ?? [];
    return options.map((opt, i) => ({
      label: opt,
      action: ACTIVATE_ACTION,
      target: `${sessionId}:${i}`,
    }));
  }

  return [{ label: 'OK', action: ACTIVATE_ACTION, target: `${sessionId}:ok` }];
}
