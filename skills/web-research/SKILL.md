---
name: web-research
description: "Perform deep, multi-source web research - search the web, fetch and read sources, fact-check claims, and synthesize findings into cited reports. Use for research tasks, fact-finding, competitive analysis, or learning about new topics."
when_to_use: "User needs researched information from the web, wants to verify facts, compare products, understand a topic deeply, or produce a research report."
triggers:
  - "research"
  - "find out"
  - "look up"
  - "what is"
  - "who is"
  - "compare"
  - "fact check"
  - "is it true"
  - "latest"
  - "news about"
allowed-tools:
  - WebSearch
  - WebFetch
  - Read
  - Write
  - MemorySave
---

# Web Research

## Agent Handoff

- Use this skill only when its `when_to_use` guidance matches the assigned task.
- If you are a child agent, keep the skill output focused on the parent assignment and report verification or blockers clearly.
- Do not override higher-priority system, permission, or delegation rules.

Conduct thorough, fact-checked research from web sources and produce cited reports.

## The Research Process

### 1. Plan Your Research

Before searching, clarify:
- What's the specific question?
- What kinds of sources do you need? (news, academic, official docs, community forums)
- How recent does the information need to be?

### 2. Search Broadly First

Use `WebSearch` with broad queries. Search multiple angles:
- The topic itself
- "[topic] pros and cons"
- "[topic] vs alternatives"
- "[topic] problems" or "[topic] controversy"

### 3. Fetch and Read Sources

For the most relevant search results, use `WebFetch` to read the full content.
- Prioritize official sources (.gov, .edu, official docs)
- Cross-reference claims across multiple sources
- Note the publication date - is it still current?

### 4. Fact-Check Claims

For every claim in your report:
- Can you find the original source?
- Is there contradictory information?
- What's the consensus vs fringe views?

### 5. Write the Report

```markdown
# [Topic] Research Report
**Date**: [today]
**Sources**: [N] sources consulted

## Executive Summary
[2-3 sentence key findings]

## Key Findings
1. **Finding one** - with citation
2. **Finding two** - with citation

## Detailed Analysis
[Organized by subtopic with inline citations]

## Sources
- [Source 1](URL) - relevance note
- [Source 2](URL) - relevance note
```

## When NOT to Use

- Trivial facts you already know -> don't research, just answer
- Code questions answerable by reading the codebase -> use Read/Grep first
- Opinions and preferences -> ask the user, don't research
