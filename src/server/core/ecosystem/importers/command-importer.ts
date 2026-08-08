/**
 * Command importer — parses Claude/OpenCode/OpenClaw slash-command markdown
 * into a normalized { name, description, body, argumentHint } shape.
 */

import * as path from 'path';
import { parseSkillMarkdown } from '../../skills/SkillParser.js';
import type { EcosystemAsset } from '../types.js';
import { substituteSkillPathVars } from '../placeholders.js';

export interface ImportedCommand {
  name: string;
  description: string;
  body: string;
  argumentHint?: string;
  allowedTools?: string[];
}

export function parseCommandAsset(asset: EcosystemAsset): ImportedCommand {
  let content = asset.payload.content as string;
  const skillDir = asset.payload.skillDir as string | undefined;
  const pluginRoot = asset.payload.pluginRoot as string | undefined;
  content = substituteSkillPathVars(content, {
    skillDir: skillDir ? path.resolve(skillDir) : undefined,
    pluginRoot: pluginRoot ? path.resolve(pluginRoot) : undefined,
  });

  let fm: Record<string, unknown> = {};
  let body = content;
  try {
    const parsed = parseSkillMarkdown(content, asset.sourcePath);
    fm = parsed.frontmatter;
    body = parsed.body;
  } catch {
    body = content;
  }

  const base = path.basename(asset.sourcePath).replace(/\.md$/i, '');
  const name = (fm.name as string | undefined) || base;
  const description = (fm.description as string | undefined) || asset.detail || 'Imported slash command';
  const allowedToolsRaw = fm['allowed-tools'] ?? fm.allowedTools ?? fm.allowed_tools;
  const allowedTools = Array.isArray(allowedToolsRaw)
    ? allowedToolsRaw.filter((v): v is string => typeof v === 'string')
    : typeof allowedToolsRaw === 'string'
      ? allowedToolsRaw.split(/[,\s]+/).filter(Boolean)
      : undefined;

  return {
    name,
    description,
    body,
    argumentHint: typeof fm['argument-hint'] === 'string' ? fm['argument-hint'] : undefined,
    allowedTools,
  };
}
