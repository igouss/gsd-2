#!/usr/bin/env node

/**
 * wtf-run — Standalone WTF orchestrator CLI.
 *
 * Usage:
 *   wtf-run <projectDir> [options]
 *
 * Options:
 *   --model <id>         Default model (default: claude-sonnet-4-6)
 *   --claude-bin <path>  Path to claude CLI binary (default: "claude")
 *   --max-budget <usd>   Max budget per unit in USD
 *   --verbose            Show debug output
 *   --dry-run            Resolve next dispatch without executing
 *
 * The orchestrator derives state from .wtf/, builds prompts, and dispatches
 * units to Claude Code via the ClaudeCodeAdapter. The executing agent has
 * access to WTF state-mutation tools via an MCP server started automatically.
 */

import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";

import {
  ClaudeCodeAdapter,
  PROJECT_DIR_NAME,
} from "@igouss/wtf-core";
import type { ClaudeCodeAdapterOptions } from "@igouss/wtf-core";
import { consoleEventSink } from "@igouss/wtf-tui";
import { startMcpHost } from "./mcp-host.ts";
import { minimalLoop } from "./minimal-loop.ts";

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

interface CliArgs {
  projectDir: string;
  model: string;
  claudeBin: string;
  maxBudget?: number;
  verbose: boolean;
  dryRun: boolean;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const result: CliArgs = {
    projectDir: "",
    model: "claude-sonnet-4-6",
    claudeBin: "claude",
    verbose: false,
    dryRun: false,
  };

  let i = 0;
  while (i < args.length) {
    const arg = args[i]!;
    switch (arg) {
      case "--model":
        result.model = args[++i]!;
        break;
      case "--claude-bin":
        result.claudeBin = args[++i]!;
        break;
      case "--max-budget":
        result.maxBudget = parseFloat(args[++i]!);
        break;
      case "--verbose":
        result.verbose = true;
        break;
      case "--dry-run":
        result.dryRun = true;
        break;
      case "--help":
      case "-h":
        printUsage();
        process.exit(0);
      default:
        if (arg.startsWith("-")) {
          process.stderr.write(`Unknown option: ${arg}\n`);
          printUsage();
          process.exit(1);
        }
        result.projectDir = arg;
    }
    i++;
  }

  if (!result.projectDir) {
    process.stderr.write("Error: project directory is required\n\n");
    printUsage();
    process.exit(1);
  }

  result.projectDir = resolve(result.projectDir);
  return result;
}

function printUsage(): void {
  process.stderr.write(`
Usage: wtf-run <projectDir> [options]

Options:
  --model <id>         Default model (default: claude-sonnet-4-6)
  --claude-bin <path>  Path to claude CLI binary (default: "claude")
  --max-budget <usd>   Max budget per unit in USD
  --verbose            Show debug output
  --dry-run            Resolve next dispatch without executing
  -h, --help           Show this help
`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function run(): Promise<void> {
  const args = parseArgs();
  const events = consoleEventSink;

  // Validate project dir
  if (!existsSync(args.projectDir)) {
    events.notify(`Project directory does not exist: ${args.projectDir}`, "error");
    process.exit(1);
  }

  const wtfDir = resolve(args.projectDir, PROJECT_DIR_NAME);
  if (!existsSync(wtfDir)) {
    events.notify(`No .wtf/ directory found in ${args.projectDir} — run 'wtf init' first`, "error");
    process.exit(1);
  }

  events.notify(`WTF orchestrator starting for ${args.projectDir}`, "info");
  events.notify(`Model: ${args.model}`, "info");

  // Set up adapter
  const adapterOpts: ClaudeCodeAdapterOptions = {
    cliBinary: args.claudeBin,
    defaultModel: args.model,
    maxBudgetUsd: args.maxBudget,
    events,
    verbose: args.verbose,
  };
  const adapter = new ClaudeCodeAdapter(adapterOpts);

  try {
    await adapter.init(args.projectDir);
  } catch (err) {
    events.notify(`Failed to initialize adapter: ${(err as Error).message}`, "error");
    process.exit(1);
  }

  // Start MCP unit-tools server in this process (SSE transport)
  const mcpHost = await startMcpHost(
    args.projectDir,
    resolve(args.projectDir, PROJECT_DIR_NAME, ".tmp"),
    events,
  );
  events.notify(`MCP config: ${mcpHost.mcpConfigPath}`, "info");

  if (args.dryRun) {
    events.notify("Dry run — would start auto-loop here", "info");
    await adapter.shutdown();
    await mcpHost.shutdown();
    return;
  }

  // Run the minimal dispatch loop
  try {
    // Resolve templates dir from wtf-core package
    const require_ = createRequire(import.meta.url);
    const wtfCorePkg = require_.resolve("@igouss/wtf-core/package.json");
    const templatesDir = resolve(wtfCorePkg, "..", "dist", "templates");

    await minimalLoop({
      adapter,
      events,
      projectDir: args.projectDir,
      mcpConfigPath: mcpHost.mcpConfigPath,
      templatesDir,
    });
  } finally {
    await adapter.shutdown();
    await mcpHost.shutdown();
  }
}

// Direct execution
run().catch((err) => {
  process.stderr.write(`Fatal: ${(err as Error).message}\n`);
  process.exit(1);
});
