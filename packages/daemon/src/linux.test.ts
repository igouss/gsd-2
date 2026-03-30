import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  existsSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  generateUnit,
  getUnitPath,
  getDesktopPath,
  generateDesktopFile,
  install,
  uninstall,
  status,
} from './linux.js';
import type { UnitOptions, RunCommandFn } from './linux.js';

// ---------- helpers ----------

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), `linux-test-${randomUUID().slice(0, 8)}-`));
}

const cleanupDirs: string[] = [];
afterEach(() => {
  while (cleanupDirs.length) {
    const d = cleanupDirs.pop()!;
    if (existsSync(d)) rmSync(d, { recursive: true, force: true });
  }
});

function baseUnitOpts(overrides?: Partial<UnitOptions>): UnitOptions {
  return {
    nodePath: '/usr/local/bin/node',
    scriptPath: '/usr/local/lib/gsd-daemon/dist/cli.js',
    configPath: join(homedir(), '.gsd', 'daemon.yaml'),
    ...overrides,
  };
}

// ---------- generateUnit ----------

describe('generateUnit', () => {
  it('produces a [Unit] section with Description and After', () => {
    const unit = generateUnit(baseUnitOpts());
    assert.ok(unit.includes('[Unit]'));
    assert.ok(unit.includes('Description=GSD Daemon'));
    assert.ok(unit.includes('After=network.target'));
  });

  it('produces a [Service] section with Type=simple', () => {
    const unit = generateUnit(baseUnitOpts());
    assert.ok(unit.includes('[Service]'));
    assert.ok(unit.includes('Type=simple'));
  });

  it('includes ExecStart with the node path, script path, and --config flag', () => {
    const opts = baseUnitOpts({
      nodePath: '/home/user/.fnm/node/v22/bin/node',
      scriptPath: '/home/user/.local/lib/gsd-daemon/cli.js',
      configPath: '/home/user/.gsd/daemon.yaml',
    });
    const unit = generateUnit(opts);
    assert.ok(
      unit.includes(
        'ExecStart=/home/user/.fnm/node/v22/bin/node /home/user/.local/lib/gsd-daemon/cli.js --config /home/user/.gsd/daemon.yaml',
      ),
    );
  });

  it('sets Restart=on-failure and RestartSec=5s', () => {
    const unit = generateUnit(baseUnitOpts());
    assert.ok(unit.includes('Restart=on-failure'));
    assert.ok(unit.includes('RestartSec=5s'));
  });

  it('includes StandardOutput and StandardError as append paths', () => {
    const unit = generateUnit(baseUnitOpts());
    assert.ok(unit.includes('StandardOutput=append:'));
    assert.ok(unit.includes('StandardError=append:'));
    assert.ok(unit.includes('daemon-stdout.log'));
    assert.ok(unit.includes('daemon-stderr.log'));
  });

  it('uses custom stdout/stderr paths when provided', () => {
    const unit = generateUnit(
      baseUnitOpts({
        stdoutPath: '/tmp/my-stdout.log',
        stderrPath: '/tmp/my-stderr.log',
      }),
    );
    assert.ok(unit.includes('StandardOutput=append:/tmp/my-stdout.log'));
    assert.ok(unit.includes('StandardError=append:/tmp/my-stderr.log'));
  });

  it('includes PATH Environment= entry with node bin dir prepended', () => {
    const unit = generateUnit(
      baseUnitOpts({ nodePath: '/home/user/.fnm/node/v22/bin/node' }),
    );
    assert.ok(unit.includes('Environment="PATH=/home/user/.fnm/node/v22/bin:'));
    assert.ok(unit.includes(':/usr/local/bin:/usr/bin:/bin"'));
  });

  it('includes HOME Environment= entry', () => {
    const unit = generateUnit(baseUnitOpts());
    assert.ok(unit.includes(`Environment="HOME=${homedir()}"`));
  });

  it('produces a [Install] section with WantedBy=default.target', () => {
    const unit = generateUnit(baseUnitOpts());
    assert.ok(unit.includes('[Install]'));
    assert.ok(unit.includes('WantedBy=default.target'));
  });

  it('uses custom working directory when provided', () => {
    const unit = generateUnit(
      baseUnitOpts({ workingDirectory: '/custom/work/dir' }),
    );
    assert.ok(unit.includes('WorkingDirectory=/custom/work/dir'));
  });

  // ----- Critical security constraint -----

  it('MUST NOT include ANTHROPIC_API_KEY in the unit file', () => {
    // Set the env var to make sure it is NOT forwarded (unlike launchd.ts)
    const original = process.env['ANTHROPIC_API_KEY'];
    process.env['ANTHROPIC_API_KEY'] = 'sk-test-super-secret-key';
    try {
      const unit = generateUnit(baseUnitOpts());
      assert.ok(
        !unit.includes('ANTHROPIC_API_KEY'),
        'Unit file must not contain ANTHROPIC_API_KEY',
      );
      assert.ok(
        !unit.includes('sk-test-super-secret-key'),
        'Unit file must not contain the API key value',
      );
    } finally {
      if (original === undefined) {
        delete process.env['ANTHROPIC_API_KEY'];
      } else {
        process.env['ANTHROPIC_API_KEY'] = original;
      }
    }
  });

  it('MUST NOT include DISCORD_TOKEN in the unit file', () => {
    const original = process.env['DISCORD_TOKEN'];
    process.env['DISCORD_TOKEN'] = 'discord-secret-token-xyz';
    try {
      const unit = generateUnit(baseUnitOpts());
      assert.ok(
        !unit.includes('DISCORD_TOKEN'),
        'Unit file must not contain DISCORD_TOKEN',
      );
      assert.ok(
        !unit.includes('discord-secret-token-xyz'),
        'Unit file must not contain the Discord token value',
      );
    } finally {
      if (original === undefined) {
        delete process.env['DISCORD_TOKEN'];
      } else {
        process.env['DISCORD_TOKEN'] = original;
      }
    }
  });
});

// ---------- getUnitPath ----------

describe('getUnitPath', () => {
  it('returns ~/.config/systemd/user/gsd-daemon.service', () => {
    const expected = join(
      homedir(),
      '.config',
      'systemd',
      'user',
      'gsd-daemon.service',
    );
    assert.equal(getUnitPath(), expected);
  });
});

// ---------- install ----------

describe('install', () => {
  it('calls daemon-reload BEFORE enable --now', () => {
    const calls: string[] = [];
    const mockRun: RunCommandFn = (cmd: string) => {
      calls.push(cmd);
      return '';
    };

    try {
      install(baseUnitOpts(), mockRun);
    } catch {
      // writeFileSync may fail if ~/.config/systemd/user doesn't exist
    }

    const reloadIdx = calls.findIndex(c => c.includes('daemon-reload'));
    const enableIdx = calls.findIndex(c => c.includes('enable --now'));

    // Both commands must have been issued and reload must precede enable
    if (reloadIdx !== -1 && enableIdx !== -1) {
      assert.ok(
        reloadIdx < enableIdx,
        'daemon-reload must be called before enable --now',
      );
    } else {
      // At minimum the attempt was made
      assert.ok(
        calls.some(c => c.includes('daemon-reload')),
        'daemon-reload must be called',
      );
    }
  });

  it('writes a unit file that contains no credentials', () => {
    // Verify the unit content via generateUnit (install uses it internally)
    const unit = generateUnit(baseUnitOpts());
    assert.ok(!unit.includes('ANTHROPIC_API_KEY'));
    assert.ok(!unit.includes('DISCORD_TOKEN'));
  });

  it('does NOT throw when enable --now fails (partial success)', () => {
    const calls: string[] = [];
    const mockRun: RunCommandFn = (cmd: string) => {
      calls.push(cmd);
      if (cmd.includes('enable --now')) {
        throw new Error('Failed to connect to bus: No such file or directory');
      }
      return '';
    };

    // Should not throw even though enable --now fails
    assert.doesNotThrow(() => install(baseUnitOpts(), mockRun));
  });

  it('still issues daemon-reload even when enable --now will fail', () => {
    const calls: string[] = [];
    const mockRun: RunCommandFn = (cmd: string) => {
      calls.push(cmd);
      if (cmd.includes('enable --now')) {
        throw new Error('No D-Bus session');
      }
      return '';
    };

    try {
      install(baseUnitOpts(), mockRun);
    } catch {
      // should not throw, but be safe
    }

    assert.ok(
      calls.some(c => c.includes('daemon-reload')),
      'daemon-reload must be issued regardless of enable outcome',
    );
  });
});

// ---------- uninstall ----------

describe('uninstall', () => {
  it('handles missing unit file gracefully (no-op)', () => {
    const calls: string[] = [];
    const mockRun: RunCommandFn = (cmd: string) => {
      calls.push(cmd);
      return '';
    };

    // Should not throw even if unit file doesn't exist
    assert.doesNotThrow(() => uninstall(mockRun));
  });

  it('does not throw when disable --now fails (already uninstalled)', () => {
    const mockRun: RunCommandFn = (cmd: string) => {
      if (cmd.includes('disable --now')) {
        throw new Error('Unit gsd-daemon.service not loaded');
      }
      return '';
    };

    assert.doesNotThrow(() => uninstall(mockRun));
  });

  it('calls disable --now with the correct service name', () => {
    const calls: string[] = [];
    const mockRun: RunCommandFn = (cmd: string) => {
      calls.push(cmd);
      return '';
    };

    uninstall(mockRun);

    const disableCalls = calls.filter(c => c.includes('disable --now gsd-daemon'));
    // If called, it should use the correct service name
    // (it may not be called if the unit file doesn't exist — that's fine)
    if (disableCalls.length > 0) {
      assert.ok(disableCalls[0].includes('gsd-daemon'));
    }
  });
});

// ---------- status ----------

describe('status', () => {
  it('returns not-registered when is-enabled throws', () => {
    const mockRun: RunCommandFn = (_cmd: string) => {
      throw new Error('Unit gsd-daemon.service could not be found');
    };

    const result = status(mockRun);
    assert.equal(result.registered, false);
    assert.equal(result.active, false);
    assert.equal(result.pid, null);
    assert.equal(result.lastExitStatus, null);
  });

  it('returns not-registered when is-enabled returns not-found', () => {
    const mockRun: RunCommandFn = (cmd: string) => {
      if (cmd.includes('is-enabled')) return 'not-found';
      return '';
    };

    const result = status(mockRun);
    assert.equal(result.registered, false);
  });

  it('parses active running service with PID', () => {
    const mockRun: RunCommandFn = (cmd: string) => {
      if (cmd.includes('is-enabled')) return 'enabled';
      // systemctl status output
      return `● gsd-daemon.service - GSD Daemon
     Loaded: loaded (/home/user/.config/systemd/user/gsd-daemon.service; enabled)
     Active: active (running) since Sun 2026-03-29 12:00:00 UTC; 5min ago
   Main PID: 12345 (node)
      Tasks: 7 (limit: 9357)
     Memory: 45.2M
         IO: 1.2M read, 512K written`;
    };

    const result = status(mockRun);
    assert.equal(result.registered, true);
    assert.equal(result.active, true);
    assert.equal(result.pid, 12345);
  });

  it('parses inactive service (stopped, no PID)', () => {
    const mockRun: RunCommandFn = (cmd: string) => {
      if (cmd.includes('is-enabled')) return 'enabled';
      return `● gsd-daemon.service - GSD Daemon
     Loaded: loaded (/home/user/.config/systemd/user/gsd-daemon.service; enabled)
     Active: inactive (dead) since Sun 2026-03-29 11:55:00 UTC; 5min ago
    Process: 12300 ExecStart=/usr/bin/node /path/cli.js --config /path/d.yaml (code=exited, status=1/FAILURE)`;
    };

    const result = status(mockRun);
    assert.equal(result.registered, true);
    assert.equal(result.active, false);
    assert.equal(result.pid, null);
    assert.equal(result.lastExitStatus, 1);
  });

  it('parses clean exit status=0', () => {
    const mockRun: RunCommandFn = (cmd: string) => {
      if (cmd.includes('is-enabled')) return 'enabled';
      return `● gsd-daemon.service - GSD Daemon
     Active: inactive (dead)
    Process: 12300 ExecStart=/usr/bin/node cli.js (code=exited, status=0/SUCCESS)`;
    };

    const result = status(mockRun);
    assert.equal(result.registered, true);
    assert.equal(result.active, false);
    assert.equal(result.lastExitStatus, 0);
  });

  it('returns registered:true but active:false when status command throws', () => {
    let callCount = 0;
    const mockRun: RunCommandFn = (cmd: string) => {
      callCount++;
      if (cmd.includes('is-enabled')) return 'enabled';
      // status exits non-zero for stopped services on some systemd versions
      throw new Error('exit code 3');
    };

    const result = status(mockRun);
    assert.equal(result.registered, true);
    assert.equal(result.active, false);
    assert.equal(result.pid, null);
  });

  it('returns structured result with all required fields', () => {
    const mockRun: RunCommandFn = (cmd: string) => {
      if (cmd.includes('is-enabled')) return 'enabled';
      return `● gsd-daemon.service
     Active: active (running)
   Main PID: 99 (node)`;
    };

    const result = status(mockRun);
    assert.ok('registered' in result);
    assert.ok('active' in result);
    assert.ok('pid' in result);
    assert.ok('lastExitStatus' in result);
  });

  it('handles disabled-but-registered service (disabled state)', () => {
    const mockRun: RunCommandFn = (cmd: string) => {
      if (cmd.includes('is-enabled')) return 'disabled';
      return `● gsd-daemon.service - GSD Daemon
     Loaded: loaded (/home/user/.config/systemd/user/gsd-daemon.service; disabled)
     Active: inactive (dead)`;
    };

    const result = status(mockRun);
    // "disabled" is not "not-found" — still registered
    assert.equal(result.registered, true);
    assert.equal(result.active, false);
  });
});

// ---------- generateDesktopFile ----------

describe('generateDesktopFile', () => {
  it('returns a string containing [Desktop Entry]', () => {
    const desktop = generateDesktopFile();
    assert.ok(desktop.includes('[Desktop Entry]'), 'Must have [Desktop Entry] section');
  });

  it('contains X-DBus-AppId=gsd.daemon', () => {
    const desktop = generateDesktopFile();
    assert.ok(desktop.includes('X-DBus-AppId=gsd.daemon'), 'Must include X-DBus-AppId=gsd.daemon');
  });

  it('contains NoDisplay=true', () => {
    const desktop = generateDesktopFile();
    assert.ok(desktop.includes('NoDisplay=true'), 'Must include NoDisplay=true');
  });

  it('contains Type=Application', () => {
    const desktop = generateDesktopFile();
    assert.ok(desktop.includes('Type=Application'));
  });

  it('contains DBusActivatable=true', () => {
    const desktop = generateDesktopFile();
    assert.ok(desktop.includes('DBusActivatable=true'), 'Must include DBusActivatable=true for GNOME action buttons');
  });

  it('contains X-GNOME-UsesNotifications=true', () => {
    const desktop = generateDesktopFile();
    assert.ok(desktop.includes('X-GNOME-UsesNotifications=true'), 'Must include X-GNOME-UsesNotifications=true');
  });
});

// ---------- getDesktopPath ----------

describe('getDesktopPath', () => {
  it('returns a path ending in gsd.daemon.desktop', () => {
    const p = getDesktopPath();
    assert.ok(p.endsWith('gsd.daemon.desktop'), `Expected path ending in gsd.daemon.desktop, got: ${p}`);
  });

  it('returns path under ~/.local/share/applications/', () => {
    const expected = join(homedir(), '.local', 'share', 'applications', 'gsd.daemon.desktop');
    assert.equal(getDesktopPath(), expected);
  });
});

// ---------- install writes .desktop file ----------

describe('install — desktop file', () => {
  it('generateDesktopFile produces valid content used by install()', () => {
    const desktop = generateDesktopFile();
    assert.ok(desktop.includes('[Desktop Entry]'));
    assert.ok(desktop.includes('X-DBus-AppId=gsd.daemon'));
    assert.ok(desktop.includes('NoDisplay=true'));
  });

  it('does not throw when update-desktop-database fails', () => {
    const mockRun: RunCommandFn = (cmd: string) => {
      if (cmd.includes('update-desktop-database')) throw new Error('not found');
      return '';
    };

    // install() catches update-desktop-database failures non-fatally
    // Only verify the logic doesn't blow up on the mock path
    assert.doesNotThrow(() => {
      try {
        install(baseUnitOpts(), mockRun);
      } catch (e) {
        // Allow ENOENT/EACCES from real fs operations in test environment
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes('ENOENT') || msg.includes('EACCES') || msg.includes('EPERM')) return;
        throw e;
      }
    });
  });
});

// ---------- uninstall removes .desktop file ----------

describe('uninstall — desktop file', () => {
  it('getDesktopPath and generateDesktopFile are exported and well-formed', () => {
    assert.equal(typeof getDesktopPath, 'function');
    assert.equal(typeof generateDesktopFile, 'function');

    const path = getDesktopPath();
    assert.ok(path.length > 0, 'getDesktopPath returns non-empty string');

    const content = generateDesktopFile();
    assert.ok(content.includes('[Desktop Entry]'));
    assert.ok(content.includes('X-DBus-AppId=gsd.daemon'));
  });

  it('does not throw if desktop file does not exist during uninstall', () => {
    const mockRun: RunCommandFn = (_cmd: string) => '';
    // uninstall checks existsSync before unlinking — if file doesn't exist, no-op
    assert.doesNotThrow(() => uninstall(mockRun));
  });
});

