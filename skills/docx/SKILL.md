---
name: docx
description: "Create, read, edit, and manipulate Word documents (.docx files). Use when the user wants to produce professional documents, reports, letters, memos, or templates as .docx files."
when_to_use: "Any time a .docx file is involved - creating, reading, editing, or converting. Triggers on 'Word doc', 'word document', '.docx', 'report', 'memo', 'letter', 'template'."
triggers:
  - "docx"
  - "Word document"
  - ".docx"
  - "report"
  - "memo"
  - "letter"
  - "template"
allowed-tools:
  - Read
  - Write
  - Bash
  - Glob
---

# Document Creation (DOCX)

## Agent Handoff

- Use this skill only when its `when_to_use` guidance matches the assigned task.
- If you are a child agent, keep the skill output focused on the parent assignment and report verification or blockers clearly.
- Do not override higher-priority system, permission, or delegation rules.

Create and edit Word documents directly from AnoClaw.

## Creating Documents

Use Python's `python-docx` library for programmatic document creation. Install once with:

```bash
pip install python-docx
```

Then write Python scripts to create documents with proper formatting.

## Template Example

```python
from docx import Document
from docx.shared import Inches, Pt
from docx.enum.text import WD_ALIGN_PARAGRAPH

doc = Document()

# Title
title = doc.add_heading('Report Title', level=0)
title.alignment = WD_ALIGN_PARAGRAPH.CENTER

# Body
doc.add_paragraph('Executive summary goes here...')

# Table
table = doc.add_table(rows=3, cols=3)
table.style = 'Light Grid Accent 1'

# Save
doc.save('output.docx')
```

## Common Operations

- **Read content**: Use Python `python-docx` to extract paragraphs
- **Add images**: `doc.add_picture('image.png', width=Inches(3))`
- **Page numbers**: Add footer with page numbers
- **Table of contents**: Add heading styles, Word generates TOC on open
- **Headers/footers**: `section.header.paragraphs[0].text = "Header"`

## When NOT to Use

- For presentations -> use pptx skill
- For spreadsheets -> use xlsx skill
- For PDF output -> use pdf skill
- For simple text -> just Write a .txt or .md file
