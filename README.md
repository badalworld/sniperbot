# ⚡ MEXC AI FUSION — Compounding Master

AI Futures auto-trading bot + live neon dashboard for **MEXC Futures**.
Development by **BadalWorld** · Contact: [t.me/anonymousvai](https://t.me/anonymousvai)

---

## 🧠 What this bot does (your full strategy, implemented)

| Feature | Implementation |
| --- | --- |
| **Core strategies** | ① **3M Scalping** (Phase 6): EMA9/EMA21 trend + RSI14 cross 50 + volume spike ≥1.3× + 15M higher-TF filter + structure S/L, TP1 +15% ROI (close 50%, SL→breakeven, trail EMA21), TP2 +30% ROI, exit engine (EMA cross flip / RSI loses 50 / volume collapse / 18-min timeout). ② **OBV × EMA50 Compounding** (Phase 1/5): OBV crossing its EMA50 up = BUY, down = SELL on 15M closes + 15m move ≥2% filter |
| **AI Score 0–100** | 10 weighted indicators (Trend 15, Volume 15, Structure 15, Multi-TF 15, RSI 10, MACD 10, S/R 10, ATR 5, Open Interest 3, Funding 2). Only trades **≥70 score with ≥7/10 confirmations** + trend, volume & structure aligned |
| **Compounding** | Starts at your configured margin (default **$2**). After every closed trade: `margin += profit ÷ maxOpenTrades` (loss mirrors negative). $1 profit over 5 slots → next trades use +$0.20 each |
| **TP / SL / Trail** | Symmetric ROI targets (default 30%/30% on margin at 10× = 3% price move). At 30% ROI the **0.5% trailing stop arms** to ride maximum profit |
| **Risk guards** | Max open trades (default 5, changeable), 3 consecutive losses → halt, 5% daily drawdown → halt, 90s anti-revenge cooldown, one position per symbol, BTC instability filter, funding overheated filter, fake-breakout filter, spread & wick filters |
| **Market scanner** | Live rotating scan of every USDT pair with ≥ your min 24h volume (default **$5M**) — price, market cap, 24h vol, 24h%, 15m %, AI bias LONG/SHORT/NEUTRAL, funding, OI value. 40 rolling rows, animated, updates every second |
| **TradeMaster robot** | Animated robot (bottom-right) that **talks every action**: “New trade open — congratulations, pair X”, “This pair made profit $X”, “Sorry, we lost this pair $X” — with voice on/off |
| **Dashboard** | Real-time balance (auto-updates), ping in ms (green <100, red ≥100), your IP with one-click copy, power START/STOP button (green start / red stop) that opens the settings + API key modal, active positions with **TP price, SL price, trailing status, live AI score**, win rate, completed trades, compounding liquid reactor (−100 loss … 0 … +100 profit), Millionaire Path progress to $1,000,000, archive page with season sparklines |
| **Safety net** | Exchange-side stop-loss is attached to every position on MEXC itself — if your server dies, the SL still protects you |

> **Note:** MEXC has **no native 3-minute kline**, so the bot builds exact 3m candles by aggregating 1m data — entries fire only on **confirmed candle closes** (no repainting).

---

## 🖥️ How to run — Windows PC (step by step)

1. **Install Node.js** (18 or newer): download from <https://nodejs.org> → choose **LTS** → install with defaults.
2. **Get the app folder** (this project) to your PC, e.g. `C:\mexc-ai-fusion`.
3. **Open Command Prompt** in that folder: hold `Shift` + right-click inside the folder → *“Open PowerShell window here”*.
4. **Start the server:**
   ```
   node server.js
   ```
   That’s it — **no npm install needed** (zero dependencies, pure Node.js).
5. **Open Chrome** → go to:
   ```
   http://localhost:8080
   ```
6. Press the green **START** power button → the launch modal opens:
   - Your **IP** is shown with a COPY button.
   - Paste your **MEXC API Key** and **Secret Key**.
   - Adjust any configuration (leverage, margin, max open trades, min volume, season goal, TP/SL, strategy mode…).
   - Press **SAVE & START**. The button turns red (STOP) and the engine goes live.

### Create your MEXC API key
1. MEXC app/website → **Profile → API Management → Create API**.
2. Choose **Web API** note the **Access Key** + **Secret Key**.
3. Permissions: enable **Futures — Trade**. (Withdrawal stays OFF.)
4. If you use an IP whitelist, add your current IP (shown on the dashboard with copy button).

---

## 📱 How to run — Android Termux (step by step)

1. Install **Termux** (from F-Droid: <https://f-droid.org/en/packages/com.termux/>).
2. In Termux:
   ```
   pkg update && pkg upgrade -y
   pkg install nodejs -y
   ```
3. Copy the project folder to your phone, then:
   ```
   cd ~/mexc-ai-fusion
   node server.js
   ```
4. Open Chrome on the phone → `http://localhost:8080` — or from a PC on the **same Wi-Fi**, use the LAN IP shown in the dashboard header, e.g. `http://192.168.1.5:8080`.
5. Tip: keep Termux alive with a notification (`termux-wake-lock`, install with `pkg install termux-api`) and disable battery optimization for Termux.

---

## 🕹️ Daily usage

| Action | How |
| --- | --- |
| Start | Green **⏻ START** → keys + settings → SAVE & START |
| Stop | Red **⏻ STOP** → optional “also close open positions” → STOP ENGINE |
| Change settings live | ⚙ gear icon (top right) |
| Close one position | **Close** button on its row |
| Close everything | **Close All** button |
| Full history + season charts | **Archive** page (View All Archive) |
| Market scanner full page | **Market Scan** page |
| Mute TradeMaster | Speaker icon or tap the robot |
| Analyze one symbol deeply | `http://localhost:8080/api/analyze?symbol=BTC_USDT` |

Season balance rule: when you start a season, the **season start balance = your current futures equity** at that moment. The liquid reactor shows session equity wave from **−100% (wipeout) to +100% (doubled)**, and the Millionaire Path tracks progress to your season goal ($1,000,000 default).

---

## ⚙️ Configuration reference

| Setting | Default | Meaning |
| --- | --- | --- |
| Strategy Mode | 3M Scalping | `3M Scalping` or `OBV × EMA50 Compounding` |
| Leverage | 10× | Capped per symbol by MEXC max leverage |
| Start Margin per Trade | $2 | Compounding base at season start |
| Max Open Trades | 5 | Also the compounding divider (profit ÷ 5) |
| Min 24h Volume | $5,000,000 | Only coins above this turnover are scanned/traded |
| Season Goal | $1,000,000 | Millionaire Path target |
| Take Profit ROI | 30% | On margin (at 10× = 3% price move) |
| Stop Loss ROI | 30% | Attached on-exchange + engine-side |
| Trail Trigger ROI | 30% | Trail arms here (OBV mode) |
| Trail Distance | 0.5% | Price distance of the trailing stop |
| Min AI Score | 70 | Nothing below trades. Ever. |
| 15M Move Filter (OBV) | 2% | Phase 5 momentum filter |
| Move 15–30min (Scalp) | 1% | Phase 6 market filter |
| Volume Spike | 1.3× | vs 5-candle average |
| Max Hold | 18 min | 6 × 3m candles timeout (not-in-profit) |
| Max Consecutive Losses | 3 | Risk halt |
| Daily Drawdown Halt | 5% | Risk halt |
| Cooldown After Loss | 90 s | Anti-revenge-trading |
| BTC Instability Filter | 1.5% | Pauses entries 15 min when BTC spikes |

All settings persist in `data/settings.json` (local only, never uploaded). Trade history & sessions live in `data/state.json`. Delete those files to fully reset the bot.

---

## 🧪 Self-test

```
node tests/test.js        # indicator & math checks (offline)
node tests/engine_sim.js  # full trading-pipeline check (offline simulation harness)
```

---

## ❓ Troubleshooting

| Problem | Fix |
| --- | --- |
| `MEXC API validation failed` | Check keys, enable **Futures trade** permission, check IP whitelist matches the IP shown on the dashboard |
| Balance shows `API: …` error | Same as above; also make sure your account has a USDT-M futures wallet |
| No trades opening | This is by design — rules are strict: 70+ AI score, 7/10 confirmations, trend+volume+structure aligned, volume spike, momentum filter. The AI Decision Log on the dashboard shows exactly why each symbol was rejected |
| Page doesn’t open | Is `node server.js` still running? Is the port free? Change port: `PORT=9090 node server.js` (Windows: `set PORT=9090 && node server.js`) |
| No robot voice | Chrome blocks audio until you interact once — tap/click anywhere, then tap the robot. Voice also depends on your OS voices |
| Scanner empty for ~30s | It’s warming kline caches; rows appear as the rotation covers pairs |

---

## ⚠️ Disclaimer

Futures trading is high-risk. This bot compounds aggressively by design (that’s the strategy you chose). Only run it with funds you can afford to lose, and monitor it. Nothing here is financial advice.

**Mexc AI Fusion Development by BadalWorld** — Contact Us: [t.me/anonymousvai](https://t.me/anonymousvai)
