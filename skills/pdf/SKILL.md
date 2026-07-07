---
name: pdf
description: "Work with PDF files - read, extract text, merge, split, rotate, add watermarks, OCR scanned documents, and fill forms. Use any time a .pdf file is involved."
when_to_use: "Any time a PDF file is the input or output. Triggers on 'pdf', 'PDF', 'merge PDFs', 'split PDF', 'extract from PDF', 'OCR', 'fill PDF form'."
triggers:
  - "pdf"
  - "merge"
  - "split"
  - "OCR"
  - "extract"
  - "form"
allowed-tools:
  - Read
  - Write
  - Bash
---

# PDF Operations

## Agent Handoff

- Use this skill only when its `when_to_use` guidance matches the assigned task.
- If you are a child agent, keep the skill output focused on the parent assignment and report verification or blockers clearly.
- Do not override higher-priority system, permission, or delegation rules.

Work with PDF files using Python libraries.

## Setup

```bash
pip install PyPDF2 pdfplumber reportlab
# For OCR:
pip install pytesseract pdf2image
```

## Common Operations

### Extract Text

```python
import pdfplumber
with pdfplumber.open("document.pdf") as pdf:
    for page in pdf.pages:
        print(page.extract_text())
```

### Merge PDFs

```python
from PyPDF2 import PdfMerger
merger = PdfMerger()
for pdf in ["file1.pdf", "file2.pdf", "file3.pdf"]:
    merger.append(pdf)
merger.write("merged.pdf")
merger.close()
```

### Split PDF

```python
from PyPDF2 import PdfReader, PdfWriter
reader = PdfReader("input.pdf")
for i, page in enumerate(reader.pages):
    writer = PdfWriter()
    writer.add_page(page)
    writer.write(f"page_{i+1}.pdf")
```

### Create PDF from Scratch

```python
from reportlab.pdfgen import canvas
c = canvas.Canvas("output.pdf")
c.drawString(100, 750, "Hello World")
c.save()
```

### Add Watermark

```python
from PyPDF2 import PdfReader, PdfWriter
reader = PdfReader("input.pdf")
watermark = PdfReader("watermark.pdf").pages[0]
writer = PdfWriter()
for page in reader.pages:
    page.merge_page(watermark)
    writer.add_page(page)
writer.write("watermarked.pdf")
```

## When NOT to Use

- For editable documents -> use docx skill
- For spreadsheets -> use xlsx skill
- For presentations -> use pptx skill
