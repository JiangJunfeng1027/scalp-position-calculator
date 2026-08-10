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

// Bybit tsE3 is a UTC+2/+3 server wall clock, but its DST dates are not an
// IANA timezone. The receive timestamp must select the non-future candidate.
const marchReceive = Date.UTC(2026, 2, 15, 12, 0, 0);
close(core.resolveBybitServerWallTime(marchReceive + 3 * 60 * 60 * 1000, marchReceive), marchReceive);
const octoberReceive = Date.UTC(2026, 9, 30, 12, 0, 0);
close(core.resolveBybitServerWallTime(octoberReceive + 3 * 60 * 60 * 1000, octoberReceive), octoberReceive);
const winterReceive = Date.UTC(2026, 11, 15, 12, 0, 0);
close(core.resolveBybitServerWallTime(winterReceive + 2 * 60 * 60 * 1000, winterReceive), winterReceive);
const staleSummerQuote = Date.UTC(2026, 7, 8, 12, 0, 0);
const staleSummerReceive = staleSummerQuote + 60 * 60 * 1000 + 5_000;
close(
  core.resolveBybitServerWallTime(staleSummerQuote + 3 * 60 * 60 * 1000, staleSummerReceive),
  staleSummerQuote,
);
assert.equal(staleSummerReceive - staleSummerQuote, 3_605_000);
const repeatedHourRaw = Date.UTC(2026, 10, 1, 4, 30, 0);
assert.throws(
  () => core.resolveBybitServerWallTime(repeatedHourRaw, Date.UTC(2026, 10, 1, 2, 30, 1)),
  /重叠区间/,
);
assert.throws(
  () => core.resolveBybitServerWallTime(winterReceive + 4 * 60 * 60 * 1000, winterReceive),
  /晚于接收时间/,
);

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

// 20. Bybit XAU lots convert through the 100 oz contract multiplier, while
// the fixed USD 6/lot commission is charged once for the complete round trip.
assert.deepEqual(
  estimate(),
  estimate({ contractMultiplier: 1, fixedRoundTripCommissionPerQuantity: 0 }),
);
const xauMarket = core.estimate({
  bids: [[4341.3, 100]],
  asks: [[4341.5, 100]],
  stopPercent: 0.2,
  risk: 200,
  takerRate: 0,
  fixedRoundTripCommissionPerQuantity: 6,
  contractMultiplier: 100,
  quantityStep: "0.01",
  minQuantity: 0.01,
  maxQuantity: 100,
});
assert.equal(xauMarket.status, "ok");
close(xauMarket.quantity, 0.23);
close(xauMarket.contractMultiplier, 100);
close(xauMarket.actualNotional, 99_852.2, 1e-8);
close(xauMarket.actualPriceRisk, 199.7044, 1e-8);
close(xauMarket.proportionalFeeCost, 0);
close(xauMarket.fixedCommissionCost, 1.38, 1e-12);
close(xauMarket.feeCost, 1.38, 1e-12);
close(xauMarket.spreadCost, 4.6, 1e-9);
close(xauMarket.directionalBookCost, 4.6, 1e-9);
close(xauMarket.directionalCost, 5.98, 1e-9);
close(xauMarket.directionalRiskPercent, 2.99, 1e-9);
close(xauMarket.buy.totalVisibleNotional, 43_415_000, 1e-6);
close(xauMarket.sell.totalVisibleNotional, 43_413_000, 1e-6);

// 21. XAG uses 5,000 oz/lot; its lot rounding and visible notional must use
// the same multiplier as position, spread, and risk calculations.
const xagMarket = core.estimate({
  bids: [[63.522, 20]],
  asks: [[63.578, 20]],
  stopPercent: 1,
  risk: 200,
  takerRate: 0,
  fixedRoundTripCommissionPerQuantity: 6,
  contractMultiplier: 5000,
  quantityStep: "0.01",
  minQuantity: 0.01,
  maxQuantity: 20,
});
assert.equal(xagMarket.status, "ok");
close(xagMarket.quantity, 0.06);
close(xagMarket.actualNotional, 19_065, 1e-9);
close(xagMarket.actualPriceRisk, 190.65, 1e-9);
close(xagMarket.fixedCommissionCost, 0.36, 1e-12);
close(xagMarket.proportionalFeeCost, 0);
close(xagMarket.spreadCost, 16.8, 1e-9);
close(xagMarket.directionalCost, 17.16, 1e-9);
close(xagMarket.directionalRiskPercent, 8.58, 1e-9);

// 22. The existing Post-only limit model keeps its semantics, but all
// notional, stop, queue, and fixed-commission fields understand lot contracts.
const xauLimit = core.estimateLimitEntryMarketStop({
  bids: [[4341.3, 100]],
  asks: [[4341.5, 100]],
  side: "long",
  limitPrice: 4341.3,
  postOnly: true,
  stopPercent: 0.2,
  risk: 200,
  makerRate: 0,
  takerRate: 0,
  fixedRoundTripCommissionPerQuantity: 6,
  contractMultiplier: 100,
  quantityStep: "0.01",
  minQuantity: 0.01,
  maxQuantity: 100,
  priceTick: "0.01",
});
assert.equal(xauLimit.status, "ok");
assert.equal(xauLimit.executionMode, "limit_maker_market_stop");
assert.equal(xauLimit.fillAssumption, "post_only_full_fill");
close(xauLimit.quantity, 0.23);
close(xauLimit.actualNotional, 99_849.9, 1e-8);
close(xauLimit.fixedCommissionCost, 1.38, 1e-12);
close(xauLimit.proportionalFeeCost, 0);
close(xauLimit.feeCost, 1.38, 1e-12);
close(xauLimit.stopNotional, xauLimit.quantity * 100 * xauLimit.stopProxyPrice, 1e-8);
close(xauLimit.entryVisibleQueueAheadNotional, 100 * 100 * 4341.3, 1e-6);
close(xauLimit.buy.totalVisibleNotional, 43_415_000, 1e-6);

// 23. Fixed and proportional fees remain separately auditable, and invalid
// contract/commission inputs fail closed.
const xauHybridFees = core.estimate({
  bids: [[4341.3, 100]],
  asks: [[4341.5, 100]],
  stopPercent: 0.2,
  risk: 200,
  takerRate: 0.0001,
  fixedRoundTripCommissionPerQuantity: 6,
  contractMultiplier: 100,
  quantityStep: "0.01",
  minQuantity: 0.01,
  maxQuantity: 100,
});
close(
  xauHybridFees.feeCost,
  xauHybridFees.fixedCommissionCost + xauHybridFees.proportionalFeeCost,
  1e-12,
);
assert.throws(() => estimate({ contractMultiplier: 0 }), /合约乘数/);
assert.throws(
  () => estimate({ fixedRoundTripCommissionPerQuantity: -1 }),
  /完整往返固定佣金/,
);

// 24. Bybit forex CFD lots use 100,000 base units and the same single
// complete-trade commission model as metals.
const eurusdMarket = core.estimate({
  bids: [[1.15524, 100]],
  asks: [[1.15526, 100]],
  stopPercent: 0.2,
  risk: 200,
  takerRate: 0,
  fixedRoundTripCommissionPerQuantity: 6,
  contractMultiplier: 100000,
  quantityStep: "0.01",
  minQuantity: 0.01,
  maxQuantity: 100,
});
assert.equal(eurusdMarket.status, "ok");
close(eurusdMarket.quantity, 0.86);
close(eurusdMarket.actualNotional, 99_351.5, 1e-8);
close(eurusdMarket.actualPriceRisk, 198.703, 1e-8);
close(eurusdMarket.fixedCommissionCost, 5.16, 1e-12);
close(eurusdMarket.spreadCost, 1.72, 1e-9);
close(eurusdMarket.directionalCost, 6.88, 1e-9);

// 25. CME futures retain integer contracts, contract multipliers, tick
// friction and one complete-round-trip commission per contract.
const mesScenario = core.estimate({
  bids: [[7749.75, 1_000_000]],
  asks: [[7750.25, 1_000_000]],
  stopPercent: 0.1,
  risk: 500,
  takerRate: 0,
  fixedRoundTripCommissionPerQuantity: 1.9,
  contractMultiplier: 5,
  quantityStep: "1",
  minQuantity: 1,
});
assert.equal(mesScenario.status, "ok");
close(mesScenario.quantity, 12);
close(mesScenario.actualNotional, 465_000, 1e-8);
close(mesScenario.actualPriceRisk, 465, 1e-8);
close(mesScenario.fixedCommissionCost, 22.8, 1e-12);
close(mesScenario.directionalBookCost, 30, 1e-9);
close(mesScenario.directionalCost, 52.8, 1e-9);

// 26. IBKR's current micro-futures schedule is $0.25 execution + $0.35
// exchange + $0.01 regulatory per side, or $1.22 per complete round trip.
const ibkrMesScenario = core.estimate({
  bids: [[7749.75, 1_000_000]],
  asks: [[7750.25, 1_000_000]],
  stopPercent: 0.1,
  risk: 500,
  takerRate: 0,
  fixedRoundTripCommissionPerQuantity: 1.22,
  contractMultiplier: 5,
  quantityStep: "1",
  minQuantity: 1,
});
assert.equal(ibkrMesScenario.status, "ok");
close(ibkrMesScenario.quantity, 12);
close(ibkrMesScenario.fixedCommissionCost, 14.64, 1e-12);
close(ibkrMesScenario.directionalCost, 44.64, 1e-9);

// 27. LP indicative CFD feeds may publish a locked zero-spread BBO. It is
// valid only when the adapter opts in; a genuinely crossed book still fails.
const lockedIndicative = core.estimate({
  bids: [[1.35, 100]],
  asks: [[1.35, 100]],
  stopPercent: 1,
  risk: 200,
  takerRate: 0,
  fixedRoundTripCommissionPerQuantity: 6,
  contractMultiplier: 100000,
  quantityStep: "0.01",
  minQuantity: 0.01,
  allowLockedBook: true,
});
assert.equal(lockedIndicative.status, "ok");
close(lockedIndicative.spreadCost, 0, 1e-12);
assert.throws(
  () => core.estimate({
    bids: [[1.35001, 100]],
    asks: [[1.35, 100]],
    stopPercent: 1,
    risk: 200,
    takerRate: 0,
    contractMultiplier: 100000,
    allowLockedBook: true,
  }),
  /盘口交叉或倒挂/,
);

console.log("cost-core: market and limit-entry checks passed");
