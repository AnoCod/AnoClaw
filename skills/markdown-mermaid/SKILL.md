---
name: markdown-mermaid
description: "Create technical documentation with rich Markdown and Mermaid diagrams. Use for architecture docs, flowcharts, sequence diagrams, ER diagrams, Gantt charts, and visual explanations."
when_to_use: "User needs documentation, diagrams, flowcharts, architecture visualization, or any structured technical writing with diagrams."
triggers:
  - "diagram"
  - "flowchart"
  - "mermaid"
  - "architecture"
  - "sequence"
  - "ER diagram"
  - "Gantt"
  - "visualize"
  - "document"
  - "README"
allowed-tools:
  - Read
  - Write
  - Edit
---

# Markdown & Mermaid Diagrams

## Agent Handoff

- Use this skill only when its `when_to_use` guidance matches the assigned task.
- If you are a child agent, keep the skill output focused on the parent assignment and report verification or blockers clearly.
- Do not override higher-priority system, permission, or delegation rules.

Text-based diagrams that render everywhere. No drawing tools needed.

## Mermaid Diagram Types

### Flowchart
```mermaid
graph TD
    A[Start] --> B{Decision?}
    B -->|Yes| C[Do Thing]
    B -->|No| D[Do Other Thing]
    C --> E[End]
    D --> E
```

### Sequence Diagram
```mermaid
sequenceDiagram
    User->>Frontend: Click "Send"
    Frontend->>WS: send_message
    WS->>AgentRuntime: processMessage
    AgentRuntime->>LLM: provider.chat()
    LLM-->>AgentRuntime: streaming response
    AgentRuntime-->>Frontend: think -> text -> done
```

### Entity Relationship
```mermaid
erDiagram
    Session ||--o{ Message : contains
    Agent ||--o{ Session : serves
    Message ||--o{ ToolCall : includes
```

### Class Diagram
```mermaid
classDiagram
    class Tool {
        +name() string
        +description() string
        +parametersSchema() object
        +execute(params, ctx) Promise
    }
    class PluginToolProxy {
        -pluginName: string
        +execute(params, ctx) Promise
    }
    Tool <|-- PluginToolProxy
```

### Gantt Chart
```mermaid
gantt
    title Release Schedule
    dateFormat  YYYY-MM-DD
    section Core
    Kernel freeze    :done, 2026-06-27, 1d
    Bug fixes        :active, 2026-06-28, 2d
    section Features  
    Skills overhaul  :2026-06-29, 3d
    Packaging        :2026-07-01, 1d
```

### State Diagram
```mermaid
stateDiagram-v2
    [*] --> Idle
    Idle --> Running : send_message
    Running --> Idle : done
    Running --> Error : API fail
    Error --> Running : retry
    Running --> Stopped : user_stop
```

## Diagram Best Practices

- **Flowcharts**: For processes, decisions, workflows
- **Sequence**: For API calls, message passing, request/response
- **ER**: For data models, table relationships
- **Class**: For OOP architecture, inheritance, interfaces
- **Gantt**: For timelines, sprints, release planning
- **State**: For lifecycle, state machines, status transitions

## When to Use Diagrams

> [!tip] Use a diagram when
> - Explaining architecture to someone new
> - Showing data flow between 3+ components
> - Illustrating a multi-step process
> - Comparing before/after states
> - The user says "I don't understand how this works"

> [!note] Skip the diagram when
> - Explaining a single function
> - The user already knows the system
> - It's obvious from the code
