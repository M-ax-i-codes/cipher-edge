# Competition Submission — CipherEdge (v2, updated 2026-09-23 with observed backtest data)
Track: Agentic Trading

## Project Name
CipherEdge

## One-line Project Summary (133 / 140 chars)
CipherEdge: an agent that automates VMC Cipher B exhaustion & retest setups on Bitget with full risk-defined orders and audit trail.

## Project Description

### Part 1 · Thesis
The VMC Cipher B indicator (WaveTrend oscillators, momentum wave, top red / bottom green dots, divergence lines) is one of the most-used retail TA tools, but its two highest-probability setups are multi-condition and time-sensitive, so traders miss or mis-time them — especially across timeframes (1h structure, 15m trigger). Core hypothesis: encoding those two canonical setups into an agent that reads indicator state plus price action and emits a structured, risk-defined execution decision captures the exhaustion/retest windows consistently and without emotion. A second, equally important hypothesis: most retail TA setups do NOT survive realistic costs once encoded faithfully — and an honest, reproducible harness is what separates a signal from a product.

Signal sources: VMC Cipher B computed from raw Bitget candles — WaveTrend os1/os2 (n1=10, n2=21), momentum wave (EMA of os1, 3), top-red/bottom-green dot events, and divergence detection — fused with price action: swing highs/lows, horizontal levels, breakout/retest state. Structure on 1h; triggers on 15m.

Decision logic is two-layer. A deterministic rules engine encodes: [Setup A — bearish mean-reversion short] local-high sweep + bearish divergence + momentum wave overbought (>+60) + top red dot + rejection candle; [Setup B — bullish retest long] breakout-retest of resistance as support + momentum wave cooled to/below zero while structure holds + bottom green dot or rising curvature. A higher-timeframe veto forces NO_TRADE when no confirmed, already-closed 1h level anchors the setup. An optional LLM layer reads the same indicator + price JSON to resolve ambiguous confluence and assign confidence (LONG / SHORT / NO_TRADE, schema-validated).

Risk-control design: fixed-fractional sizing (0.5% intended risk/trade), per-setup stops with 0.4% buffer, TP1 at 1.5R (50% off, stop to breakeven), TP2 at 2.5R, hard minimum 1.5R, max 3 concurrent positions, 2% daily loss cap, notional cap, 12h time stop, pessimistic intra-bar fills. The risk engine can only reduce or reject — never enlarge. Every decision is logged with the full indicator snapshot.

### Part 2 · Target user and product value
Intermediate-to-advanced retail and pro crypto/TA traders on Bitget who already use VMC Cipher B on TradingView: risk-managed (≤1% risk/trade), capital $1k–$50k, intraday-to-swing frequency (a few trades/week), liquid BTC/ETH/SOL spot now and Bitget rToken US-equity pairs next. Use case: automating the exact two Cipher B setups they trade by hand, so they stop missing exhaustion/retest entries across timeframes or while away from the screen.

Pain point: the setups need several conditions aligned on the right timeframe at the right moment (divergence + dot + zone + HTF structure), and monitoring 1h/15m simultaneously is exhausting and error-prone. Existing alert tools fire on single conditions, never on the full confluence, and never size or risk the trade. CipherEdge evaluates the complete confluence and returns a finished, risk-defined order plan (entry, SL, TP1, TP2, R:R, rationale) with a replayable audit trail — and, just as importantly, tells the user when the honest answer is NO_TRADE.

### Part 3 · Validation data and key metrics
Backtest: 2026-06-23 → 2026-09-21 (90 days total; 60d in-sample + 30d strictly out-of-sample), BTC/ETH/SOL spot, committed Bitget candles (≥99.5% completeness, integrity-audited), costs modelled at 10bps taker + 5bps slippage + 1bp/8h funding, parameters fixed a priori (config-hash pinned, never re-tuned).

| Metric | In-sample (60d) | Out-of-sample (30d) | Label |
|---|---|---|---|
| Total return | -4.55% | -1.32% | OBSERVED (backtest) |
| Max drawdown | 4.92% | 2.08% | OBSERVED |
| Sharpe / Sortino | -8.08 / -3.48 | -3.91 / -1.76 | OBSERVED |
| Trades / win rate | 64 / 29.7% | 36 / 44.4% | OBSERVED |
| Profit factor / avg R | 0.30 / -0.64 | 0.61 / -0.29 | OBSERVED |
| Fees+slippage+funding | modelled 10/5/1 bps | same | MODELLED (no live fills exist) |
| Turnover | 386,141 USDT notional over 90d on $10k | — | OBSERVED |

Honest headline: the strategy as specified does NOT currently show edge net of costs. We report it un-tuned. Diagnosis is in-hand: Setup B (breakout-retest) is 90/100 trades with 58 stops vs 17 TP2 exits — stops too tight or entries too early; Setup A fired only 10 times. The signal funnel is fully observable (175 raw setups → 53 HTF-vetoed → 7 risk-rejected → 100 executed), so improvement is measurable, not guesswork. TARGETED: a Setup-B variant with positive expectancy OOS before any forward paper trading with size.

Validation plan next: (1) rToken US-equity universe backtest on the same harness (data already fetched and committed); (2) forward paper trading against the live Bitget feed, emitting the required run-record schema (timestamp, instrument, direction, price, quantity, balance change); (3) only then consider live capital — the code has never placed and cannot place a real order.

Proof of use / distribution (TARGETED until launch): Activation = configured symbols with fired setups; Trading Volume = paper then live notional via Bitget attribution; AUM / Retention / Incremental Fee targeted post-launch; Risk = max DD and per-trade risk adherence, OBSERVED directly from the trade ledger.

### Part 4 · Progress
Built (all committed, 135/135 tests pass, typecheck clean): faithful-from-raw-candles Cipher B computation (WaveTrend, momentum wave, dots, divergence); market-structure engine (swings, levels, breakout/retest); two-layer decision logic with 1h veto/anchoring (lookahead-tested); LLM confirmation layer with schema validation and a deterministic mock provider for reproducible backtests; risk engine; backtest engine with pessimistic intra-bar fills and modelled costs; paper-trading harness with run-record ledger; data pipeline with integrity audit and pre-flight gate; auto-generated OBSERVED/MODELLED/TARGETED-labelled reports with config-hash pinning; 90-day backtest executed and reproduced.

Not built: live order routing (deliberate), forward (non-replay) paper session, rToken-universe backtest run (data ready).

Problems hit and solved: lookahead bias — solved with dedicated tests proving HTF anchoring only uses closed 1h bars and signal timestamps are the bar's own open time; TradingView indicator opacity — VMC never published the Cipher B momentum-wave formula, so we use common WaveTrend defaults and declare this as an unverified assumption in every report instead of claiming equivalence; data gaps — solved with a completeness/gap audit and a strict pre-flight gate (99% completeness, max 4-bar adjacent gap); cost double-counting — slippage embedded in fill prices, never deducted twice.

Next: Setup B diagnosis and variant evaluation, rToken universe run, forward paper session with published ledger.

Frameworks / models / APIs: Node 22+ / TypeScript with zero runtime dependencies (node --test); Bitget public spot REST v2 for candles; Bitget AI hackathon MCP endpoint (Qwen-class) for the LLM confirmation layer; no live-order APIs used.

### Part 5 · Your take on AI Trading
The LLM's value in TA strategies is not replacing the indicator — it is resolving ambiguous multi-condition confluence a rigid script cannot, attaching calibrated confidence, and defaulting to NO_TRADE. But the harder lesson from building CipherEdge: most beloved retail setups lose money net of costs once encoded faithfully and tested without tuning. Agentic trading products earn trust by being auditable and honest about negative results — an agent that mostly says NO_TRADE and can prove why is more valuable than one that always fires. Suggestion for Bitget: expose indicator-ready candle history and a paper-trading sandbox through the MCP so agents can forward-test without live risk.

## Submission Material Links
- Project link (GitHub, public, full README): https://github.com/M-ax-i-codes/cipher-edge
- Run records (backtest report + code that generated it; screenshots not used): https://github.com/M-ax-i-codes/cipher-edge/blob/main/reports/backtest_2026-09-23_15-18-41Z/report.md
- Run records (trade ledger CSV + equity curve): https://github.com/M-ax-i-codes/cipher-edge/tree/main/reports/backtest_2026-09-23_15-18-41Z
- Data integrity audit: https://github.com/M-ax-i-codes/cipher-edge/blob/main/data/INTEGRITY.md
- Demo video: [TODO — ≤3 min, public X post or YouTube link]

## Role of the LLM / AI in Your Project
Two distinct roles. (1) In the product: the LLM is the signal-confirmer and decision orchestrator — it ingests Cipher B indicator state plus price-action JSON, resolves ambiguous or conflicting confluence, assigns a confidence score, and emits a schema-validated LONG / SHORT / NO_TRADE decision with rationale; a separate deterministic risk layer (outside the LLM) enforces sizing, minimum R:R, position and loss caps, and can only reduce or reject trades. Backtests run on a deterministic mock provider so results are reproducible; the live provider targets the Bitget hackathon endpoint (Qwen-class model). The system has never placed and cannot place a live order. (2) In development: LLM coding assistance (Codex / GPT-class) for the TypeScript implementation, test suite, and data-integrity tooling.
