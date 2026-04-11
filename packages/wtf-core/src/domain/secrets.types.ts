// Secrets manifest types: credential tracking and status.

export type SecretsManifestEntryStatus = "pending" | "collected" | "skipped";

export interface SecretsManifestEntry {
  key: string; // e.g. "OPENAI_API_KEY"
  service: string; // e.g. "OpenAI"
  dashboardUrl: string; // e.g. "https://platform.openai.com/api-keys" — empty if unknown
  guidance: string[]; // numbered setup steps
  formatHint: string; // e.g. "starts with sk-" — empty if unknown
  status: SecretsManifestEntryStatus;
  destination: string; // e.g. "dotenv", "vercel", "convex"
}

export interface SecretsManifest {
  milestone: string; // e.g. "M001"
  generatedAt: string; // ISO 8601 timestamp
  entries: SecretsManifestEntry[];
}

export interface ManifestStatus {
  pending: string[]; // manifest status = pending AND not in env
  collected: string[]; // manifest status = collected AND not in env
  skipped: string[]; // manifest status = skipped
  existing: string[]; // key present in .env or process.env (regardless of manifest status)
}
