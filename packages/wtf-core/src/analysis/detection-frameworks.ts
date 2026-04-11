/**
 * WTF Detection — Framework-specific dependency detection (FastAPI, Spring Boot).
 */

import { join } from "node:path";
import { readBounded, isPythonRequirementsFile } from "./detection-markers.ts";

// ─── FastAPI Detection ──────────────────────────────────────────────────────────

export function containsFastapiDependency(basePath: string, relativePaths: string[]): boolean {
  for (const relativePath of relativePaths) {
    try {
      const raw = readBounded(join(basePath, relativePath), 64 * 1024);
      const content = extractDependencyContent(relativePath, raw);
      if (isPythonRequirementsFile(relativePath)) {
        for (const line of content.split("\n")) {
          if (extractRequirementName(line) === "fastapi") return true;
        }
        continue;
      }

      if (relativePath.endsWith("pyproject.toml")) {
        if (containsFastapiInPyproject(content)) return true;
      }
    } catch {
      // unreadable file — continue scanning other candidate files
    }
  }

  return false;
}

function containsFastapiInPyproject(content: string): boolean {
  for (const line of content.split("\n")) {
    const keyMatch = line.match(/^\s*([A-Za-z0-9_.-]+)\s*=/);
    if (keyMatch) {
      const key = normalizePackageName(keyMatch[1]!);
      if (key === "fastapi") {
        return true;
      }
      if (key !== "dependencies") {
        continue;
      }
    }

    const quotedSpecRe = /["']([^"']+)["']/g;
    let match: RegExpExecArray | null;
    while ((match = quotedSpecRe.exec(line)) !== null) {
      if (extractRequirementName(match[1]!) === "fastapi") {
        return true;
      }
    }
  }

  return false;
}

// ─── Spring Boot Detection ──────────────────────────────────────────────────────

export function containsSpringBootMarker(
  basePath: string,
  buildFiles: string[],
  versionCatalogFiles: string[],
  settingsFiles: string[],
): boolean {
  const usedPluginAliases = new Set<string>();
  const usedLibraryAliases = new Set<string>();
  const catalogAccessors = resolveVersionCatalogAccessors(basePath, versionCatalogFiles, settingsFiles);

  for (const relativePath of buildFiles) {
    try {
      const raw = readBounded(join(basePath, relativePath), 64 * 1024);
      const content = stripDependencyComments(relativePath, raw);
      if (containsDirectSpringBootReference(relativePath, content)) {
        return true;
      }

      const normalized = content.toLowerCase();
      let match: RegExpExecArray | null;
      for (const accessor of catalogAccessors) {
        const aliasRe = new RegExp(`alias\\(\\s*${accessor}\\.plugins\\.([a-z0-9_.-]+)\\s*\\)`, "gi");
        while ((match = aliasRe.exec(normalized)) !== null) {
          usedPluginAliases.add(normalizePluginAlias(match[1]!));
        }

        const libraryAliasRe = new RegExp(`\\b${accessor}\\.((?!plugins\\b)[a-z0-9_.-]+)`, "gi");
        while ((match = libraryAliasRe.exec(normalized)) !== null) {
          usedLibraryAliases.add(normalizePluginAlias(match[1]!));
        }
      }
    } catch {
      // unreadable build file — continue scanning others
    }
  }

  if (usedPluginAliases.size === 0 && usedLibraryAliases.size === 0) {
    return false;
  }
  if (versionCatalogFiles.length === 0) {
    return false;
  }

  const springBootAliases = new Set<string>();
  const springBootLibraries = new Set<string>();
  const pendingSpringBootBundles: Array<{ bundleAlias: string; referencedAliases: string[] }> = [];
  for (const relativePath of versionCatalogFiles) {
    try {
      const raw = readBounded(join(basePath, relativePath), 64 * 1024);
      const content = stripDependencyComments(relativePath, raw);
      const aliasRe = /^\s*([A-Za-z0-9_.-]+)\s*=\s*\{[^\n}]*\bid\s*=\s*["']org\.springframework\.boot["'][^\n}]*\}/gm;
      let match: RegExpExecArray | null;
      while ((match = aliasRe.exec(content)) !== null) {
        springBootAliases.add(normalizePluginAlias(match[1]!));
      }

      const libraryRe = /^\s*([A-Za-z0-9_.-]+)\s*=\s*\{[^\n}]*\b(module\s*=\s*["']org\.springframework\.boot:[^"']+["']|group\s*=\s*["']org\.springframework\.boot["'][^\n}]*\bname\s*=\s*["']spring-boot[^"']*["'])[^\n}]*\}/gm;
      while ((match = libraryRe.exec(content)) !== null) {
        springBootLibraries.add(normalizePluginAlias(match[1]!));
      }

      const bundleRe = /^\s*([A-Za-z0-9_.-]+)\s*=\s*\[([\s\S]*?)\]/gm;
      while ((match = bundleRe.exec(content)) !== null) {
        pendingSpringBootBundles.push({
          bundleAlias: normalizePluginAlias(`bundles.${match[1]!}`),
          referencedAliases: match[2]!
            .split(",")
            .map((part) => normalizePluginAlias(part.replace(/["'\s]/g, "")))
            .filter(Boolean),
        });
      }
    } catch {
      // unreadable version catalog — continue scanning others
    }
  }

  const springBootBundles = new Set<string>();
  for (const pendingBundle of pendingSpringBootBundles) {
    if (pendingBundle.referencedAliases.some((alias) => springBootLibraries.has(alias))) {
      springBootBundles.add(pendingBundle.bundleAlias);
    }
  }

  for (const alias of usedPluginAliases) {
    if (springBootAliases.has(alias)) return true;
  }
  for (const alias of usedLibraryAliases) {
    if (springBootLibraries.has(alias) || springBootBundles.has(alias)) return true;
  }

  return false;
}

function containsDirectSpringBootReference(relativePath: string, content: string): boolean {
  if (relativePath.endsWith("pom.xml")) {
    return /<groupId>\s*org\.springframework\.boot\s*<\/groupId>/i.test(content);
  }

  if (relativePath.endsWith("build.gradle") || relativePath.endsWith("build.gradle.kts")) {
    return /(id\s*\(?\s*["']org\.springframework\.boot["']|apply\s*\(?\s*plugin\s*[:=]\s*["']org\.springframework\.boot["']|(?:implementation|api|compileOnly|runtimeOnly|testImplementation|annotationProcessor|kapt)\s*\(?\s*["'][^"']*org\.springframework\.boot:[^"']*spring-boot[^"']*["'])/i.test(content);
  }

  return false;
}

function resolveVersionCatalogAccessors(
  basePath: string,
  versionCatalogFiles: string[],
  settingsFiles: string[],
): Set<string> {
  const accessors = new Set(versionCatalogFiles.map(versionCatalogAccessorName).filter(Boolean));
  if (versionCatalogFiles.length === 0 || settingsFiles.length === 0) {
    return accessors;
  }

  for (const settingsFile of settingsFiles) {
    try {
      const raw = readBounded(join(basePath, settingsFile), 64 * 1024);
      const content = stripDependencyComments(settingsFile, raw);
      const createRe = /create\(\s*["']([A-Za-z0-9_]+)["']\s*\)\s*\{[\s\S]*?([A-Za-z0-9_.-]+\.versions\.toml)["']?\s*\)\s*\)/g;
      let match: RegExpExecArray | null;
      while ((match = createRe.exec(content)) !== null) {
        const accessor = match[1]!.toLowerCase();
        const catalogBasename = match[2]!.replaceAll("\\", "/").split("/").pop()!;
        if (versionCatalogFiles.some((file) => {
          const normalized = file.replaceAll("\\", "/");
          return normalized === catalogBasename || normalized.endsWith(`/${catalogBasename}`);
        })) {
          accessors.add(accessor);
        }
      }
    } catch {
      // unreadable settings file — ignore
    }
  }

  return accessors;
}

// ─── Shared Helpers ─────────────────────────────────────────────────────────────

export function stripDependencyComments(relativePath: string, content: string): string {
  if (relativePath.endsWith("requirements.txt")) {
    return content.replace(/(^|\s)#.*$/gm, "");
  }
  if (relativePath.endsWith("pyproject.toml")) {
    return content.replace(/(^|\s)#.*$/gm, "");
  }
  if (relativePath.endsWith(".versions.toml")) {
    return content.replace(/(^|\s)#.*$/gm, "");
  }
  if (relativePath.endsWith("settings.gradle") || relativePath.endsWith("settings.gradle.kts")) {
    return content
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
  }
  if (relativePath.endsWith("pom.xml")) {
    return content.replace(/<!--[\s\S]*?-->/g, "");
  }
  if (relativePath.endsWith("build.gradle") || relativePath.endsWith("build.gradle.kts")) {
    return content
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
  }
  return content;
}

function extractDependencyContent(relativePath: string, content: string): string {
  const stripped = stripDependencyComments(relativePath, content);
  if (relativePath.endsWith("pyproject.toml")) {
    return extractPyprojectDependencySections(stripped);
  }
  return stripped;
}

function extractRequirementName(spec: string): string | null {
  const trimmed = spec.trim().replace(/^["']|["']$/g, "");
  if (!trimmed) return null;

  const match = trimmed.match(/^([A-Za-z0-9_.-]+)(?:\[[^\]]+\])?(?=\s*(?:@|[<>=!~;]|$))/);
  if (!match) return null;
  return normalizePackageName(match[1]!);
}

function extractPyprojectDependencySections(content: string): string {
  const lines = content.split("\n");
  const collected: string[] = [];
  let section = "";
  let collectingProjectDeps = false;
  let collectingOptionalDeps = false;
  let bracketDepth = 0;

  for (const line of lines) {
    const trimmed = line.trim();

    if (collectingProjectDeps) {
      collected.push(line);
      bracketDepth += countChar(line, "[") - countChar(line, "]");
      if (bracketDepth <= 0) {
        collectingProjectDeps = false;
      }
      continue;
    }

    if (collectingOptionalDeps) {
      collected.push(line);
      bracketDepth += countChar(line, "[") - countChar(line, "]");
      if (bracketDepth <= 0) {
        collectingOptionalDeps = false;
      }
      continue;
    }

    const sectionMatch = trimmed.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      section = sectionMatch[1]!.trim();
      continue;
    }

    if (section === "project" && /^dependencies\s*=\s*\[/.test(trimmed)) {
      collected.push(line);
      bracketDepth = countChar(line, "[") - countChar(line, "]");
      collectingProjectDeps = bracketDepth > 0;
      continue;
    }

    if (
      section === "project.optional-dependencies" ||
      section === "tool.poetry.dependencies"
    ) {
      if (section === "project.optional-dependencies") {
        const equalsIndex = line.indexOf("=");
        if (equalsIndex !== -1) {
          const value = line.slice(equalsIndex + 1);
          collected.push(value);
          bracketDepth = countChar(value, "[") - countChar(value, "]");
          collectingOptionalDeps = bracketDepth > 0;
        }
      } else {
        collected.push(line);
      }
    }
  }

  return collected.join("\n");
}

function countChar(text: string, char: string): number {
  return [...text].filter((c) => c === char).length;
}

function normalizePackageName(name: string): string {
  return name.toLowerCase().replace(/[_.]/g, "-");
}

function normalizePluginAlias(alias: string): string {
  return alias.toLowerCase().replace(/[-_]/g, ".");
}

function versionCatalogAccessorName(relativePath: string): string {
  const normalized = relativePath.replaceAll("\\", "/");
  const basename = normalized.slice(normalized.lastIndexOf("/") + 1);
  return basename.replace(/\.versions\.toml$/i, "").toLowerCase();
}
