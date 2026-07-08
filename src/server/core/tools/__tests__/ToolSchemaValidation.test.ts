import { describe, expect, it } from 'vitest';
import { ToolPipeline } from '../ToolPipeline.js';
import { AgentMessageTool } from '../builtin/AgentMessageTool.js';
import { ApiCallTool } from '../builtin/ApiCallTool.js';
import { AskUserQuestionTool } from '../builtin/AskUserQuestionTool.js';
import { BashTool } from '../builtin/BashTool.js';
import { EditTool } from '../builtin/EditTool.js';
import { EnterPlanModeTool } from '../builtin/EnterPlanModeTool.js';
import { ExitPlanModeTool } from '../builtin/ExitPlanModeTool.js';
import { GlobTool } from '../builtin/GlobTool.js';
import { GrepTool } from '../builtin/GrepTool.js';
import { HireEmployeeTool } from '../builtin/HireEmployeeTool.js';
import { ListEmployeesTool } from '../builtin/ListEmployeesTool.js';
import { MemoryDeleteTool } from '../builtin/MemoryDeleteTool.js';
import { MemoryRecallTool } from '../builtin/MemoryRecallTool.js';
import { MemorySaveTool } from '../builtin/MemorySaveTool.js';
import { MemorySearchTool } from '../builtin/MemorySearchTool.js';
import { PlanTool } from '../builtin/PlanTool.js';
import { ReadTool } from '../builtin/ReadTool.js';
import { SkillInspectTool } from '../builtin/SkillInspectTool.js';
import { SkillListTool } from '../builtin/SkillListTool.js';
import { SkillMatchingTool } from '../builtin/SkillMatchingTool.js';
import { SkillTool } from '../builtin/SkillTool.js';
import { SleepTool } from '../builtin/SleepTool.js';
import { SubAgentSpawnTool } from '../builtin/SubAgentSpawnTool.js';
import { TaskAssignTool } from '../builtin/TaskAssignTool.js';
import { TaskListTool } from '../builtin/TaskListTool.js';
import { TaskOutputTool } from '../builtin/TaskOutputTool.js';
import { TaskStopTool } from '../builtin/TaskStopTool.js';
import { TodoWriteTool } from '../builtin/TodoWriteTool.js';
import { UpdateOrgTool } from '../builtin/UpdateOrgTool.js';
import { WebFetchTool } from '../builtin/WebFetchTool.js';
import { WebSearchTool } from '../builtin/WebSearchTool.js';
import { WriteTool } from '../builtin/WriteTool.js';

describe('native tool parameter schemas', () => {
  it('exposes WebSearch bounds to the shared pipeline validator', () => {
    expect(ToolPipeline.validateParams(new WebSearchTool(), {
      query: 'release notes',
      max_results: 2,
      timeout_ms: 1000,
      allowed_domains: ['example.com'],
    })).toBeNull();

    const tooMany = ToolPipeline.validateParams(new WebSearchTool(), {
      query: 'release notes',
      max_results: 11,
    });
    expect(tooMany?.errorMessage).toContain('expected <= 10');

    const emptyDomain = ToolPipeline.validateParams(new WebSearchTool(), {
      query: 'release notes',
      allowed_domains: ['   '],
    });
    expect(emptyDomain?.errorMessage).toContain('allowed_domains[0]');
  });

  it('exposes WebFetch timeout, retry, prompt, and output bounds', () => {
    const tool = new WebFetchTool();

    expect(ToolPipeline.validateParams(tool, {
      url: 'https://example.com',
      max_content_chars: 100,
      timeout_ms: 1000,
      retry_attempts: 1,
      prompt: 'summary',
    })).toBeNull();

    expect(ToolPipeline.validateParams(tool, {
      url: 'https://example.com',
      retry_attempts: 4,
    })?.errorMessage).toContain('expected <= 3');

    expect(ToolPipeline.validateParams(tool, {
      url: 'https://example.com',
      prompt: 'x'.repeat(1001),
    })?.errorMessage).toContain('expected at most 1000');
  });

  it('exposes Bash command and numeric execution bounds', () => {
    const tool = new BashTool();

    expect(ToolPipeline.validateParams(tool, {
      command: 'npm test',
      description: 'Run tests',
      timeout: 100,
      max_output_chars: 100,
    })).toBeNull();

    expect(ToolPipeline.validateParams(tool, {
      command: '',
      description: 'Run tests',
    })?.errorMessage).toContain('command');

    expect(ToolPipeline.validateParams(tool, {
      command: 'npm test',
      description: 'Run tests',
      timeout: 99,
    })?.errorMessage).toContain('expected >= 100');
  });

  it('exposes file search numeric and nested list bounds', () => {
    const glob = new GlobTool();
    expect(ToolPipeline.validateParams(glob, {
      pattern: '**/*.ts',
      max_results: 1,
      timeout_ms: 1000,
      max_output_chars: 100,
      exclude: ['dist/**'],
    })).toBeNull();

    expect(ToolPipeline.validateParams(glob, {
      pattern: '**/*.ts',
      max_results: 0,
    })?.errorMessage).toContain('expected >= 1');

    expect(ToolPipeline.validateParams(glob, {
      pattern: '**/*.ts',
      exclude: [''],
    })?.errorMessage).toContain('exclude[0]');
  });

  it('exposes grep context, timeout, and output bounds', () => {
    const tool = new GrepTool();

    expect(ToolPipeline.validateParams(tool, {
      pattern: 'needle',
      '-A': 1,
      '-B': 1,
      '-C': 0,
      head_limit: 0,
      timeout_ms: 1000,
      max_output_chars: 100,
    })).toBeNull();

    expect(ToolPipeline.validateParams(tool, {
      pattern: 'needle',
      '-C': 101,
    })?.errorMessage).toContain('expected <= 100');
  });

  it('exposes read range and output bounds', () => {
    const tool = new ReadTool();

    expect(ToolPipeline.validateParams(tool, {
      file_path: 'src/index.ts',
      offset: 1,
      limit: 1,
      tail: undefined,
      max_chars: 100,
      timeout_ms: 1000,
    })).toBeNull();

    expect(ToolPipeline.validateParams(tool, {
      file_path: 'src/index.ts',
      tail: 5001,
    })?.errorMessage).toContain('expected <= 5000');

    expect(ToolPipeline.validateParams(tool, {
      file_path: 'src/index.ts',
      timeout_ms: 999,
    })?.errorMessage).toContain('expected >= 1000');
  });

  it('exposes write and edit safety hash formats', () => {
    const badWrite = ToolPipeline.validateParams(new WriteTool(), {
      file_path: 'out.txt',
      content: 'hello',
      expected_sha256: 'not-a-hash',
    });
    expect(badWrite?.errorMessage).toContain('Invalid format');

    const badEdit = ToolPipeline.validateParams(new EditTool(), {
      file_path: 'out.txt',
      old_string: 'hello',
      new_string: 'world',
      expected_replacements: 0,
    });
    expect(badEdit?.errorMessage).toContain('expected >= 1');
  });

  it('exposes nested planning and user-question bounds', () => {
    expect(ToolPipeline.validateParams(new AskUserQuestionTool(), {
      questions: [
        { question: 'Which path?', header: 'Path', options: ['A', 'B'] },
      ],
    })).toBeNull();

    expect(ToolPipeline.validateParams(new AskUserQuestionTool(), {
      questions: [
        { question: 'One?', header: 'QuestionOneTooLong' },
      ],
    })?.errorMessage).toContain('questions[0].header');

    expect(ToolPipeline.validateParams(new AskUserQuestionTool(), {
      questions: [
        { question: 'One?', header: 'One', options: ['A'], typo: true },
      ],
    })?.errorMessage).toContain('questions[0].typo');

    expect(ToolPipeline.validateParams(new AskUserQuestionTool(), {
      questions: [
        { question: 'One?', header: 'One', options: ['A'], multiSelect: 'yes' },
      ],
    })?.errorMessage).toContain('questions[0].multiSelect');

    expect(ToolPipeline.validateParams(new ExitPlanModeTool(), {
      allowedPrompts: [{ tool: 'Bash', prompt: '   ' }],
    })?.errorMessage).toContain('allowedPrompts[0].prompt');
  });

  it('exposes ApiCall request shaping and response bounds', () => {
    const tool = new ApiCallTool();

    expect(ToolPipeline.validateParams(tool, {
      path: '/api/v1/items/:id',
      params: { id: 'item-1' },
      query: { tag: ['a', 'b'], active: true },
      timeout_ms: 100,
      max_response_chars: 500,
    })).toBeNull();

    expect(ToolPipeline.validateParams(tool, {
      path: '/api/v1/items/:id',
      params: { id: ['bad'] },
    })?.errorMessage).toContain('params.id');

    expect(ToolPipeline.validateParams(tool, {
      path: '/api/v1/items/:id',
      query: { nested: { nope: true } },
    })?.errorMessage).toContain('query.nested');

    expect(ToolPipeline.validateParams(tool, {
      path: '/api/v1/items',
      timeout_ms: 99,
    })?.errorMessage).toContain('expected >= 100');
  });

  it('exposes todo and plan size/shape bounds', () => {
    expect(ToolPipeline.validateParams(new TodoWriteTool(), {
      todos: [
        { content: 'Inspect state', status: 'completed', activeForm: 'Inspecting state' },
        { content: 'Run tests', status: 'pending', activeForm: 'Running tests' },
      ],
    })).toBeNull();

    expect(ToolPipeline.validateParams(new TodoWriteTool(), {
      todos: [
        { content: 'Inspect state', status: 'pending', activeForm: 'Inspecting state', extra: true },
      ],
    })?.errorMessage).toContain('todos[0].extra');

    expect(ToolPipeline.validateParams(new PlanTool(), {
      name: 'x'.repeat(61),
      content: '## Step 1: Inspect',
    })?.errorMessage).toContain('expected at most 60');
  });

  it('exposes memory tool bounds', () => {
    expect(ToolPipeline.validateParams(new MemorySaveTool(), {
      scope: 'team',
      type: 'project',
      name: 'build-rule',
      content: 'Run verification before committing.',
      description: 'Build rule',
    })).toBeNull();

    expect(ToolPipeline.validateParams(new MemorySaveTool(), {
      scope: 'team',
      type: 'project',
      name: 'build-rule',
      content: '',
    })?.errorMessage).toContain('content');

    expect(ToolPipeline.validateParams(new MemorySearchTool(), {
      query: 'release',
      limit: 51,
    })?.errorMessage).toContain('expected <= 50');

    expect(ToolPipeline.validateParams(new MemoryRecallTool(), {
      id: '1',
      max_content_chars: 199,
    })?.errorMessage).toContain('expected >= 200');

    expect(ToolPipeline.validateParams(new MemoryDeleteTool(), {
      scope: 'personal',
      name: '   ',
    })?.errorMessage).toContain('Invalid format');
  });

  it('exposes skill tool bounds and rejects stray no-arg params', () => {
    expect(ToolPipeline.validateParams(new SkillTool(), {
      skill: 'code-review',
      args: 'focused',
    })).toBeNull();

    expect(ToolPipeline.validateParams(new SkillInspectTool(), {
      skill: '   ',
    })?.errorMessage).toContain('Invalid format');

    expect(ToolPipeline.validateParams(new SkillMatchingTool(), {
      task: '',
    })?.errorMessage).toContain('task');

    expect(ToolPipeline.validateParams(new SkillListTool(), {
      unused: true,
    })?.errorMessage).toContain('Unexpected parameter');

    expect(ToolPipeline.validateParams(new ListEmployeesTool(), {})).toBeNull();

    expect(ToolPipeline.validateParams(new ListEmployeesTool(), {
      verbose: true,
    })?.errorMessage).toContain('Unexpected parameter');
  });

  it('exposes sleep and task coordination bounds', () => {
    expect(ToolPipeline.validateParams(new SleepTool(), {
      delaySeconds: 0.1,
      reason: 'waiting for background task',
    })).toBeNull();

    expect(ToolPipeline.validateParams(new SleepTool(), {
      delaySeconds: 301,
    })?.errorMessage).toContain('expected <= 300');

    expect(ToolPipeline.validateParams(new TaskAssignTool(), {
      targetAgentId: 'member-1',
      task: 'Inspect the native tool tests.',
      priority: 'normal',
    })).toBeNull();

    expect(ToolPipeline.validateParams(new TaskAssignTool(), {
      targetAgentId: 'member-1',
      task: '   ',
    })?.errorMessage).toContain('Invalid format');

    expect(ToolPipeline.validateParams(new TaskAssignTool(), {
      targetAgentId: 'member-1',
      task: 'Inspect the native tool tests.',
      priority: 'later',
    })?.errorMessage).toContain('priority');

    expect(ToolPipeline.validateParams(new TaskAssignTool(), {
      targetAgentId: 'x'.repeat(201),
      task: 'Inspect the native tool tests.',
    })?.errorMessage).toContain('targetAgentId');

    expect(ToolPipeline.validateParams(new TaskOutputTool(), {
      task_id: 'task-1',
      max_chars: 200,
      include_history: true,
      include_tool_messages: false,
      tail_messages: 1,
    })).toBeNull();

    expect(ToolPipeline.validateParams(new TaskOutputTool(), {
      task_id: 'task-1',
      max_chars: 199,
    })?.errorMessage).toContain('expected >= 200');

    expect(ToolPipeline.validateParams(new TaskOutputTool(), {
      task_id: '   ',
    })?.errorMessage).toContain('task_id');

    expect(ToolPipeline.validateParams(new TaskStopTool(), {
      taskId: 'task-1',
      typo: true,
    })?.errorMessage).toContain('typo');

    expect(ToolPipeline.validateParams(new TaskListTool(), {
      anything: true,
    })?.errorMessage).toContain('Unexpected parameter');

    expect(ToolPipeline.validateParams(new EnterPlanModeTool(), {
      anything: true,
    })?.errorMessage).toContain('Unexpected parameter');
  });

  it('exposes AgentMessage content and summary bounds', () => {
    const tool = new AgentMessageTool();

    expect(ToolPipeline.validateParams(tool, {
      targetAgentId: 'member-1',
      content: 'Please check the current task status.',
      summary: 'Status check',
    })).toBeNull();

    expect(ToolPipeline.validateParams(tool, {
      targetAgentId: 'member-1',
      content: '   ',
    })?.errorMessage).toContain('content');

    expect(ToolPipeline.validateParams(tool, {
      targetAgentId: 'member-1',
      content: 'Please check the current task status.',
      summary: 'x'.repeat(121),
    })?.errorMessage).toContain('summary');

    expect(ToolPipeline.validateParams(tool, {
      targetAgentId: 'member-1',
      content: 'Please check the current task status.',
      typo: true,
    })?.errorMessage).toContain('Unexpected parameter');
  });

  it('exposes HireEmployee role, string, and list bounds', () => {
    const tool = new HireEmployeeTool();

    expect(ToolPipeline.validateParams(tool, {
      name: 'QA Tester',
      role: 'Member',
      parentAgentId: 'main-agent',
      agentPrompt: 'You test changes and report bugs.',
      reason: 'The project needs durable QA coverage.',
      allowedTools: ['Read', 'Grep'],
      enabledSkills: ['code-review'],
      mcpServers: [],
    })).toBeNull();

    expect(ToolPipeline.validateParams(tool, {
      name: 'QA Tester',
      role: 'SubAgent',
      parentAgentId: 'main-agent',
      agentPrompt: 'You test changes and report bugs.',
      reason: 'The project needs durable QA coverage.',
    })?.errorMessage).toContain('role');

    expect(ToolPipeline.validateParams(tool, {
      name: 'QA Tester',
      role: 'Member',
      parentAgentId: 'main-agent',
      agentPrompt: 'You test changes and report bugs.',
      reason: 'The project needs durable QA coverage.',
      allowedTools: 'Read',
    })?.errorMessage).toContain('allowedTools');

    expect(ToolPipeline.validateParams(tool, {
      name: 'QA Tester',
      role: 'Member',
      parentAgentId: 'main-agent',
      agentPrompt: 'You test changes and report bugs.',
      reason: 'The project needs durable QA coverage.',
      extra: true,
    })?.errorMessage).toContain('Unexpected parameter');
  });

  it('exposes UpdateOrg identifier bounds and rejects stray params', () => {
    const tool = new UpdateOrgTool();

    expect(ToolPipeline.validateParams(tool, {
      agentId: 'member-1',
      newParentId: 'manager-2',
    })).toBeNull();

    expect(ToolPipeline.validateParams(tool, {
      agentId: '   ',
      newParentId: 'manager-2',
    })?.errorMessage).toContain('agentId');

    expect(ToolPipeline.validateParams(tool, {
      agentId: 'member-1',
      newParentId: 'x'.repeat(201),
    })?.errorMessage).toContain('newParentId');

    expect(ToolPipeline.validateParams(tool, {
      agentId: 'member-1',
      newParentId: 'manager-2',
      extra: true,
    })?.errorMessage).toContain('Unexpected parameter');
  });

  it('exposes SubAgentSpawn enum, string, and boolean bounds', () => {
    const tool = new SubAgentSpawnTool();

    expect(ToolPipeline.validateParams(tool, {
      description: 'Inspect a focused subsystem',
      prompt: 'Review the relevant files and report findings.',
      subagent_type: 'Explore',
      model: 'sonnet',
      persist: false,
      run_in_background: true,
    })).toBeNull();

    expect(ToolPipeline.validateParams(tool, {
      description: 'Inspect a focused subsystem',
      prompt: 'Review the relevant files and report findings.',
      subagent_type: 'Worker',
    })?.errorMessage).toContain('subagent_type');

    expect(ToolPipeline.validateParams(tool, {
      description: 'Inspect a focused subsystem',
      prompt: 'Review the relevant files and report findings.',
      subagent_type: 'Explore',
      run_in_background: 'false',
    })?.errorMessage).toContain('run_in_background');

    expect(ToolPipeline.validateParams(tool, {
      description: 'Inspect a focused subsystem',
      prompt: 'Review the relevant files and report findings.',
      subagent_type: 'Explore',
      extra: true,
    })?.errorMessage).toContain('Unexpected parameter');
  });
});
