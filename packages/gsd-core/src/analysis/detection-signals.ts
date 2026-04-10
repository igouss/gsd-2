/**
 * GSD Detection — Project ecosystem signal detection.
 *
 * detectProjectSignals is the main function: quick filesystem scan for
 * project ecosystem markers (languages, frameworks, CI, tests, etc.).
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ProjectSignals, XcodePlatform } from "./detection-types.js";
import { PROJECT_FILES } from "./detection-types.js";
import {
  LANGUAGE_MAP,
  MONOREPO_MARKERS,
  CI_MARKERS,
  TEST_MARKERS,
  SQLITE_EXTENSIONS,
  SQL_EXTENSIONS,
  VUE_EXTENSIONS,
  ROOT_ONLY_PROJECT_FILES,
  readBounded,
  pushUnique,
  matchesProjectFileMarker,
  isPythonRequirementsFile,
  scanProjectFiles,
} from "./detection-markers.js";
import { containsFastapiDependency, containsSpringBootMarker } from "./detection-frameworks.js";

// ─── Project Signals Detection ──────────────────────────────────────────────────

/**
 * Quick filesystem scan for project ecosystem markers.
 * Reads only file existence + minimal content (package.json for monorepo/scripts).
 */
export function detectProjectSignals(basePath: string): ProjectSignals {
  const detectedFiles: string[] = [];
  let primaryLanguage: string | undefined;

  // Detect project files
  for (const file of PROJECT_FILES) {
    if (existsSync(join(basePath, file))) {
      detectedFiles.push(file);
      if (!primaryLanguage) {
        primaryLanguage = LANGUAGE_MAP[file];
      }
    }
  }

  // Bounded recursive scan for nested markers and dependency files.
  const scannedFiles = scanProjectFiles(basePath);

  for (const file of PROJECT_FILES) {
    if (detectedFiles.includes(file) || ROOT_ONLY_PROJECT_FILES.has(file)) continue;
    const hasMatch = file === "requirements.txt"
      ? scannedFiles.some(isPythonRequirementsFile)
      : scannedFiles.some((scannedFile) => matchesProjectFileMarker(scannedFile, file));
    if (hasMatch) {
      pushUnique(detectedFiles, file);
      if (!primaryLanguage && LANGUAGE_MAP[file]) {
        primaryLanguage = LANGUAGE_MAP[file];
      }
    }
  }

  if (scannedFiles.some((file) => SQLITE_EXTENSIONS.some((ext) => file.endsWith(ext)))) {
    pushUnique(detectedFiles, "*.sqlite");
  }
  if (scannedFiles.some((file) => SQL_EXTENSIONS.some((ext) => file.endsWith(ext)))) {
    pushUnique(detectedFiles, "*.sql");
  }

  const hasCsproj = scannedFiles.some((file) => file.endsWith(".csproj"));
  const hasFsproj = scannedFiles.some((file) => file.endsWith(".fsproj"));
  const hasSln = scannedFiles.some((file) => file.endsWith(".sln"));

  if (hasCsproj) {
    pushUnique(detectedFiles, "*.csproj");
    if (!primaryLanguage) primaryLanguage = "csharp";
  }
  if (hasFsproj) {
    pushUnique(detectedFiles, "*.fsproj");
    if (!primaryLanguage) primaryLanguage = "fsharp";
  }
  if (hasSln) {
    pushUnique(detectedFiles, "*.sln");
    if (!primaryLanguage) primaryLanguage = "dotnet";
  }

  if (scannedFiles.some((file) => VUE_EXTENSIONS.some((ext) => file.endsWith(ext)))) {
    pushUnique(detectedFiles, "*.vue");
  }

  // Python framework detection
  const dependencyFiles = scannedFiles.filter((file) =>
    isPythonRequirementsFile(file) || file.endsWith("pyproject.toml"),
  );
  if (containsFastapiDependency(basePath, dependencyFiles)) {
    pushUnique(detectedFiles, "dep:fastapi");
  }

  const springBootBuildFiles = scannedFiles.filter((file) =>
    file.endsWith("pom.xml") || file.endsWith("build.gradle") || file.endsWith("build.gradle.kts"),
  );
  const springBootVersionCatalogs = scannedFiles.filter((file) => file.endsWith(".versions.toml"));
  const springBootSettingsFiles = scannedFiles.filter((file) =>
    file.endsWith("settings.gradle") || file.endsWith("settings.gradle.kts"),
  );
  if (containsSpringBootMarker(basePath, springBootBuildFiles, springBootVersionCatalogs, springBootSettingsFiles)) {
    pushUnique(detectedFiles, "dep:spring-boot");
    if (!primaryLanguage) {
      primaryLanguage = "java/kotlin";
    }
  }

  // Git repo detection
  const isGitRepo = existsSync(join(basePath, ".git"));

  // Xcode platform detection
  const xcodePlatforms = detectXcodePlatforms(basePath);

  if (!primaryLanguage && xcodePlatforms.length > 0) {
    primaryLanguage = "swift";
  }

  // Monorepo detection
  let isMonorepo = false;
  for (const marker of MONOREPO_MARKERS) {
    if (existsSync(join(basePath, marker))) {
      isMonorepo = true;
      break;
    }
  }
  if (!isMonorepo && detectedFiles.includes("package.json")) {
    isMonorepo = packageJsonHasWorkspaces(basePath);
  }

  // CI detection
  let hasCI = false;
  for (const marker of CI_MARKERS) {
    if (existsSync(join(basePath, marker))) {
      hasCI = true;
      break;
    }
  }

  // Test detection
  let hasTests = false;
  for (const marker of TEST_MARKERS) {
    if (existsSync(join(basePath, marker))) {
      hasTests = true;
      break;
    }
  }

  // Package manager detection
  const packageManager = detectPackageManager(basePath);

  // Verification commands
  const verificationCommands = detectVerificationCommands(basePath, detectedFiles, packageManager);

  return {
    detectedFiles,
    isGitRepo,
    isMonorepo,
    primaryLanguage,
    xcodePlatforms,
    hasCI,
    hasTests,
    packageManager,
    verificationCommands,
  };
}

// ─── Xcode Platform Detection ───────────────────────────────────────────────────

/** Known SDKROOT values → canonical platform names. */
const SDKROOT_MAP: Record<string, XcodePlatform> = {
  iphoneos: "iphoneos",
  iphonesimulator: "iphoneos",
  macosx: "macosx",
  watchos: "watchos",
  watchsimulator: "watchos",
  appletvos: "appletvos",
  appletvsimulator: "appletvos",
  xros: "xros",
  xrsimulator: "xros",
};

/** Regex for SUPPORTED_PLATFORMS — fallback when SDKROOT = auto (Xcode 15+). */
const SUPPORTED_PLATFORMS_RE = /SUPPORTED_PLATFORMS\s*=\s*"([^"]+)"/gi;

/** Common subdirectories where .xcodeproj may live in monorepos / standard layouts. */
const XCODE_SUBDIRS = ["ios", "macos", "app", "apps"] as const;

/**
 * Scan *.xcodeproj directories for project.pbxproj and extract SDKROOT values.
 * Returns deduplicated, canonical platform list (e.g. ["iphoneos"]).
 */
function detectXcodePlatforms(basePath: string): XcodePlatform[] {
  const platforms = new Set<XcodePlatform>();

  const dirsToScan = [basePath];
  for (const sub of XCODE_SUBDIRS) {
    const subPath = join(basePath, sub);
    if (existsSync(subPath)) dirsToScan.push(subPath);
  }

  for (const dir of dirsToScan) {
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || !entry.name.endsWith(".xcodeproj")) continue;
        const pbxprojPath = join(dir, entry.name, "project.pbxproj");
        try {
          const content = readBounded(pbxprojPath, 1024 * 1024);
          const sdkRe = /SDKROOT\s*=\s*"?([a-z]+)"?\s*;/gi;
          let m: RegExpExecArray | null;
          let foundExplicit = false;
          while ((m = sdkRe.exec(content)) !== null) {
            const val = m[1].toLowerCase();
            if (val === "auto") continue;
            const canonical = SDKROOT_MAP[val];
            if (canonical) {
              platforms.add(canonical);
              foundExplicit = true;
            }
          }
          if (!foundExplicit) {
            let sp: RegExpExecArray | null;
            while ((sp = SUPPORTED_PLATFORMS_RE.exec(content)) !== null) {
              for (const tok of sp[1].split(/\s+/)) {
                const canonical = SDKROOT_MAP[tok.toLowerCase()];
                if (canonical) platforms.add(canonical);
              }
            }
            SUPPORTED_PLATFORMS_RE.lastIndex = 0;
          }
        } catch {
          // unreadable pbxproj — skip
        }
      }
    } catch {
      // unreadable directory
    }
  }
  return [...platforms];
}

// ─── Package Manager Detection ──────────────────────────────────────────────────

function detectPackageManager(basePath: string): string | undefined {
  if (existsSync(join(basePath, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(basePath, "yarn.lock"))) return "yarn";
  if (existsSync(join(basePath, "bun.lockb")) || existsSync(join(basePath, "bun.lock"))) return "bun";
  if (existsSync(join(basePath, "package-lock.json"))) return "npm";
  if (existsSync(join(basePath, "package.json"))) return "npm";
  return undefined;
}

// ─── Verification Command Detection ─────────────────────────────────────────────

function detectVerificationCommands(
  basePath: string,
  detectedFiles: string[],
  packageManager?: string,
): string[] {
  const commands: string[] = [];
  const pm = packageManager ?? "npm";
  const run = pm === "npm" ? "npm run" : pm === "yarn" ? "yarn" : pm === "bun" ? "bun run" : `${pm} run`;

  if (detectedFiles.includes("package.json")) {
    const scripts = readPackageJsonScripts(basePath);
    if (scripts) {
      if (scripts.test && scripts.test !== "echo \"Error: no test specified\" && exit 1") {
        commands.push(pm === "npm" ? "npm test" : `${pm} test`);
      }
      if (scripts.build) {
        commands.push(`${run} build`);
      }
      if (scripts.lint) {
        commands.push(`${run} lint`);
      }
      if (scripts.typecheck) {
        commands.push(`${run} typecheck`);
      } else if (scripts.tsc) {
        commands.push(`${run} tsc`);
      }
    }
  }

  if (detectedFiles.includes("Cargo.toml")) {
    commands.push("cargo test");
    commands.push("cargo clippy");
  }

  if (detectedFiles.includes("go.mod")) {
    commands.push("go test ./...");
    commands.push("go vet ./...");
  }

  if (detectedFiles.includes("pyproject.toml") || detectedFiles.includes("setup.py") || detectedFiles.includes("requirements.txt")) {
    commands.push("pytest");
  }

  if (detectedFiles.includes("Gemfile")) {
    if (existsSync(join(basePath, "spec"))) {
      commands.push("bundle exec rspec");
    } else {
      commands.push("bundle exec rake test");
    }
  }

  if (detectedFiles.includes("Makefile")) {
    const makeTargets = readMakefileTargets(basePath);
    if (makeTargets.includes("test")) {
      commands.push("make test");
    }
  }

  return commands;
}

// ─── Helpers ────────────────────────────────────────────────────────────────────

function packageJsonHasWorkspaces(basePath: string): boolean {
  try {
    const raw = readFileSync(join(basePath, "package.json"), "utf-8");
    const pkg = JSON.parse(raw);
    return Array.isArray(pkg.workspaces) || (pkg.workspaces && typeof pkg.workspaces === "object");
  } catch {
    return false;
  }
}

function readPackageJsonScripts(basePath: string): Record<string, string> | null {
  try {
    const raw = readFileSync(join(basePath, "package.json"), "utf-8");
    const pkg = JSON.parse(raw);
    return pkg.scripts && typeof pkg.scripts === "object" ? pkg.scripts : null;
  } catch {
    return null;
  }
}

function readMakefileTargets(basePath: string): string[] {
  try {
    const raw = readFileSync(join(basePath, "Makefile"), "utf-8");
    const targets: string[] = [];
    for (const line of raw.split("\n")) {
      const match = line.match(/^([a-zA-Z_][a-zA-Z0-9_-]*):/);
      if (match) targets.push(match[1]);
    }
    return targets;
  } catch {
    return [];
  }
}
