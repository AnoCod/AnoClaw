import { describe, expect, it } from 'vitest';
import { isRetiredBuiltinOrganizationTool } from '../ToolRegistrar.js';

describe('ToolRegistrar retired organization tools', () => {
  it('excludes retired organization modules and names from auto-registration', () => {
    expect(isRetiredBuiltinOrganizationTool('HireEmployeeTool.js')).toBe(true);
    expect(isRetiredBuiltinOrganizationTool('UpdateOrgTool.js')).toBe(true);
    expect(isRetiredBuiltinOrganizationTool('SubAgentSpawnTool.js')).toBe(true);
    expect(isRetiredBuiltinOrganizationTool('ListEmployeesTool.js')).toBe(true);
    expect(isRetiredBuiltinOrganizationTool('anything.js', 'ListEmployees')).toBe(true);
    expect(isRetiredBuiltinOrganizationTool('Other.js', 'HireEmployee')).toBe(true);
    expect(isRetiredBuiltinOrganizationTool('TeamMemberAddTool.js', 'TeamMemberAdd')).toBe(false);
  });
});
