# src/shared/ — Type Contracts

These files are the contract between frontend and backend. **Changes here break both sides.** Always run `npm run build:all` after any change.

## File Map

```
src/shared/
├── constants.ts                # Global constants (paths, timeouts, limits)
└── types/
    ├── index.ts                # Unified exports — add new exports here
    ├── ws-protocol.ts          # ★ WebSocket protocol — client↔server message format
    ├── session.ts              # Session, Message, JsonlEvent, ContentBlock
    ├── agent.ts                # Agent definition, AgentRole, AgentStatus
    ├── tool.ts                 # Tool definition, ToolSchema, ToolCategory
    ├── command.ts              # Slash command definitions, CommandCategory
    ├── llm.ts                  # LLM config, ModelConfig
    ├── evolution.ts           # Evolution system types (scores, stats, patterns)
    └── events.ts               # Event constant definitions + TypedEventMap
        └── stream-events.ts         # Stream event type definitions
```

## Add a New Type (Safe Operation)

```
1. Add interface/type/enum to the right file
2. Export from types/index.ts
3. Run: npm run build:all
4. Verify both sides compile
```

## Change an Existing Type (Dangerous Operation)

```
1. Read the type, understand what it represents
2. Grep ALL consumers: grep -r "TypeName" src/server/ src/public/ src/shared/
3. Make the change:
   - Adding optional fields (?): safe, go ahead
   - Changing field types: check ALL consumers first
   - Removing fields: DON'T without explicit approval — check ALL consumers
   - Renaming fields: DON'T — add new field, deprecate old with @deprecated comment
4. Update all broken consumers in both src/server/ and src/public/
5. Run: npm run build:all
6. Fix any remaining build errors
```

## Quick Task Routing

| User asks | Touch these files |
|------|------|
| "agent capabilities / discovery" | `types/agent.ts` |
| "event types / TypedEventMap" | `types/events.ts` |
| "WS protocol / message types" | `types/ws-protocol.ts` |

## Consumer Checklist by Type File

| Changing... | Check these consumers |
|------|------|
| `ws-protocol.ts` | `WSClient.ts` (frontend), `WsMessageRouter.ts`, `WsServer.ts`, `main.ts`, `infra/network/handlers/*.ts` (backend) |
| `session.ts` | `SessionManager.ts`, `SessionStore.ts`, `ConversationViewModel.ts`, `SessionListModel.ts` |
| `agent.ts` | `AgentConfig.ts`, `AgentRegistry.ts`, `AgentRuntime.ts`, `AgentViewModel.ts` |
| `tool.ts` | `ToolRegistry.ts`, `Tool.ts`, all 33 builtin tools, frontend tool result rendering |
| `llm.ts` | `OpenAICompatibleProvider.ts`, `OllamaProvider.ts`, `APIScheduler.ts`, `PromptAssembler.ts` |
| `gateway.ts` | `GatewayRouter.ts` (kernel bridge — platform adapters now in plugins) |
| `events.ts` | `TypedEventBus.ts`, `EventSubscriptionManager.ts`, `WsForwardSubscriber.ts` |
| `evolution.ts` | `EvolutionManager.ts`, all 6 evolution modules, `EvolutionStore.ts`, frontend `StarRating.ts` |

## Key Types Reference

### ws-protocol.ts (Most Critical)
- `WsClientMessage` — Client→Server, discriminated union on `type`
- `WsServerMessage` — Server→Client
- When adding a new WS message: add type to union + create handler in both `src/server/infra/network/handlers/` and `src/public/ts/handlers/`

### session.ts
- `SessionMeta` — Lightweight, for list display
- `Session` — Full session with messages
- `Message` — `senderId`, `role`, `contentBlocks[]`
- `JsonlEvent` — Append-only event, UUID chain

## Standards
1. **Interface** for pure data. **Type** for unions/intersections. **Enum** for string constants.
2. New fields → optional (`?`). Don't break existing consumers.
3. Runtime validation → companion Zod schema (when needed).
4. **No `any`** in type definitions. Fix the type, don't force-cast.
5. One type = one canonical location. No duplicates between files.
6. PascalCase interfaces, camelCase fields.
7. Comments/identifiers in English.
