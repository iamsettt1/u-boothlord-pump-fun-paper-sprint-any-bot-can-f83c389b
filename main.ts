// Selective early scalper for Pump.fun Paper Sprint: Any Bot Can Win.
// Run by the grader as `node /bot/main.ts`. The strategy lives in
// strategy.ts; the protocol shim is the kit's sdk/ts/makefun-bot.ts,
// vendored byte for byte in vendor/.
//
// What it does: buys a young coin once for 0.05 SOL, only when the early
// tape looks like a genuine launch (real SOL 1-2.9, 2+ trades from 2+
// distinct buyers, net buying, creator holding, creator's own buy a
// moderate 0.3-2.5 SOL), then exits at +15% take-profit, -8% stop-loss,
// a 400-slot time cap, 300 slots of staleness, or a creator sale. Tight
// buy/sell slippage limits reject fills that moved against it in the
// 2-slot latency. See strategy.ts for the measured reasoning.

import { runBot } from './vendor/makefun-bot.ts';
import { createRider, DEFAULT_PARAMS } from './strategy.ts';

// One strategy instance for the whole run (state lives in the closure).
const rider = createRider(DEFAULT_PARAMS);

await runBot({
  onBatch: (state, batch) => rider.onBatch(state, batch),
});
