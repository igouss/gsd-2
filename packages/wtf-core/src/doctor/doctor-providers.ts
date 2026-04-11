/**
 * doctor-providers.ts — Stub for harness-coupled provider checks.
 *
 * Real implementation depends on AuthStorage and getEnvApiKey from
 * @wtf/pi-coding-agent and @wtf/pi-ai. This exports the types
 * and a no-op function for wtf-core compilation.
 */

export type ProviderCategory = "llm" | "tool" | "integration";
export type ProviderCheckStatus = "ok" | "warning" | "error" | "unconfigured";

export interface ProviderCheckResult {
  name: string;
  label: string;
  category: ProviderCategory;
  status: ProviderCheckStatus;
  message: string;
  detail?: string;
  required: boolean;
}

export function runProviderChecks(): ProviderCheckResult[] {
  // Stub — real implementation checks API keys and auth state
  return [];
}
