/**
 * Portal button test — must be run as:
 *   systemd-run --user --scope \
 *     --unit="app-gsd.daemon-test.scope" \
 *     --slice=app.slice \
 *     node /home/elendal/IdeaProjects/gsd-2/packages/daemon/dist/portal-button-test.js
 *
 * Running under a systemd scope with gsd.daemon.desktop installed lets
 * xdg-desktop-portal resolve the app-id as "gsd.daemon" and render buttons.
 * The GApplicationService registers us as "gsd.daemon" on the bus so GNOME
 * can call ActivateAction back when a button is clicked.
 *
 * Stop the daemon first if running:
 *   systemctl --user stop gsd-daemon.service
 */

import dbus from 'dbus-next';
const { Variant } = dbus;
import { GApplicationService } from './gapplication-service.js';
import type { Logger } from './logger.js';

// Minimal console logger for the test
const logger: Logger = {
  info: (msg: string, ctx?: unknown) => console.log(`INFO  ${msg}`, ctx ?? ''),
  warn: (msg: string, ctx?: unknown) => console.warn(`WARN  ${msg}`, ctx ?? ''),
  error: (msg: string, ctx?: unknown) => console.error(`ERROR ${msg}`, ctx ?? ''),
  debug: (msg: string, ctx?: unknown) => console.debug(`DEBUG ${msg}`, ctx ?? ''),
  close: async () => {},
} as unknown as Logger;

const bus = dbus.sessionBus();
try {
  // 1. Register as gsd-daemon so GNOME can route ActivateAction to us
  const service = new GApplicationService(logger);
  await service.start(bus);

  if (!service.nameAcquired) {
    console.warn('⚠️  Name "gsd.daemon" not acquired — is the daemon running? Stop it first.');
    console.warn('     systemctl --user stop gsd-daemon.service');
  } else {
    console.log('✅  Name "gsd.daemon" acquired on session bus');
  }

  // 2. Register ActivateAction callback
  service.onActivateAction((action, params) => {
    console.log(`\n✅  ActivateAction received`);
    console.log(`    action=${action}`);
    console.log(`    params[0]=${JSON.stringify(params[0])}`);

    // Decode the target: "sessionId:response"
    const raw = (params[0] != null && typeof params[0] === 'object' && 'value' in params[0])
      ? String((params[0] as { value: unknown }).value)
      : String(params[0] ?? '');

    const colonIdx = raw.lastIndexOf(':');
    if (colonIdx > 0) {
      const sessionId = raw.slice(0, colonIdx);
      const response = raw.slice(colonIdx + 1);
      console.log(`    → sessionId=${sessionId}  response=${response}`);
    }

    service.stop().then(() => {
      bus.disconnect();
      process.exit(0);
    });
  });

  // 3. Connect to portal
  const proxy = await bus.getProxyObject('org.freedesktop.portal.Desktop', '/org/freedesktop/portal/desktop');
  const iface = proxy.getInterface('org.freedesktop.portal.Notification');

  const testSessionId = `test-session-${Date.now()}`;
  const id = 'gsd-portal-btn-test';

  await iface.AddNotification(id, {
    title:   new Variant('s', 'GSD Daemon — Blocked'),
    body:    new Variant('s', 'Should the daemon proceed? (click Yes or No)'),
    buttons: new Variant('aa{sv}', [
      {
        label:  new Variant('s', 'Yes'),
        action: new Variant('s', 'app.resolve-blocker'),
        target: new Variant('v', new Variant('s', `${testSessionId}:true`)),
      },
      {
        label:  new Variant('s', 'No'),
        action: new Variant('s', 'app.resolve-blocker'),
        target: new Variant('v', new Variant('s', `${testSessionId}:false`)),
      },
    ]),
  });

  console.log(`Notification sent (session=${testSessionId}).`);
  console.log('Waiting up to 60s for button click...');

  setTimeout(async () => {
    console.log('⚠️  Timed out — no button clicked.');
    await service.stop();
    bus.disconnect();
    process.exit(0);
  }, 60_000);
} catch (err) {
  console.error('Error:', err instanceof Error ? err.message : err);
  bus.disconnect();
  process.exit(1);
}
