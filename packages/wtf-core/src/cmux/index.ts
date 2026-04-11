/**
 * cmux/index.ts — Stub for cmux integration (harness-coupled).
 *
 * The real cmux module provides terminal multiplexer integration.
 * This stub exports the types and no-op functions that wtf-core needs.
 */

import type { WTFPreferences } from "../preferences/preferences.ts";

export type CmuxLogLevel = "info" | "progress" | "success" | "warning" | "error";

export interface CmuxEnvironment {
  available: boolean;
  cliAvailable: boolean;
  socketPath: string;
  workspaceId?: string;
  surfaceId?: string;
}

export interface ResolvedCmuxConfig extends CmuxEnvironment {
  enabled: boolean;
  notifications: boolean;
  sidebar: boolean;
  splits: boolean;
  browser: boolean;
}

export class CmuxClient {
  constructor(_config: ResolvedCmuxConfig) {}

  static fromPreferences(_preferences: WTFPreferences | undefined): CmuxClient {
    return new CmuxClient({
      available: false,
      cliAvailable: false,
      socketPath: "",
      enabled: false,
      notifications: false,
      sidebar: false,
      splits: false,
      browser: false,
    });
  }

  notify(_title: string, _message: string): boolean {
    return false;
  }

  getConfig(): ResolvedCmuxConfig {
    return {
      available: false,
      cliAvailable: false,
      socketPath: "",
      enabled: false,
      notifications: false,
      sidebar: false,
      splits: false,
      browser: false,
    };
  }
}

export function emitOsc777Notification(_title: string, _body: string): void {
  // Stub — no terminal multiplexer available in standalone mode
}

export function resolveCmuxConfig(
  _preferences: WTFPreferences | undefined,
  _env: NodeJS.ProcessEnv = process.env,
): ResolvedCmuxConfig {
  return {
    available: false,
    cliAvailable: false,
    socketPath: "",
    enabled: false,
    notifications: false,
    sidebar: false,
    splits: false,
    browser: false,
  };
}
