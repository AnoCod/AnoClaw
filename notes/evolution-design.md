# Evolution System — 深度设计方案

## 总体架构

```
用户交互层
┌──────────────────────────────────────────────────────────────┐
│  MessageCard (5星+评论) │ SessionCard (标签chips) │ 设置页   │
└──────────────────────────────┬───────────────────────────────┘
                               │ WS (SSE events)
数据采集层 (运行时，零阻塞)
┌────────────────┬──────────────┬──────────────┬────────────────┐
│  Module 1      │ Module 2     │ Module 4     │  Module 5      │
│  PatternDetect │ KeywordExt   │ SessionTag   │  QualityScore  │
│  (agent loop   │ (每10轮)     │ (mid/end)    │  (用户触发)    │
│   完成时)      │              │              │                │
└────────┴───────┴──────┴──────┴──────┴───────┴───────┴────────┘
         │              │              │               │
         ▼              ▼              ▼               ▼
持久化层
┌──────────────────────────────────────────────────────────────┐
│  data/evolution/                                            │
│  ├── patterns.json       (Module 1: 工作流模式库)           │
│  ├── stats/                                                 │
│  │   ├── skill-stats.json  (Module 3: 全局技能统计)         │
│  │   ├── memory-stats.json (Module 3: 全局记忆统计)         │
│  │   └── tool-stats.json   (Module 3: 工具效率统计)         │
│  ├── scores/                                                │
│  │   ├── YYYY-MM-DD.jsonl  (Module 5: 按天分片评分)        │
│  │   └── index.json         (聚合索引)                      │
│  └── reports/                                               │
│      ├── preview/            (Module 6: 进化预览)           │
│      └── applied/            (Module 6: 已应用的进化)       │
└────────────────────────┬────────────────────────────────────┘
                         │
分析层 (Module 6: 复盘进化引擎)
┌──────────────────────────────────────────────────────────────┐
│                    EvolutionEngine                           │
│  ├── 技能分析: LLM变异 + A/B统计 → 分支/晋升/归档           │
│  ├── 记忆分析: 检索率 + 时效性 → 保留/合并/修改/删除        │
│  ├── 提示词分析: 评分关联 → 微调/保持                       │
│  └── Token分析: 算法统计 → 浪费报告                         │
│  输出: EvolutionReport (预览→人工审批→应用→可回滚)            │
└──────────────────────────────────────────────────────────────┘
```

---

## 模块一：重复率检测 → 自动生成技能

### 问题
Hermes 只看"单次复杂度"（5+ tool calls），你要求的是"跨会话的重复率"。

### 方案

**模式追踪**

每次工具调用记录规范化签名（工具名 + 参数类型，不计实际值）：

```typescript
// data/evolution/patterns.json 内的一条
{
  "patternId": "pat_abc123",
  "signature": [
    { "tool": "Grep", "params": ["pattern:string", "path:string"] },
    { "tool": "Read", "params": ["file_path:string"] },
    { "tool": "Edit", "params": ["file_path:string", "old_string:string"] }
  ],
  "count": 5,
  "firstSeen": "2026-06-20T10:00:00Z",
  "lastSeen": "2026-06-24T15:30:00Z",
  "sessions": ["sess_001", "sess_002", "sess_005"],
  "avgTokenCost": 12500,
  "skillId": null   // 生成了skill之后填这里
}
```

**触发阈值**

| 条件 | 动作 |
|------|------|
| 同一 pattern 出现 ≥3 次 | LLM 生成 SKILL.md 草案 |
| 同一 pattern 出现 ≥5 次 且已有 skill | LLM 评估现有 skill 是否需要更新 |
| 同一 pattern 30天无匹配 | 标记为"休眠"，不触发创建 |

**为什么这样设计：**
- 纯算法统计（count++）零成本
- LLM 只在阈值触发时才调用，不浪费 token
- session 列表可追溯，方便后面模块6分析

### 存储
`data/evolution/patterns.json` — 启动时加载到内存，变更时原子写入（`.tmp` → rename）

---

## 模块二：每N轮自动提取关键词

### 方案

AgentLoop 每 N 轮（默认 10，可配置）插入一次关键词提取：

```
AgentLoop 每轮末尾:
  if (turnCount % KEYWORD_INTERVAL === 0 && turnCount > 0) {
    const keywords = await extractKeywords(recentMessages);
    appendToSession(keywords);
  }
```

每次提取的结果：

```typescript
// 写入 session JSONL 作为 keyword_extraction 事件
{
  "type": "keyword_extraction",
  "turnRange": { "start": 11, "end": 20 },
  "userKeywords": ["button color", "login page", "dark mode"],
  "llmKeywords": ["CSS variable", "theme system", "responsive layout"],
  "summary": "用户正在修改登录页面的暗黑模式配色方案",
  "timestamp": "2026-06-24T15:35:00Z"
}
```

**关键词的持久化路径：**

```
session JSONL:     keyword_extraction 事件（完整历史）
memory/sessions/
  └── <sessionId>/
      └── keywords.json      （快速检索用，仅最新摘要）
```

**提取方式：** 用 LLM 提取，单次调用 ~200 tokens。可选的降级方案：基于 TF-IDF 的纯算法提取（零 token 成本），但质量会差一些。

---

## 模块三：技能使用率 & 记忆检索率统计

### 双范围设计

这是跟 Hermes Curator 最大的区别点——你的设计有全局和会话两个维度。

### 全局统计

```typescript
// data/evolution/stats/skill-stats.json
{
  "version": 1,
  "updatedAt": "2026-06-24T16:00:00Z",
  "skills": {
    "skill_frontend_fix": {
      "loadCount": 47,        // 被加载到 prompt 的次数
      "matchL0Count": 182,    // 命中了 L0 索引但未加载全文
      "execReferencedCount": 31,  // agent 实际引用了 skill 内容
      "patchCount": 3,        // 被修改的次数
      "avgScore": 4.2,        // 来自 Module 5 的平均评分
      "lastUsedAt": "2026-06-24T14:00:00Z",
      "lastPatchedAt": "2026-06-20T09:00:00Z"
    }
  }
}
```

```typescript
// data/evolution/stats/memory-stats.json
{
  "version": 1,
  "memories": {
    "memory_user_pref_theme": {
      "retrievalCount": 12,      // MemorySearch 命中的次数
      "clickThroughCount": 9,    // 命中后 agent 实际读取了内容
      "clickThroughRate": 0.75,
      "lastRetrievedAt": "2026-06-24T10:00:00Z"
    }
  }
}
```

### 会话级统计

存储在 session metadata 中：

```typescript
// SessionNode.evolutionStats
{
  "skillsUsed": [
    { "skillId": "skill_frontend_fix", "loadedAt": "...", "turnsReferenced": [5, 7, 12] }
  ],
  "keywords": ["login", "dark mode", "CSS"],
  "tokenUsage": {
    "total": 45000,
    "byTool": { "Read": 12000, "Grep": 5000, "Edit": 3000 }
  }
}
```

### 埋点位置

| 统计项 | 埋点位置 | 方式 |
|--------|---------|------|
| skill loadCount | SkillManager.loadSkill() | +1 |
| skill matchL0Count | PromptAssembler 构建时 | +1 |
| skill execReferenced | agent 调用 skill 相关工具后 | AgentLoop 检测引用 |
| memory retrievalCount | MemorySearch.execute() | +1 |
| memory clickThroughCount | agent 用 Read 读取了返回的文件 | AgentLoop 追踪 |
| tool token usage | ToolPipeline.run() | 累加 token |

所有统计操作都是 O(1) 内存计数 + 异步写入，不影响主流程性能。

---

## 模块四：会话自动打标签

### 方案

**标签生成时机：**

| 时机 | 方式 | 标签类型 |
|------|------|---------|
| 每 10 轮（与关键词提取同步） | LLM 提取 1-3 个标签 | `auto` |
| 会话结束时 | LLM 生成最终标签集（合并+提炼） | `auto` |
| 用户手动 | UI 上添加/删除/确认 | `user` |

**数据结构：**

```typescript
// 附加到 SessionNode.tags
[
  {
    "label": "frontend",
    "category": "auto",
    "confidence": 0.85,
    "createdAt": "2026-06-24T15:00:00Z"
  },
  {
    "label": "bug-fix",
    "category": "user",
    "createdAt": "2026-06-24T15:05:00Z"
  }
]
```

**用户交互：**
- Session 卡片上显示标签 chips
- `auto` 标签用灰色，`user` 标签用蓝色
- 点击 X 移除标签（`userRemoved = true`，不真删）
- 点 + 输入新标签

**反向索引（用于标签检索）：**
```
memory/tags/<tagName>/sessions.json → session ID 列表
```

---

## 模块五：人工质量评分（最关键的设计）

这是模块6的"燃料"——没有评分数据，进化引擎就没有优化目标。

### 评分绑定

每次 agent 输出一条消息，这条消息有一个 `messageId`。评分绑定到：

```
score → sessionId + agentId + messageId + turnNumber
```

精确到是哪条输出被打了分。

### 数据结构

```typescript
interface QualityScore {
  id: string;                    // auto UUID
  sessionId: string;
  agentId: string;
  messageId: string;             // 被评分的消息
  turnNumber: number;
  score: number;                 // 1-5
  comment?: string;              // 人类写的评论
  createdAt: string;
  updatedAt?: string;
  source: 'human';
}
```

### 存储

**按天分片**（跟 session JSONL 同样的模式，成熟稳定）：

```
data/evolution/scores/
├── 2026-06-24.jsonl     // 今天的评分，append-only
├── 2026-06-23.jsonl     // 昨天的
└── index.json           // 聚合索引
```

`index.json` 结构：

```typescript
{
  "version": 1,
  "updatedAt": "...",
  "summary": {
    "totalScores": 284,
    "avgScore": 3.8,
    "byAgent": {
      "agent_dev_1": { "count": 45, "avg": 4.1 },
      "agent_mgr_eng": { "count": 23, "avg": 3.5 }
    },
    "bySession": {
      "sess_001": { "count": 5, "avg": 4.0 }
    }
  }
}
```

### 前端通信流

```
消息卡片底部:
  ┌──────────────────────────────────────┐
  │  评分: ★★★★☆  4/5                   │
  │  评论: "CSS 选择器写得很干净，但      │
  │         缺少移动端断点"               │
  │  [编辑]                              │
  └──────────────────────────────────────┘

WS:
  Frontend → { type: "quality_score", payload: { score, messageId, comment? } }
  Backend  → { type: "quality_score_ack", payload: { id, status: "saved" } }
```

### 为什么评分必须持久化

模块6的进化引擎需要数据驱动决策。没有评分数据，所有"要不要改"的判断都是盲猜。有了评分数据：

| 分析维度 | 数据支撑 |
|---------|---------|
| 技能好坏 | 使用了该技能的 session 评分均值 |
| 提示词好坏 | 该 agent 收到的所有评分均值趋势 |
| 工具使用效率 | 评分高的 session 用了哪些工具组合 |
| Token 浪费 | 评分一样的 session，token 用量差异大的说明浪费 |

---

## 模块六：复盘进化引擎

这是所有模块的汇聚点。最初由人类手动触发（Settings 页面的"复盘进化"按钮），未来可以 cron 定时触发。

### 进化管线

```
触发 → 数据聚合 → 多维度分析 → 生成报告 → 预览 → 人工审批 → 应用 → 备份
```

### 四个分析维度

#### 6.1 技能分析（trunk/branch 模型）

```
当前状态:                  进化后:
skill_A (trunk)            skill_A (trunk, unchanged)
  ├── score: 4.2             └── skill_A_v2 (branch→new trunk)
  └── token: avg 12k               ├── score: 4.6
       (被分支)                     ├── token: avg 8k
                                    └── traffic: 100%
```

**算法逻辑：**

1. 对每个活跃技能，检查 `avgScore` 趋势
2. 如果评分下降或 token 成本异常高 → LLM 生成变异版本
3. 变异版本分配 10% 流量，观测 N 个 session 的评分
4. 评分比较：
   - 变异显著优于主干 → 晋升为新主干（旧主干降为分支，保留可回滚）
   - 变异劣于主干 → 丢弃
   - 数据不足 → 增流量继续观测
5. 90 天无活动的分支 → 归档

**什么是"显著优于"：** 评分高 ≥0.5 且样本数 ≥10，或者评分相近但 token 成本低 ≥30%。

#### 6.2 记忆分析

| 判定 | 条件 | 动作 |
|------|------|------|
| 好记忆 | 检索率 > 50% | 保留 |
| 冗余记忆 | 多段记忆内容重叠 | LLM 合并 |
| 过时记忆 | 30天未被检索 | 标记 stale |
| 无效记忆 | 检索后 clickThrough 为 0 | 标记 stale |
| 错误记忆 | 用户评分低且评论指出错误 | LLM 修改 |

**分支同样适用：** 旧版本保留 30 天可回滚。

#### 6.3 专属提示词微调

这是最谨慎的操作。只有满足以下条件才会触发：

- 该 agent 收到了 ≥20 条评分
- 评分趋势是**持续下降**（最近 10 条比之前 10 条低 ≥0.5）
- 用户评论中提到了明确的行为问题

满足条件的：
1. 收集评分 + 评论 + 最近 session 摘要
2. LLM 分析：是提示词问题还是其他问题？
3. 如果判断为提示词问题 → LLM 生成修改建议（diff 格式）
4. 人类审查 diff → 确认或拒绝

**不满足条件的不动。** 这条规则优先级最高。

#### 6.4 Token 浪费分析

这个是纯算法，零LLM成本：

```typescript
interface TokenWasteReport {
  toolName: string;
  avgTokens: number;
  p50: number;
  p95: number;
  callCount: number;
  estimatedWasteTokens: number; // (p95 - p50) * callCount
  topSessions: string[];        // waste 最多的 session
}
```

**判断浪费的逻辑：** 同一工具的 `p95 > p50 * 3` → 说明该工具的某些调用异常大。可能原因：Read 读了太多行、Grep返回了太多结果、Bash 输出没限制。

**优化建议：** "Read 工具 p95 是 p50 的 5 倍，建议在提示词中强调 offset/limit 参数的使用"。

### 进化报告格式

```typescript
interface EvolutionReport {
  id: string;
  createdAt: string;
  trigger: 'manual' | 'auto';
  
  skillChanges: Array<{
    skillId: string;
    action: 'promote_branch' | 'archive' | 'keep';
    reason: string;
    diff?: string;        // SKILL.md 的变化（如果有）
  }>;
  
  memoryChanges: Array<{
    memoryId: string;
    action: 'keep' | 'merge' | 'stale' | 'modify';
    reason: string;
  }>;
  
  promptSuggestions: Array<{
    agentId: string;
    action: 'tweak' | 'keep';
    diff?: string;
    reason: string;
  }>;
  
  tokenFindings: Array<{
    toolName: string;
    finding: string;
    recommendation: string;
    estimatedSavings: number;
  }>;
  
  appliedAt?: string;
  rollbackId?: string;
}
```

### 安全机制

1. **所有进化的输出必须是报告，不是直接操作**
2. **人类审批评后才能应用**
3. **应用前自动备份被修改的文件**
4. **一键回滚：** 每个 applied report 都有一个 rollbackId

---

## 实施优先级

| 优先级 | 模块 | 理由 | 预估工期 |
|--------|------|------|---------|
| P0 | Module 5: Quality Score | 模块6的数据基础，独立可用，即时价值 | 2-3天 |
| P1 | Module 3: Stats | 模块6需要数据，简单计数先跑起来 | 2天 |
| P2 | Module 4: Session Tagging | 用户体验提升明显，复杂度中等 | 3天 |
| P3 | Module 2: Keyword Extract | 轻量级，给模块6提供语义信号 | 1天 |
| P4 | Module 1: Pattern Detect | 需要足够 session 积累才能生效 | 3天 |
| P5 | Module 6: Evolution Engine | 依赖 P0-P4 数据，最后才做 | 5天 |

### 代码组织

```
src/server/core/evolution/
├── EvolutionManager.ts           # 主调度器 (singleton, EventEmitter)
├── EvolutionExtension.ts         # Extension 包装
├── modules/
│   ├── PatternDetector.ts        # M1
│   ├── KeywordExtractor.ts       # M2
│   ├── StatsCollector.ts         # M3
│   ├── SessionTagger.ts          # M4
│   ├── QualityScoreManager.ts    # M5
│   └── EvolutionEngine.ts        # M6
├── storage/
│   ├── EvolutionStore.ts         # 通用进化数据持久化
│   └── ScoreStore.ts             # 评分 JSONL 存储
└── types/
    └── evolution-types.ts        # 所有共享类型
```

---

## 跟现有系统的集成点

| 集成点 | 位置 | 做什么 |
|-------|------|--------|
| AgentLoop 每轮末尾 | `AgentLoop.ts` | 触发关键词提取、标签生成 |
| AgentLoop 完成时 | `AgentLoop.ts` | 触发模式分析 |
| ToolPipeline.run() | `ToolPipeline.ts` | 收集 token 用量 |
| MemorySearch | `MemorySearch.ts` | 统计检索率和 clickThrough |
| SkillManager | `SkillManager.ts` | 统计技能加载/使用 |
| TypedEventBus | 全局 | 模块间事件通信 |
| WsMessageRouter | 前端通信 | 接收评分、标签修改等用户操作 |
| SessionNode | 会话元数据 | 扩展 evolutionStats 和 tags 字段 |

---

## 总结

这个设计方案的核心原则：

1. **数据先行** — 模块 5（评分）最先做。没有评分，进化没有目标。
2. **双范围统计** — 全局 + 会话，既能看长期趋势又能看单次行为。
3. **trunk/branch 模型** — 继承自 git 的设计理念，安全可回滚。
4. **算法优先，LLM 补充** — 统计计数零成本，只关键判断用 LLM。
5. **人类在环** — 所有改变需要审批，不回滚也能手动修正。

---

## 实施状态 (2026-06-24)

### ✅ 已完成 — 全部模块 + 前端集成

```
src/shared/types/evolution.ts          — 所有共享类型定义
src/server/core/evolution/
  storage/EvolutionStore.ts             — 原子JSON + JSONL分片存储 (已测试)
  modules/
    QualityScoreManager.ts              — M5: 评分管理 (已测试)
    StatsCollector.ts                   — M3: 工具/技能/记忆统计 (已测试)
    SessionTagger.ts                    — M4: 会话标签管理 (已测试)
    PatternDetector.ts                  — M1: 模式检测 (已测试)
    KeywordExtractor.ts                 — M2: 关键词提取 (已测试)
    EvolutionEngine.ts                  — M6: 进化分析引擎 (已测试)
  EvolutionManager.ts                  — 统一调度器
  EvolutionExtension.ts                — Extension 包装器 (TypedEventBus 订阅)
src/server/infra/network/handlers/
  QualityScoreHandler.ts               — WS quality_score 消息处理
  registerAllHandlers.ts               — 已注册 quality_score 处理器
src/server/gateway/routes/
  EvolutionRoute.ts                    — POST /api/v1/evolution/analyze
src/public/ts/
  handlers/ChatHandlers.ts             — 已注册 quality_score_ack/error 处理器
  components/evolution/
    StarRating.ts                      — 前端星卡组件 (1-5星 + 评论)
  components/conversation/
    delegates/AgentMessageDelegate.ts   — StarRating 嵌入消息卡片底部
    SessionTreeNode.ts                  — 标签 chips 显示
  components/pages/SettingsPage.ts      — "复盘进化"按钮 + 结果展示
  app.ts                               — sendQualityScore() WS 通信
```

**测试: 590 全绿** (548 存量 + 42 新进化测试)

### 🔌 事件连线

| 事件 | 生产者 | 消费者 | 用途 |
|------|--------|--------|------|
| `tool:execution_completed` | ToolRegistry | EvolutionExtension | M3 统计 + M1 模式缓冲 |
| `loop:keyword_turn` | AgentLoop (每10轮) | EvolutionExtension | M2 关键词提取 |
| `loop:completed` | AgentRuntime | EvolutionExtension | M4 自动标签 + M1 模式提交 |
| WS `quality_score` | 前端 StarRating | QualityScoreHandler | M5 评分持久化 |

### 📝 已知限制

- M6 EvolutionEngine 的分析是启发式的（算法优先）。未来可集成 LLM 或 DSPy/GEPA 做更深入的语义分析。
- M1 自动生成 SKILL.md 的后半段（pattern → SKILL.md）依赖 SkillManager.autoGenerateSkill，需要额外联调。当前 PatternDetector 会记录重复序列但不会自动创建技能文件。
- 评分的前端展示（按 agent 查看评分趋势图表）尚未实现。
