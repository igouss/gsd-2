/**
 * WTF Detection — Type definitions and project file markers.
 */

// ─── Types ──────────────────────────────────────────────────────────────────────

export interface ProjectDetection {
  /** What kind of WTF state exists in this directory */
  state: "none" | "v1-planning" | "v2-wtf" | "v2-wtf-empty";

  /** Is this the first time WTF has been used on this machine? */
  isFirstEverLaunch: boolean;

  /** Does ~/.wtf/ exist with preferences? */
  hasGlobalSetup: boolean;

  /** v1 details (only when state === 'v1-planning') */
  v1?: V1Detection;

  /** v2 details (only when state === 'v2-wtf' or 'v2-wtf-empty') */
  v2?: V2Detection;

  /** Detected project ecosystem signals */
  projectSignals: ProjectSignals;
}

export interface V1Detection {
  path: string;
  hasPhasesDir: boolean;
  hasRoadmap: boolean;
  phaseCount: number;
}

export interface V2Detection {
  milestoneCount: number;
  hasPreferences: boolean;
  hasContext: boolean;
}

/** Apple platform SDKROOTs found in Xcode project.pbxproj files. */
export type XcodePlatform = "iphoneos" | "macosx" | "watchos" | "appletvos" | "xros";

export interface ProjectSignals {
  /** Detected project/package files */
  detectedFiles: string[];
  /** Is this already a git repo? */
  isGitRepo: boolean;
  /** Is this a monorepo? */
  isMonorepo: boolean;
  /** Primary language hint */
  primaryLanguage?: string;
  /** Apple platform SDKROOTs detected from *.xcodeproj/project.pbxproj */
  xcodePlatforms: XcodePlatform[];
  /** Has existing CI configuration? */
  hasCI: boolean;
  /** Has existing test setup? */
  hasTests: boolean;
  /** Detected package manager */
  packageManager?: string;
  /** Auto-detected verification commands */
  verificationCommands: string[];
}

// ─── Project File Markers ───────────────────────────────────────────────────────

export const PROJECT_FILES = [
  "package.json",
  "Cargo.toml",
  "go.mod",
  "pyproject.toml",
  "setup.py",
  "Gemfile",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "CMakeLists.txt",
  "Makefile",
  "composer.json",
  "pubspec.yaml",
  "Package.swift",
  "mix.exs",
  "deno.json",
  "deno.jsonc",
  // .NET
  ".sln",
  ".csproj",
  "Directory.Build.props",
  // Git submodules
  ".gitmodules",
  // Xcode
  "project.yml",
  ".xcodeproj",
  ".xcworkspace",
  // Cloud platform config files
  "firebase.json",
  "cdk.json",
  "samconfig.toml",
  "serverless.yml",
  "serverless.yaml",
  "azure-pipelines.yml",
  // Database / ORM config files
  "prisma/schema.prisma",
  "supabase/config.toml",
  "drizzle.config.ts",
  "drizzle.config.js",
  "redis.conf",
  // React Native markers
  "metro.config.js",
  "metro.config.ts",
  "react-native.config.js",
  // Frontend framework config files
  "angular.json",
  "next.config.js",
  "next.config.ts",
  "next.config.mjs",
  "nuxt.config.ts",
  "nuxt.config.js",
  "svelte.config.js",
  "svelte.config.ts",
  // Vue CLI config files
  "vue.config.js",
  "vue.config.ts",
  // Frontend tooling
  "tailwind.config.js",
  "tailwind.config.ts",
  "tailwind.config.mjs",
  "tailwind.config.cjs",
  // Android project markers
  "app/build.gradle",
  "app/build.gradle.kts",
  // Container / DevOps config files
  "Dockerfile",
  "docker-compose.yml",
  "docker-compose.yaml",
  // Infrastructure as Code
  "main.tf",
  // Kubernetes / Helm markers
  "Chart.yaml",
  "kustomization.yaml",
  // CI/CD markers
  ".github/workflows",
  // Blockchain / Web3 markers
  "hardhat.config.js",
  "hardhat.config.ts",
  "foundry.toml",
  // Data engineering markers
  "dbt_project.yml",
  "airflow.cfg",
  // Game engine markers
  "ProjectSettings/ProjectVersion.txt",
  "project.godot",
  // Python framework markers
  "manage.py",
  "requirements.txt",
] as const;
