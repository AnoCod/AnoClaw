import { describe, expect, it } from 'vitest';
import type { CapabilityRecord } from '../../../../shared/types/capability.js';
import { buildPluginRecommendations } from '../CapabilityPluginRecommender.js';

describe('CapabilityPluginRecommender', () => {
  it('recommends activating an installed plugin that provides the capability', () => {
    const recommendations = buildPluginRecommendations(
      {
        capability: capabilityRecord({
          id: 'report.create',
          recommendedPlugins: ['report-provider'],
          missingTools: ['report.render'],
        }),
        recommendedPlugins: ['report-provider'],
        missingTools: ['report.render'],
      },
      [
        {
          name: 'report-provider',
          displayName: 'Report Provider',
          version: '0.1.0',
          publisher: 'anoclaw',
          status: 'loaded',
          contributes: {
            tools: [{ name: 'report.render' }],
            capabilities: [capabilityDefinition('report.create')],
          },
        },
      ],
      [],
    );

    expect(recommendations).toHaveLength(1);
    expect(recommendations[0]).toMatchObject({
      pluginName: 'report-provider',
      displayName: 'Report Provider',
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
          id: 'archive.extract',
          recommendedPlugins: ['archive-provider'],
          missingTools: ['archive.extract'],
        }),
        recommendedPlugins: ['archive-provider'],
        missingTools: ['archive.extract'],
      },
      [],
      [
        {
          name: 'archive-provider',
          displayName: 'Archive Provider',
          version: '1.0.0',
          publisher: 'anoclaw',
          tags: ['official'],
          installUrl: 'https://example.com/archive-plugin.json',
          capabilities: ['archive.extract'],
          tools: ['archive.extract'],
        },
      ],
    );

    expect(recommendations).toHaveLength(1);
    expect(recommendations[0]).toMatchObject({
      pluginName: 'archive-provider',
      displayName: 'Archive Provider',
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
