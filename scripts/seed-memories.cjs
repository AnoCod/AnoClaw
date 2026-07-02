// Seed memory entries for AnoClaw — writes .md files directly with proper UTF-8
const fs = require('fs');
const path = require('path');

const MEMORY_DIR = path.resolve(__dirname, '..', 'memory');
const NOW = Date.now();

const entries = [
  // ── User ──
  {
    dir: 'team', name: 'user-profile', type: 'user', scope: 'team',
    description: '用户画像：产品经理，偏好中文交流，脾气急躁',
    content: `## User Profile

- **角色**: 非技术产品经理
- **语言偏好**: 中文（Chinese communication required）
- **性格特点**: 脾气急躁，需要简洁直接的回答
- **技术要求**: 避免技术术语，避免文件路径堆砌，用产品语言汇报

### 沟通规则
1. 先想产品结果 — 用户要什么，不要急着写代码
2. 最多 2 个跟进问题，技术决策自己做
3. 汇报格式：用白话说明做了什么、结果如何，不用术语和路径
4. 回复要简短，错了就认，重来
5. 禁止 emoji（除非用户明确要求）`,
  },
  {
    dir: 'team', name: 'chinese-language', type: 'user', scope: 'team',
    description: '中文是主要交流语言',
    content: `## Chinese Communication

所有与用户的交流必须使用中文。

- 界面文字：中文
- 错误信息：中文
- 回复用户：中文
- 报告进度：中文
- Toast 通知：中文

代码注释和标识符仍然使用英文（项目规范）。面向 AI 的文档（CLAUDE.md 等）使用英文。`,
  },
  {
    dir: 'agents/ceo', name: 'ceo-agent-work-patterns', type: 'user', scope: 'agent',
    description: 'CEO Agent 的有效工作模式',
    content: `## CEO Agent Effective Work Patterns

### 委派策略
1. 简单任务 → 直接执行
2. 中等任务 → 委派给 Member agents
3. 复杂任务 → 让 Manager 分配
4. 多步骤任务 → 拆分后并行委派

### 质量保证
1. 每次代码变更后 build
2. 使用 skills（不要跳过）
3. 遵循 SOP 6 阶段流程
4. 完成后验证结果

### 沟通风格
- 用户是产品经理，用中文
- 简洁直接，不堆砌细节
- 报告结果，不报告过程
- 问题立即承认，不要拖延

### 常见陷阱
- 不要跳过 skill gate（最大错误来源）
- 不要补丁式修复（修根因，不是症状）
- 不要未经确认改无关代码
- 不要让文件超过 500 行`,
  },
  // ── Feedback ──
  {
    dir: 'team', name: 'karpathy-rules', type: 'feedback', scope: 'team',
    description: 'Karpathy 编码法则（不可协商）',
    content: `## Karpathy Rules (Non-Negotiable)

### Rule 1: Surface, Don't Hide
- 明确陈述假设。不确定时停下来问 — 不要默默猜测
- 有多个可行方案时，列出 2 个最佳选择，不要默默选
- 被要求做有问题的操作时，推回去解释为什么

### Rule 2: Minimum Code, Maximum Clarity
- 用最少代码解决问题。200 行能变 50 行就重写
- 禁止推测性功能、未来-proof 抽象、不可能状态的处理
- 3 行重复代码优于过早抽象

### Rule 3: Surgical Precision
- 只改和用户请求直接相关的代码，每个改动都要有理由
- 禁止顺便改格式、注释、变量名
- 禁止删除已有的死代码/注释 — 指出它，让用户决定
- 精确匹配现有代码风格，一致性 > 你的偏好

### Rule 4: Verify, Don't Assume
- 每个任务以可验证的结果结束
- "应该可以了"不是验证
- 改代码后证明它有效：构建 + 运行 + 看到结果
- 审查者能否独立确认你的工作是正确的？如果不能，你没完成`,
  },
  {
    dir: 'team', name: 'skill-discipline', type: 'feedback', scope: 'team',
    description: 'Skill 纪律规则',
    content: `## Skill Discipline

### 核心原则
在行动之前调用 Skill。不是中途。不是之后。是之前。

Skills 存在就是为了阻止跳过它们产生的错误：没有理解问题就开始编码，遗漏边缘情况，编写不可测试的代码，不经过验证就发布。

### Gate Rule
每个请求经过以下闸门：
- 涉及 bug/异常行为 → systematic-debugging FIRST
- 涉及创意/前端/UI → brainstorming FIRST
- 涉及实现功能或修复 → test-driven-development FIRST
- 涉及 3+ 文件或架构变更 → writing-plans FIRST
- 工作即将声明完成 → verification-before-completion FIRST

### 红旗信号
- "This is just a simple fix" — 简单修复造成最严重的回归
- "I know what the problem is" — skill 确保你知道
- "A skill is overkill here" — skill 只需 2 秒，回归需要数小时
- "Let me just look at the code first" — skill 告诉你如何看
- "The user wants speed" — 跳过 skill 导致返工，那才慢`,
  },
  {
    dir: 'team', name: 'sop-phases', type: 'feedback', scope: 'team',
    description: '标准操作流程 6 阶段',
    content: `## Standard Operating Procedure

每个请求走 6 个阶段，跳阶段或跳步是流程违规。

### Phase 0: INTAKE — 分类
- 不读文件、不搜索代码、不调用 skill
- 匹配到唯一 Track: HOTFIX / FEATURE / REFACTOR / UI / REVIEW / ANSWER / GIT
- 子分类: LIGHTWEIGHT (简单) 或 FULL PROCESS (复杂)

### Phase 1: SKILL GATE
- 只能调用 Skill 工具，禁止 Read/Write/Edit/Glob/Grep/Bash
- 按 Track 调用强制 skill

### Phase 2: PLAN
- LIGHTWEIGHT: 3-5 条 TodoWrite
- FULL: writing-plans skill → 用户批准

### Phase 3: EXECUTE
- 类型优先 → 后端 → 前端 → 样式
- 一次一个 TodoWrite
- TDD: 测试先于实现

### Phase 4: VERIFY
- Build (必须通过) → Tests → 功能验证 → 行数检查 → CLAUDE.md 同步

### Phase 5: REPORT
- 结果第一，白话说明，禁止路径和术语

### Phase 6: HANDOFF
- 只在用户明确要求时 commit/push/PR`,
  },
  {
    dir: 'team', name: 'no-backward-compat', type: 'feedback', scope: 'team',
    description: '开发阶段无需向后兼容',
    content: `## No Backward Compatibility

开发阶段所有数据都是可丢弃的。

- 不需要支持旧格式
- 不需要数据迁移脚本
- 不需要兼容性层
- 直接改数据结构，旧的丢掉
- 不需要 legacy format support

这意味着：
- 类型变更直接改，不需要保留旧字段
- API 格式直接换，不需要 v1/v2 并存
- 数据库 schema 直接改，不需要 migration
- 旧的 JSONL 文件直接删掉重新生成

这给了我们最大灵活性来优化架构，不用背负技术债。`,
  },
  {
    dir: 'team', name: 'ai-autonomy-philosophy', type: 'feedback', scope: 'team',
    description: 'AI 自主性工作哲学',
    content: `## AI Autonomy Philosophy

AnoClaw 的核心设计理念：AI 应该自主处理一切。

### 原则
- AI 是独立的员工，不只是工具
- Agent 拥有持久身份（ID, name, role, memory）
- Agent 在自己的记忆中积累经验
- 自主做技术决策，不需要用户微观管理
- 错了就修复，不找借口

### 对 AI 的要求
- 理解用户意图，不只字面意思
- 独立解决问题，不问不必要的澄清问题
- 对自己的工作和代码质量负责
- 使用 skills 和工作流确保质量
- 从错误中学习（通过 feedback 类型记忆）

### 边界
- 破坏性操作需要确认
- 不要自动 commit/PR/push
- 遇到需要用户决策的事情才问`,
  },
  // ── Project ──
  {
    dir: 'team', name: 'project-architecture', type: 'project', scope: 'team',
    description: 'AnoClaw v2 项目架构总览',
    content: `## AnoClaw v2 Architecture

核心三层架构：

1. **前端** (src/public/) — 纯 TypeScript + 原生 DOM，无 React/Vue。页面通过 PageRegistry 注册，采用 Cinema 设计系统。
2. **后端核心** (src/server/core/) — Agent 系统（ReAct loop）、Session 管理、Tool 注册、Memory 系统、Skill 系统、Plugin Host。
3. **后端基础设施** (src/server/infra/) — WebSocket 服务、LLM Provider（DeepSeek API）、JSONL 存储、日志系统。
4. **网关** (src/server/gateway/) — REST API 路由、权限验证、静态文件服务。
5. **插件系统** — Worker Thread 隔离，VSCode 风格扩展 API。插件在 plugins/ 目录。

Agent 层级：MainAgent(CEO, level 0) → Manager(1) → Member(2) → SubAgent(临时)`,
  },
  {
    dir: 'team', name: 'tech-stack', type: 'project', scope: 'team',
    description: '技术栈选型决策',
    content: `## Tech Stack

- **运行时**: Node.js (纯原生 http + ws 模块，无 Express/Fastify)
- **语言**: TypeScript (严格模式，ESM)
- **前端**: 原生 DOM + TypeScript，无框架
- **CSS**: 自定义属性系统，暗色主题优先，Cinema 设计语言
- **LLM**: DeepSeek API (OpenAI 兼容格式)
- **存储**: JSONL (会话数据)，YAML/JSON (配置)，文件系统 (Memory)
- **包管理**: npm only (禁止 pnpm)
- **构建**: tsc + esbuild
- **测试**: Vitest

### 关键约束
- DeepSeek 不支持 image_url 内容类型
- 所有消息必须有 role 字段（包括 tool results）
- sanitizeHistory() 必须同步清理孤立的 tool 消息`,
  },
  {
    dir: 'team', name: 'file-conventions', type: 'project', scope: 'team',
    description: '文件规范和命名约定',
    content: `## File Conventions

1. **ESM**: import 必须带 .js 扩展名
2. **后端路径别名**: @shared/*, @server/*, @public/*（编译时）
3. **前端**: 无路径别名，只用相对路径
4. **文件大小**: ≤500 行（硬上限 1000 行）
5. **每个文件必须有顶部注释**
6. **每个函数/类必须有 JSDoc**
7. **注释和标识符全部英文**
8. **禁止 innerHTML 用于用户内容** — 用 textContent 或转义
9. **禁止 style.cssText** — 用 class 切换
10. **禁止 as any** — 修复类型定义
11. **TODO 格式**: // TODO(area): description
12. **Dark theme first**: CSS 在 :root 定义

新增文件必须更新 src/*/CLAUDE.md 文件树和 Quick Task Routing 表。`,
  },
  {
    dir: 'team', name: 'frontend-patterns', type: 'project', scope: 'team',
    description: '前端组件开发模式',
    content: `## Frontend Patterns

### Page 接口
\`\`\`ts
export interface Page {
  name: string;
  container: HTMLElement;
  onEnter(): void;
  onExit(): void;
}
\`\`\`

### EventEmitter 模式
组件继承 EventEmitter，通过事件通信，禁止直接调用其他组件方法。

### 纯 DOM 构建
使用 document.createElement + appendChild，禁止 innerHTML（用户内容安全风险）。

### Cinema 设计系统
- \`.cinema-static-page\` — 全宽页面容器
- \`.cinema-static-inner\` — 居中内容区 (max-width 720px)
- \`.cinema-section\` — 卡片分区
- \`.cinema-card-grid\` / \`.cinema-card\` — 响应式卡片网格
- \`.cinema-btn\` / \`.cinema-btn-primary\` — 按钮
- \`.cinema-filter\` / \`.cinema-filter-input\` — 筛选栏

### 页面注册
1. 创建 Page 实现类
2. 在 app.ts 中实例化并注册
3. 在 TitleBar.ts KERNEL_PAGES 中添加导航入口`,
  },
  {
    dir: 'team', name: 'backend-agent-system', type: 'project', scope: 'team',
    description: 'Agent 系统架构和工作流程',
    content: `## Agent System

### ReAct Loop
Agent 的核心执行循环：
1. 组装 Prompt (PromptAssembler)
2. 调用 LLM API (AgentLoopLLM)
3. 解析响应 → 文本消息 / 工具调用
4. 执行工具 (ToolRegistry)
5. 将结果反馈给 LLM
6. 检查停止条件（max turns / stall detection / interrupt）

### Stall Detector
监控 Agent 是否陷入循环：
- 连续 3 轮无工具调用 → 注入提示
- 连续相同工具调用超过阈值 → 中断并要求重新规划

### Agent 层级
- CEO (level 0): 最高权限，可管理组织架构
- Manager (level 1): 可分配任务、雇佣下属
- Member (level 2): 执行任务、可生成子 Agent
- SubAgent (level 3+): 临时生成，有时限

### 工具权限
- Manager+: HireEmployee, UpdateOrg, TaskAssign
- Member+: SubAgentSpawn
- SubAgent+: 所有常规工具
- Delegation timeout: 10 分钟 → InterruptController 触发中断`,
  },
  {
    dir: 'team', name: 'plugin-system', type: 'project', scope: 'team',
    description: '插件系统架构',
    content: `## Plugin System

Worker Thread 隔离，VSCode 风格扩展 API。

### 插件组成
- plugin.json: 清单文件（name, displayName, version, main, activationEvents）
- extension.js: 插件入口，导出 activate(anoclaw) + 可选 executeTool(name, params)

### anoclaw API
- anoclaw.tools.register() — 注册工具（零内核修改）
- anoclaw.api.call() — 调用 REST 端点
- anoclaw.routes.register() — 自托管 HTTP 路由
- anoclaw.log — 日志

### 扩展点 (ExtensionPoints)
8 个内核覆盖钩子：promptAssembler, memoryStore, sessionStore, settingsStore, llmProvider, toolExecutor, agentLoop

### 生命周期
扫描 plugins/ 目录 → 解析 plugin.json → 匹配 activationEvents → 调用 activate()
文件监视器自动检测变更 → 重新加载`,
  },
  {
    dir: 'team', name: 'build-pipeline', type: 'project', scope: 'team',
    description: '构建和开发命令',
    content: `## Build Commands

\`\`\`bash
npm run build          # 后端: src/ → dist/
npm run build:frontend # 前端: src/public/ts/ → src/public/js/
npm run build:all      # 前后端 + CSS bundle + 插件前端
npm run dev            # 完整构建 + 启动服务器
npm test               # Vitest 测试
\`\`\`

### 构建流程
1. tsc 编译后端 (src/server/ → dist/server/)
2. bundle-css.js 合并所有 CSS 文件
3. tsc 编译前端 (src/public/ts/ → src/public/js/)
4. build-plugin-frontends.cjs 编译插件前端

### 服务器
- 默认端口: 3456
- 默认主机: 0.0.0.0
- REST API 前缀: /api/v1/`,
  },
  {
    dir: 'team', name: 'config-system', type: 'project', scope: 'team',
    description: '配置和设置系统',
    content: `## Configuration

### Settings
- port: 服务器端口 (default: 3456)
- host: 绑定地址 (default: 0.0.0.0)
- apiKeys: API 密钥列表
- extensions.disabled: 禁用的扩展列表

### Agent Config
每个 Agent 一个 JSON/YAML 文件，包含 provider, model, contextWindow, temperature, maxTurns。apiKey 不返回给前端（安全原因）。

### Feature Flags
通过 ExtensionManager 管理。Extensions 注册 → topo-sort 启动顺序。extensions.disabled 列表跳过不启用的。

### API 权限
memory:read / memory:write, settings:read / settings:write。通过 ApiAuth token 验证。`,
  },
  {
    dir: 'team', name: 'security-rules', type: 'project', scope: 'team',
    description: '安全编码规范',
    content: `## Security Rules

### API 密钥管理
- apiKey 绝不出现在前端类型中
- Agent 配置的前端版本排除 apiKey 字段
- API 密钥通过后端 API 单独传递

### 输入验证
- 所有外部输入用 Zod 验证
- 文件路径用 path.basename(path.normalize(id)) 防止目录遍历
- 前端用户内容用 textContent（禁止 innerHTML）

### API 权限
- 每个端点检查 ApiPermission token
- 默认生成 admin token

### 代码安全
- 不使用 eval()
- 插件在 Worker Thread 中隔离运行
- POST/DELETE 操作需要 memory:write 权限`,
  },
  {
    dir: 'team', name: 'recent-cleanup-jun2026', type: 'project', scope: 'team',
    description: '2026年6月代码清理记录',
    content: `## Recent Cleanup (June 2026)

### 已完成
- 修复 memory 系统 10 个 bug
- 清除 meeting/workflow/comfyui 残留代码
- 重置运行时数据
- 拆分 4 个超限文件
- 删除 plugin/mcp/meeting/workflow/comfyui 内核代码
- 清理前端类型
- 恢复插件前端页面（TypeScript source + esbuild bundles）
- 修复插件 iframe 尺寸
- 添加插件共享 CSS 和主题同步
- 工作流画布功能

### 注意事项
- meeting/workflow/comfyui 现在都是插件，不在内核中
- 不要往内核添加这些功能
- 插件通过 ExtensionPoints 扩展内核`,
  },
  {
    dir: 'team', name: 'claude-md-sync', type: 'project', scope: 'team',
    description: 'CLAUDE.md 文档同步规则',
    content: `## CLAUDE.md Sync Rules

每次代码变更后必须检查 CLAUDE.md 是否需要同步更新。

### 检查清单
1. 新增文件 → 添加到对应 src/*/CLAUDE.md 的文件树
2. 删除文件 → 从文件树中移除
3. 拆分文件 → 更新旧文件和新文件的文件树条目
4. 职责变更 → 更新描述和 Quick Task Routing
5. 新增系统 → 添加路由条目

### 验证
\`grep -r <new-file-basename> src/*/CLAUDE.md\` 确认新文件已出现。

过时的文档比没有文档更危险 — 主动误导。`,
  },
  // ── Reference ──
  {
    dir: 'team', name: 'quick-routing', type: 'reference', scope: 'team',
    description: '快速任务路由索引',
    content: `## Quick Task Routing

| 用户说 | 去哪里 | 关键文件 |
|---|---|---|
| chat/session/message broken | src/public/ | ConversationViewModel.ts, SessionsPage*.ts, InputPanel.ts |
| agent not responding/looping | src/server/core/agent/ | AgentLoop.ts, AgentRuntime.ts, StallDetector.ts |
| new tool | src/server/core/tools/builtin/ | 创建一个文件即自动注册 |
| new WS message type | src/server/infra/network/handlers/ | 创建 handler + registerAllHandlers.ts |
| new HTTP endpoint | src/server/gateway/routes/ | 创建 RouteHandler + registerAllRoutes.ts |
| new page | src/public/ts/components/pages/ | PageRegistry.ts + TitleBar.ts KERNEL_PAGES |
| new slash command | src/server/core/commands/builtin/ | 创建文件即自动注册 |
| CSS/style/theme/layout | src/public/css/ | layout.css, theme.css |
| WebSocket/protocol | src/shared/types/ | ws-protocol.ts → 后端 + 前端 |
| API endpoint | src/server/gateway/ | routes/*.ts |
| type/interface change | src/shared/types/ | 目标 .ts → 检查所有消费者 |
| new prompt section | src/server/core/prompt/sections/ | 创建 section + registerAllSections.ts |
| plugin system | src/server/core/plugin-host/ | PluginHostManager.ts, PluginHost.ts, PluginLoader.ts |`,
  },
  {
    dir: 'team', name: 'design-selection', type: 'reference', scope: 'team',
    description: '设计系统选择指南',
    content: `## Design Selection

### Base Brand
整个 App 的基础设计系统，控制所有共享 UI。64 个 DESIGN.md 文件在 design-md/ 目录。

### 选择规则
1. 首次 UI 工作前，询问用户选择哪种基础品牌
2. 一旦选定，整个会话保持相同品牌
3. 读取对应的 DESIGN.md，提取所有 tokens 到 CSS 自定义属性
4. 禁止在同一页面混合两个品牌的 tokens

### 页面特定覆盖
以下页面可以有独立的品牌：
- Workflow editor (plugin): 节点画布需要独特的视觉语言
- Meeting page (plugin): 协作空间，不同的氛围
- Agents org chart: 可以有自己的外观`,
  },
  {
    dir: 'team', name: 'reference-sources', type: 'reference', scope: 'team',
    description: '外部参考源码位置',
    content: `## Reference Sources

位于 F:/QoderSoft/reference/，遇到难题时查阅：

| Directory | 参考内容 |
|---|---|
| Claude code 源码/ | CLI 架构、工具系统、Agent 编排 |
| hermes-agent/ | 多 Agent、任务委派、ACP 协议 |
| crewAI/ | 多 Agent 协作、Role-Based Agent |
| autogen/ | 多 Agent 对话、代码生成 |
| codex/ | 沙箱执行、全自动 Agent |
| comfyui-backend/ | 节点图 / 工作流引擎 |`,
  },
  {
    dir: 'team', name: 'deepseek-constraints', type: 'reference', scope: 'team',
    description: 'DeepSeek API 关键约束',
    content: `## DeepSeek API Constraints

1. **role 字段必须存在**: 所有消息必须有 role，包括 tool results
2. **sanitizeHistory() 同步清理**: 孤立的 tool 消息必须在发送前清理
3. **不支持 image_url**: DeepSeek 不支持 image_url 内容类型
4. **reasoning_content 处理**: 缺失时存为空字符串，不要省略字段
5. **Token 计数**: 使用 TokenCounter 统一计数
6. **API URL**: OpenAI 兼容格式，通过 provider-factory.ts 创建

Retry 逻辑通过 AgentLoopLLM.ts 处理，速率限制通过 APIScheduler.ts 管理。`,
  },
  {
    dir: 'team', name: 'css-architecture', type: 'reference', scope: 'team',
    description: 'CSS 文件职责映射',
    content: `## CSS Architecture

| File | Purpose |
|---|---|
| theme.css | 设计 tokens: surface ladder, text colors, spacing, radius, typography |
| layout-core.css | HTML/body reset, app-root flex, titlebar, page-container, scrollbar |
| layout-cinema.css | Cinema 设计系统类 |
| layout-chat.css | Sessions 页面: tree, nodes, header, mode menu, log panel |
| layout-input.css | Input panel, attachments, slash popup |
| layout-panels.css | 共享组件: panel-header, form-field, buttons, dialog, toggle-switch |
| layout-page-components.css | SkillsPage/MemoryPage 卡片网格 + 共享 Modal |
| layout-page-agents.css | AgentsPage: org chart canvas |
| layout-pages.css | OverviewTab + PlanTab |
| layout-delegates.css | User/agent/streaming 消息 delegate |
| layout-delegate-cards.css | Think/todo/plan/system/delegation cards |
| layout-log-panel.css | Sub-session cards + floating log panel |
| layout-motion.css | Page transitions, keycap, shimmer |
| layout-page-files.css | FilesTab, file preview, AskUser card |`,
  },
  {
    dir: 'team', name: 'memory-system-internals', type: 'reference', scope: 'team',
    description: 'Memory 系统内部实现',
    content: `## Memory System Internals

### 目录结构
memory/team/ (团队共享), memory/agents/<agentId>/ (个人), memory/sessions/<sessionId>/ (会话)

### 核心类
- **MemoryManager** (singleton): search, searchAll, save, remove, buildMemoryPrompt, autoExtract
- **MemoryStore**: 文件系统层，MAX_LINES/MAX_BYTES 管理
- **MemoryEntry**: 类型定义 — MemoryScope (Team/Agent/Session), MemoryType (User/Feedback/Project/Reference)
- **MemorySearchScorer**: fuse.js 模糊搜索 — 加权键 (name:0.4, description:0.35, content:0.25)
- **MemorySynonyms**: 跨语言同义词扩展

### 自动提取
识别模式: "remember:", "learned:", "decided:", "know that:"`,
  },
  {
    dir: 'team', name: 'types-change-protocol', type: 'reference', scope: 'team',
    description: '类型变更的影响范围检查',
    content: `## Types Change Protocol

### 变更顺序
1. src/shared/types/ — 先改类型定义
2. src/server/ — 后端消费者
3. src/public/ts/types.ts — 前端副本同步
4. src/public/ts/ — 前端消费者

### 前端类型同步
需要手动同步的类型：AgentRole, AgentConfig (无 apiKey), SessionNode, TokenBreakdown

### 检查命令
\`grep -r "type-name" src/\` 找到所有引用点。后端用 @shared/* 别名，前端用相对路径。`,
  },
  {
    dir: 'team', name: 'tool-development-guide', type: 'reference', scope: 'team',
    description: '开发新 Tool 的指南',
    content: `## Tool Development Guide

### 内置 Tool
继承 Tool 基类，放到 src/server/core/tools/builtin/，自动注册不需要手动 import。

\`\`\`ts
export class MyTool extends Tool {
  static category = "File & Code";
  static toolDescription = "What this tool does.";
  name() { return "MyTool"; }
  parametersSchema() { return { type: "object", properties: {}, required: [] }; }
  async execute(params, ctx) { /* implementation */ }
}
\`\`\`

### 插件 Tool (零内核修改)
通过 anoclaw.tools.register() 注册，executeTool() 执行。PluginToolProxy 代理。`,
  },
  {
    dir: 'team', name: 'session-lifecycle', type: 'reference', scope: 'team',
    description: 'Session 生命周期和恢复机制',
    content: `## Session Lifecycle

### 创建
SessionManager.createSession(agentId, workspace)，生成 UUID，创建 JSONL 分片文件。

### 运行
AgentLoop 执行 ReAct 循环，每条消息追加到 JSONL。SessionStore 管理分片：10K 行 / 10MB / 30 天。

### 中断
InterruptController.requestInterrupt(sessionId)，Delegation timeout: 10 分钟。

### 恢复
SessionStore.scanRecoveryCandidates() 扫描未完成 session，启动时自动恢复。

### 存储结构
data/sessions/<sessionId>/shard_NNNNNN.jsonl`,
  },
  {
    dir: 'team', name: 'page-development-guide', type: 'reference', scope: 'team',
    description: '开发新 Page 的完整指南',
    content: `## Page Development Guide

### 创建新页面
1. 创建 Page 实现类，放到 src/public/ts/components/pages/
2. 在 app.ts 中实例化并注册
3. 在 TitleBar.ts KERNEL_PAGES 中添加导航条目
4. Build: npm run build:frontend

### 页面模式
- constructor: 创建 DOM，绑定事件
- onEnter: 加载数据（fetch API）
- onExit: 清理监听器、关闭 modal

### 使用已有组件
- ConfirmDialog.show(msg, title) → Promise<boolean>
- ToastManager (全局)
- ClientLogger.ui.error/warn/info`,
  },
  {
    dir: 'team', name: 'error-handling-patterns', type: 'reference', scope: 'team',
    description: '错误处理模式',
    content: `## Error Handling Patterns

### 后端
\`\`\`ts
try { /* logic */ } catch (err) {
  this._apiServer.sendJson(res, 500, { error: "Internal Error", message: (err as Error).message });
}
\`\`\`

### 前端 API 调用
\`\`\`ts
try { const r = await fetch("/api/v1/..."); this._data = r.ok ? await r.json() : []; }
catch { this._data = []; }
\`\`\`

### 日志
- 后端: LogManager.getLogger("module")，禁止 console.log
- 前端: ClientLogger.ui.error/warn/info`,
  },
  {
    dir: 'team', name: 'testing-strategy', type: 'reference', scope: 'team',
    description: '测试策略和规范',
    content: `## Testing Strategy

### 测试框架
Vitest (npm test)，测试文件: *.test.ts

### 测试原则
1. 系统级测试优先 — 测试真实行为，不是 mock
2. 不要 mock 数据库
3. 测试覆盖 golden path + 边缘情况
4. 每个 bug 修复要有对应的回归测试
5. 构建必须在测试之前通过

### 未覆盖区域
目前没有完整的前端自动化测试，依赖手动浏览器验证 + verification-before-completion skill。`,
  },
  {
    dir: 'team', name: 'plugin-development-checklist', type: 'reference', scope: 'team',
    description: '插件开发检查清单',
    content: `## Plugin Development Checklist

### 插件结构
plugins/<name>/plugin.json + extension.js + frontend/

### plugin.json
\`\`\`json
{
  "name": "my-plugin", "displayName": "My Plugin", "version": "1.0.0",
  "main": "extension.js", "activationEvents": ["onStartup"],
  "contributes": {
    "pages": [{ "id": "my-page", "title": "My Page", "html": "frontend/index.html" }],
    "commands": [{ "id": "my-cmd", "label": "My Command" }]
  }
}
\`\`\`

### 可用 API
anoclaw.tools.register, anoclaw.api.call, anoclaw.routes.register, anoclaw.log`,
  },
];

// ── Write files ──

for (const e of entries) {
  const dir = path.join(MEMORY_DIR, e.dir);
  fs.mkdirSync(dir, { recursive: true });

  const filePath = path.join(dir, e.name + '.md');
  const yaml = [
    '---',
    `name: ${e.name}`,
    `description: ${e.description}`,
    'metadata:',
    `  type: ${e.type}`,
    `  scope: ${e.scope}`,
    '---',
    '',
    e.content,
  ].join('\n');

  fs.writeFileSync(filePath, yaml, 'utf8');
  console.log(`  wrote ${e.dir}/${e.name}.md`);
}

// ── Rebuild MEMORY.md indexes ──

function buildIndex(dirPath, label) {
  const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.md') && f !== 'MEMORY.md');
  if (!files.length) return;

  const lines = [
    '---',
    'name: memory',
    `description: AnoClaw v2 ${label} memory index`,
    'metadata:',
    '  node_type: memory',
    `  type: ${label}`,
    '  originSessionId: dd8337e5-cbe5-4ad9-8083-f46d3210d79d',
    '---',
    '',
  ];

  // Group by type
  const groups = {};
  for (const f of files) {
    const content = fs.readFileSync(path.join(dirPath, f), 'utf8');
    const m = content.match(/^type:\s*(\w+)/m);
    const type = m ? m[1] : 'reference';
    if (!groups[type]) groups[type] = [];
    const desc = content.match(/^description:\s*(.+)$/m);
    groups[type].push({ file: f, desc: desc ? desc[1] : f });
  }

  for (const [type, items] of Object.entries(groups)) {
    lines.push(`## ${type.charAt(0).toUpperCase() + type.slice(1)}`);
    for (const item of items) {
      lines.push(`- [${item.desc}](${item.file})`);
    }
    lines.push('');
  }

  fs.writeFileSync(path.join(dirPath, 'MEMORY.md'), lines.join('\n'), 'utf8');
  console.log(`  rebuilt ${dirPath}/MEMORY.md (${files.length} entries)`);
}

buildIndex(path.join(MEMORY_DIR, 'team'), 'team');
buildIndex(path.join(MEMORY_DIR, 'agents/ceo'), 'personal');

console.log(`\nDone! ${entries.length} memory files written.`);
