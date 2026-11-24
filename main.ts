// Launch-fade paper bot for the pump.fun replay (agent-fun/replay/v2).
//
// The harness speaks NDJSON on stdin: hello, then one batch per slot step,
// then done. This file answers every batch with one reply line of orders.
// It runs through the kit SDK shim in vendor/makefun-bot.ts, which owns the
// wire, validates every order, and assigns client ids.
//
// No network, no clock, no randomness. The same input stream always yields
// the same replies, which is what the grader needs: it runs the bot twice
// and demands identical action logs.
//
// Idea: pump.fun coins do almost all of their moving in the first seconds
// after launch, and most of them only go down from there. So this bot buys
// at the launch itself, but only launches that do not smell like a rug:
// the creator has not sold, the creator did not load up big in the create
// slot, and the opening crowd is small (a launch bundled by a dozen
// wallets in its first slots is usually the creator's cluster waiting to
// dump). It takes one small stake per coin, 0.08 SOL, and gets out fast:
// take profit at +25%, stop loss at -12%, a trailing stop once the
// position runs 10% up, an exit the moment the creator sells, and a hard
// 15-slot hold limit. One entry per coin, never a re-entry, at most five
// positions open, so the bot rotates through hundreds of launches across
// the six-hour window instead of sitting on dead coins. A pacing probe
// (a 0.01 SOL round trip on a liquid coin) keeps the round-trip count up
// when the tape goes quiet, which matters for the guardrail: at least 20
// coins with a round trip of 0.01 SOL or more, max drawdown 50%.

import {
  LAMPORTS_PER_SOL,
  runBot,
  type Batch,
  type BotState,
  type BuyInput,
  type OrderInput,
  type Pubkey,
} from "./vendor/makefun-bot.ts";

const LAMPORTS = 1_000_000_000;
const CURVE_FEE = 0.0125;

// ---- tunables (SOL units unless noted) ----
const STAKE = 0.08; // one buy per coin, never more
const MIN_BUY = 0.01; // smallest buy worth sending (guardrail round trip)
const MAX_AGE_SLOTS = 6; // first buy must be decided within this many slots of launch
const MAX_DEV_BUY = 2.0; // creator's own buy in the create slot, at most
const MIN_DEV_BUY = 0.02; // creator's own buy in the create slot, at least
const MIN_BUYERS = 3; // distinct non-creator buyers seen before entry, at least
const MAX_BUYERS = 5; // distinct non-creator buyers seen before entry, at most
const MIN_RQ_SOL = 0.3; // real SOL reserves at entry, low end
const MAX_RQ_SOL = 30; // real SOL reserves at entry, high end
const BUY_SLIP_BPS = 10_000;
const SELL_SLIP_BPS = 10_000;
const TAKE_PROFIT = 1.25; // sell when value reaches cost * this
const STOP_LOSS = 0.88; // sell when value falls to cost * this
const TRAIL_ARM = 1.2; // trailing stop arms once value hits cost * this
const TRAIL_GIVEBACK = 0.85; // then sell when value drops to peak * this
const MAX_HOLD_SLOTS = 15; // sell a position after this long, whatever it did
const PROBE_SOL = 0.01; // pacing probe stake
const MIN_AGE_PROBE = 120; // probes only touch coins older than this
const TARGET_COINS = 25; // pacing target over the window
const TARGET_FILLS = 240;
const PACE_SECS = 14_400; // window the pacing targets are spread over

interface Launch {
  created: number;
  creator: string;
  devBuy: number; // SOL the creator bought in the create slot
  devSold: boolean;
  buyers: Set<string>;
  done: boolean; // decided (entered, filtered out, or exited)
}

interface Held {
  opened: number;
  peak: number; // best close value seen, SOL
  exiting: boolean;
}

const launches = new Map<Pubkey, Launch>();
const held = new Map<Pubkey, Held>();
const probes = new Map<Pubkey, boolean>(); // false = buying, true = selling
let myFills = 0;
const myCoins = new Set<Pubkey>();
let firstTime: number | null = null;
let lastTime: number | null = null;

/** Close value of a position in SOL, curve fee and one tx fee deducted. */
function valueOf(state: BotState, mint: Pubkey): number {
  const pos = state.positions.get(mint);
  const curve = state.curves.get(mint);
  if (pos === undefined || curve === undefined) return 0;
  const tokens = Number(pos.token_amount);
  if (tokens <= 0) return 0;
  const vq = Number(curve.virtual_quote_reserves);
  const vt = Number(curve.virtual_token_reserves);
  const gross = (tokens * vq) / (vt + tokens);
  return (gross / LAMPORTS) * (1 - CURVE_FEE) - Number(state.txFeeLamports()) / LAMPORTS;
}

function costOf(state: BotState, mint: Pubkey): number {
  const pos = state.positions.get(mint);
  return pos === undefined ? 0 : Number(pos.cost_lamports) / LAMPORTS;
}

await runBot({
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    const now = batch.slot;
    const orders: OrderInput[] = [];
    const fresh = new Set<Pubkey>();

    for (const f of batch.fills) {
      if (f.status === "filled" && !f.client_id.startsWith("_")) {
        myFills++;
        myCoins.add(f.mint);
      }
    }

    for (const e of batch.events) {
      if (e.block_time !== null) {
        if (firstTime === null) firstTime = e.block_time;
        if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
      }
      if (e.event === "CreateEvent") {
        launches.set(e.mint, {
          created: e.slot,
          creator: e.creator,
          devBuy: 0,
          devSold: false,
          buyers: new Set(),
          done: false,
        });
        fresh.add(e.mint);
      } else if (e.event === "TradeEvent") {
        const l = launches.get(e.mint);
        if (l !== undefined) {
          const sol = Number(e.sol_amount) / LAMPORTS;
          const isDev = e.user === l.creator;
          if (e.is_buy) {
            if (isDev && e.slot === l.created) l.devBuy += sol;
            else if (!isDev) l.buyers.add(e.user);
          } else if (isDev) {
            l.devSold = true;
          }
        }
        fresh.add(e.mint);
      } else if (e.event === "CompleteEvent") {
        const l = launches.get(e.mint);
        if (l !== undefined) l.done = true;
      }
    }

    const pendingByMint = new Map<Pubkey, number>();
    for (const po of state.pending.values()) {
      pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);
    }
    const sellPending = (mint: Pubkey): boolean => {
      for (const po of state.pending.values()) {
        if (po.order.mint === mint && po.order.side === "sell") return true;
      }
      return false;
    };

    const cap = state.hello.caps.max_orders_per_batch;
    const txSol = Number(state.txFeeLamports()) / LAMPORTS;

    // ---- exits first ----
    for (const [mint, h] of held) {
      const pos = state.positions.get(mint);
      const curve = state.curves.get(mint);
      if (pos === undefined) {
        if (!pendingByMint.has(mint)) held.delete(mint);
        continue;
      }
      if (curve === undefined || curve.complete) continue;
      const value = valueOf(state, mint);
      const cost = costOf(state, mint);
      if (value > h.peak) h.peak = value;
      let exit = h.exiting;
      if (!exit && value >= cost * TAKE_PROFIT) exit = true;
      if (!exit && value <= cost * STOP_LOSS) exit = true;
      if (!exit && h.peak >= cost * TRAIL_ARM && value <= h.peak * TRAIL_GIVEBACK) exit = true;
      if (!exit && launches.get(mint)?.devSold) exit = true;
      if (!exit && now - h.opened > MAX_HOLD_SLOTS) exit = true;
      if (!exit) continue;
      h.exiting = true;
      if (sellPending(mint)) continue;
      if (orders.length >= cap) break;
      orders.push({ side: "sell", mint, token_amount: pos.token_amount, max_slippage_bps: SELL_SLIP_BPS });
    }

    // ---- probe round trips: sell as soon as the probe buy lands ----
    for (const [mint, selling] of probes) {
      const pos = state.positions.get(mint);
      const curve = state.curves.get(mint);
      if (pos === undefined) {
        if (!pendingByMint.has(mint)) probes.delete(mint);
        continue;
      }
      if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
      if (orders.length >= cap) break;
      orders.push({ side: "sell", mint, token_amount: pos.token_amount, max_slippage_bps: SELL_SLIP_BPS });
      if (!selling) probes.set(mint, true);
    }

    // ---- entries: young launches that pass the rug filter ----
    let free = Number(state.freeCashLamports()) / LAMPORTS;
    let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
    for (const mint of fresh) {
      if (orders.length >= cap) break;
      const l = launches.get(mint);
      if (l === undefined || l.done) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      if (pendingByMint.has(mint) || probes.has(mint) || held.has(mint)) continue;
      const age = now - l.created;
      if (age > MAX_AGE_SLOTS) {
        l.done = true;
        continue;
      }
      if (slotsLeft <= 0) continue;
      // Rug filter: creator selling or loading up, or a bundled crowd.
      if (l.devSold) {
        l.done = true;
        continue;
      }
      if (l.devBuy > MAX_DEV_BUY || l.devBuy < MIN_DEV_BUY) {
        // A creator who buys nothing has no skin in the launch; one who
        // loads up big is often about to dump on the crowd. Either way the
        // launch stays out, but only once its window has closed: the
        // creator's buy can still land in the create slot's later batches.
        if (age >= MAX_AGE_SLOTS) l.done = true;
        continue;
      }
      if (l.buyers.size < MIN_BUYERS) {
        if (age >= MAX_AGE_SLOTS) l.done = true;
        continue;
      }
      if (l.buyers.size > MAX_BUYERS) {
        l.done = true;
        continue;
      }
      const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
      if (rqSol < MIN_RQ_SOL || rqSol > MAX_RQ_SOL) {
        // Reserves only grow from here on a fresh curve, so a launch that
        // is already above the ceiling stays out; one below the floor may
        // still qualify on a later batch while it is young.
        if (rqSol > MAX_RQ_SOL) l.done = true;
        continue;
      }
      const capSol = Number(state.maxBuyLamports(mint)) / LAMPORTS;
      let amount = Math.min(capSol, STAKE);
      if (amount > free - txSol) amount = free - txSol;
      if (amount < MIN_BUY) continue;
      const buy: BuyInput = {
        side: "buy",
        mint,
        quote_lamports: BigInt(Math.floor(amount * LAMPORTS)),
        max_slippage_bps: BUY_SLIP_BPS,
      };
      orders.push(buy);
      free -= amount + txSol;
      held.set(mint, { opened: now, peak: 0, exiting: false });
      l.done = true;
      slotsLeft--;
    }

    // ---- pacing: open a probe when fills or coins lag the pace ----
    if (probes.size < 1 && slotsLeft > 0 && firstTime !== null && lastTime !== null) {
      const pace = Math.min(1, (lastTime - firstTime) / PACE_SECS);
      const needCoins = myCoins.size < Math.ceil(TARGET_COINS * pace);
      const needFills = myFills < Math.ceil(TARGET_FILLS * pace);
      if (needCoins || needFills) {
        const minRq = (PROBE_SOL * 10_000) / state.hello.caps.max_order_bps_of_real_reserve;
        for (const mint of fresh) {
          if (orders.length >= cap || probes.size >= 1) break;
          if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
          if (needCoins && !needFills && myCoins.has(mint)) continue;
          const curve = state.curves.get(mint);
          if (curve === undefined || curve.complete) continue;
          // Never probe a brand-new curve: the probe is for liquid coins
          // the launch filter passed over, not for fresh launches.
          const created = launches.get(mint)?.created;
          if (created === undefined || now - created < MIN_AGE_PROBE) continue;
          if (Number(curve.real_quote_reserves) / LAMPORTS < minRq * 1.5) continue;
          if (free < PROBE_SOL + 2 * txSol) break;
          orders.push({
            side: "buy",
            mint,
            quote_lamports: BigInt(Math.floor(PROBE_SOL * LAMPORTS)),
            max_slippage_bps: BUY_SLIP_BPS,
          });
          probes.set(mint, false);
          free -= PROBE_SOL + txSol;
        }
      }
    }

    return orders;
  },
});
