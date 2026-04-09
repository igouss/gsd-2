/**
 * skills-loader.ts — Scans skill directories and builds a skills table
 * for the system prompt.
 *
 * Skills are directories containing a SKILL.md with YAML frontmatter
 * (name, description). The agent reads the full SKILL.md at runtime
 * when a task matches.
 */

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface SkillEntry {
  name: string;
  description: string;
  path: string;
}

/**
 * Default skill directories to scan.
 */
export function defaultSkillDirs(): string[] {
  return [
    join(homedir(), ".agents", "skills"),  // user global
  ];
}

/**
 * Scan skill directories for SKILL.md files and parse their frontmatter.
 */
export function scanSkills(dirs: string[]): SkillEntry[] {
  const skills: SkillEntry[] = [];
  const seen = new Set<string>();

  for (const dir of dirs) {
    if (!existsSync(dir)) continue;

    let entries: string[];
    try {
      entries = readdirSync(dir, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name);
    } catch {
      continue;
    }

    for (const entry of entries) {
      const skillPath = join(dir, entry, "SKILL.md");
      if (!existsSync(skillPath)) continue;

      try {
        const content = readFileSync(skillPath, "utf-8");
        const parsed = parseFrontmatter(content);
        if (!parsed.name) continue;
        if (seen.has(parsed.name)) continue;
        seen.add(parsed.name);

        skills.push({
          name: parsed.name,
          description: parsed.description || "",
          path: skillPath,
        });
      } catch {
        // Skip unparseable skills
      }
    }
  }

  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Build a markdown table of available skills for the system prompt.
 */
export function buildSkillsTable(skills: SkillEntry[]): string {
  if (skills.length === 0) {
    return "_No skills found. Place skill directories in `~/.agents/skills/`._";
  }

  const lines = [
    "| Skill | Description | Path |",
    "|-------|-------------|------|",
  ];

  for (const skill of skills) {
    // Truncate description to keep the table readable
    const desc = skill.description.length > 120
      ? skill.description.slice(0, 117) + "..."
      : skill.description;
    lines.push(`| ${skill.name} | ${desc} | \`${skill.path}\` |`);
  }

  return lines.join("\n");
}

/**
 * Parse YAML frontmatter from a SKILL.md file.
 * Handles the --- delimited block at the start.
 */
function parseFrontmatter(content: string): { name: string; description: string } {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return { name: "", description: "" };

  const block = match[1];
  let name = "";
  let description = "";

  // Simple YAML parsing — handles single-line and multi-line (>) values
  const lines = block.split("\n");
  let currentKey = "";
  let multiLineValue = "";
  let inMultiLine = false;

  for (const line of lines) {
    if (inMultiLine) {
      if (line.match(/^\S/) && !line.startsWith("  ")) {
        // New key — flush multi-line
        if (currentKey === "description") description = multiLineValue.trim();
        inMultiLine = false;
      } else {
        multiLineValue += " " + line.trim();
        continue;
      }
    }

    const kvMatch = line.match(/^(\w+):\s*(.*)/);
    if (kvMatch) {
      const [, key, value] = kvMatch;
      if (key === "name") {
        name = value.trim().replace(/^["']|["']$/g, "");
      } else if (key === "description") {
        if (value.trim() === ">" || value.trim() === "|") {
          currentKey = "description";
          multiLineValue = "";
          inMultiLine = true;
        } else {
          description = value.trim().replace(/^["']|["']$/g, "");
        }
      }
    }
  }

  // Flush trailing multi-line
  if (inMultiLine && currentKey === "description") {
    description = multiLineValue.trim();
  }

  return { name, description };
}
