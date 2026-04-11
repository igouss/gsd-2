/**
 * ClaudeCodeAdapter — dispatches WTF units to the Claude Code CLI.
 *
 * Each unit is executed as: claude -p <prompt> --output-format json
 * with an MCP config pointing to the WTF unit-tools server.
 *
 * Completion is detected by process exit. Cost/tokens are parsed from
 * the JSON result.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { writeFileSync, readFileSync, mkdirSync, unlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import type {
  HarnessAdapter,
  UnitDispatchRequest,
  UnitDispatchResult,
  OrchestratorEventSink,
} from "./harness-adapter.ts";
import { nullEventSink } from "./harness-adapter.ts";

// ---------------------------------------------------------------------------
// Claude CLI result shape (from --output-format json)
// ---------------------------------------------------------------------------

interface ClaudeResultOutput {
  type: "result";
  subtype: "success" | "error";
  is_error: boolean;
  duration_ms: number;
  result: string;
  stop_reason?: string;
  total_cost_usd?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

interface ClaudeUserOutput {
  type: "user";
  message?: {
    content?: Array<{ type: string; text?: string }> | string;
  };
  result?: string;
}

/** Discriminated union of all possible Claude CLI JSON outputs. */
type ClaudeCliOutput = ClaudeResultOutput | ClaudeUserOutput | { type: string };

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface ClaudeCodeAdapterOptions {
  /** Path to the `claude` CLI binary. Default: "claude" (resolved via PATH). */
  cliBinary?: string;

  /** Default model ID to use when UnitDispatchRequest.modelId is not set. */
  defaultModel?: string;

  /** Permission mode. Default: "bypassPermissions" (headless execution). */
  permissionMode?: string;

  /** Max budget in USD per unit dispatch. Optional. */
  maxBudgetUsd?: number;

  /** Additional CLI flags passed to every invocation. */
  extraArgs?: string[];

  /** Path to a CLAUDE.md file to append as system prompt context. */
  claudeMdPath?: string;

  /** Event sink for streaming agent activity. */
  events?: OrchestratorEventSink;

  /** Stream agent stderr to the event sink in real-time. Default: false. */
  verbose?: boolean;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class ClaudeCodeAdapter implements HarnessAdapter {
  readonly name = "claude-code";

  private projectDir = "";
  private currentProc: ChildProcess | null = null;
  private tempDir: string;
  private readonly opts: Required<
    Pick<ClaudeCodeAdapterOptions, "cliBinary" | "permissionMode">
  > &
    ClaudeCodeAdapterOptions;

  private events: OrchestratorEventSink;
  private verbose: boolean;

  constructor(options: ClaudeCodeAdapterOptions = {}) {
    this.opts = {
      cliBinary: options.cliBinary ?? "claude",
      permissionMode: options.permissionMode ?? "bypassPermissions",
      ...options,
    };
    this.events = options.events ?? nullEventSink;
    this.verbose = options.verbose ?? false;
    this.tempDir = join(tmpdir(), `wtf-claude-${randomUUID().slice(0, 8)}`);
  }

  async init(projectDir: string): Promise<void> {
    this.projectDir = projectDir;
    mkdirSync(this.tempDir, { recursive: true });

    // Validate claude CLI is available
    await new Promise<void>((resolve, reject) => {
      const proc = spawn(this.opts.cliBinary, ["--version"], {
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 10_000,
      });
      let stdout = "";
      proc.stdout?.on("data", (d: Buffer) => {
        stdout += d.toString();
      });
      proc.on("error", (err) =>
        reject(new Error(`claude CLI not found: ${err.message}`)),
      );
      proc.on("close", (code) => {
        if (code === 0) {
          process.stderr.write(
            `[claude-code-adapter] CLI version: ${stdout.trim()}\n`,
          );
          resolve();
        } else {
          reject(
            new Error(`claude --version exited with code ${code}`),
          );
        }
      });
    });
  }

  async dispatchUnit(
    request: UnitDispatchRequest,
  ): Promise<UnitDispatchResult> {
    // Write prompt to a temp file (avoids shell escaping issues with large prompts)
    const safeId = request.unitId.replace(/\//g, "_");
    const promptFile = join(
      this.tempDir,
      `prompt-${request.unitType}-${safeId}-${Date.now()}.md`,
    );
    writeFileSync(promptFile, request.prompt, "utf-8");

    // Build CLI args — use stream-json for real-time progress, json for quiet mode
    const outputFormat = this.verbose ? "stream-json" : "json";
    const args: string[] = [
      "-p",
      "--output-format",
      outputFormat,
      "--no-session-persistence",
      "--permission-mode",
      this.opts.permissionMode,
      ...(this.verbose ? ["--verbose"] : []),
    ];

    if (request.modelId) {
      args.push("--model", request.modelId);
    } else if (this.opts.defaultModel) {
      args.push("--model", this.opts.defaultModel);
    }

    if (request.mcpConfigPath) {
      args.push("--mcp-config", request.mcpConfigPath);
    }

    if (this.opts.maxBudgetUsd !== undefined) {
      args.push("--max-budget-usd", String(this.opts.maxBudgetUsd));
    }

    if (request.systemPrompt) {
      const systemFile = join(
        this.tempDir,
        `system-${Date.now()}.md`,
      );
      writeFileSync(systemFile, request.systemPrompt, "utf-8");
      args.push("--system-prompt-file", systemFile);
    }

    if (this.opts.extraArgs) {
      args.push(...this.opts.extraArgs);
    }

    // Execute
    return new Promise<UnitDispatchResult>((resolve) => {
      const proc = spawn(this.opts.cliBinary, args, {
        cwd: request.cwd || this.projectDir,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          // Ensure the agent doesn't try to use interactive features
          CI: "true",
        },
      });

      this.currentProc = proc;
      let stdout = "";
      let stderr = "";
      let lastResultLine = "";  // for stream-json: the final result JSON

      proc.stdout?.on("data", (d: Buffer) => {
        const chunk = d.toString();
        stdout += chunk;

        if (this.verbose) {
          // In stream-json mode, each line is a JSON event.
          // Parse and display meaningful events.
          for (const line of chunk.split("\n").filter(Boolean)) {
            try {
              const event = JSON.parse(line);
              // Only keep "result" or "user" lines for final parse.
              // "result" = normal completion, "user" = agent asked a question (fatal).
              // All other types (system, rate_limit_event, etc.) are ignored.
              if (event.type === "result" || event.type === "user") {
                lastResultLine = line;
              }
              this.handleStreamEvent(event, request);
            } catch {
              // Not JSON — ignore partial lines
            }
          }
        }
      });
      proc.stderr?.on("data", (d: Buffer) => {
        const chunk = d.toString();
        stderr += chunk;
        if (this.verbose) {
          // Stream stderr through — this shows MCP server logs, tool errors, etc.
          for (const line of chunk.split("\n").filter(Boolean)) {
            this.events.notify(`  ${line}`, "info");
          }
        }
      });

      // Feed the prompt via stdin
      proc.stdin?.write(readPromptFile(promptFile));
      proc.stdin?.end();

      proc.on("error", (err) => {
        this.currentProc = null;
        cleanupFile(promptFile);
        resolve({
          status: "error",
          errorContext: {
            message: `Failed to spawn claude: ${err.message}`,
            category: "session-failed",
            isTransient: false,
          },
        });
      });

      proc.on("close", (code, signal) => {
        this.currentProc = null;
        cleanupFile(promptFile);

        if (signal === "SIGTERM" || signal === "SIGKILL") {
          resolve({
            status: "cancelled",
            errorContext: {
              message: `Process killed by ${signal}`,
              category: "aborted",
              isTransient: false,
            },
          });
          return;
        }

        if (code !== 0 && !stdout.trim()) {
          resolve({
            status: "error",
            errorContext: {
              message: `claude exited with code ${code}: ${stderr.slice(0, 500)}`,
              category: "unknown",
              isTransient: code === 1,
            },
          });
          return;
        }

        // Parse result — in stream-json mode, use the last "result"/"user" line;
        // in json mode, the entire stdout is the result.
        const jsonToParse = this.verbose ? lastResultLine : stdout;
        if (this.verbose && !lastResultLine) {
          // Stream mode but no result/user line — process exited without completing
          resolve({
            status: "error",
            errorContext: {
              message: `Claude CLI exited (code ${code}) without producing a result — likely killed by timeout or signal`,
              category: "timeout",
              isTransient: true,
            },
          });
          return;
        }
        const result = parseClaudeResult(jsonToParse);
        resolve(result);
      });
    });
  }

  /**
   * Handle a stream-json event from Claude CLI — extract meaningful
   * progress info and forward to the event sink.
   */
  private handleStreamEvent(
    event: Record<string, unknown>,
    _request: UnitDispatchRequest,
  ): void {
    const type = event.type as string;

    if (type === "assistant" && event.message) {
      const msg = event.message as Record<string, unknown>;
      const content = msg.content as Array<Record<string, unknown>> | undefined;
      if (content) {
        for (const block of content) {
          if (block.type === "tool_use") {
            this.events.notify(
              `  🔧 ${block.name as string}`,
              "info",
            );
          } else if (block.type === "text" && typeof block.text === "string") {
            // Show first 120 chars of assistant text
            const preview = block.text.length > 120
              ? block.text.slice(0, 120) + "..."
              : block.text;
            if (preview.trim()) {
              this.events.notify(`  💬 ${preview}`, "info");
            }
          }
        }
      }
    } else if (type === "tool_result" || type === "tool_execution_end") {
      // Tool completed — no action needed
    } else if (type === "rate_limit_event") {
      const info = event.rate_limit_info as Record<string, unknown> | undefined;
      const status = info?.status as string | undefined;
      if (status && status !== "allowed") {
        const resetsAt = info?.resetsAt as number | undefined;
        const resetTime = resetsAt ? new Date(resetsAt * 1000).toISOString() : "unknown";
        this.events.notify(
          `Rate limited (status: ${status}, resets: ${resetTime}). Stopping execution.`,
          "warning",
        );
        // Kill the process — no point continuing under rate limit
        this.currentProc?.kill("SIGTERM");
      }
    } else if (type === "user" || type === "system") {
      // Expected stream events:
      // - "user": the prompt / conversation turn echoed back (normal in stream-json)
      // - "system": system messages
    } else if (type === "result") {
      const subtype = event.subtype as string;
      const cost = event.total_cost_usd as number | undefined;
      this.events.notify(
        `  ✓ ${subtype}${cost ? ` ($${cost.toFixed(4)})` : ""}`,
        subtype === "success" ? "success" : "warning",
      );
    } else {
      // Unknown event type — log so we notice new CLI output formats
      this.events.notify(
        `Unknown CLI event type: ${type} — ${JSON.stringify(event).slice(0, 200)}`,
        "warning",
      );
    }
  }

  async cancelUnit(): Promise<void> {
    if (this.currentProc && !this.currentProc.killed) {
      this.currentProc.kill("SIGTERM");
      // Give it 5s then force kill
      const proc = this.currentProc;
      setTimeout(() => {
        if (!proc.killed) {
          proc.kill("SIGKILL");
        }
      }, 5_000);
    }
  }

  async shutdown(): Promise<void> {
    await this.cancelUnit();
    // Clean up temp directory
    try {
      rmSync(this.tempDir, { recursive: true, force: true });
    } catch {
      // Best effort cleanup
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readPromptFile(path: string): string {
  return readFileSync(path, "utf-8");
}

function cleanupFile(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Best effort
  }
}

/**
 * Extract the question text from a `type: "user"` CLI output event.
 * Handles both stream-json events (with message.content array) and
 * json-mode output (with result string).
 */
function extractQuestionText(parsed: ClaudeUserOutput | Record<string, unknown>): string {
  const msg = (parsed as ClaudeUserOutput).message;
  if (msg) {
    const { content } = msg;
    if (Array.isArray(content)) {
      const texts = content
        .filter((b): b is { type: string; text: string } => b.type === "text" && typeof b.text === "string")
        .map((b) => b.text);
      if (texts.length > 0) return texts.join(" ").slice(0, 500);
    }
    if (typeof content === "string") return content.slice(0, 500);
  }
  const result = (parsed as ClaudeUserOutput).result;
  if (typeof result === "string") return result.slice(0, 500);
  // Fallback: dump raw JSON so we can debug the structure
  return `(unknown structure) ${JSON.stringify(parsed).slice(0, 500)}`;
}

function parseClaudeResult(stdout: string): UnitDispatchResult {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return {
      status: "error",
      errorContext: {
        message: "Empty output from claude CLI",
        category: "unknown",
        isTransient: true,
      },
    };
  }

  let parsed: ClaudeCliOutput;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    return {
      status: "error",
      errorContext: {
        message: `Failed to parse claude JSON output: ${(err as Error).message}`,
        category: "unknown",
        isTransient: false,
      },
    };
  }

  if (parsed.type === "user") {
    // Agent asked a question in headless mode — this is a fatal error.
    // It means the task requirements are underspecified and need human
    // clarification before the agent can proceed.
    const questionText = extractQuestionText(parsed);
    return {
      status: "error",
      errorContext: {
        message: `Agent asked a user question in headless mode — requirements are underspecified. Question: ${questionText}`,
        category: "session-failed",
        isTransient: false,
      },
    };
  }

  if (parsed.type !== "result") {
    return {
      status: "error",
      errorContext: {
        message: `Unexpected output type: ${parsed.type}`,
        category: "unknown",
        isTransient: false,
      },
    };
  }

  // After the guards above, parsed is guaranteed to be ClaudeResultOutput
  const result = parsed as ClaudeResultOutput;

  const cost = result.total_cost_usd
    ? {
        totalCost: result.total_cost_usd,
        tokens: {
          input: result.usage?.input_tokens ?? 0,
          output: result.usage?.output_tokens ?? 0,
          cacheRead: result.usage?.cache_read_input_tokens ?? 0,
          cacheWrite: result.usage?.cache_creation_input_tokens ?? 0,
        },
      }
    : undefined;

  if (result.is_error || result.subtype === "error") {
    return {
      status: "error",
      errorContext: {
        message: result.result || "Claude CLI reported an error",
        category: "provider",
        isTransient: true,
        stopReason: result.stop_reason,
      },
      cost,
    };
  }

  return {
    status: "completed",
    cost,
  };
}
