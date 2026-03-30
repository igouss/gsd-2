#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { resolveConfigPath, loadConfig } from './config.js';
import { Logger } from './logger.js';
import { Daemon } from './daemon.js';
import { install, uninstall, status } from './launchd.js';
import { install as linuxInstall, uninstall as linuxUninstall, status as linuxStatus } from './linux.js';
import { SecretServiceAdapter } from './secret-service.js';

const USAGE = `Usage: gsd-daemon [options]

Options:
  --config <path>  Path to YAML config file (default: ~/.gsd/daemon.yaml)
  --verbose        Print log entries to stderr in addition to the log file
  --install        Install the daemon service (systemd on Linux, launchd on macOS)
  --uninstall      Uninstall the daemon service
  --status         Show daemon service status (registered, PID, exit code)
  --help           Show this help message and exit

Platform support:
  Linux   systemd user service (~/.config/systemd/user/gsd-daemon.service)
  macOS   launchd LaunchAgent (~/Library/LaunchAgents/com.gsd.daemon.plist)
`;

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      config: { type: 'string', short: 'c' },
      verbose: { type: 'boolean', short: 'v', default: false },
      install: { type: 'boolean', default: false },
      uninstall: { type: 'boolean', default: false },
      status: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
  });

  if (values.help) {
    process.stdout.write(USAGE);
    process.exit(0);
  }

  // --- service lifecycle commands (dispatch before Daemon creation) ---

  if (values.install) {
    const configPath = resolveConfigPath(values.config);
    const thisFile = fileURLToPath(import.meta.url);
    const scriptPath = resolve(dirname(thisFile), 'cli.js');

    if (process.platform === 'linux') {
      // Install systemd user service
      linuxInstall({ nodePath: process.execPath, scriptPath, configPath });

      // Store credentials in keyring (D003 — never write them to the unit file)
      const adapter = new SecretServiceAdapter();
      const anthropicKey = process.env['ANTHROPIC_API_KEY'];
      const config = loadConfig(configPath);
      const discordToken = process.env['DISCORD_TOKEN'] ?? config.discord?.token;
      const creds: Array<[string, string]> = [];
      if (anthropicKey) creds.push(['ANTHROPIC_API_KEY', anthropicKey]);
      if (discordToken) creds.push(['DISCORD_TOKEN', discordToken]);
      const results = await Promise.allSettled(
        creds.map(([key, val]) => adapter.storeCredential(key, val)),
      );
      results.forEach((result, i) => {
        if (result.status === 'rejected') {
          const key = creds[i]![0];
          const e = result.reason;
          process.stderr.write(
            `gsd-daemon: warn: keyring store failed for ${key}: ${e instanceof Error ? e.message : String(e)}\n`,
          );
        }
      });
      if (creds.length === 0) {
        process.stderr.write(
          'gsd-daemon: warn: ANTHROPIC_API_KEY not set — credentials not stored in keyring.\n',
        );
      }
      process.stdout.write('gsd-daemon: systemd user service installed.\n');
    } else {
      // macOS launchd path
      install({
        nodePath: process.execPath,
        scriptPath,
        configPath,
      });
      process.stdout.write('gsd-daemon: launchd agent installed and loaded.\n');
    }
    process.exit(0);
  }

  if (values.uninstall) {
    if (process.platform === 'linux') {
      linuxUninstall();
      process.stdout.write('gsd-daemon: systemd user service uninstalled.\n');
    } else {
      uninstall();
      process.stdout.write('gsd-daemon: launchd agent uninstalled.\n');
    }
    process.exit(0);
  }

  if (values.status) {
    if (process.platform === 'linux') {
      const result = linuxStatus();
      if (!result.registered) {
        process.stdout.write('gsd-daemon: not registered with systemd.\n');
      } else if (result.active && result.pid != null) {
        process.stdout.write(`gsd-daemon: running (PID ${result.pid})\n`);
      } else {
        process.stdout.write(
          `gsd-daemon: registered but not running (last exit status: ${result.lastExitStatus ?? 'n/a'})\n`,
        );
      }
    } else {
      const result = status();
      if (!result.registered) {
        process.stdout.write('gsd-daemon: not registered with launchd.\n');
      } else if (result.pid != null) {
        process.stdout.write(
          `gsd-daemon: running (PID ${result.pid}, last exit status: ${result.lastExitStatus ?? 'n/a'})\n`,
        );
      } else {
        process.stdout.write(
          `gsd-daemon: registered but not running (last exit status: ${result.lastExitStatus ?? 'n/a'})\n`,
        );
      }
    }
    process.exit(0);
  }

  // --- normal daemon start ---

  const configPath = resolveConfigPath(values.config);
  const config = loadConfig(configPath);

  const logger = new Logger({
    filePath: config.log.file,
    level: config.log.level,
    verbose: values.verbose,
  });

  const daemon = new Daemon(config, logger);
  await daemon.start();
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`gsd-daemon: fatal: ${msg}\n`);
  process.exit(1);
});
