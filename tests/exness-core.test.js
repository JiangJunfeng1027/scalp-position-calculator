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
console.log("Exness cost tests passed (5 symbols, account commissions, rounding, invalid inputs).");

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
console.log("Exness ratio tests passed (risk budget, money values, units, redline, unknown baselines, invalid inputs).");
