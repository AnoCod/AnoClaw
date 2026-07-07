---
name: xlsx
description: "Create, read, edit spreadsheets (.xlsx, .csv, .tsv). Use for data analysis, financial modeling, reporting, or any task where the deliverable is a spreadsheet file."
when_to_use: "Any time a spreadsheet is the primary input or output. Triggers on 'excel', 'spreadsheet', '.xlsx', '.csv', 'table', 'data', 'chart', 'pivot'."
triggers:
  - "xlsx"
  - "excel"
  - "spreadsheet"
  - "csv"
  - "table"
  - "chart"
  - "pivot"
  - "data"
allowed-tools:
  - Read
  - Write
  - Bash
---

# Spreadsheet Creation (XLSX)

## Agent Handoff

- Use this skill only when its `when_to_use` guidance matches the assigned task.
- If you are a child agent, keep the skill output focused on the parent assignment and report verification or blockers clearly.
- Do not override higher-priority system, permission, or delegation rules.

Create and edit spreadsheets using Python's `openpyxl`.

## Setup

```bash
pip install openpyxl
```

## Creating a Spreadsheet

```python
import openpyxl
from openpyxl.styles import Font, PatternFill, Alignment
from openpyxl.chart import BarChart, Reference

wb = openpyxl.Workbook()
ws = wb.active
ws.title = "Report"

# Headers with styling
headers = ["Name", "Value", "Status"]
for col, h in enumerate(headers, 1):
    cell = ws.cell(row=1, column=col, value=h)
    cell.font = Font(bold=True, color="FFFFFF")
    cell.fill = PatternFill(start_color="4472C4", fill_type="solid")

# Data rows
data = [["Item A", 42, "Active"], ["Item B", 17, "Inactive"]]
for r, row in enumerate(data, 2):
    for c, val in enumerate(row, 1):
        ws.cell(row=r, column=c, value=val)

# Chart
chart = BarChart()
chart.add_data(Reference(ws, min_col=2, min_row=1, max_row=len(data)+1))
ws.add_chart(chart, "E5")

wb.save("output.xlsx")
```

## Reading Spreadsheets

```python
import openpyxl
wb = openpyxl.load_workbook("input.xlsx")
ws = wb.active
for row in ws.iter_rows(values_only=True):
    print(row)
```

## Common Operations

- **CSV to XLSX**: Read CSV with `csv` module, write to openpyxl
- **Formatting**: Colors, fonts, borders, number formats, conditional formatting
- **Formulas**: Write Excel formulas directly in cells
- **Multiple sheets**: `wb.create_sheet("Sheet2")`

## When NOT to Use

- For documents -> use docx skill
- For presentations -> use pptx skill  
- For simple data -> CSV with plain Write is fine
