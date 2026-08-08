/**
 * Skill importer — normalizes SKILL.md files from the five ecosystems into
 * AnoClaw Skill instances while preserving unknown frontmatter.
 */

import * as path from 'path';
import { Skill, SkillSource, type SkillOrigin } from '../../skills/Skill.js';
import { parseSkillMarkdown } from '../../skills/SkillParser.js';
import type { EcosystemAsset, EcosystemKind } from '../types.js';
import { substituteSkillPathVars } from '../placeholders.js';

export interface ImportedSkill {
  skill: Skill;
  warnings: string[];
}

/** OpenClaw-style fallback: frontmatter keys are single-line `key: value`. */
function parseOpenClawStyleFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string } | null {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n*/);
  if (!m) return null;
  const fm: Record<string, unknown> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    let value: string = line.slice(idx + 1).trim();
    if (!key || !value) continue;
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    fm[key] = value;
  }
  if (!fm.name && !fm.description) return null;
  const body = content.slice(m[0].length).trim();
  return { frontmatter: fm, body };
}

/** Build a normalized SKILL.md string from frontmatter + body. */
function renderFrontmatter(fm: Record<string, unknown>): string {
  const lines = ['---'];
  for (const [key, value] of Object.entries(fm)) {
    if (typeof value === 'string') lines.push(`${key}: ${JSON.stringify(value)}`);
    else lines.push(`${key}: ${JSON.stringify(value)}`);
  }
  lines.push('---');
  return lines.join('\n') + '\n';
}

export function parseSkillAsset(
  asset: EcosystemAsset,
  mountName?: string,
  gates: { ok: boolean; reasons: string[] } = { ok: true, reasons: [] },
): ImportedSkill {
  const warnings: string[] = [...(asset.warnings ?? [])];
  let content = asset.payload.content as string;
  if (!content) throw new Error(`Skill asset "${asset.name}" has no content`);

  // Substitute path variables so instructions keep working after mounting.
  const skillDir = (asset.payload.skillDir as string | undefined) ?? (asset.assetType === 'skill' ? asset.sourcePath : undefined);
  const pluginRoot = asset.payload.pluginRoot as string | undefined;
  content = substituteSkillPathVars(content, {
    skillDir: skillDir ? path.resolve(skillDir) : undefined,
    pluginRoot: pluginRoot ? path.resolve(pluginRoot) : undefined,
  });

  // Normalize frontmatter: try YAML first, fall back to OpenClaw single-line style.
  let normalized = content;
  try {
    parseSkillMarkdown(content, asset.sourcePath);
  } catch {
    const fallback = parseOpenClawStyleFrontmatter(content);
    if (fallback) {
      warnings.push('Frontmatter parsed with single-line fallback (OpenClaw style)');
      normalized = renderFrontmatter(fallback.frontmatter) + fallback.body;
    }
  }

  // Some ecosystems allow missing `name` (directory name wins). Inject it.
  if (mountName && !/^---[\s\S]*?\nname\s*:/m.test(normalized)) {
    const fm = parseOpenClawStyleFrontmatter(normalized);
    if (fm) {
      fm.frontmatter.name = mountName;
      normalized = renderFrontmatter(fm.frontmatter) + fm.body;
      warnings.push('Injected missing frontmatter name from mount name');
    }
  }

  const origin: SkillOrigin = {
    kind: asset.kind,
    sourcePath: asset.sourcePath,
    supportLevel: asset.supportLevel,
    displayName: asset.displayName,
  };

  if (mountName) normalized = renameSkillName(normalized, mountName, warnings);

  const skill = Skill.fromContent(normalized, asset.sourcePath, SkillSource.Ecosystem, { origin });

  // OpenClaw encodes nested metadata as a single-line JSON string. Re-parse it
  // so gates and the UI can inspect metadata.openclaw as an object.
  const raw = skill.rawFrontmatter();
  if (typeof raw.metadata === 'string') {
    try {
      const parsed = JSON.parse(raw.metadata);
      if (parsed && typeof parsed === 'object') {
        const corrected = Skill.fromContent(normalized, asset.sourcePath, SkillSource.Ecosystem, {
          rawFrontmatter: { ...raw, metadata: parsed },
          origin,
        });
        return { skill: corrected, warnings };
      }
    } catch {
      warnings.push('metadata frontmatter is not valid JSON; kept as string');
    }
  }

  if (!gates.ok) {
    warnings.push(`Gated out at load time: ${gates.reasons.join('; ')}`);
  }
  return { skill, warnings };
}

/** Rewrite the frontmatter `name` while keeping every other field intact. */
function renameSkillName(content: string, mountName: string, warnings: string[]): string {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return content;
  const fmBlock = m[1];
  const nameMatch = fmBlock.match(/^name\s*:\s*(.*)$/m);
  const original = nameMatch?.[1]?.trim().replace(/^["']|["']$/g, '');
  if (original && String(original) !== mountName) {
    warnings.push(`Renamed "${original}" -> "${mountName}" for collision-free mounting`);
  }
  const replaced = nameMatch
    ? fmBlock.replace(/^name\s*:.*$/m, `name: "${mountName}"`)
    : `name: "${mountName}"\n` + fmBlock;
  return '---\n' + replaced + '\n---' + content.slice(m[0].length);
}

export function ecosystemKindLabel(kind: EcosystemKind): string {
  return kind;
}
