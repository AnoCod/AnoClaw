/**
 * Agent importer — parses Claude Code / OpenCode agent markdown into a
 * normalized shape that the registry maps onto AnoClaw Agent configs.
 */

import * as path from 'path';
import { parseSkillMarkdown } from '../../skills/SkillParser.js';
import type { EcosystemAsset } from '../types.js';
import { substituteSkillPathVars } from '../placeholders.js';

export interface ImportedAgent {
  name: string;
  description: string;
  body: string;
  mode: 'primary' | 'subagent';
  allowedTools?: string[];
  model?: string;
}

export function parseAgentAsset(asset: EcosystemAsset): ImportedAgent {
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
  const description = (fm.description as string | undefined) || asset.detail || 'Imported agent';

  const modeRaw = String(fm.mode ?? '').toLowerCase();
  const mode: 'primary' | 'subagent' = modeRaw.includes('primary') || modeRaw.includes('main') ? 'primary' : 'subagent';

  const toolsRaw = fm['allowed-tools'] ?? fm.allowedTools ?? fm.tools;
  const allowedTools = Array.isArray(toolsRaw)
    ? toolsRaw.filter((v): v is string => typeof v === 'string')
    : typeof toolsRaw === 'string'
      ? toolsRaw.split(/[,\s]+/).filter(Boolean)
      : undefined;

  return {
    name,
    description,
    body,
    mode,
    allowedTools,
    model: typeof fm.model === 'string' ? fm.model : undefined,
  };
}
