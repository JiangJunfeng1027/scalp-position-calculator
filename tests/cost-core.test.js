"use strict";

const assert = require("node:assert/strict");
const core = require("../cost-core.js");

function close(actual, expected, tolerance = 1e-9) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
}

function estimate(overrides = {}) {
  return core.estimate({
    bids: [[99.99, 1_000_000]],
    asks: [[100.01, 1_000_000]],
    stopPercent: 1,
    risk: 200,
    takerRate: 0.00045,
    quantityStep: "0.001",
    minQuantity: 0.001,
    maxQuantity: 1_000_000,
    minNotional: 5,
    ...overrides,
  });
}

function limitEstimate(overrides = {}) {
  return core.estimateLimitEntryMarketStop({
    bids: [[99.99, 1_000_000]],
    asks: [[100.01, 1_000_000]],
    side: "long",
    limitPrice: 99.99,
    postOnly: true,
    stopPercent: 1,
    risk: 200,
    makerRate: 0.00018,
    takerRate: 0.00036,
    quantityStep: "0.001",
    minQuantity: 0.001,
    maxQuantity: 1_000_000,
    minNotional: 5,
    ...overrides,
  });
}

// 1. Fixed risk and stop map to the expected notional.
const base = estimate();
assert.equal(base.status, "ok");
close(base.theoreticalNotional, 20_000);
close(base.actualNotional, 20_000);
assert.ok(base.actualPriceRisk <= 200);

// 2. With an effectively infinite top level, fee share stays consistent.
close(base.feeRiskPercent, 9, 1e-6);
assert.ok(base.conservativeRiskPercent >= base.directionalRiskPercent);

// 3. Symmetric books produce equal directional and conservative estimates.
close(base.conservativeCost, base.directionalCost, 1e-6);

// 4. A thin ask side makes the conservative estimate strictly larger.
const asymmetric = estimate({
  bids: [[99.99, 1_000_000]],
  asks: [[100.01, 50], [100.5, 1_000_000]],
});
assert.ok(asymmetric.conservativeCost > asymmetric.directionalCost);

// 5. Snapshot depth must never be extrapolated.
const insufficient = estimate({
  bids: [[99.99, 1]],
  asks: [[100.01, 1]],
});
assert.equal(insufficient.status, "insufficient_snapshot_depth");

const priceProtected = estimate({
  asks: [[100.01, 50], [101, 1_000_000]],
  markPrice: 100,
  marketTakeBound: 0.005,
});
assert.equal(priceProtected.status, "market_take_bound");

// 6. Market quantity limits block the result instead of silently truncating it.
const aboveMax = estimate({ maxQuantity: 100 });
assert.equal(aboveMax.status, "above_market_max");
assert.equal(estimate({ maxNotional: 10_000 }).status, "above_market_max_notional");
const roundedToMax = estimate({ risk: 100.1, quantityStep: "1", maxQuantity: 100 });
assert.equal(roundedToMax.status, "ok");
assert.equal(roundedToMax.quantity, 100);

// 7. Quantity rounds down to exchange step.
close(core.floorToStep(49_764.9, "1"), 49_764);
close(core.floorToStep(1.23459, "0.001"), 1.234);

const signature = core.bookSignature([[100, 2]], [[101, 3]]);
assert.equal(signature, core.bookSignature([[100, 2]], [[101, 3]]));
assert.notEqual(signature, core.bookSignature([[100, 2]], [[101, 4]]));

// 8. Binance product classification uses the exact TradFi enum.
close(
  core.inferBinanceTaker({ contractType: "PERPETUAL", underlyingType: "COIN" }, true).rate,
  0.00045,
);
close(
  core.inferBinanceTaker({ contractType: "TRADIFI_PERPETUAL", underlyingType: "EQUITY" }, true).rate,
  0.00036,
);
assert.equal(core.inferBinanceTaker({ contractType: "OTHER" }, true).rate, null);
const binanceFees = core.inferBinanceFees(
  { contractType: "TRADIFI_PERPETUAL", underlyingType: "EQUITY" },
  true,
);
close(binanceFees.takerRate, 0.00036);
close(binanceFees.makerRate, 0);
close(binanceFees.rate, core.inferBinanceTaker(
  { contractType: "TRADIFI_PERPETUAL", underlyingType: "EQUITY" },
  true,
).rate);

// 9. Hyperliquid Tier 0 fee inference respects asset-level growth mode and fee scale.
close(core.inferHyperliquidTaker({}, null, true).rate, 0.00045);
close(
  core.inferHyperliquidTaker({ deployerFeeScale: "1.0", growthMode: "enabled" }, null, false).rate,
  0.00009,
);
close(
  core.inferHyperliquidTaker({ deployerFeeScale: "1.0" }, null, false).rate,
  0.0009,
);
close(
  core.inferHyperliquidTaker({ deployerFeeScale: "0.5", growthMode: "enabled" }, null, false).rate,
  0.0000675,
);
const hyperliquidFees = core.inferHyperliquidFees(
  { deployerFeeScale: "1.0", growthMode: "enabled" },
  null,
  false,
);
close(hyperliquidFees.takerRate, 0.00009);
close(hyperliquidFees.makerRate, 0.00003);
close(hyperliquidFees.rate, core.inferHyperliquidTaker(
  { deployerFeeScale: "1.0", growthMode: "enabled" },
  null,
  false,
).rate);

// 10. Rolling selection returns current, median sample, and raw worst without deleting tails.
const samples = [2, 4, 3].map((value, index) => ({
  id: index,
  result: { conservativeRiskPercent: value },
}));
assert.equal(core.pickSample(samples, "current", "conservativeRiskPercent").result.conservativeRiskPercent, 3);
assert.equal(core.pickSample(samples, "median", "conservativeRiskPercent").result.conservativeRiskPercent, 3);
assert.equal(core.pickSample(samples, "worst", "conservativeRiskPercent").result.conservativeRiskPercent, 4);

const evenSamples = [1, 100].map((value, index) => ({
  id: index,
  time: index,
  result: { conservativeRiskPercent: value, conservativeCost: value },
}));
close(core.pickSample(evenSamples, "median", "conservativeRiskPercent").result.conservativeRiskPercent, 50.5);

// 11. Total stop loss uses the executable, step-rounded price risk.
const stepped = estimate({ stopPercent: 3, risk: 200, quantityStep: "1" });
close(
  stepped.totalLossConservative,
  stepped.actualPriceRisk + stepped.conservativeCost,
  1e-9,
);

// 12. A Post-only maker entry is conditional on a full fill and has no entry book cost.
const limitLong = limitEstimate();
assert.equal(limitLong.status, "ok");
assert.equal(limitLong.executionMode, "limit_maker_market_stop");
assert.equal(limitLong.conditionalOnFullFill, true);
assert.equal(limitLong.fillAssumption, "post_only_full_fill");
assert.equal(limitLong.unfilledCost, 0);
assert.equal(limitLong.unfilledQuantity, 0);
assert.equal(limitLong.entryBookCost, 0);
assert.equal(limitLong.stopBookSide, "bid");
assert.ok(limitLong.actualPriceRisk <= 200);
assert.ok(Number.isFinite(limitLong.spreadBp));
assert.ok(Number.isFinite(limitLong.limitDistanceFromMidPercent));
assert.ok(Number.isFinite(limitLong.buySlipBp));
assert.ok(Number.isFinite(limitLong.sellSlipBp));
assert.equal(limitLong.stopSweep, limitLong.sell);
close(
  limitLong.totalLossConditional,
  limitLong.actualPriceRisk + limitLong.conditionalTotalCost,
  1e-9,
);
close(limitLong.conditionalTotalLoss, limitLong.totalLossConditional, 1e-12);
close(limitLong.feeRiskPercent, limitLong.feeCost / 200 * 100, 1e-9);

// 13. The single market-stop leg uses only the directionally relevant side.
const thinUnusedAsk = limitEstimate({
  asks: [[100.01, 0.001], [150, 1_000_000]],
});
assert.equal(thinUnusedAsk.status, "ok");
close(thinUnusedAsk.stopSlipCost, limitLong.stopSlipCost, 1e-9);
assert.equal(limitEstimate({ bids: [[99.99, 1]] }).status, "insufficient_stop_depth");

const limitShort = limitEstimate({
  side: "short",
  limitPrice: 100.01,
});
assert.equal(limitShort.status, "ok");
assert.equal(limitShort.stopBookSide, "ask");
assert.equal(limitShort.stopSweep, limitShort.buy);
const thinUnusedBid = limitEstimate({
  side: "short",
  limitPrice: 100.01,
  bids: [[99.99, 0.001], [50, 1_000_000]],
});
assert.equal(thinUnusedBid.status, "ok");
close(thinUnusedBid.stopSlipCost, limitShort.stopSlipCost, 1e-9);
assert.equal(limitEstimate({
  side: "short",
  limitPrice: 100.01,
  asks: [[100.01, 1]],
}).status, "insufficient_stop_depth");

// 14. Stop slippage includes one half-spread/impact proxy, never a duplicated round trip.
const expectedLongBookSlip = limitLong.quantity * limitLong.stopReferencePrice * 0.0001;
close(limitLong.stopBookSlipCost, expectedLongBookSlip, 1e-8);
close(limitLong.stopSlipCost, limitLong.stopBookSlipCost, 1e-12);
close(limitLong.entryFeeOrRebate, limitLong.actualNotional * 0.00018, 1e-9);
close(
  limitLong.stopTakerFeeCost,
  limitLong.quantity * limitLong.stopProxyPrice * 0.00036,
  1e-9,
);
close(
  limitLong.conditionalRiskPercent,
  limitLong.conditionalTotalCost / 200 * 100,
  1e-9,
);

// 15. Maker rebates are negative costs and reduce the conditional total exactly.
const makerRebate = limitEstimate({ makerRate: -0.0001 });
assert.equal(makerRebate.status, "ok");
assert.ok(makerRebate.entryFeeOrRebate < 0);
close(
  limitLong.conditionalTotalCost - makerRebate.conditionalTotalCost,
  limitLong.actualNotional * (0.00018 + 0.0001),
  1e-8,
);

// 16. Post-only, crossing, tick, quantity and notional boundaries fail closed.
assert.equal(limitEstimate({ postOnly: false }).status, "post_only_required");
assert.equal(limitEstimate({ limitPrice: 100.01 }).status, "would_take_liquidity");
assert.equal(limitEstimate({
  side: "short",
  limitPrice: 99.99,
}).status, "would_take_liquidity");
assert.equal(limitEstimate({ priceTick: "0.05" }).status, "invalid_limit_tick");
assert.equal(limitEstimate({ maxQuantity: 200 }).status, "above_market_max");
assert.equal(limitEstimate({ maxNotional: 10_000 }).status, "above_market_max_notional");
assert.equal(limitEstimate({ minNotional: 30_000 }).status, "below_min_notional");
assert.equal(limitEstimate({ stopPercent: 100 }).status, "invalid_stop_price");

// 17. A coarse stop-depth book may be paired with a raw entry BBO without
// moving the Post-only entry price or its crossing test.
const referencedEntryBook = limitEstimate({
  bids: [[99.9, 1_000_000]],
  asks: [[100.1, 1_000_000]],
  entryBids: [[99.99, 1_000_000]],
  entryAsks: [[100.01, 1_000_000]],
});
assert.equal(referencedEntryBook.status, "ok");
close(referencedEntryBook.bestBid, 99.99);
close(referencedEntryBook.bestAsk, 100.01);
close(referencedEntryBook.mid, 100);
close(referencedEntryBook.bookMid, 100);
assert.ok(referencedEntryBook.stopSlipCost > limitLong.stopSlipCost);
assert.equal(limitEstimate({
  bids: [[99.9, 1_000_000]],
  asks: [[100.1, 1_000_000]],
  entryBids: [[99.99, 1_000_000]],
  entryAsks: [[100.01, 1_000_000]],
  limitPrice: 100.01,
}).status, "would_take_liquidity");

// 18. Extra gap stress is charged once and price protection checks the worst stop level.
const gapStress = limitEstimate({ extraGapBp: 10 });
assert.equal(gapStress.status, "ok");
assert.ok(gapStress.stopGapCost > 0);
close(
  gapStress.stopSlipCost,
  gapStress.stopBookSlipCost + gapStress.stopGapCost,
  1e-9,
);
assert.equal(limitEstimate({ marketTakeBound: 0.00005 }).status, "market_take_bound");
assert.equal(limitEstimate({ marketTakeBound: null }).status, "ok");

// 19. Queue visibility is informational only and never changes the full-fill assumption.
const queued = limitEstimate({
  bids: [[100, 5], [99.99, 7], [99.98, 1_000_000]],
  asks: [[100.01, 1_000_000]],
});
assert.equal(queued.status, "ok");
close(queued.entryVisibleQueueAheadQuantity, 12);
assert.equal(queued.conditionalOnFullFill, true);
close(makerRebate.entryMakerRebate, -makerRebate.entryFeeOrRebate);
close(makerRebate.entryMakerFeeCost, 0);
close(limitLong.stopNotional, limitLong.quantity * limitLong.stopProxyPrice);

console.log("cost-core: market and limit-entry checks passed");
