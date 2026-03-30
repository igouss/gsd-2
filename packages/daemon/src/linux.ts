import { writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';

// --------------- types ---------------

export interface UnitOptions {
  /** Absolute path to the Node.js binary */
  nodePath: string;
  /** Absolute path to the daemon script (cli.js) */
  scriptPath: string;
  /** Absolute path to the config file */
  configPath: string;
  /** Directory to use as WorkingDirectory (defaults to homedir) */
  workingDirectory?: string;
  /** Override stdout log path */
  stdoutPath?: string;
  /** Override stderr log path */
  stderrPath?: string;
}

export interface SystemdStatus {
  /** Whether the unit is registered with systemd (enabled or disabled) */
  registered: boolean;
  /** Whether the service is currently active (running) */
  active: boolean;
  /** Main PID if running, null otherwise */
  pid: number | null;
  /** Last exit status code, null if never exited or unknown */
  lastExitStatus: number | null;
}

export type RunCommandFn = (cmd: string) => string;

// --------------- constants ---------------

const SERVICE_NAME = 'gsd-daemon';
const UNIT_FILENAME = `${SERVICE_NAME}.service`;
// D-Bus well-known names require dots; the desktop file stem must match.
// "gsd-daemon" is not a valid D-Bus name; "gsd.daemon" is.
const DBUS_APP_ID = 'gsd.daemon';
const DESKTOP_FILENAME = `${DBUS_APP_ID}.desktop`;

// --------------- helpers ---------------

/** Return the canonical unit file path under ~/.config/systemd/user/. */
export function getUnitPath(): string {
  return resolve(homedir(), '.config', 'systemd', 'user', UNIT_FILENAME);
}

/** Return the canonical .desktop file path under ~/.local/share/applications/. */
export function getDesktopPath(): string {
  return resolve(homedir(), '.local', 'share', 'applications', DESKTOP_FILENAME);
}

/**
 * Generate the .desktop file content needed for the XDG portal to resolve
 * the daemon's app-id as "gsd-daemon". Without this file the portal rejects
 * notifications with "The app by ID '' could not be found".
 */
export function generateDesktopFile(): string {
  return `[Desktop Entry]
Type=Application
Name=GSD Daemon
Comment=GSD background daemon
Exec=/bin/true
Icon=dialog-information
Categories=Utility;
NoDisplay=true
DBusActivatable=true
X-GNOME-UsesNotifications=true
X-DBus-AppId=${DBUS_APP_ID}
`;
}

/** Default runCommand using execSync. */
function defaultRunCommand(cmd: string): string {
  return execSync(cmd, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
}

// --------------- unit file generation ---------------

/**
 * Generate a systemd user service unit file for the GSD daemon.
 *
 * IMPORTANT: This function deliberately omits ANTHROPIC_API_KEY and
 * DISCORD_TOKEN. Credentials are stored in the system keyring (Secret
 * Service / GNOME Keyring) and retrieved at runtime — never written to disk
 * in plaintext.
 */
export function generateUnit(opts: UnitOptions): string {
  const home = homedir();
  const workDir = opts.workingDirectory ?? home;
  const stdoutPath = opts.stdoutPath ?? resolve(home, '.gsd', 'daemon-stdout.log');
  const stderrPath = opts.stderrPath ?? resolve(home, '.gsd', 'daemon-stderr.log');
  const nodeBinDir = dirname(opts.nodePath);

  // PATH includes the node binary's directory so systemd can find it without
  // a shell session (NVM/FNM not sourced under the service manager).
  return `[Unit]
Description=GSD Daemon
After=network.target

[Service]
Type=simple
ExecStart=${opts.nodePath} ${opts.scriptPath} --config ${opts.configPath}
Restart=on-failure
RestartSec=5s
WorkingDirectory=${workDir}
StandardOutput=append:${stdoutPath}
StandardError=append:${stderrPath}
Environment="PATH=${nodeBinDir}:/usr/local/bin:/usr/bin:/bin"
Environment="HOME=${home}"
Slice=app.slice

[Install]
WantedBy=default.target
`;
}

// --------------- install / uninstall / status ---------------

/**
 * Install the systemd user service: write the unit file, reload systemd,
 * then enable and start the service.
 *
 * Order is mandatory:
 *   1. mkdir -p ~/.config/systemd/user/
 *   2. Write unit file (no credentials)
 *   3. systemctl --user daemon-reload
 *   4. systemctl --user enable --now gsd-daemon
 *
 * If step 4 fails (e.g. user lingering not enabled, no D-Bus session), a
 * warning is written to stderr and the function returns without throwing.
 * The unit file is still on disk and can be enabled later.
 */
export function install(
  opts: UnitOptions,
  runCommand: RunCommandFn = defaultRunCommand,
): void {
  const unitPath = getUnitPath();
  const unitDir = dirname(unitPath);

  // 1. Ensure the systemd user unit directory exists
  mkdirSync(unitDir, { recursive: true });

  // 2. Write unit file — NO credentials
  const unit = generateUnit(opts);
  writeFileSync(unitPath, unit, 'utf-8');

  // 2b. Write .desktop file so the XDG portal can resolve the app-id
  //     as "gsd-daemon". Without it, portal rejects notifications.
  const desktopPath = getDesktopPath();
  const desktopDir = dirname(desktopPath);
  mkdirSync(desktopDir, { recursive: true });
  writeFileSync(desktopPath, generateDesktopFile(), 'utf-8');
  try {
    runCommand(`update-desktop-database ${desktopDir}`);
  } catch {
    // Non-fatal — update-desktop-database may not be installed or may fail
    // in some environments; the .desktop file is still on disk.
  }

  // 3. Reload systemd so it picks up the new unit
  runCommand('systemctl --user daemon-reload');

  // 4. Enable and start the service.
  //    Failure here is non-fatal: lingering may not be configured, or the
  //    user may not have a running systemd session. Warn and return.
  try {
    runCommand(`systemctl --user enable --now ${SERVICE_NAME}`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `gsd-daemon: warn: systemctl --user enable --now failed` +
        ` (unit written to ${unitPath}): ${msg}\n`,
    );
    // Partial success — unit is on disk; caller should inform the user
    return;
  }
}

/**
 * Uninstall the systemd user service: disable it, remove the unit file,
 * and reload systemd.
 *
 * Graceful — does not throw if the service is already disabled or the unit
 * file doesn't exist.
 */
export function uninstall(runCommand: RunCommandFn = defaultRunCommand): void {
  const unitPath = getUnitPath();

  // Disable and stop (swallow errors — may already be inactive or not found)
  try {
    runCommand(`systemctl --user disable --now ${SERVICE_NAME}`);
  } catch {
    // already disabled / not found — fine
  }

  // Remove unit file
  try { unlinkSync(unitPath); } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }

  // Remove .desktop file if present
  const desktopPath = getDesktopPath();
  try { unlinkSync(desktopPath); } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }

  // Reload after removal so systemd forgets the unit
  try {
    runCommand('systemctl --user daemon-reload');
  } catch {
    // best-effort; systemd may not be running in all environments
  }
}

/**
 * Query systemd for the daemon's status.
 *
 * Two commands are issued:
 *   - `systemctl --user is-enabled gsd-daemon` → registered flag
 *   - `systemctl --user status gsd-daemon --no-pager -l` → PID + active state
 *
 * Returns a structured SystemdStatus. Never throws.
 */
export function status(runCommand: RunCommandFn = defaultRunCommand): SystemdStatus {
  // --- Step 1: check registration ---
  let registered = false;
  try {
    const enabledOutput = runCommand(
      `systemctl --user is-enabled ${SERVICE_NAME}`,
    ).trim();
    // "enabled" or "disabled" → registered; "not-found" → not installed
    registered = enabledOutput !== 'not-found' && enabledOutput.length > 0;
  } catch {
    // is-enabled exits non-zero when the unit file doesn't exist at all
    return { registered: false, active: false, pid: null, lastExitStatus: null };
  }

  if (!registered) {
    return { registered: false, active: false, pid: null, lastExitStatus: null };
  }

  // --- Step 2: get active state, PID, last exit status ---
  let active = false;
  let pid: number | null = null;
  let lastExitStatus: number | null = null;

  try {
    const out = runCommand(
      `systemctl --user status ${SERVICE_NAME} --no-pager -l`,
    );

    // Active state — match "Active: active" vs "Active: inactive" etc.
    const activeMatch = out.match(/Active:\s+(\w+)/);
    if (activeMatch?.[1] === 'active') {
      active = true;
    }

    // Main PID — "Main PID: 12345 (node)"
    const pidMatch = out.match(/Main PID:\s+(\d+)/);
    if (pidMatch) {
      const n = parseInt(pidMatch[1], 10);
      if (!Number.isNaN(n)) pid = n;
    }

    // Last exit status — "(code=exited, status=1/FAILURE)" or "status=0/SUCCESS"
    const exitMatch = out.match(/status=(\d+)\//);
    if (exitMatch) {
      const n = parseInt(exitMatch[1], 10);
      if (!Number.isNaN(n)) lastExitStatus = n;
    }
  } catch {
    // status command can exit non-zero when the service is stopped on some
    // systemd versions — still registered, just no detail available
  }

  return { registered, active, pid, lastExitStatus };
}
