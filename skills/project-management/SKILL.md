---
name: project-management
description: "Plan, track, and execute projects - task breakdown, timeline estimation, risk assessment, stakeholder communication, and sprint planning. Use for any project that spans more than a single coding session."
when_to_use: "User mentions a 'project', needs to plan work, break down tasks, create a timeline, assess risks, or organize team collaboration."
triggers:
  - "project"
  - "plan"
  - "timeline"
  - "sprint"
  - "milestone"
  - "deadline"
  - "team"
  - "coordinate"
  - "roadmap"
allowed-tools:
  - Read
  - Write
  - TodoWrite
  - TaskAssign
  - TaskList
---

# Project Management

## Agent Handoff

- Use this skill only when its `when_to_use` guidance matches the assigned task.
- If you are a child agent, keep the skill output focused on the parent assignment and report verification or blockers clearly.
- Do not override higher-priority system, permission, or delegation rules.

Plan, track, and deliver projects. Use TodoWrite for task tracking and TaskAssign for delegation.

## Project Lifecycle

### 1. Define
- What's the goal? One sentence.
- Who's involved? List stakeholders.
- What's the deadline? If none, propose one.
- What's NOT in scope? Explicitly state exclusions.

### 2. Break Down
Decompose into bite-sized tasks (2-5 min each):
```
Goal: Add dark mode to settings
  -> Add CSS variables for dark theme
  -> Update theme toggle in SettingsPage
  -> Test on 3 pages (chat, agents, plugins)
  -> Handle system preference detection
  -> Add transition animation
```

### 3. Prioritize

```
P0 - Must have (ship blocker)
P1 - Should have (this release)
P2 - Nice to have (next release)
P3 - Someday (backlog)
```

### 4. Estimate (T-Shirt Sizes)

| Size | Effort | Example |
|------|--------|---------|
| XS | < 1 hour | CSS tweak, typo fix |
| S | 1-4 hours | Add one component, one endpoint |
| M | 1-2 days | Feature with 3+ files |
| L | 3-5 days | New subsystem |
| XL | 1-2 weeks | Multi-agent orchestration |

### 5. Track
- One task `in_progress` at a time
- Mark complete immediately - don't batch
- If blocked, flag it with what's needed
- End of session: update project status

## Risk Assessment

For any non-trivial project, identify:
1. **What can go wrong?** (technical, people, timeline)
2. **How likely?** (Low/Medium/High)
3. **Impact if it does?** (Low/Medium/High)
4. **Mitigation** - what can we do now to prevent or reduce impact?

## Stakeholder Communication

When reporting to non-technical stakeholders:
- Lead with outcome, not process
- Use plain language, no jargon
- What's done, what's next, what's blocked
- One update per milestone, not per commit

## Sprint Planning Template

```
Sprint Goal: [One sentence]
Duration: [1-2 weeks]
Team: [who's working on this]

Backlog -> This Sprint:
  [ ] P0: Task 1 - Owner: @name
  [ ] P0: Task 2 - Owner: @name
  [ ] P1: Task 3 - Owner: @name

Definition of Done:
  - [ ] Tests pass
  - [ ] Code reviewed
  - [ ] User verified
```
