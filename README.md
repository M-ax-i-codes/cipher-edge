# CipherEdge

**CipherEdge** is a reproducible research and paper-trading agent that encodes the two canonical
VMC Cipher B setups (momentum-exhaustion short, breakout-retest long) into a deterministic rules
engine with an optional LLM confirmation layer, a hard risk engine, and a full audit trail.

> **Research / paper-trading only. CipherEdge has never placed a live order and never will
> (`placesRealOrders: false` is enforced in config and code).**

Built for the Bitget AI Hackathon S2 — Agentic Trading track.

## Honest headline result

90-day backtest (2026-06-23 → 2026-09-21) on BTCUSDT / ETHUSDT / SOLUSDT spot,
1h structure + 15m trigger, committed candles, modelled costs (10 bps taker + 5 bps slippage + 1 bp/8h funding):

| window | return | max DD | Sharpe | trades | win rate | profit factor |
| --- | --- | --- | --- | --- | --- | --- |
| total (90d) | **-5.81%** | 6.39% | -6.52 | 100 | 35% | 0.40 |
| in-sample (60d) | -4.55% | 4.92% | -8.08 | 64 | 29.7% | 0.30 |
| out-of-sample (30d) | -1.32% | 2.08% | -3.91 | 36 | 44.4% | 0.61 |

**The strategy as specified does not currently show edge net of costs.** These figures are reported
as-is, un-tuned: parameters were fixed a priori from the written specification and never re-run to
look better. The value of this repository is the *research harness*: a reproducible, auditable,
lookahead-tested pipeline in which strategy variants can be evaluated honestly. See
`reports/backtest_2026-09-23_15-18-41Z/report.md` for the full observed report, including the
signal funnel, per-setup slices, sizing transparency, cost decomposition, and the list of
unverified assumptions.

## What it does

Two setups, both derived from VMC Cipher B state computed from raw candles:

- **Setup A — bearish mean-reversion short:** price sweeps a local high / supply zone, bearish
  divergence (price higher-high vs WaveTrend lower-high), momentum wave overbought (> +60), top red
  dot, and a bearish rejection candle. Stop above the swing high (+0.4% buffer).
- **Setup B — bullish breakout-retest long:** breakout above resistance that retests as support,
  momentum wave cooled to/below zero while structure holds, bottom green dot or rising curvature.
  Stop below structural support (+0.4% buffer).

Pipeline per trigger bar:

1. **Indicators** (`src/indicators/`) — WaveTrend (os1/os2), momentum wave (EMA of os1), red/green
   dot detection, divergence detection. Faithful to *common* WaveTrend defaults; TradingView
   equivalence is explicitly **not** claimed (see unverified assumptions in every report).
2. **Market structure** (`src/structure/`) — swing highs/lows, horizontal levels, breakout/retest
   state.
3. **Deterministic rules engine** (`src/strategy/`) — evaluates Setup A/B with a higher-timeframe
   (1h) veto and anchoring: a setup with no confirmed 1h level within tolerance is forced to
   NO_TRADE. HTF anchoring only uses 1h bars that had already closed (lookahead-tested).
4. **LLM confirmation layer** (`src/llm/`) — optional; reads the same indicator + price JSON,
   resolves ambiguous confluence, assigns confidence, and emits a schema-validated
   LONG / SHORT / NO_TRADE decision. A deterministic mock provider keeps backtests reproducible
   with zero network access. Live provider targets the Bitget hackathon endpoint (Qwen-class).
5. **Risk engine** (`src/risk/`) — fixed-fractional sizing (0.5% intended risk/trade), minimum
   1.5R, max 3 concurrent positions, 2% daily loss cap, notional cap, minimum stop distance.
   The risk engine can only reduce or reject; it never enlarges a position.
6. **Backtest / paper engines** (`src/backtest/`, `src/paper/`) — bar-based fills with pessimistic
   intra-bar assumptions, modelled fees/slippage/funding, TP1 partial exit + stop-to-breakeven,
   time stop. Paper mode emits run-record ledgers (timestamp, instrument, direction, price,
   quantity, balance change).
7. **Reports** (`src/report/`) — every run writes `report.md`, `metrics.json`, `trades.csv`,
   `equity.jsonl`, `provenance.json`, and a `config.snapshot.json` pinned by config hash. Every
   number is labelled OBSERVED / MODELLED / TARGETED.

## Data

- Candles: Bitget public spot REST v2 (`/api/v2/spot/market/history-candles`, keyless, read-only),
  fetched 2026-09-21 over a 92-day window: 5m/15m/1h for BTC, ETH, SOL and 13 Bitget rToken
  US-equity pairs (RAAPL, RNVDA, RTSLA, ...).
- `data/INTEGRITY.md` — per-series completeness/gap audit (all headline symbols ≥ 99.5% complete,
  pre-flight gate: PASS).
- `data/provenance.json` — per-file request provenance.
- Candles are **committed** so the backtest is fully reproducible offline with no API key.

## Reproduce

```bash
npm install            # optional - zero runtime dependencies, dev-only TypeScript
npm run doctor         # data integrity + config pre-flight
npm run backtest       # regenerates reports/ from committed data + config
npm run report         # regenerate report from the latest run
npm test               # 135 tests (node --test), incl. lookahead-bias tests
npm run typecheck      # tsc --noEmit
```

Node >= 22.18 (runs TypeScript natively). Config hash pins the exact parameters of every run.

## Repository layout

```
config/default.json   # all strategy, risk, cost and backtest parameters (a priori)
src/indicators/       # WaveTrend, momentum wave, dots, divergence
src/structure/        # swings, levels, breakout/retest
src/strategy/         # setupA, setupB, HTF veto/anchoring, engine
src/llm/              # confirmation layer, schema, deterministic mock provider
src/risk/             # sizing, limits, vetoes
src/backtest/         # engine, portfolio, costs
src/paper/            # paper-trading harness + run-record ledger
src/data/             # fetch, local store, integrity, pre-flight, resample
src/report/           # metrics + markdown/JSON reporting
tests/                # 135 tests incl. lookahead, risk, config-tamper detection
data/                 # committed candles, INTEGRITY.md, provenance.json
reports/              # every generated run (backtest, paper replay, sensitivity)
```

## Status and next steps

- Built and tested: everything above; 135/135 tests pass; typecheck clean.
- Not built: live order routing (deliberately), forward (non-replay) paper session against the
  live Bitget feed, rToken-universe backtest (data already fetched and committed).
- Next: diagnose Setup B (90/100 trades, exit mix 58 stops vs 17 TP2 suggests stops too tight or
  entries too early), evaluate the rToken US-equity universe, then run a forward paper session and
  publish its ledger.

## Disclaimer

Research software. Not financial advice. No live orders. The VMC Cipher B replication is
independent and unofficial; it does not claim TradingView equivalence.

## License

MIT
