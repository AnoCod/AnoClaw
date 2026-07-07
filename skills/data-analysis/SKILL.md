---
name: data-analysis
description: "Analyze data using Python - load CSV/JSON/Excel, clean data, compute statistics, create visualizations, find patterns. Use for any data exploration or analysis task."
when_to_use: "User has data to analyze, wants to see trends, needs charts, asks 'what does this data tell us', or mentions data/statistics/visualization."
triggers:
  - "data"
  - "analyze"
  - "chart"
  - "graph"
  - "statistics"
  - "trend"
  - "visualize"
  - "plot"
  - "correlation"
  - "pandas"
allowed-tools:
  - Read
  - Write
  - Bash
---

# Data Analysis

## Agent Handoff

- Use this skill only when its `when_to_use` guidance matches the assigned task.
- If you are a child agent, keep the skill output focused on the parent assignment and report verification or blockers clearly.
- Do not override higher-priority system, permission, or delegation rules.

Load, clean, analyze, and visualize data with Python.

## Setup

```bash
pip install pandas matplotlib seaborn numpy
```

## Data Loading

```python
import pandas as pd

# CSV
df = pd.read_csv("data.csv")

# Excel
df = pd.read_excel("data.xlsx", sheet_name="Sheet1")

# JSON
df = pd.read_json("data.json")

# From URL
df = pd.read_csv("https://example.com/data.csv")
```

## First Look

```python
# Quick overview
df.head()        # first 5 rows
df.info()        # columns, types, nulls
df.describe()    # count, mean, std, min, max, quartiles
df.isnull().sum() # missing values per column
```

## Data Cleaning

```python
# Drop duplicates
df = df.drop_duplicates()

# Fill missing values
df['column'] = df['column'].fillna(df['column'].mean())

# Convert types
df['date'] = pd.to_datetime(df['date'])
df['price'] = df['price'].astype(float)

# Filter rows
df = df[df['value'] > 0]  # remove negative values
```

## Analysis

```python
# Group by
df.groupby('category')['value'].sum()
df.groupby('category')['value'].agg(['count', 'mean', 'std'])

# Pivot table
df.pivot_table(values='sales', index='region', columns='product', aggfunc='sum')

# Correlation
df[['price', 'sales', 'rating']].corr()

# Rolling averages
df['7day_avg'] = df['value'].rolling(7).mean()
```

## Visualization

```python
import matplotlib.pyplot as plt

# Line chart
df.plot(x='date', y='value', kind='line')

# Bar chart
df.groupby('category')['value'].sum().plot(kind='bar')

# Histogram
df['value'].hist(bins=30)

# Scatter with trend line
df.plot.scatter(x='price', y='sales')

# Save
plt.savefig('chart.png', dpi=150, bbox_inches='tight')
```

## When NOT to Use

- Simple "what's the max/min of this list" -> just compute it in your response
- Need a dashboard -> this is exploratory analysis, not a web app
- Real-time data streaming -> this is batch analysis
