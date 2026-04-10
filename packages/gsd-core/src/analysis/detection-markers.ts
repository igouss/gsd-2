/**
 * GSD Detection — Marker constants, scan limits, and shared low-level utilities.
 */

import { openSync, readSync, closeSync, readdirSync } from "node:fs";
import { join } from "node:path";

// ─── Language & Marker Maps ─────────────────────────────────────────────────────

export const LANGUAGE_MAP: Record<string, string> = {
  "package.json": "javascript/typescript",
  "Cargo.toml": "rust",
  "go.mod": "go",
  "pyproject.toml": "python",
  "setup.py": "python",
  "Gemfile": "ruby",
  "pom.xml": "java",
  "build.gradle": "java/kotlin",
  "build.gradle.kts": "kotlin",
  "app/build.gradle": "java/kotlin",
  "app/build.gradle.kts": "kotlin",
  "CMakeLists.txt": "c/c++",
  "composer.json": "php",
  "pubspec.yaml": "dart/flutter",
  "Package.swift": "swift",
  "mix.exs": "elixir",
  "deno.json": "typescript/deno",
  "deno.jsonc": "typescript/deno",
  ".sln": "dotnet",
  ".csproj": "dotnet",
  "Directory.Build.props": "dotnet",
  "project.yml": "swift/xcode",
  ".xcodeproj": "swift/xcode",
  ".xcworkspace": "swift/xcode",
  "Dockerfile": "docker",
  "manage.py": "python",
  "requirements.txt": "python",
};

export const MONOREPO_MARKERS = [
  "lerna.json",
  "nx.json",
  "turbo.json",
  "pnpm-workspace.yaml",
] as const;

export const CI_MARKERS = [
  ".github/workflows",
  ".gitlab-ci.yml",
  "Jenkinsfile",
  ".circleci",
  ".travis.yml",
  "azure-pipelines.yml",
  "bitbucket-pipelines.yml",
] as const;

export const TEST_MARKERS = [
  "__tests__",
  "tests",
  "test",
  "spec",
  "jest.config.js",
  "jest.config.ts",
  "vitest.config.ts",
  "vitest.config.js",
  ".mocharc.yml",
  "pytest.ini",
  "conftest.py",
  "phpunit.xml",
] as const;

// ─── Extension Sets ─────────────────────────────────────────────────────────────

/** File extensions that indicate SQLite databases in the project. */
export const SQLITE_EXTENSIONS = [".sqlite", ".sqlite3", ".db"] as const;

/** File extensions that indicate SQL usage (migrations, schemas, seeds). */
export const SQL_EXTENSIONS = [".sql"] as const;

/** File extensions that indicate .NET / C# projects. */
export const DOTNET_EXTENSIONS = [".csproj", ".sln", ".fsproj"] as const;

/** File extensions that indicate Vue.js single-file components. */
export const VUE_EXTENSIONS = [".vue"] as const;

// ─── Scan Limits ────────────────────────────────────────────────────────────────

/** Directories skipped during bounded recursive project scans. */
export const RECURSIVE_SCAN_IGNORED_DIRS = new Set([
  ".git",
  ".gsd",
  ".planning",
  ".plans",
  ".claude",
  ".cursor",
  ".vscode",
  "node_modules",
  ".venv",
  "venv",
  "dist",
  "build",
  "coverage",
  ".next",
  ".nuxt",
  "target",
  "vendor",
  ".turbo",
  "Pods",
  "bin",
  "obj",
  ".gradle",
  "DerivedData",
  "out",
]) as ReadonlySet<string>;

/** Project file markers safe to detect recursively via suffix matching. */
export const ROOT_ONLY_PROJECT_FILES: Set<string> = new Set<string>([
  ".github/workflows",
  "package.json",
  "Gemfile",
  "Makefile",
  "CMakeLists.txt",
  "build.gradle",
  "build.gradle.kts",
  "deno.json",
  "deno.jsonc",
]);

export const MAX_RECURSIVE_SCAN_FILES = 2000;
export const MAX_RECURSIVE_SCAN_DEPTH = 6;

// ─── Shared Utilities ───────────────────────────────────────────────────────────

/** Read at most `maxBytes` from a file without loading the full file into memory. */
export function readBounded(filePath: string, maxBytes: number): string {
  const buf = Buffer.alloc(maxBytes);
  const fd = openSync(filePath, "r");
  try {
    const bytesRead = readSync(fd, buf, 0, maxBytes, 0);
    return buf.toString("utf-8", 0, bytesRead);
  } finally {
    closeSync(fd);
  }
}

export function pushUnique(arr: string[], value: string): void {
  if (!arr.includes(value)) arr.push(value);
}

export function matchesProjectFileMarker(scannedFile: string, marker: string): boolean {
  const normalized = scannedFile.replaceAll("\\", "/");
  return (
    normalized === marker ||
    normalized.endsWith(`/${marker}`)
  );
}

export function isPythonRequirementsFile(relativePath: string): boolean {
  const normalized = relativePath.replaceAll("\\", "/");
  const basename = normalized.slice(normalized.lastIndexOf("/") + 1);
  return (
    basename === "requirements.txt" ||
    basename === "requirements.in" ||
    /^requirements([-.].+)?\.(txt|in)$/i.test(basename) ||
    /(^|\/)requirements\/.+\.(txt|in)$/i.test(normalized)
  );
}

// ─── Recursive Project File Scanner ─────────────────────────────────────────────

export function scanProjectFiles(basePath: string): string[] {
  const files: string[] = [];
  const queue: Array<{ path: string; depth: number }> = [{ path: basePath, depth: 0 }];

  while (queue.length > 0 && files.length < MAX_RECURSIVE_SCAN_FILES) {
    const current = queue.shift()!;
    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
    try {
      entries = readdirSync(current.path, { withFileTypes: true, encoding: "utf8" });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const entryPath = join(current.path, entry.name);
      const relativePath = entryPath.slice(basePath.length + 1);

      if (entry.isDirectory()) {
        if (current.depth < MAX_RECURSIVE_SCAN_DEPTH && !RECURSIVE_SCAN_IGNORED_DIRS.has(entry.name)) {
          queue.push({ path: entryPath, depth: current.depth + 1 });
        }
        continue;
      }

      if (!entry.isFile()) continue;
      files.push(relativePath);
      if (files.length >= MAX_RECURSIVE_SCAN_FILES) break;
    }
  }

  return files;
}
