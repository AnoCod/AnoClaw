import { describe, expect, it } from 'vitest';
import type { CapabilityRecord } from '../../../../shared/types/capability.js';
import { buildPluginRecommendations } from '../CapabilityPluginRecommender.js';

describe('CapabilityPluginRecommender', () => {
  it('recommends activating an installed plugin that provides the capability', () => {
    const recommendations = buildPluginRecommendations(
      {
        capability: capabilityRecord({
          id: 'presentation.create',
          recommendedPlugins: ['anoclaw-office'],
          missingTools: ['office.create_pptx'],
        }),
        recommendedPlugins: ['anoclaw-office'],
        missingTools: ['office.create_pptx'],
      },
      [
        {
          name: 'anoclaw-office',
          displayName: 'Office',
          version: '0.1.0',
          publisher: 'anoclaw',
          status: 'loaded',
          contributes: {
            tools: [{ name: 'office.create_pptx' }],
            capabilities: [capabilityDefinition('presentation.create')],
          },
        },
      ],
      [],
    );

    expect(recommendations).toHaveLength(1);
    expect(recommendations[0]).toMatchObject({
      pluginName: 'anoclaw-office',
      displayName: 'Office',
      status: 'installed',
      action: 'activate',
      reason: 'plugin_not_active',
      source: 'local',
      installable: false,
    });
  });

  it('recommends installing a marketplace plugin when no local provider exists', () => {
    const recommendations = buildPluginRecommendations(
      {
        capability: capabilityRecord({
          id: 'pdf.summarize',
          recommendedPlugins: ['pdf'],
          missingTools: ['pdf.summarize'],
        }),
        recommendedPlugins: ['pdf'],
        missingTools: ['pdf.summarize'],
      },
      [],
      [
        {
          name: 'pdf',
          displayName: 'PDF',
          version: '1.0.0',
          publisher: 'anoclaw',
          tags: ['official'],
          installUrl: 'https://example.com/pdf-plugin.json',
          capabilities: ['pdf.summarize'],
          tools: ['pdf.summarize'],
        },
      ],
    );

    expect(recommendations).toHaveLength(1);
    expect(recommendations[0]).toMatchObject({
      pluginName: 'pdf',
      displayName: 'PDF',
      status: 'missing',
      action: 'install',
      reason: 'capability_provider',
      source: 'official',
      installable: true,
      installRoute: '/api/v1/plugins/install',
    });
  });
});

function capabilityRecord(overrides: Partial<CapabilityRecord>): CapabilityRecord {
  return {
    id: 'test.capability',
    title: 'Test capability',
    domain: 'test',
    kind: 'utility',
    triggers: ['test'],
    requiredTools: [],
    recommendedPlugins: [],
    source: 'catalog',
    sourceName: 'test',
    status: 'needs_plugin',
    missingTools: [],
    ...overrides,
  };
}

function capabilityDefinition(id: string) {
  return {
    id,
    title: 'Test capability',
    domain: 'test',
    triggers: ['test'],
  };
}
