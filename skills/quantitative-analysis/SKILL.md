---
name: quantitative-analysis
description: "Quantitative financial analysis, trading strategy development, backtesting, risk management, and portfolio optimization. Use for analyzing stocks, crypto, or any financial instrument with data-driven methods."
when_to_use: "User wants to analyze financial data, backtest a strategy, optimize a portfolio, calculate risk metrics, or make data-driven investment decisions."
triggers:
  - "stock"
  - "crypto"
  - "trading"
  - "backtest"
  - "portfolio"
  - "quant"
  - "Sharpe"
  - "risk"
  - "option"
  - "alpha"
  - "investment"
allowed-tools:
  - Read
  - Write
  - Bash
  - WebSearch
  - WebFetch
---

# Quantitative Analysis

## Agent Handoff

- Use this skill only when its `when_to_use` guidance matches the assigned task.
- If you are a child agent, keep the skill output focused on the parent assignment and report verification or blockers clearly.
- Do not override higher-priority system, permission, or delegation rules.

Data-driven financial analysis using Python. Strategy development, backtesting, risk management, and portfolio optimization.

## Setup

```bash
pip install pandas numpy yfinance matplotlib scipy
```

## Data Acquisition

```python
import yfinance as yf

# Download historical data
ticker = yf.Ticker("AAPL")
hist = ticker.history(period="1y")

# Multiple tickers
data = yf.download(["AAPL", "MSFT", "GOOGL"], period="6mo")

# Crypto
btc = yf.download("BTC-USD", period="1y")
```

## Key Metrics

### Risk-Adjusted Returns

```python
import numpy as np

# Daily returns
returns = data['Close'].pct_change().dropna()

# Sharpe Ratio (risk-adjusted return)
sharpe = (returns.mean() * 252) / (returns.std() * np.sqrt(252))

# Maximum Drawdown
cumulative = (1 + returns).cumprod()
running_max = cumulative.expanding().max()
drawdown = (cumulative - running_max) / running_max
max_drawdown = drawdown.min()

# Value at Risk (95% confidence)
var_95 = returns.quantile(0.05)
```

### Portfolio Optimization

```python
# Equal weight baseline
weights = np.array([1/len(tickers)] * len(tickers))

# Risk parity (inverse volatility)
vols = returns.std()
weights = (1 / vols) / (1 / vols).sum()

# Minimum variance (requires scipy)
from scipy.optimize import minimize
def portfolio_vol(weights, cov_matrix):
    return np.sqrt(weights.T @ cov_matrix @ weights)
result = minimize(portfolio_vol, weights, args=(returns.cov(),),
                  constraints={'type': 'eq', 'fun': lambda w: w.sum() - 1})
```

## Strategy Backtesting

```python
# Simple moving average crossover
short_ma = data['Close'].rolling(20).mean()
long_ma = data['Close'].rolling(50).mean()

# Generate signals
signal = (short_ma > long_ma).astype(int)
position = signal.diff()  # 1= buy, -1= sell

# Calculate strategy returns
strategy_returns = position.shift(1) * returns
total_return = (1 + strategy_returns).prod() - 1
```

## When NOT to Use

- Simple stock price lookups -> just use WebSearch/WebFetch
- Financial advice -> you're an AI, don't give financial advice. Provide analysis, let the user decide.
- Live trading -> requires broker API keys. Warn the user about risks.
- Paper trading only unless user explicitly connects a broker.

## Risk Warnings

Always include:
- Past performance ≠ future results
- Backtests have survivorship bias
- Paper trade before real money
- Never risk more than you can afford to lose
