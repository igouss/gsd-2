// Verification gate types: check results, runtime errors, audit warnings.

/** Result of a single verification command execution */
export interface VerificationCheck {
  command: string; // e.g. "npm run lint"
  exitCode: number; // 0 = pass
  stdout: string;
  stderr: string;
  durationMs: number;
}

/** A runtime error captured from bg-shell processes or browser console */
export interface RuntimeError {
  source: "bg-shell" | "browser";
  severity: "crash" | "error" | "warning";
  message: string;
  blocking: boolean;
}

/** A dependency vulnerability warning from npm audit */
export interface AuditWarning {
  name: string;
  severity: "low" | "moderate" | "high" | "critical";
  title: string;
  url: string;
  fixAvailable: boolean;
}

/** Aggregate result from the verification gate */
export interface VerificationResult {
  passed: boolean; // true if all checks passed (or no checks discovered)
  checks: VerificationCheck[]; // per-command results
  discoverySource: "preference" | "task-plan" | "package-json" | "none";
  timestamp: number; // Date.now() at gate start
  runtimeErrors?: RuntimeError[]; // optional — populated by captureRuntimeErrors()
  auditWarnings?: AuditWarning[]; // optional — populated by runDependencyAudit()
}
