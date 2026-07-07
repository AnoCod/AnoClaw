---
name: pptx
description: "Create, read, edit PowerPoint presentations (.pptx files). Use for slide decks, pitch decks, presentations, or converting content into slides."
when_to_use: "Any time a .pptx file is involved. Triggers on 'PowerPoint', 'slides', 'presentation', 'pitch deck', '.pptx'."
triggers:
  - "pptx"
  - "PowerPoint"
  - "slides"
  - "presentation"
  - "pitch deck"
  - "deck"
allowed-tools:
  - Read
  - Write
  - Bash
---

# Presentation Creation (PPTX)

## Agent Handoff

- Use this skill only when its `when_to_use` guidance matches the assigned task.
- If you are a child agent, keep the skill output focused on the parent assignment and report verification or blockers clearly.
- Do not override higher-priority system, permission, or delegation rules.

Create PowerPoint presentations with Python `python-pptx`.

## Setup

```bash
pip install python-pptx
```

## Creating a Presentation

```python
from pptx import Presentation
from pptx.util import Inches, Pt

prs = Presentation()
prs.slide_width = Inches(16)
prs.slide_height = Inches(9)

# Title slide
slide = prs.slides.add_slide(prs.slide_layouts[0])
slide.shapes.title.text = "Presentation Title"
slide.placeholders[1].text = "Subtitle"

# Content slide
slide = prs.slides.add_slide(prs.slide_layouts[1])
slide.shapes.title.text = "Key Points"
body = slide.placeholders[1]
body.text = "Point 1\nPoint 2\nPoint 3"

# Image slide
slide = prs.slides.add_slide(prs.slide_layouts[6])  # blank
slide.shapes.add_picture("chart.png", Inches(1), Inches(1), Inches(14), Inches(7))

prs.save("presentation.pptx")
```

## Reading Presentations

```python
from pptx import Presentation
prs = Presentation("input.pptx")
for slide in prs.slides:
    for shape in slide.shapes:
        if shape.has_text_frame:
            print(shape.text)
```

## Design Tips

- Use 16:9 aspect ratio (standard for modern displays)
- Keep slides focused - one idea per slide
- Use consistent fonts and colors
- Add images to break up text
- Keep bullet points brief

## When NOT to Use

- For documents -> use docx skill
- For spreadsheets -> use xlsx skill
- For PDFs -> use pdf skill
