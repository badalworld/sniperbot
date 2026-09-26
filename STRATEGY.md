# MEXC AI FUSION — Complete Build & Strategy Prompt (v2)

> This is the canonical spec of everything implemented in this repository.
> Reuse it to rebuild, audit, or extend the bot with any AI developer.

## 0. Product

A local, fully-functional (real orders, no mock trading) AI futures trading webapp for **MEXC Futures**:

- **Stack:** pure Node.js (≥16, zero npm dependencies) backend + HTML/CSS/JS dashboard. Runs on a PC (Chrome) or Android Termux. `node server.js` → `http://localhost:8080`.
- **Files:** `server.js`, `server/{mexc,engine,strategy,aiscore,scanner,indicators,http,store,util}.js`, `public/{index,marketscan,archive}.html`, `public/style.css`, `public/js/{common,app,marketscan,archive,robot}.js`.
- **Realtime:** Server-Sent Events push a full snapshot every 1s (5s polling fallback) — no manual refresh anywhere.

## 1. Strategies (both implemented, switchable in settings)

### A) 3M Scalping (Phase 6 — default)
- Data: 3m candles (aggregated from 1m — MEXC has no native 3m) + 15m HTF.
- Pre-trade market filter (ALL required): price move ≥1% in last 15–30 min; current candle volume > 1.3× avg(5); normal spread (<0.15%); no abnormal wicks (<65% of range); active volatility (ATR 0.10–2.5% of price).
- Trend filter: 3m EMA9 vs EMA21 must agree with 15m EMA9 vs EMA21 (+15m close vs EMA21). Mismatch → no trade.
- LONG entry (all required, evaluated only at 3m candle close): retrace touched EMA9/EMA21 within last 3 candles → bullish candle closes above EMA9 → RSI14 crosses above 50 → volume spike ≥1.3× → market BUY.
- SHORT mirrored.
- Confluence score ≥ 7/10 required (trend 2, volume 2, structure 2, RSI 1, volatility 2, momentum 1).
- Management: SL = recent swing low/high capped at −30% ROI (attached on-exchange); TP1 = +15% ROI → close 50%, SL→breakeven, then SL trails EMA21 (ratchet); TP2 = +30% ROI → close rest.
- Exit engine (any triggers market exit): EMA9 crosses opposite EMA21; RSI fails to hold the 50 zone; volume collapses below 5-candle average while not in profit; not in profit after 18 minutes.

### B) OBV × EMA50 Compounding (Phase 1/5)
- On closed 15m candles: OBV crossing **above** its EMA50 → BUY; crossing **below** → SELL.
- Momentum filter: 15m move ≥ 2% (configurable).
- TP/SL 30% ROI both sides; when ROI reaches 30%, a **0.5% trailing stop arms** (ratchets with peak) to ride maximum profit. Hard TP only applies if trailing never armed.

## 2. AI Score System (0–100) — gates BOTH strategies

Weighted, direction-aware evaluation per symbol (full breakdown stored per trade):

| # | Indicator | Weight | Bull/Bear logic |
| --- | --- | --- | --- |
| 1 | Trend (EMA50 & EMA200, 15m) | 15 | price>EMA50 & EMA50>EMA200 |
| 2 | Volume Strength + OBV slope | 15 | vol vs SMA20 participation |
| 3 | Market Structure (HH/HL vs LH/LL) | 15 | swing pivots |
| 4 | Multi-Timeframe (3m/15m/1h/4h) | 15 | count of aligned TFs |
| 5 | RSI (3m) | 10 | 55–70 bull zone / 30–45 bear zone |
| 6 | MACD (3m) | 10 | line vs signal + histogram slope |
| 7 | Support/Resistance (15m) | 10 | confirmed breakout / rejection / fake-breakout detect |
| 8 | ATR Volatility Band (3m) | 5 | healthy percentile 30–88 |
| 9 | Open Interest | 3 | OI + price confirmation (smart money) |
| 10 | Funding Rate / Sentiment | 2 | extremes blocked |

Classification: 0–39 Very Weak · 40–59 Weak · 60–69 Moderate · 70–79 Good (tradeable) · 80–89 Strong · 90–100 Elite.

**Trade gate:** score ≥ 70 AND ≥7/10 components at ≥50% weight AND Trend + Volume + Structure aligned with direction. Professional filters block: funding overheated (|rate|>0.0015), BTC 15m instability ≥1.5% (15-min pause), fake breakouts (30-min per-symbol block), abnormal spread/wicks, low liquidity (<min volume).

## 3. Compounding (the millionaire engine)

- Season starts with **current futures equity** as start balance; target default $1,000,000.
- Per-trade margin starts at Start Margin ($2). After each close: `baseMargin += PnL ÷ MaxOpenTrades` (e.g. +$1 over 5 slots → +$0.20 per next trade; losses mirror negative). Floored at $0.50, capped at 50% of equity.
- One position per symbol; max 5 concurrent (configurable); isolated margin.

## 4. Risk management

- 3 consecutive losses → risk halt · daily drawdown ≥5% → halt · 90s cooldown after each loss (no revenge trading) · per-trade affordability checks against available balance.
- Exchange-side stop-loss attached to every order (server-death protection); engine manages TP/TP1/TP2/trailing precision exits; reconciliation every 8s detects positions closed manually in the MEXC app and archives them (with best-effort realized PnL from position history) — active list and executed-trade counts stay exact.

## 5. Dashboard requirements (all implemented)

- Live USDT futures balance (equity/available/in-position/unrealized), auto-updating.
- Ping in ms, green <100ms, red ≥100ms.
- Public + LAN IP with one-click copy.
- Power button: green START when stopped (opens settings modal with IP + API key/secret + full config), red STOP when running.
- Active Positions: pair, side, live AI score (with breakdown tooltip), margin, leverage, entry, mark, ROI, PnL, **TP price, SL price, trailing stop status**, age, close button.
- Completed trades + View All Archive page: full filterable history (50/page) + Season Archive cards with **profit sparklines**.
- Win rate ring, executed trades (season + all-time, exact), today PnL with risk-guard status.
- Compounding liquid reactor: left red loss, right green profit, center 0, −100…0…+100, animated liquid wave; plus Millionaire Path progress bar to the season goal.
- AI Decision Log: per-symbol live reasons (why traded / why rejected).
- Market Scan page: rolling 40 rows, radar + sweep animations, 1s updates, newest on top & oldest drop off; columns: pair, price, **market cap**, 24h volume, 24h %, **15m %**, AI bias score, **LONG/SHORT/NEUTRAL** direction, funding, OI value (data rows in regular font).
- TradeMaster robot: floats bottom-right, animated (blinking eyes, antenna, halo, moods), speaks every action (open/win/loss/session/alerts) via speech synthesis, mute toggle.
- Auto-refresh every 5s minimum (SSE 1s primary). Footer: “Mexc AI Fusion Development by BadalWorld · Contact Us — t.me/anonymousvai”.

## 6. API endpoints

`GET /api/state` · `GET /api/stream` (SSE) · `POST /api/start` · `POST /api/stop` · `POST /api/settings` · `POST /api/position/close {symbol}` · `POST /api/position/closeAll` · `GET /api/archive` · `GET /api/analyze?symbol=X_Y` · `GET /api/ip`

## 7. MEXC integration notes

- REST v1 futures API, base `https://api.mexc.com` (fallback `contract.mexc.com`), header signing: `Signature = HMAC-SHA256(secret, apiKey + timestamp + paramString)`; GET params sorted `k=v&…`, POST signs the exact JSON body; headers `ApiKey`, `Request-Time`, `Signature`, `Recv-Window`, `Content-Type: application/json`.
- Used endpoints: `contract/ticker`, `contract/detail`, `contract/kline/{symbol}` (Min1/Min15/Min60/Hour4), `contract/funding_rate/{symbol}`, `private/account/assets`, `private/position/open_positions`, `private/position/list` (history), `private/order/create` (market type 5, sides 1 open-long / 3 open-short / 2 close-short / 4 close-long, isolated openType 1, attached `stopLossPrice`).
- Rate limiting: global token bucket ~8 req/s with per-endpoint caching; every candle decision uses **closed candles only** (no repainting).
