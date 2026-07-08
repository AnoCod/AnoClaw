import { describe, expect, it } from 'vitest';
import { ToolPipeline } from '../ToolPipeline.js';
import { AskUserQuestionTool } from '../builtin/AskUserQuestionTool.js';
import { BashTool } from '../builtin/BashTool.js';
import { EditTool } from '../builtin/EditTool.js';
import { ExitPlanModeTool } from '../builtin/ExitPlanModeTool.js';
import { GlobTool } from '../builtin/GlobTool.js';
import { GrepTool } from '../builtin/GrepTool.js';
import { ReadTool } from '../builtin/ReadTool.js';
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
    })).toBeNull();

    expect(ToolPipeline.validateParams(tool, {
      file_path: 'src/index.ts',
      tail: 5001,
    })?.errorMessage).toContain('expected <= 5000');
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

    expect(ToolPipeline.validateParams(new ExitPlanModeTool(), {
      allowedPrompts: [{ tool: 'Bash', prompt: '   ' }],
    })?.errorMessage).toContain('allowedPrompts[0].prompt');
  });
});
