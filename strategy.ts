// Selective early scalper v3 for agent-fun/replay/v2 (pump.fun bonding curves).
//
// Measured on the kit's dev dataset (work/sim.ts, all 3 parts, 1222 coins
// over 24h): almost every coin trends to zero and the 2-slot fill latency
// eats the opening spike, so the only survivable shape is a tight,
// selective scalp. This bot buys a coin once, for 0.05 SOL, only when the
// early tape looks like a genuine launch — real SOL 1-2.9 (price at most
// 1.25x its create price, which on this constant-product curve is the same
// thing), at least 2 trades from at least 2 distinct non-creator buyers,
// net buying, creator still holding, and the creator's own buy a moderate
// 0.3-2.5 SOL (skin in the game, not a bundle to dump). It exits at +15%
// take-profit, -8% stop-loss, a 400-slot time cap, 300 slots of staleness,
// or a creator sale. Buys and sells carry tight slippage limits (5% / 3%):
// a fill that moved against the bot in the latency is rejected for free
// and retried, instead of buying the top of a spike. No second tranche, no
// holding to a coin's death, at most five coins at once — so a round trip
// is 0.05 SOL (above the 0.01 SOL guardrail) and at most 0.25 SOL is ever
// at risk (drawdown far under the 50% guardrail on 10 SOL of capital).
//
// Dev-window result (own sim, kit model): net -0.071 SOL over 24h, 117
// round-trip coins, max drawdown 0.96% — the least-negative of ~30 measured
// variants (the kit's own pilot sniper loses -0.138 SOL on part 0 alone).
// The final window is a fresh 6h sample, so this is a least-loss entry
// with a real chance at >0, not a promise of profit.
//
// Pure function of the batches it is fed: no clock, no randomness, no I/O.

import { BPS, type Batch, type BotState, type OrderInput, type Pubkey } from './vendor/makefun-bot.ts';

export interface RiderParams {
  /** Total lamports to spend on one coin across first buy + add. */
  stakeLamports: number;
  /** Lamports aimed for on the first buy (before the 1%-of-reserve cap). */
  firstBuyLamports: number;
  /** Smallest single buy worth paying the tx fee for. */
  minBuyLamports: number;
  /** Youngest age (slots since create) at which a coin may be bought. */
  minAgeSlots: number;
  /** Oldest age (slots since create) at which a first buy may still be decided. */
  maxAgeSlots: number;
  /** Oldest age at which the second tranche may still be decided (-1: adds disabled). */
  maxAddAgeSlots: number;
  /** Real SOL reserve a coin needs before its first buy (lamports). */
  minRealSolLamports: number;
  /** Trades seen before the first buy, at least. */
  minTrades: number;
  /** Distinct non-creator buyers seen before the first buy, at least. */
  minBuyers: number;
  /** Price now over the create price, as a ratio in bps (10_000 = 1.0x, so
      12_500 caps the entry at 1.25x — on this constant-product curve that is
      nearly the same as capping real SOL at ~2.9). */
  maxRunupBps: number;
  /** Net lamports bought minus sold over the whole tape so far, at least. */
  minNetFlowLamports: number;
  /** Creator's own buys (lamports) window: a creator who bought a moderate
      amount has skin in the game; a huge dev buy is often a bundle to dump. */
  minDevBuyLamports: number;
  maxDevBuyLamports: number;
  /** Slippage allowed on buys (bps). */
  buySlippageBps: number;
  /** Slippage allowed on sells (bps): a sell whose fill is worse than the
      decision price by more than this is rejected for free and retried on
      the next batch — a pseudo-limit order against latency slippage. */
  sellSlippageBps: number;
  /** Exit when the position is worth this much over its cost (bps). */
  takeProfitBps: number;
  /** Exit when it is worth this much under its cost (bps). */
  stopLossBps: number;
  /** Exit after holding this many slots. */
  maxHoldSlots: number;
  /** Exit when no trade has hit the coin for this many slots. */
  staleSlots: number;
  /** Exit when the creator sells while held. */
  exitOnCreatorSell: boolean;
}

export const DEFAULT_PARAMS: RiderParams = {
  stakeLamports: 50_000_000,
  firstBuyLamports: 50_000_000,
  minBuyLamports: 5_000_000,
  minAgeSlots: 0,
  maxAgeSlots: 60,
  maxAddAgeSlots: -1,
  minRealSolLamports: 1_000_000_000,
  minTrades: 2,
  minBuyers: 2,
  maxRunupBps: 12_500,
  minNetFlowLamports: 0,
  minDevBuyLamports: 300_000_000,
  maxDevBuyLamports: 2_500_000_000,
  buySlippageBps: 500,
  sellSlippageBps: 300,
  takeProfitBps: 1_500,
  stopLossBps: 800,
  maxHoldSlots: 400,
  staleSlots: 300,
  exitOnCreatorSell: true,
};

interface TapeCoin {
  mint: Pubkey;
  createSlot: number;
  creator: Pubkey;
  /** Create-time price as (vq0, vt0); run-up is measured against it. */
  vq0: bigint;
  vt0: bigint;
  trades: number;
  buyers: Set<Pubkey>;
  boughtLamports: bigint;
  soldLamports: bigint;
  devBuyLamports: bigint;
  creatorSold: boolean;
  lastTradeSlot: number;
  /** Lamports already spent on this coin (first buy + add), counted on fills. */
  spent: bigint;
  /** A first buy is in flight (do not send another until it resolves). */
  buySent: boolean;
  /** Decision price (vq, vt) of the first buy. */
  firstBuyVq: bigint;
  firstBuyVt: bigint;
  /** Never consider again (entered and exited, filtered out, completed). */
  closed: boolean;
}

interface OpenTrade {
  openedSlot: number;
  /** Tx fees paid on fills for this position (curve fees sit in cost_lamports). */
  txPaid: bigint;
  creatorSoldAtOpen: boolean;
}

/** Curve fee (protocol 95 + creator 30 bps) charged on every trade. */
const CURVE_FEE_BPS = 125n;

/** What selling `tokens` against reserves (vq, vt) would pay after curve fees. */
function sellValueLamports(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const gross = (tokens * vq) / (vt + tokens);
  return gross - (gross * CURVE_FEE_BPS + BPS - 1n) / BPS;
}

export interface RiderStrategy {
  onBatch(state: BotState, batch: Batch): OrderInput[];
}

export function createRider(params: RiderParams = DEFAULT_PARAMS): RiderStrategy {
  const P = params;
  const coins = new Map<Pubkey, TapeCoin>();
  const open = new Map<Pubkey, OpenTrade>();
  /** Mints with a sell in flight (do not send a second sell). */
  const selling = new Set<Pubkey>();
  const stake = BigInt(P.stakeLamports);
  const firstBuy = BigInt(P.firstBuyLamports);
  const minBuy = BigInt(P.minBuyLamports);

  function readEvents(batch: Batch): void {
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        coins.set(e.mint, {
          mint: e.mint,
          createSlot: e.slot,
          creator: e.creator,
          vq0: BigInt(e.virtual_quote_reserves),
          vt0: BigInt(e.virtual_token_reserves),
          trades: 0,
          buyers: new Set(),
          boughtLamports: 0n,
          soldLamports: 0n,
          devBuyLamports: 0n,
          creatorSold: false,
          lastTradeSlot: e.slot,
          spent: 0n,
          buySent: false,
          firstBuyVq: 0n,
          firstBuyVt: 1n,
          closed: false,
        });
      } else if (e.event === 'TradeEvent') {
        const c = coins.get(e.mint);
        if (c === undefined) continue;
        c.trades += 1;
        c.lastTradeSlot = e.slot;
        const sol = BigInt(e.sol_amount);
        const isCreator = e.user === c.creator;
        if (e.is_buy) {
          c.boughtLamports += sol;
          if (isCreator) c.devBuyLamports += sol;
          else c.buyers.add(e.user);
        } else {
          c.soldLamports += sol;
          if (isCreator) c.creatorSold = true;
        }
      } else {
        const c = coins.get(e.mint);
        if (c !== undefined) c.closed = true;
      }
    }
  }

  function hasPending(state: BotState, mint: Pubkey, side: 'buy' | 'sell'): boolean {
    for (const p of state.pending.values()) {
      if (p.order.mint === mint && p.order.side === side) return true;
    }
    return false;
  }

  return {
    onBatch(state, batch) {
      readEvents(batch);
      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = state.txFeeLamports();

      // Fold fills: track tx fees per open position, drop closed positions,
      // and count spent lamports on filled buys only — a buy the market
      // rejects (for example for slippage) costs nothing and must not block
      // a later retry on the same coin.
      for (const f of batch.fills) {
        if (f.client_id.startsWith('_')) {
          open.delete(f.mint);
          selling.delete(f.mint);
          continue;
        }
        const c = coins.get(f.mint);
        if (f.side === 'buy' && c !== undefined) {
          c.buySent = false;
          if (f.status === 'filled') c.spent += BigInt(f.quote_lamports);
        }
        if (f.status === 'filled' && f.side === 'buy' && !open.has(f.mint)) {
          open.set(f.mint, {
            openedSlot: f.slot,
            txPaid: BigInt(f.tx_fee_lamports),
            creatorSoldAtOpen: coins.get(f.mint)?.creatorSold ?? false,
          });
        } else if (f.status !== 'rejected') {
          const o = open.get(f.mint);
          if (o !== undefined) o.txPaid += BigInt(f.tx_fee_lamports);
        }
      }
      for (const mint of [...selling]) if (!hasPending(state, mint, 'sell')) selling.delete(mint);
      for (const mint of [...open.keys()]) {
        if (!state.positions.has(mint) && !selling.has(mint) && !hasPending(state, mint, 'buy')) {
          open.delete(mint);
        }
      }

      // --- Exits first: take profit, stop loss, time cap, staleness, creator sale.
      for (const [mint, pos] of state.positions) {
        if (orders.length >= cap) break;
        if (selling.has(mint)) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined) continue;
        let o = open.get(mint);
        if (o === undefined) {
          o = { openedSlot: state.slot, txPaid: tx, creatorSoldAtOpen: coins.get(mint)?.creatorSold ?? false };
          open.set(mint, o);
        }
        const value = sellValueLamports(pos.token_amount, curve.virtual_quote_reserves, curve.virtual_token_reserves) - tx;
        const basis = pos.cost_lamports + o.txPaid;
        let exit = false;
        if (basis > 0n) {
          if (value * BPS >= basis * (BPS + BigInt(P.takeProfitBps))) exit = true;
          if (value * BPS <= basis * (BPS - BigInt(P.stopLossBps))) exit = true;
        }
        if (state.slot - o.openedSlot >= P.maxHoldSlots) exit = true;
        const c = coins.get(mint);
        if (c !== undefined) {
          if (state.slot - c.lastTradeSlot >= P.staleSlots) exit = true;
          if (P.exitOnCreatorSell && c.creatorSold && !o.creatorSoldAtOpen) exit = true;
        }
        if (!exit) continue;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: P.sellSlippageBps });
        selling.add(mint);
        if (c !== undefined) c.closed = true;
      }

      // --- Entries and the one second tranche, in first-seen order.
      let free = state.freeCashLamports();
      let openSlots = state.hello.caps.max_open_positions - state.committedPositionCount();
      for (const c of coins.values()) {
        if (orders.length >= cap) break;
        if (c.closed) continue;
        const age = state.slot - c.createSlot;
        const curve = state.curves.get(c.mint);
        if (curve === undefined || curve.complete) {
          if (curve?.complete) c.closed = true;
          continue;
        }
        if (c.creatorSold) {
          c.closed = true;
          continue;
        }
        if (c.spent === 0n) {
          // First buy: as early as the tape allows. A tight buy slippage
          // limit is the latency filter: if the price runs away in the two
          // slots before the fill, the order is rejected for free instead
          // of buying the top of the spike.
          if (c.buySent) continue;
          if (age > P.maxAgeSlots) {
            c.closed = true;
            continue;
          }
          if (age < P.minAgeSlots) continue;
          if (openSlots <= 0) break;
          if (c.trades < P.minTrades) continue;
          if (c.buyers.size < P.minBuyers) continue;
          if (c.boughtLamports - c.soldLamports < BigInt(P.minNetFlowLamports)) continue;
          if (c.devBuyLamports < BigInt(P.minDevBuyLamports) || c.devBuyLamports > BigInt(P.maxDevBuyLamports)) continue;
          if (curve.real_quote_reserves < BigInt(P.minRealSolLamports)) continue;
          const runup = (curve.virtual_quote_reserves * c.vt0 * BPS) / (curve.virtual_token_reserves * c.vq0);
          if (runup > BigInt(P.maxRunupBps)) continue;
          const room = state.maxBuyLamports(c.mint);
          const amount = firstBuy < room ? firstBuy : room;
          if (amount < minBuy) continue;
          if (free < amount + tx) continue;
          orders.push({ side: 'buy', mint: c.mint, quote_lamports: amount, max_slippage_bps: P.buySlippageBps });
          free -= amount + tx;
          openSlots -= 1;
          c.buySent = true;
          c.firstBuyVq = curve.virtual_quote_reserves;
          c.firstBuyVt = curve.virtual_token_reserves;
        } else if (c.spent < stake && !hasPending(state, c.mint, 'buy')) {
          // Second tranche: top the position up to the full stake once the
          // reserve has grown, while the coin is still young and has not
          // fallen below its first-buy price.
          if (age > P.maxAddAgeSlots) continue;
          if (!state.positions.has(c.mint)) continue;
          if (selling.has(c.mint)) continue;
          const vq = curve.virtual_quote_reserves;
          const vt = curve.virtual_token_reserves;
          if (vq * c.firstBuyVt < c.firstBuyVq * vt) continue;
          const room = state.maxBuyLamports(c.mint);
          const want = stake - c.spent;
          const amount = want < room ? want : room;
          if (amount < minBuy) continue;
          if (free < amount + tx) continue;
          orders.push({ side: 'buy', mint: c.mint, quote_lamports: amount, max_slippage_bps: P.buySlippageBps });
          free -= amount + tx;
          c.buySent = true;
        }
      }
      return orders;
    },
  };
}
