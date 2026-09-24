"use strict";
const assert = require("node:assert/strict");
const core = require("../exness-core.js");
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-7, `${a} != ${b}`);
const base = { symbol: "BTCUSD", bid: 79995, ask: 80005, risk: 500, stopPercent: 0.5,
  commission: 4, rebate: 0, slippage: 0, step: "0.01", maxLots: 200 };
const btc = core.estimate(base);
near(btc.lots, 1.25); near(btc.notional, 100000);
near(btc.spreadCost, 12.5); near(btc.feeCost, 5); near(btc.cost, 17.5);
near(btc.riskPercent, 3.5); near(btc.totalLoss, 517.5);
// Spread counted once, commission already contains both sides; rebate per completed lot.
const rebated = core.estimate({ ...base, rebate: 1.75, slippage: 2 });
near(rebated.rebateValue, 2.1875); near(rebated.slipCost, 2.5); near(rebated.cost, 17.8125);
const gold = core.estimate({ ...base, symbol: "XAUUSD", bid: 3999.955, ask: 4000.045, commission: 7, rebate: 1.35 });
near(gold.lots, 0.25); near(gold.cost, 3.6625);
// Different metal multiplier; Zero silver commission is large, not copied from gold.
near(core.commission(core.markets.find(m => m.id === "XAGUSD"), "zero"), 100);
const silver = core.estimate({ ...base, symbol: "XAGUSD", bid: 39.99, ask: 40.01, commission: 7, maxLots: 20 });
near(silver.lots, 0.5); near(silver.spreadCost, 50); near(silver.feeCost, 3.5);
const eth = core.estimate({ ...base, symbol: "ETHUSD", bid: 3999.5, ask: 4000.5, commission: 0.5, maxLots: 2000 });
near(eth.lots, 25); near(eth.cost, 37.5);
const nas = core.estimate({ ...base, symbol: "USTEC", bid: 24999.5, ask: 25000.5, commission: 0.625 });
near(nas.lots, 4); near(nas.cost, 6.5);
const oilMarket = core.markets.find(m => m.id === "USOIL");
near(oilMarket.multiplier, 1000);
near(core.commission(oilMarket, "raw"), 7);
near(core.commission(oilMarket, "zero"), 12.5);
const oil = core.estimate({ ...base, symbol: "USOIL", bid: 79.99, ask: 80.01, commission: 7 });
near(oil.lots, 1.25); near(oil.spreadCost, 25); near(oil.feeCost, 8.75); near(oil.cost, 33.75);
for (const symbol of core.markets) {
  near(core.commission(symbol, "standard"), 0);
  near(core.commission(symbol, "pro"), 0);
  assert.ok(core.commission(symbol, "raw") > 0);
}
assert.throws(() => core.estimate({ ...base, symbol: "ETHUSD", risk: 1 }), /最小/);
assert.throws(() => core.estimate({ ...base, risk: 1000000 }), /上限/);
assert.throws(() => core.estimate({ ...base, bid: 80006 }), /填反/);
assert.throws(() => core.estimate({ ...base, rebate: 100 }), /返佣超过/);
for (const key of ["bid", "ask", "risk", "stopPercent", "commission", "rebate", "slippage", "step", "maxLots"]) {
  for (const value of ["", null, -1, NaN, Infinity]) assert.throws(() => core.estimate({ ...base, [key]: value }));
}
near(core.estimate({ ...base, ask: 79995 }).spreadCost, 0);
// Rounding never increases the requested price risk.
for (let risk = 37; risk < 999; risk += 17) {
  const r = core.estimate({ ...base, risk });
  assert.ok(r.priceRisk <= risk + 1e-8);
}
console.log("Exness cost tests passed (6 symbols, account commissions, rounding, invalid inputs).");

// Budget scales money values while bp / stop-percent stays percent of R.
const ratioBase = { risk: 200, baseBp: 0.4, stopPercent: 0.2, slipBp: 0, rebateBp: 0, redline: 5 };
const ratio = core.estimateRatio(ratioBase);
near(ratio.riskPercent, 2); near(ratio.totalLossR, 1.02);
near(ratio.notional, 100000); near(ratio.cost, 4); near(ratio.totalLoss, 204);
const largerBudget = core.estimateRatio({ ...ratioBase, risk: 500 });
near(largerBudget.notional, 250000); near(largerBudget.cost, 10); near(largerBudget.totalLoss, 510);
near(largerBudget.riskPercent, ratio.riskPercent);
near(ratio.costPer100Risk, 2); near(ratio.costPer100k, 4); near(ratio.minStopPercent, 0.08);
near(core.estimateRatio({ ...ratioBase, baseBp: 1 }).riskPercent, 5);
near(core.estimateRatio({ ...ratioBase, stopPercent: 0.4 }).riskPercent, 1);
near(core.estimateRatio({ ...ratioBase, slipBp: 0.1, rebateBp: 0.05 }).riskPercent, 2.25);
near(core.estimateRatio({ ...ratioBase, baseBp: 0 }).riskPercent, 0);
assert.throws(() => core.estimateRatio({ ...ratioBase, rebateBp: 0.5 }), /返佣/);
for (const key of Object.keys(ratioBase)) {
  for (const value of ["", null, -1, NaN, Infinity]) assert.throws(() => core.estimateRatio({ ...ratioBase, [key]: value }));
}
for (const stopPercent of [0, 100, 200]) assert.throws(() => core.estimateRatio({ ...ratioBase, stopPercent }));
assert.throws(() => core.estimateRatio({ ...ratioBase, risk: 0 }), /风险预算/);
assert.throws(() => core.estimateRatio({ ...ratioBase, risk: Number.MAX_VALUE }), /数值过大/);
assert.throws(() => core.estimateRatio({ ...ratioBase, stopPercent: Number.MIN_VALUE }), /止损距离过小/);
assert.equal(core.referenceBp.raw.ETHUSD, undefined);
assert.equal(core.referenceBp.raw.XAGUSD, undefined);
assert.equal(core.referenceBp.raw.USTEC, undefined);
assert.equal(core.referenceBp.raw.USOIL, undefined);
console.log("Exness ratio tests passed (risk budget, money values, units, redline, unknown baselines, invalid inputs).");

const proxyBase = { symbol: "BTCUSD", account: "raw", risk: 200, stopPercent: 0.2,
  redline: 5, baseBp: 0.4, slipBp: 0, rebateBp: 0, proxyMultiplier: 1,
  bids: [[79999, 1.5], [79998, 10]], asks: [[80001, 1.5], [80003, 10]] };
const smallProxy = core.estimateProxy(proxyBase);
near(smallProxy.notional, 100000); near(smallProxy.proxyQuantity, 1.25);
near(smallProxy.baseCost, 4); near(smallProxy.impactCost, 0);
near(smallProxy.riskPercent, 2); near(smallProxy.totalLoss, 204);
near(smallProxy.totalLossR, 1.02); near(smallProxy.estimatedLots, 1.25);
assert.equal(smallProxy.status, "ok"); assert.equal(smallProxy.baselineMode, "configured");
assert.equal(smallProxy.buy.levelsUsed, 1); assert.equal(smallProxy.sell.levelsUsed, 1);
assert.equal(smallProxy.minStopPercent, undefined); // Impact cannot be inverted as a fixed fee rate.
// Larger budgets only change the ratio once they reach a worse price level.
const largeProxy = core.estimateProxy({ ...proxyBase, risk: 500 });
near(largeProxy.proxyQuantity, 3.125); near(largeProxy.buyImpactCost, 3.25);
near(largeProxy.sellImpactCost, 1.625); near(largeProxy.impactCost, 6.5);
near(largeProxy.baseCost, 10); near(largeProxy.cost, 16.5); near(largeProxy.riskPercent, 3.3);
assert.ok(largeProxy.riskPercent > smallProxy.riskPercent);
assert.equal(largeProxy.buy.levelsUsed, 2); assert.equal(largeProxy.sell.levelsUsed, 2);
const deepTop = { ...proxyBase, bids: [[79999, 100]], asks: [[80001, 100]] };
near(core.estimateProxy(deepTop).riskPercent, core.estimateProxy({ ...deepTop, risk: 500 }).riskPercent);
near(core.estimateProxy({ ...proxyBase, risk: 500, method: "directional" }).cost, 14.875);
// Supplied complete fee replaces spread AND Exness commission. Other venues'
// fees must never enter this approximation, even if supplied accidentally.
near(largeProxy.referenceSpreadCost, 0); near(largeProxy.exnessCommissionCost, 0);
near(core.estimateProxy({ ...proxyBase, takerRate: 1, makerRate: 1 }).cost, smallProxy.cost);
near(core.estimateProxy({ ...proxyBase, account: "zero" }).cost, smallProxy.cost);
const zeroConfigured = core.estimateProxy({ ...deepTop, baseBp: 0 });
near(zeroConfigured.baseCost, 0); near(zeroConfigured.cost, 0);
assert.equal(zeroConfigured.baselineMode, "configured");
// Equal USD notional is invariant when an identical book is represented as
// underlying units versus reference contracts/lots (especially gold/silver).
for (const [symbol, mid, multiplier] of [
  ["BTCUSD", 80000, 1], ["ETHUSD", 4000, 1], ["XAUUSD", 4000, 100],
  ["XAGUSD", 40, 5000], ["USTEC", 25000, 1], ["USTEC", 25000, 10],
  ["USOIL", 80, 1000], ["USOIL", 80, 100],
]) {
  const units = 100000 / mid;
  const spread = mid / 100000;
  const book = { bids: [[mid - spread, units / 2], [mid - 2 * spread, units * 5]],
    asks: [[mid + spread, units / 2], [mid + 3 * spread, units * 5]] };
  const unitResult = core.estimateProxy({ ...proxyBase, ...book, symbol });
  const lotResult = core.estimateProxy({ ...proxyBase, symbol, proxyMultiplier: multiplier,
    bids: book.bids.map(([px, qty]) => [px, qty / multiplier]),
    asks: book.asks.map(([px, qty]) => [px, qty / multiplier]) });
  near(unitResult.cost, lotResult.cost); near(lotResult.proxyQuantity, units / multiplier);
  near(lotResult.estimatedLots, units / core.markets.find(m => m.id === symbol).multiplier);
  near(lotResult.impactCost, 2); near(lotResult.riskPercent, 3);
}
// Empty fee basis uses the proxy's one spread plus Exness round-trip commission,
// clearly marked as a different approximation; it never claims an Exness quote.
const fallbackBase = { ...proxyBase, symbol: "XAUUSD", baseBp: "", proxyMultiplier: 100,
  bids: [[3999.95, 5]], asks: [[4000.05, 5]] };
const fallback = core.estimateProxy(fallbackBase);
assert.equal(fallback.baselineMode, "proxy-spread");
near(fallback.referenceSpreadCost, 2.5); near(fallback.exnessCommissionCost, 1.75);
near(fallback.baseCost, 4.25); near(fallback.baseBp, 0.425); near(fallback.cost, 4.25);
for (const baseBp of [null, undefined, " "]) near(core.estimateProxy({ ...fallbackBase, baseBp }).cost, 4.25);
near(core.estimateProxy({ ...fallbackBase, account: "pro" }).cost, 2.5);
near(core.estimateProxy({ ...fallbackBase, account: "zero" }).exnessCommissionCost, 2.75);
near(core.estimateProxy({ ...fallbackBase, bids: [[4000, 5]], asks: [[4000, 5]] }).cost, 1.75);
// WTI: both books use 1,000 barrels/lot, but fees stay with Exness.
const oilProxyBase = { ...proxyBase, symbol: "USOIL", baseBp: "", proxyMultiplier: 1000,
  bids: [[79.99, 10]], asks: [[80.01, 10]] };
const oilProxy = core.estimateProxy(oilProxyBase);
near(oilProxy.estimatedLots, 1.25); near(oilProxy.proxyQuantity, 1.25);
near(oilProxy.referenceSpreadCost, 25); near(oilProxy.exnessCommissionCost, 8.75);
near(oilProxy.cost, 33.75); near(oilProxy.riskPercent, 16.875);
near(core.estimateProxy({ ...oilProxyBase, account: "zero" }).exnessCommissionCost, 15.625);
near(core.estimateProxy({ ...oilProxyBase, account: "pro" }).cost, 25);
near(core.estimateProxy({ ...oilProxyBase, baseBp: 0.4 }).cost, 4);
for (const [stopPercent, zone] of [[0.5, "good"], [0.25, "warn"]]) {
  const atThreshold = core.estimateProxy({ ...oilProxyBase, risk: 500, stopPercent, account: "pro" });
  assert.equal(require("../cost-core.js").costRiskZone(atThreshold.riskPercent), zone);
}
const rebates = core.estimateProxy({ ...proxyBase, risk: 500, slipBp: 0.2, rebateBp: 0.1 });
near(rebates.extraSlipCost, 5); near(rebates.rebateValue, 2.5); near(rebates.cost, 19);
near(core.estimateProxy({ ...proxyBase, risk: 500, rebateBp: 0.4 }).cost, largeProxy.impactCost);
assert.throws(() => core.estimateProxy({ ...proxyBase, risk: 500, rebateBp: 0.41 }), /不能抵消扫档/);
assert.throws(() => core.estimateProxy({ ...fallbackBase, rebateBp: 0.5 }), /返佣/);
assert.throws(() => core.estimateProxy({ ...proxyBase, risk: 1e6 }), /深度不足/);
assert.throws(() => core.estimateProxy({ ...proxyBase, bids: [[80002, 100]] }), /倒挂/);
assert.throws(() => core.estimateProxy({ ...proxyBase, bids: [[79999, 1], [80000, 1]] }), /排序/);
assert.throws(() => core.estimateProxy({ ...proxyBase, asks: [[80003, 1], [80002, 1]] }), /排序/);
for (const side of ["bids", "asks"]) {
  for (const levels of [[], null, [[80000, 0]], [[80000, null]], [[80000, ""]],
    [[80000, -1]], [[80000, NaN]], [[80000, Infinity]], [[80000, true]],
    [[0, 100]], [[null, 100]], [["", 100]], [null], [{}]]) {
    assert.throws(() => core.estimateProxy({ ...proxyBase, [side]: levels }), /盘/);
  }
}
for (const key of ["risk", "stopPercent", "redline", "proxyMultiplier", "slipBp", "rebateBp"]) {
  for (const value of [null, undefined, "", -1, NaN, Infinity]) {
    assert.throws(() => core.estimateProxy({ ...proxyBase, [key]: value }));
  }
}
for (const key of ["risk", "stopPercent", "redline", "proxyMultiplier"]) {
  assert.throws(() => core.estimateProxy({ ...proxyBase, [key]: 0 }));
}
for (const baseBp of [-1, NaN, Infinity]) assert.throws(() => core.estimateProxy({ ...proxyBase, baseBp }));
assert.throws(() => core.estimateProxy({ ...proxyBase, stopPercent: 100 }), /止损/);
assert.throws(() => core.estimateProxy({ ...proxyBase, redline: 11 }), /红线/);
assert.throws(() => core.estimateProxy({ ...proxyBase, account: "unknown" }), /账户/);
assert.throws(() => core.estimateProxy({ ...proxyBase, method: "unknown" }), /方式/);
assert.throws(() => core.estimateProxy({ ...proxyBase, symbol: "unknown" }), /标的/);
assert.throws(() => core.estimateProxy({ ...proxyBase, risk: Number.MAX_VALUE }), /数值过大/);
assert.throws(() => core.estimateProxy({ ...proxyBase, stopPercent: Number.MIN_VALUE }), /止损距离过小/);
// No fictitious lot rounding/capacity constraint; the proxy scenario uses the
// exact requested notional, with the live book itself as the only size bound.
const tinyProxy = core.estimateProxy({ ...deepTop, risk: 0.2 });
near(tinyProxy.notional, 100); near(tinyProxy.estimatedLots, 0.00125);
const objectBook = core.estimateProxy({ ...deepTop,
  bids: [{ px: 79999, sz: 100 }], asks: [{ px: 80001, sz: 100 }] });
near(objectBook.cost, smallProxy.cost);
console.log("Exness proxy tests passed (size-dependent impact, equal-notional contract units, no double fees, fallback, invalid books).");
