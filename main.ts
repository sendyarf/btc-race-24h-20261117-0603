// Dip-DCA: buy cbBTC dips in tranches, hold to the end.
//
// The dev window (1,440 one-minute bars) rises +0.49% with a 2.5% range, while a
// full-size round trip costs ~25-37 bps in fees, slippage and price impact, so the
// bot trades rarely and never chases: it buys at most four tranches of 25% of
// starting equity, each on a dip of 0.30% or more below the 60-bar mean close,
// spaced at least 60 bars apart, and holds everything to the replay's final
// flatten. A wide 3% stop-loss on the position's cost caps a falling race window
// (it never fires on the dev window), and new buys halt while equity sits more
// than 10% below its peak. If no dip ever comes, one tranche is bought halfway
// through the window so the entry still meets the one-trade guardrail.
//
// Deterministic: float64 arithmetic on bar closes only, no wall clock, no
// randomness, no environment. Every decision uses the bar time the batch carries.

import { BPS, runBars } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
/** Rolling mean window, in bars. */
const WINDOW_BARS = 60;
/** Buy when the close is at least this far below the rolling mean, in bps. */
const DIP_BPS = 30;
/** Each tranche is this share of starting equity, in bps. */
const TRANCHE_BPS = 2500;
/** At most this many tranches. */
const MAX_TRANCHES = 4;
/** Minimum bars between two buys. */
const MIN_GAP_BARS = 60;
/** If no tranche was bought by this batch, buy one anyway (guardrail insurance). */
const FALLBACK_BAR = 720;
/** No new buys once this many minutes have elapsed since the first bar. */
const NO_ENTRY_AFTER_MINUTES = 1410;
/** Sell everything if the position is worth this much less than its cost, in bps. */
const STOP_LOSS_BPS = 300;
/** Halt new buys while equity is this far below its peak, in bps. */
const DD_HALT_BPS = 1000;
/** Slippage cap per order, in bps (1-minute moves top out near 45 bps). */
const MAX_SLIPPAGE_BPS = 100;

const DIP_FACTOR = 1 - DIP_BPS / 10_000;

/** Every CBBTC close seen so far, in raw price units, oldest first. */
const closes: number[] = [];
let tranches = 0;
let lastBuySeq = -1_000_000;
let stopped = false;
let peakEquity = 0n;
let firstBarMs: number | null = null;

await runBars({
  onBatch(state, batch) {
    const bar = [...batch.bars].reverse().find((b) => b.symbol === SYMBOL);
    if (bar === undefined) return [];
    const close = Number(bar.c);
    if (firstBarMs === null) firstBarMs = bar.t;

    // The mean of the closes before this bar (the signal's reference).
    const mean =
      closes.length >= WINDOW_BARS
        ? closes.slice(-WINDOW_BARS).reduce((a, x) => a + x, 0) / WINDOW_BARS
        : null;
    closes.push(close);

    if (state.equity > peakEquity) peakEquity = state.equity;

    const held = state.positions.get(SYMBOL);

    // Wide stop: a falling race window is cut at -3% of cost, then trading stops.
    if (held !== undefined) {
      const value = state.value(SYMBOL, held.qty);
      if (value * BPS < held.cost * BigInt(10_000 - STOP_LOSS_BPS)) {
        stopped = true;
        return [{ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
    }

    if (stopped || state.warmingUp || mean === null) return [];
    if (tranches >= MAX_TRANCHES) return [];
    if (state.seq - lastBuySeq < MIN_GAP_BARS) return [];
    if (bar.t - firstBarMs >= NO_ENTRY_AFTER_MINUTES * 60_000) return [];
    // Equity drawdown halt: no new buys while 10% below the peak.
    if (state.equity * BPS < peakEquity * BigInt(10_000 - DD_HALT_BPS)) return [];

    const dipped = close < mean * DIP_FACTOR;
    const fallback = tranches === 0 && state.seq >= FALLBACK_BAR;
    if (!dipped && !fallback) return [];

    const { caps, fees } = state.hello;
    const tranche = (BigInt(state.hello.capital.quote_units) * BigInt(TRANCHE_BPS)) / BPS;
    let notional = tranche;
    const room = state.weightRoom(SYMBOL);
    if (room < notional) notional = room;
    if (state.cash < notional) notional = state.cash;
    if (notional === 0n || notional < BigInt(fees.min_notional_quote_units)) return [];
    if (caps.max_orders_per_bar < 1) return [];

    tranches += 1;
    lastBuySeq = state.seq;
    return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS }];
  },
});
