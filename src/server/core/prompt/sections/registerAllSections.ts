// registerAllSections — registers all prompt sections with the PromptAssembler
// Sections are auto-loaded from metadata exports. Priority determines order.
// Adding a new section = create file + add one entry to SECTIONS list.

import type { PromptAssembler } from '../PromptAssembler.js';
import { createSystemRulesSection, sectionMeta as rulesMeta } from './SystemRulesSection.js';
import { createAnoclawMdSection, sectionMeta as anoclawMdMeta } from './AnoclawMdSection.js';
import { createDocsSection, sectionMeta as docsMeta } from './DocsSection.js';
import { createPluginDevSection, sectionMeta as pluginDevMeta } from './PluginDevSection.js';
import { createTaskExecutionSection, sectionMeta as taskMeta } from './TaskExecutionSection.js';
import { createActionsSection, sectionMeta as actionsMeta } from './ActionsSection.js';
import { createToolUsageSection, sectionMeta as toolUseMeta } from './ToolUsageSection.js';
import { createOutputEfficiencySection, sectionMeta as outputMeta } from './OutputEfficiencySection.js';
import { createOrgContextSection, sectionMeta as orgMeta } from './OrgContextSection.js';
import { createActiveTaskSection, sectionMeta as activeTaskMeta } from './ActiveTaskSection.js';
import { createUserAwarenessSection, sectionMeta as userAwareMeta } from './UserAwarenessSection.js';
import { createEditorContextSection, sectionMeta as editorCtxMeta } from './EditorContextSection.js';
import { createSessionGuidanceSection, sectionMeta as guidanceMeta } from './SessionGuidanceSection.js';
import { createDelegationContextSection, sectionMeta as delegationMeta } from './DelegationContextSection.js';
import { createMemorySection, sectionMeta as memoryMeta } from './MemorySection.js';
import { createEnvironmentSection, sectionMeta as envMeta } from './EnvironmentSection.js';
import { createLanguageSection, sectionMeta as langMeta } from './LanguageSection.js';
import { createToolPromptSection, sectionMeta as toolPromptMeta } from './ToolPromptSection.js';
import { createTokenBudgetSection, sectionMeta as budgetMeta } from './TokenBudgetSection.js';
import { createToolsSection, sectionMeta as toolsMeta } from './ToolsSection.js';
import { createSkillsSection, sectionMeta as skillsMeta } from './SkillsSection.js';
import { createPermissionModeSection, sectionMeta as permMeta } from './PermissionModeSection.js';

interface SectionEntry {
  meta: { name: string; type: 'static' | 'dynamic'; priority: number };
  factory: () => import('../PromptSection.js').SystemPromptSection;
}

const SECTIONS: SectionEntry[] = [
  { meta: rulesMeta, factory: createSystemRulesSection },
  { meta: anoclawMdMeta, factory: createAnoclawMdSection },
  { meta: docsMeta, factory: createDocsSection },
  { meta: pluginDevMeta, factory: createPluginDevSection },
  { meta: taskMeta, factory: createTaskExecutionSection },
  { meta: actionsMeta, factory: createActionsSection },
  { meta: toolUseMeta, factory: createToolUsageSection },
  { meta: outputMeta, factory: createOutputEfficiencySection },
  { meta: orgMeta, factory: createOrgContextSection },
  { meta: activeTaskMeta, factory: createActiveTaskSection },
  { meta: userAwareMeta, factory: createUserAwarenessSection },
  { meta: editorCtxMeta, factory: createEditorContextSection },
  { meta: guidanceMeta, factory: createSessionGuidanceSection },
  { meta: delegationMeta, factory: createDelegationContextSection },
  { meta: memoryMeta, factory: createMemorySection },
  { meta: envMeta, factory: createEnvironmentSection },
  { meta: langMeta, factory: createLanguageSection },
  { meta: toolPromptMeta, factory: createToolPromptSection },
  { meta: budgetMeta, factory: createTokenBudgetSection },
  { meta: toolsMeta, factory: createToolsSection },
  { meta: skillsMeta, factory: createSkillsSection },
  { meta: permMeta, factory: createPermissionModeSection },
];

/**
 * Register all prompt sections with the assembler.
 * Sections are sorted by priority within their zone (static/dynamic).
 */
export function registerAllSections(assembler: PromptAssembler): void {
  // Sort by priority
  const sorted = [...SECTIONS].sort((a, b) => a.meta.priority - b.meta.priority);

  for (const entry of sorted) {
    const section = entry.factory();
    assembler.registerSection(section, entry.meta.type);
  }
}
