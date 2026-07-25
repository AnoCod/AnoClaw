import { describe, expect, it } from 'vitest';
import { AgentMessageTool } from '../builtin/AgentMessageTool.js';
import { HireEmployeeTool } from '../builtin/HireEmployeeTool.js';
import { ListEmployeesTool } from '../builtin/ListEmployeesTool.js';
import { TeamCreateTool } from '../builtin/TeamCreateTool.js';
import { TeamDeleteTool } from '../builtin/TeamDeleteTool.js';
import { TeamStatusTool } from '../builtin/TeamStatusTool.js';
import { TeamUpdateTool } from '../builtin/TeamUpdateTool.js';
import { UpdateOrgTool } from '../builtin/UpdateOrgTool.js';

describe('Agent Teams tool group', () => {
  it('contains durable roster, session Team, and communication controls', () => {
    const toolClasses = [
      ListEmployeesTool,
      HireEmployeeTool,
      UpdateOrgTool,
      TeamCreateTool,
      TeamUpdateTool,
      TeamStatusTool,
      TeamDeleteTool,
      AgentMessageTool,
    ];

    expect(toolClasses.map((toolClass) => toolClass.category))
      .toEqual(Array(toolClasses.length).fill('Agent Teams'));
  });
});
