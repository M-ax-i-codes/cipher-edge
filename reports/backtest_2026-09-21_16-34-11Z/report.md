# CipherEdge backtest report - `backtest_2026-09-21_16-34-11Z`

Generated: 2026-09-21T16:34:12.316Z  ·  config hash: `95f1b9227f451336`  ·  Node v24.19.0
Mode: **research-and-paper-trading-only**. Places real orders: **false**.

## How to read this report

- **OBSERVED** = computed from the committed candle dataset by the committed code. Reproducible.
- **MODELLED** = an assumption about execution cost. CipherEdge has never placed an order, so no
  empirically observed execution cost exists anywhere in this project.
- **TARGETED** = a goal, not a measurement.
- No figure in this report was tuned, selected or re-run to look better. Parameters are fixed a priori
  from the written strategy specification (see `config/default.json`).

## Test period (OBSERVED)

| window | start (UTC) | end (UTC) | days |
| --- | --- | --- | --- |
| total | 2026-06-23T15:45:00.000Z | 2026-09-21T15:45:00.000Z | 90 |
| in-sample | 2026-06-23T15:45:00.000Z | 2026-08-22T15:45:00.000Z | 60 |
| out-of-sample | 2026-08-22T15:45:00.000Z | 2026-09-21T15:45:00.000Z | 30 |

## Returns (OBSERVED, net of MODELLED costs)

| window | start capital | final equity | total return | max drawdown | Sharpe | Sortino | ann. vol | equity bars |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| total | 10000 | 9395.11 | -6.049% | 6.63% | -6.779 | -2.977 | 3.74% | 8599 |
| in-sample | 10000 | 9520.56 | -4.794% | 5.168% | -8.486 | -3.661 | 3.53% | 5732 |
| out-of-sample | 9520.56 | 9395.11 | -1.318% | 2.082% | -3.909 | -1.764 | 4.13% | 2867 |

Sharpe/Sortino annualise a 365-day year (24/7 market) at 35040 periods/year, rf = 0.

## Trade statistics (OBSERVED)

| window | trades | win rate | net PnL | profit factor | avg R | expectancy | avg hold | LONG/SHORT | setupA/setupB |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| total | 104 | 33.7% | -604.89 | 0.393 | -0.839 | -5.82 | 334m | 94/10 | 10/94 |
| in-sample | 68 | 27.9% | -479.44 | 0.289 | -1.128 | -7.05 | 342m | 62/6 | 6/62 |
| out-of-sample | 36 | 44.4% | -125.45 | 0.61 | -0.293 | -3.48 | 319m | 32/4 | 4/32 |

Best R 1.682 · worst R -22.432 · median R -1.325 · avg win 11.17 · avg loss -14.43

Exit reasons (OBSERVED): stop=61, tp2=18, time=25

## Costs

| component | amount | basis |
| --- | --- | --- |
| fees | 401.15 | MODELLED (MODELLED - Bitget spot taker bps from config; no live fills exist) |
| slippage | 200.57 | MODELLED (MODELLED - flat adverse bps; not measured against an order book) - already embedded in fill prices, not deducted twice |
| funding | 13.34 | MODELLED (MODELLED - flat bps per 8h; spot rToken funding was not sampled) |
| observed execution costs | 0 | NONE - CipherEdge has never placed an order |

Turnover notional (OBSERVED): 401145.64 USDT over 90 days.

## Sizing transparency (OBSERVED)

| metric | value |
| --- | --- |
| positions where the notional cap bound | 0 / 104 |
| binding constraint counts | undefined=104 |
| avg intended risk per trade | 0.5% |
| avg actual risk per trade | 0.1218% |
| max actual risk per trade | 0.1951% |
| avg exposure (notional / equity) | n/a% |
| max exposure (notional / equity) | n/a% |
| max concurrent open positions | 3 |

The notional cap can only REDUCE risk below the intended budget. When it binds, the intended risk
is forgone and reported here - it is never silently converted into a larger position.

## Signal funnel (OBSERVED)

| stage | count |
| --- | --- |
| trigger bars evaluated | 25797 |
| deterministic setups fired (pre-HTF) | 175 |
| vetoed: no 1h structure within tolerance | 53 |
| anchored onto a 1h level | 122 |
| vetoed: LLM confidence floor | 0 |
| rejected by the risk engine | 3 |
| executed | 104 |

## Slices (OBSERVED)

### By setup

| setup | trades | net PnL | win rate | avg R |
| --- | --- | --- | --- | --- |
| BREAKOUT_RETEST | 94 | -560.36 | 33% | -0.865 |
| BEARISH_DIVERGENCE | 10 | -44.54 | 40% | -0.585 |

### By direction

| direction | trades | net PnL | win rate | avg R |
| --- | --- | --- | --- | --- |
| LONG | 94 | -560.36 | 33% | -0.865 |
| SHORT | 10 | -44.54 | 40% | -0.585 |

### By symbol

| symbol | trades | net PnL | win rate | avg R |
| --- | --- | --- | --- | --- |
| ETHUSDT | 34 | -258.68 | 23.5% | -0.681 |
| SOLUSDT | 30 | -222.59 | 33.3% | -0.904 |
| BTCUSDT | 40 | -123.62 | 42.5% | -0.923 |

## Per-symbol signal counts (OBSERVED)

| symbol | trigger bars | bars in window | raw setups | HTF vetoed | HTF anchored | risk rejections | entries |
| --- | --- | --- | --- | --- | --- | --- | --- |
| BTCUSDT | 8788 | 8599 | 66 | 19 | 47 | 1 | 40 |
| ETHUSDT | 8788 | 8599 | 58 | 18 | 40 | 1 | 34 |
| SOLUSDT | 8788 | 8599 | 51 | 16 | 35 | 1 | 30 |

## Data provenance (OBSERVED)

| symbol | granularity | source | bars | first (UTC) | last (UTC) |
| --- | --- | --- | --- | --- | --- |
| BTCUSDT | 15m | local-jsonl | 8788 | 2026-06-21T16:15:00.000Z | 2026-09-21T15:45:00.000Z |
| BTCUSDT | 1h | local-jsonl | 2197 | 2026-06-21T17:00:00.000Z | 2026-09-21T15:00:00.000Z |
| ETHUSDT | 15m | local-jsonl | 8788 | 2026-06-21T16:15:00.000Z | 2026-09-21T15:45:00.000Z |
| ETHUSDT | 1h | local-jsonl | 2197 | 2026-06-21T17:00:00.000Z | 2026-09-21T15:00:00.000Z |
| SOLUSDT | 15m | local-jsonl | 8788 | 2026-06-21T16:15:00.000Z | 2026-09-21T15:45:00.000Z |
| SOLUSDT | 1h | local-jsonl | 2197 | 2026-06-21T17:00:00.000Z | 2026-09-21T15:00:00.000Z |

See `data/INTEGRITY.md` for the per-series gap / completeness audit.

## Unverified assumptions

- **UNVERIFIED ASSUMPTION:** momentumWave = EMA(WaveTrend os1, 3); VMC has not published the Cipher B momentum-wave formula
- **UNVERIFIED ASSUMPTION:** WaveTrend channel-length constants (n1=10, n2=21, os2Smooth=4) follow the common WaveTrend default, not a published VMC Cipher B spec
- **UNVERIFIED ASSUMPTION:** fees (10bps taker), slippage (5bps) and funding (1bp per 8h) are MODELLED assumptions, not empirically observed fills
- **UNVERIFIED ASSUMPTION:** funding is modelled as a constant rate; real funding varies per symbol and per period
- **UNVERIFIED ASSUMPTION:** top red / bottom green dot placement (local extremum of the momentum wave inside an extreme zone).
- **MODELLED:** fills are bar-based. No order-book depth, no partial fills, no queue position, no exchange downtime handling.
- **MODELLED:** the same flat cost model is applied to BTC/ETH/SOL and to thin rToken pairs, which almost certainly
  understates real slippage on the rTokens.

CipherEdge does **not** claim TradingView-equivalent VMC Cipher B calculations.

## Data quality gate (pre-flight)



| symbol | gran | bars | completeness | missing | max gap (bars) | max gap (min) | partial last bar | first (UTC) | last (UTC) | verdict |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
BTCUSDT | 15m | 8788 | 99.51% | 43 | 2 | 30 | no | 2026-06-21T16:15:00.000Z | 2026-09-21T15:45:00.000Z | PASS
BTCUSDT | 1h | 2197 | 99.55% | 10 | 2 | 120 | no | 2026-06-21T17:00:00.000Z | 2026-09-21T15:00:00.000Z | PASS
ETHUSDT | 15m | 8788 | 99.51% | 43 | 2 | 30 | no | 2026-06-21T16:15:00.000Z | 2026-09-21T15:45:00.000Z | PASS
ETHUSDT | 1h | 2197 | 99.55% | 10 | 2 | 120 | no | 2026-06-21T17:00:00.000Z | 2026-09-21T15:00:00.000Z | PASS
SOLUSDT | 15m | 8788 | 99.51% | 43 | 2 | 30 | no | 2026-06-21T16:15:00.000Z | 2026-09-21T15:45:00.000Z | PASS
SOLUSDT | 1h | 2197 | 99.55% | 10 | 2 | 120 | no | 2026-06-21T17:00:00.000Z | 2026-09-21T15:00:00.000Z | PASS

## Reproduce this run

```bash
npm install            # optional - the project has zero runtime dependencies
npm run backtest       # regenerates reports/ from the committed data + config
npm test               # full test suite
```

Config hash `95f1b9227f451336` pins the exact parameters. The candle files are committed, so the run is
reproducible offline with no network access and no API key.
