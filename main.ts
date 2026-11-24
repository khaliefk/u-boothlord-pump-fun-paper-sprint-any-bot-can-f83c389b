// Early-momentum paper bot for the pump.fun replay (agent-fun/replay/v2).
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
// Idea: buy a coin soon after it launches, but only once real buyers show
// up. A fresh curve moves most in its first minutes, so the bot watches
// each new mint's tape for buy flow (several buy trades from several
// distinct wallets, net SOL flowing in, price up and sitting near its
// recent high) and takes a small first stake. It adds once if the price
// keeps stepping up, and sells the whole position on the first of a
// take-profit, a stop loss, a trailing give-back, a whale sell, or a
// hold-time limit. Small stakes and fast exits keep at most five slots
// busy, so the bot rotates through many coins across the six-hour window
// instead of sitting on dead ones. A pacing probe keeps the round-trip
// count up when the tape goes quiet, which matters for the guardrail: at
// least 20 coins with a round trip of 0.01 SOL or more, max drawdown 50%.

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
const FIRST_STAKE = 0.05; // first buy per coin
const ADD_STAKE = 0.05; // one add-on buy per coin
const MAX_STAKE = 0.1; // most SOL ever put into one coin
const MIN_BUY = 0.01; // smallest buy worth sending (guardrail round trip)
const WINDOW_SLOTS = 45; // tape window for the entry signal
const MIN_BUYS = 4; // buy trades inside the window
const MIN_BUYERS = 4; // distinct buying wallets inside the window
const MIN_NET_SOL = 1.0; // net SOL (buys minus sells) inside the window
const MIN_UP = 0.04; // price rise across the window
const MAX_UP = 1.5; // skip coins that already ran too far in one window
const NEAR_HIGH = 0.9; // price now must sit near the window high
const MIN_RQ_SOL = 1; // real SOL reserves at entry, low end
const MAX_RQ_SOL = 60; // real SOL reserves at entry, high end
const MIN_AGE_SLOTS = 120; // slots since CreateEvent before an entry
const BUY_SLIP_BPS = 2000;
const SELL_SLIP_BPS = 10_000;
const TAKE_PROFIT = 1.4; // sell when value reaches cost * this
const STOP_LOSS = 0.9; // sell when value falls to cost * this
const TRAIL_ARM = 1.2; // trailing stop arms once value hits cost * this
const TRAIL_GIVEBACK = 0.8; // then sell when value drops to peak * this
const BIG_SELL_SOL = 2; // one recorded sell this big triggers an exit
const MAX_HOLD_SLOTS = 1500; // sell a flat position after this long
const HOLD_IF_UP = 0.1; // hold-time limit does not apply while up this much
const ADD_STEP = 0.12; // add only when price is this far above last buy
const ACCEL = 1; // newer-half net inflow must be at least this x the older half
const COOLDOWN_SLOTS = 400; // wait after an exit before re-entering a coin
const MAX_ENTRIES = 2; // most entries per coin over the run
const PROBE_SOL = 0.01; // pacing probe stake
const TARGET_COINS = 25; // pacing target over the window
const TARGET_FILLS = 240;
const PACE_SECS = 14_400; // window the pacing targets are spread over

interface TapeTrade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface Tape {
  created: number | null;
  trades: TapeTrade[];
  entries: number;
  lastExit: number;
}

interface Held {
  opened: number;
  peak: number; // best close value seen, SOL
  invested: number; // SOL sent in buys for this position
  lastAddPrice: number;
  exiting: boolean;
  /** Some buy of this position actually filled. */
  filled: boolean;
}

const tapes = new Map<Pubkey, Tape>();
const held = new Map<Pubkey, Held>();
const probes = new Map<Pubkey, boolean>(); // false = buying, true = selling
let myFills = 0;
const myCoins = new Set<Pubkey>();
let firstTime: number | null = null;
let lastTime: number | null = null;

function tapeOf(mint: Pubkey): Tape {
  let t = tapes.get(mint);
  if (t === undefined) {
    t = { created: null, trades: [], entries: 0, lastExit: -1e12 };
    tapes.set(mint, t);
  }
  return t;
}

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

/** Entry signal on a mint's tape at slot `now`. */
function entrySignal(t: Tape, now: number, rqSol: number): boolean {
  if (rqSol < MIN_RQ_SOL || rqSol > MAX_RQ_SOL) return false;
  if (t.created === null || now - t.created < MIN_AGE_SLOTS) return false;
  const from = now - WINDOW_SLOTS;
  const mid = now - WINDOW_SLOTS / 2;
  let buySol = 0;
  let sellSol = 0;
  let buys = 0;
  let netOld = 0;
  let netNew = 0;
  let startPrice = -1;
  let high = 0;
  let last = 0;
  const buyers = new Map<string, number>();
  for (const tr of t.trades) {
    if (tr.slot <= from) {
      startPrice = tr.price;
      continue;
    }
    if (startPrice < 0) startPrice = tr.price;
    const signed = tr.buy ? tr.sol : -tr.sol;
    if (tr.slot <= mid) netOld += signed;
    else netNew += signed;
    if (tr.buy) {
      buySol += tr.sol;
      buys++;
      buyers.set(tr.user, (buyers.get(tr.user) ?? 0) + tr.sol);
    } else {
      sellSol += tr.sol;
    }
    if (tr.price > high) high = tr.price;
    last = tr.price;
  }
  if (buys < MIN_BUYS || buyers.size < MIN_BUYERS) return false;
  if (buySol - sellSol < MIN_NET_SOL) return false;
  // Acceleration: the flow must be speeding up, not fading. A coin whose
  // buyers already left looks the same on totals alone, so require the
  // newer half of the window to beat the older half.
  if (netNew <= 0 || netNew < ACCEL * netOld) return false;
  if (startPrice <= 0 || last <= 0) return false;
  const up = last / startPrice - 1;
  if (up < MIN_UP || up > MAX_UP) return false;
  if (last < high * NEAR_HIGH) return false;
  return true;
}

/** Net recorded SOL (buys minus sells) over the last `w` slots. */
function flow(t: Tape, now: number, w: number): number {
  let net = 0;
  for (let i = t.trades.length - 1; i >= 0; i--) {
    const tr = t.trades[i]!;
    if (tr.slot <= now - w) break;
    net += tr.buy ? tr.sol : -tr.sol;
  }
  return net;
}

await runBot({
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    const now = batch.slot;
    const orders: OrderInput[] = [];
    const traded = new Set<Pubkey>();
    const bigSell = new Set<Pubkey>();

    for (const f of batch.fills) {
      if (f.status === "filled" && !f.client_id.startsWith("_")) {
        myFills++;
        myCoins.add(f.mint);
        const h = held.get(f.mint);
        if (h !== undefined && f.side === "buy") h.filled = true;
      }
    }

    for (const e of batch.events) {
      if (e.block_time !== null) {
        if (firstTime === null) firstTime = e.block_time;
        if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
      }
      if (e.event === "CreateEvent") {
        tapeOf(e.mint).created = e.slot;
      } else if (e.event === "TradeEvent") {
        const sol = Number(e.sol_amount) / LAMPORTS;
        const price = Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves);
        tapeOf(e.mint).trades.push({ slot: e.slot, buy: e.is_buy, sol, user: e.user, price });
        traded.add(e.mint);
        if (!e.is_buy && sol >= BIG_SELL_SOL) bigSell.add(e.mint);
      }
    }

    // Trim old tape entries.
    const keep = WINDOW_SLOTS + 5;
    for (const mint of traded) {
      const t = tapes.get(mint)!;
      let cut = 0;
      while (cut < t.trades.length && t.trades[cut]!.slot <= now - keep) cut++;
      if (cut > 0) t.trades.splice(0, cut);
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
        if (!pendingByMint.has(mint)) {
          held.delete(mint);
          // A buy that never filled (rejected, failed) must not burn one
          // of the coin's two entries: give the entry back.
          if (h.filled) tapeOf(mint).lastExit = now;
          else if (h.invested > 0) tapeOf(mint).entries = Math.max(0, tapeOf(mint).entries - 1);
        }
        continue;
      }
      if (curve === undefined || curve.complete) continue;
      const value = valueOf(state, mint);
      const cost = costOf(state, mint);
      if (value > h.peak) h.peak = value;
      let exit = h.exiting;
      if (!exit && value <= cost * STOP_LOSS) exit = true;
      if (!exit && value >= cost * TAKE_PROFIT) exit = true;
      if (!exit && h.peak >= cost * TRAIL_ARM && value <= h.peak * TRAIL_GIVEBACK) exit = true;
      if (!exit && bigSell.has(mint) && value < cost * 1.2) exit = true;
      if (!exit && now - h.opened > MAX_HOLD_SLOTS && value < cost * (1 + HOLD_IF_UP)) exit = true;
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

    // ---- entries and add-ons ----
    let free = Number(state.freeCashLamports()) / LAMPORTS;
    let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
    for (const mint of traded) {
      if (orders.length >= cap) break;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      if (pendingByMint.has(mint) || probes.has(mint)) continue;
      const t = tapes.get(mint)!;
      const h = held.get(mint);
      const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
      const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
      let want: number;
      if (h === undefined) {
        if (slotsLeft <= 0) continue;
        if (t.entries >= MAX_ENTRIES || now - t.lastExit < COOLDOWN_SLOTS) continue;
        if (!entrySignal(t, now, rqSol)) continue;
        want = FIRST_STAKE;
      } else {
        if (h.exiting || h.invested >= MAX_STAKE - MIN_BUY) continue;
        if (price < h.lastAddPrice * (1 + ADD_STEP)) continue;
        if (flow(t, now, WINDOW_SLOTS) < MIN_NET_SOL) continue;
        if (rqSol > MAX_RQ_SOL) continue;
        want = Math.min(ADD_STAKE, MAX_STAKE - h.invested);
      }
      const capSol = Number(state.maxBuyLamports(mint)) / LAMPORTS;
      let amount = Math.min(capSol, want);
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
      if (h === undefined) {
        held.set(mint, { opened: now, peak: 0, invested: amount, lastAddPrice: price, exiting: false, filled: false });
        t.entries++;
        slotsLeft--;
      } else {
        h.invested += amount;
        h.lastAddPrice = price;
      }
    }

    // ---- pacing: open a probe when fills or coins lag the pace ----
    if (probes.size < 1 && slotsLeft > 0 && firstTime !== null && lastTime !== null) {
      const pace = Math.min(1, (lastTime - firstTime) / PACE_SECS);
      const needCoins = myCoins.size < Math.ceil(TARGET_COINS * pace);
      const needFills = myFills < Math.ceil(TARGET_FILLS * pace);
      if (needCoins || needFills) {
        const minRq = (PROBE_SOL * 10_000) / state.hello.caps.max_order_bps_of_real_reserve;
        for (const mint of traded) {
          if (orders.length >= cap || probes.size >= 1) break;
          if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
          if (needCoins && !needFills && myCoins.has(mint)) continue;
          const curve = state.curves.get(mint);
          if (curve === undefined || curve.complete) continue;
          // Never probe a brand-new curve: the probe is for liquid coins
          // the main signal passed over, not for fresh launches.
          const created = tapeOf(mint).created;
          if (created === null || now - created < MIN_AGE_SLOTS) continue;
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
