// SkillsExtension — Extension wrapper for the Skills subsystem

import type { Extension } from '../extensible/Extension.js';
import { SkillManager } from '../skills/SkillManager.js';
import { SkillSource } from '../skills/Skill.js';
import * as path from 'node:path';

export class SkillsExtension implements Extension {
  readonly id = 'skills';
  readonly name = 'Skills System';
  readonly dependencies: string[] = [];
  private _running = false;

  async start(): Promise<void> {
    const skillsDir = path.resolve(process.cwd(), 'skills');
    await SkillManager.getInstance().loadFromDirectory(skillsDir, SkillSource.Project);
    this._running = true;
  }

  async stop(): Promise<void> {
    this._running = false;
  }

  isRunning(): boolean { return this._running; }
}
