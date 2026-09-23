(function (root, factory) {
  const api = factory(typeof module === "object" && module.exports ? require("./cost-core.js") : root.CostCore);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.ExnessCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (core) {
  "use strict";

  const checkedAt = "2026-09-23";
  const accounts = { raw: "Raw Spread 裸点", pro: "Pro 先锋", standard: "Standard 标准", zero: "Zero 零点" };
  // Official commission values are per lot PER SIDE; store round-trip here.
  const markets = [
    { id: "BTCUSD", name: "比特币", multiplier: 1, unit: "BTC", min: 0.01, max: 200, raw: 4, zero: 8.75 },
    { id: "ETHUSD", name: "以太坊", multiplier: 1, unit: "ETH", min: 0.1, max: 2000, raw: 0.5, zero: 1 },
    { id: "XAUUSD", name: "黄金", multiplier: 100, unit: "盎司", min: 0.01, max: 200, raw: 7, zero: 11 },
    { id: "XAGUSD", name: "白银", multiplier: 5000, unit: "盎司", min: 0.01, max: 20, raw: 7, zero: 100 },
    { id: "USTEC", name: "纳斯达克100", multiplier: 1, unit: "美元/点", min: 0.05, max: 200, raw: 0.625, zero: 1.25 },
  ].map(m => ({ ...m, bookSymbol: m.id, display: `${m.id} · ${m.name}`, step: "0.01" }));

  function commission(market, account) {
    if (!Object.hasOwn(accounts, account)) throw new Error("账户类型无效");
    return ["standard", "pro"].includes(account) ? 0 : market[account];
  }

  function estimate(c) {
    const read = (key, label, positive = false) => {
      if (c[key] === null || c[key] === undefined || String(c[key]).trim() === "") throw new Error(`请填写${label}`);
      const n = Number(c[key]);
      if (!Number.isFinite(n) || (positive ? n <= 0 : n < 0)) throw new Error(`${label}必须${positive ? "大于" : "不小于"}0`);
      return n;
    };
    const market = markets.find(m => m.id === c.symbol);
    if (!market) throw new Error("Exness标的无效");
    const bid = read("bid", "卖出价", true), ask = read("ask", "买入价", true);
    if (ask < bid) throw new Error("买入价不能低于卖出价，请检查是否填反");
    const risk = read("risk", "价格风险", true), stop = read("stopPercent", "止损距离", true) / 100;
    if (stop >= 1) throw new Error("止损距离须小于100%");
    const fee = read("commission", "每手往返佣金"), rebate = read("rebate", "每手往返返佣");
    const slip = read("slippage", "额外往返滑点"), step = read("step", "手数步进", true);
    const max = read("maxLots", "单笔手数上限", true);
    if (max < market.min) throw new Error("单笔手数上限不能小于最小手数");
    const mid = (bid + ask) / 2;
    const theoreticalNotional = risk / stop;
    const lots = core.floorToStep(theoreticalNotional / mid / market.multiplier, step);
    if (lots < market.min - 1e-10) throw new Error(`仓位低于最小${market.min}手，请调整风险或止损`);
    if (lots > max + 1e-10) throw new Error(`需要${lots}手，超过所设单笔${max}手上限；不会自动截仓`);
    const units = lots * market.multiplier;
    const notional = units * mid;
    const spreadCost = (ask - bid) * units;
    const feeCost = fee * lots, rebateValue = rebate * lots, slipCost = slip * units;
    if (rebateValue > spreadCost + feeCost + 1e-8) throw new Error("返佣超过点差与佣金合计，请复核每手完整往返口径");
    const gross = spreadCost + feeCost + slipCost;
    const cost = gross - rebateValue;
    const priceRisk = notional * stop;
    return { lots, units, mid, notional, spread: ask - bid, spreadCost, feeCost, rebateValue, slipCost,
      gross, cost, priceRisk, risk, totalLoss: priceRisk + cost, riskPercent: cost / risk * 100,
      grossRiskPercent: gross / risk * 100, costBp: cost / notional * 10000 };
  }
  // Historical discussion scenarios, NOT current quotes or verified account rebates.
  // At BTC 80,000 and gold 4,000 USD, per-100,000 USD gross costs were:
  // Raw 8.4375 / 4 USD; Pro 8.75 / 4.55 USD; Standard 12.5 / 6.5 USD.
  // No baseline is invented for the other instruments or Zero accounts.
  const referenceBp = {
    raw: { BTCUSD: 0.84375, XAUUSD: 0.4 },
    pro: { BTCUSD: 0.875, XAUUSD: 0.455 },
    standard: { BTCUSD: 1.25, XAUUSD: 0.65 },
    zero: {},
  };
  function estimateRatio(c) {
    const read = (key, label) => {
      const raw = c[key];
      if (raw == null || String(raw).trim() === "") throw new Error(`请先确认${label}`);
      const value = Number(raw);
      if (!Number.isFinite(value) || value < 0) throw new Error(`${label}须为不小于0的数字`);
      return value;
    };
    const stopPercent = read("stopPercent", "止损距离");
    if (stopPercent <= 0 || stopPercent >= 100) throw new Error("止损距离须大于0且小于100%");
    const baseBp = read("baseBp", "完整往返成本率"), slipBp = read("slipBp", "额外滑点率"), rebateBp = read("rebateBp", "返佣率");
    const redline = read("redline", "成本红线");
    if (redline <= 0 || redline > 10) throw new Error("成本红线须大于0且不高于10%R");
    if (rebateBp > baseBp) throw new Error("返佣率不能超过参考往返成本率");
    const netBp = baseBp + slipBp - rebateBp;
    const riskPercent = netBp / stopPercent;
    return { stopPercent, baseBp, slipBp, rebateBp, netBp, riskPercent,
      costPer100k: netBp * 10, costPer100Risk: riskPercent,
      totalLossR: 1 + riskPercent / 100, minStopPercent: netBp / redline, redline };
  }
  return { checkedAt, accounts, markets, commission, estimate, referenceBp, estimateRatio };
});
