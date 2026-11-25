// pump-sharpe-bot — Pump.fun Sharpe Sprint paper-trading bot (make.fun).
//
// Strategy: strong-curve mean reversion. On every batch, for each mint that
// traded in that batch, buy when the price sits 20-35% below its 40-trade
// high on a curve holding at least 5 real SOL, the last trade was a buy, and
// net SOL flow over the last 40 trades is non-negative. One entry per mint,
// target 0.20 SOL per position (capped at 1% of the real reserve).
// Exits: take profit +20%, stop loss -12%, a 10% trailing stop, or a
// 200-slot max hold. All money math is bigint lamports; no clock, no
// randomness, no environment reads — the run is fully deterministic.
//
// Verified on the kit dev window (grade-local, process driver, commit
// 0568968): hourly Sharpe +0.398, net PnL +0.528 SOL, max drawdown 1.79%,
// 108 round trips / 108 distinct mints, win rate 41.7%.

import { runBot, LAMPORTS_PER_SOL, type Batch, type BotState, type OrderInput } from './vendor/makefun-bot.ts';

// ---------------------------------------------------------------- parameters

const HIGH_WINDOW = 40; // trades in the rolling high / flow window
const MIN_REAL_SOL = 5n * LAMPORTS_PER_SOL; // min real SOL reserve to enter
const TARGET_BUY = 200_000_000n; // 0.20 SOL target stake per position
const MIN_BUY = 10_000_000n; // 0.01 SOL — below this a trip does not count
const BUY_SLIPPAGE_BPS = 500;
const SELL_SLIPPAGE_BPS = 3000;
const MAX_HOLD_SLOTS = 200;
const MAX_POSITIONS = 5;

// Dip band: price must be 20-35% below the 40-trade high, i.e. price/high
// in [65%, 80%]. Compared as cross-multiplied bigint fractions, never floats.
const DIP_LOW_NUM = 65n; // price/high >= 65/100
const DIP_HIGH_NUM = 80n; // price/high <= 80/100
const DIP_DEN = 100n;

// Exit thresholds, as value-vs-cost ratios in percent.
const TAKE_PROFIT_PCT = 120n; // sell when liquidation value >= 120% of cost
const STOP_LOSS_PCT = 88n; // sell when liquidation value <= 88% of cost
const TRAIL_ARM_PCT = 110n; // trailing stop arms once value >= 110% of cost
const TRAIL_DROP_PCT = 90n; // ... then sell if value falls to 90% of its best

// Curve fees charged on a trade: protocol 95 bps + creator 30 bps.
const FEE_BPS = 125n;
const BPS_DEN = 10_000n;

// ---------------------------------------------------------------- trade tape

interface TapeTrade {
  vq: bigint; // virtual quote reserves after the trade
  vt: bigint; // virtual token reserves after the trade
  isBuy: boolean;
  sol: bigint; // sol_amount of the trade, in lamports
}

// Last HIGH_WINDOW trades per mint, oldest first.
const tapes = new Map<string, TapeTrade[]>();

function appendTrade(mint: string, trade: TapeTrade): void {
  let tape = tapes.get(mint);
  if (tape === undefined) {
    tape = [];
    tapes.set(mint, tape);
  }
  tape.push(trade);
  if (tape.length > HIGH_WINDOW) tape.shift();
}

// ---------------------------------------------------------------- positions

interface BookEntry {
  cost: bigint; // lamports paid for the tokens held (curve fees + buy tx fee)
  entrySlot: number; // slot the buy fill landed
  best: bigint; // best liquidation value seen since entry (lamports)
}

// Our own book, keyed by mint. Cost and entry slot come from buy fills;
// the harness's account is the authority for how many tokens we hold.
const book = new Map<string, BookEntry>();

// Mints we have already entered once — no re-entry, no adds, ever.
const entered = new Set<string>();

// ---------------------------------------------------------------- pricing

// Net SOL we would receive for selling `tokens` into this curve right now:
// constant-product quote out, minus 1.25% curve fees, minus one tx fee.
// Returns 0n when the proceeds would not even cover the tx fee.
function liquidationValue(vq: bigint, vt: bigint, tokens: bigint, txFee: bigint): bigint {
  if (tokens <= 0n || vt <= 0n || vq <= 0n) return 0n;
  const quoteOut = (vq * tokens) / (vt + tokens);
  const afterFees = (quoteOut * (BPS_DEN - FEE_BPS)) / BPS_DEN;
  if (afterFees <= txFee) return 0n;
  return afterFees - txFee;
}

// Compare two prices p = a.vq/a.vt and q = b.vq/b.vt. Returns -1/0/1.
function comparePrice(a: TapeTrade, b: TapeTrade): number {
  const left = a.vq * b.vt;
  const right = b.vq * a.vt;
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

// ---------------------------------------------------------------- the bot

await runBot({
  onHello(_state: BotState): void {
    // Nothing to seed: the strategy is fully deterministic and uses no
    // randomness, so the hello handshake needs no setup beyond the shim.
  },

  onBatch(state: BotState, batch: Batch): OrderInput[] {
    const orders: OrderInput[] = [];
    const txFee = state.txFeeLamports();

    // 1. Fold fills into our book: buys open a position, sells and harness
    // closes (complete / flatten / write-off) remove it.
    for (const fill of batch.fills) {
      if (fill.side === 'buy' && fill.status === 'filled') {
        book.set(fill.mint, {
          cost: BigInt(fill.quote_lamports) + BigInt(fill.tx_fee_lamports),
          entrySlot: fill.slot,
          best: 0n,
        });
      } else if (fill.side === 'sell') {
        book.delete(fill.mint);
      }
    }

    // 2. Append this batch's trades to the per-mint tapes, and remember
    // which mints traded so entry checks only run on those.
    const tradedMints: string[] = [];
    const seenThisBatch = new Set<string>();
    for (const event of batch.events) {
      if (event.event !== 'TradeEvent') continue;
      appendTrade(event.mint, {
        vq: BigInt(event.virtual_quote_reserves),
        vt: BigInt(event.virtual_token_reserves),
        isBuy: event.is_buy,
        sol: BigInt(event.sol_amount),
      });
      if (!seenThisBatch.has(event.mint)) {
        seenThisBatch.add(event.mint);
        tradedMints.push(event.mint);
      }
    }

    // 3. Exits first: for every held position, first trigger wins.
    const pendingSell = new Set<string>();
    for (const pending of state.pending.values()) {
      if (pending.order.side === 'sell') pendingSell.add(pending.order.mint);
    }
    for (const [mint, holding] of state.positions) {
      if (pendingSell.has(mint)) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      let entry = book.get(mint);
      if (entry === undefined) {
        // Fallback if a fill was missed: use the harness-reported cost.
        entry = { cost: holding.cost_lamports, entrySlot: batch.slot, best: 0n };
        book.set(mint, entry);
      }
      const value = liquidationValue(
        curve.virtual_quote_reserves,
        curve.virtual_token_reserves,
        holding.token_amount,
        txFee,
      );
      if (value > entry.best) entry.best = value;

      const takeProfit = value * 100n >= entry.cost * TAKE_PROFIT_PCT;
      const stopLoss = value * 100n <= entry.cost * STOP_LOSS_PCT;
      const trailing =
        entry.best * 100n >= entry.cost * TRAIL_ARM_PCT &&
        value * 100n <= entry.best * TRAIL_DROP_PCT;
      const tooOld = batch.slot - entry.entrySlot >= MAX_HOLD_SLOTS;
      if (takeProfit || stopLoss || trailing || tooOld) {
        orders.push({
          side: 'sell',
          mint,
          token_amount: holding.token_amount,
          max_slippage_bps: SELL_SLIPPAGE_BPS,
        });
      }
    }

    // 4. Entries: one per traded mint, all filters must hold.
    if (orders.length < 16 && state.committedPositionCount() < MAX_POSITIONS) {
      for (const mint of tradedMints) {
        if (orders.length >= 16) break;
        if (state.committedPositionCount() >= MAX_POSITIONS) break;
        if (entered.has(mint)) continue;
        if (state.positions.has(mint)) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (curve.real_quote_reserves < MIN_REAL_SOL) continue;

        const tape = tapes.get(mint);
        if (tape === undefined || tape.length === 0) continue;
        const last = tape[tape.length - 1];
        // Load-bearing filter: the most recent trade must be a buy.
        if (!last.isBuy) continue;

        // Net SOL flow over the window must be non-negative.
        let flow = 0n;
        for (const trade of tape) flow += trade.isBuy ? trade.sol : -trade.sol;
        if (flow < 0n) continue;

        // High = max price over the window; current price 20-35% below it.
        let high = tape[0];
        for (const trade of tape) {
          if (comparePrice(trade, high) > 0) high = trade;
        }
        // price/high in [65%, 80%] <=> 100*vq*high.vt in [65, 80]*vt*high.vq.
        const lhs = 100n * last.vq * high.vt;
        const rhs = last.vt * high.vq;
        if (lhs < DIP_LOW_NUM * rhs || lhs > DIP_HIGH_NUM * rhs) continue;

        // Size: target 0.20 SOL, capped at 1% of the real reserve and at
        // free cash minus one tx fee; skip below 0.01 SOL.
        let size = TARGET_BUY;
        const cap = state.maxBuyLamports(mint);
        if (size > cap) size = cap;
        const affordable = state.freeCashLamports() - txFee;
        if (size > affordable) size = affordable;
        if (size < MIN_BUY) continue;

        entered.add(mint);
        orders.push({
          side: 'buy',
          mint,
          quote_lamports: size,
          max_slippage_bps: BUY_SLIPPAGE_BPS,
        });
      }
    }

    return orders;
  },

  onDone(_state: BotState): void {
    // Nothing to report: stdout carries replies only, diagnostics to stderr.
  },
});
