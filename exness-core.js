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
    { id: "USOIL", name: "WTI原油（CL）", quickLabel: "CL · 原油", multiplier: 1000, unit: "桶", min: 0.01, max: 20, raw: 7, zero: 12.5, checkedAt: "2026-09-24" },
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
    const risk = read("risk", "风险预算");
    if (risk <= 0) throw new Error("风险预算须大于0");
    const baseBp = read("baseBp", "完整往返成本率"), slipBp = read("slipBp", "额外滑点率"), rebateBp = read("rebateBp", "返佣率");
    const redline = read("redline", "成本红线");
    if (redline <= 0 || redline > 10) throw new Error("成本红线须大于0且不高于10%R");
    if (rebateBp > baseBp) throw new Error("返佣率不能超过参考往返成本率");
    const netBp = baseBp + slipBp - rebateBp;
    const riskPercent = netBp / stopPercent;
    const notional = risk / (stopPercent / 100);
    const cost = risk * riskPercent / 100;
    const totalLoss = risk + cost;
    if (![notional, cost, totalLoss, riskPercent].every(Number.isFinite)) throw new Error("输入数值过大或止损距离过小，请调整");
    return { stopPercent, risk, notional, cost, totalLoss, baseBp, slipBp, rebateBp, netBp, riskPercent,
      costPer100k: netBp * 10, costPer100Risk: riskPercent,
      totalLossR: 1 + riskPercent / 100, minStopPercent: netBp / redline, redline };
  }
  // Proxy books supply a size-dependent impact scenario, not Exness liquidity.
  // Quantities in the proxy book are contracts/lots; prices are per underlying
  // unit. Convert equal USD notional before sweeping, and apply that multiplier
  // again when converting a price difference back to USD.
  function estimateProxy(c) {
    const read = (key, label, positive = false) => {
      const raw = c[key];
      if (raw == null || String(raw).trim() === "") throw new Error(`请填写${label}`);
      const value = Number(raw);
      if (!Number.isFinite(value) || (positive ? value <= 0 : value < 0)) {
        throw new Error(`${label}须为${positive ? "大于" : "不小于"}0的数字`);
      }
      return value;
    };
    const market = markets.find(m => m.id === c.symbol);
    if (!market) throw new Error("Exness标的无效");
    const roundTripCommission = commission(market, c.account);
    const risk = read("risk", "风险预算", true);
    const stopPercent = read("stopPercent", "止损距离", true);
    if (stopPercent >= 100) throw new Error("止损距离须小于100%");
    const redline = read("redline", "成本红线", true);
    if (redline > 10) throw new Error("成本红线须不高于10%R");
    const proxyMultiplier = read("proxyMultiplier", "参考盘口合约乘数", true);
    const slipBp = read("slipBp", "额外滑点率");
    const rebateBp = read("rebateBp", "返佣率");
    const method = c.method ?? "conservative";
    if (!["conservative", "directional"].includes(method)) throw new Error("扫档计算方式无效");
    const hasBase = c.baseBp != null && String(c.baseBp).trim() !== "";
    const configuredBaseBp = hasBase ? read("baseBp", "完整往返成本率") : null;
    const normalize = (levels, side) => {
      if (Array.isArray(levels)) {
        // normalizeLevels uses Number(); reject missing values before coercion.
        for (const level of levels) {
          const price = Array.isArray(level) ? level[0] : level?.px;
          const size = Array.isArray(level) ? level[1] : level?.sz;
          if ([price, size].some(value => value == null || typeof value === "boolean" || String(value).trim() === "")) {
            throw new Error("盘口包含无效价格或数量");
          }
        }
      }
      const result = core.normalizeLevels(levels, side).filter(level => level.size > 0);
      if (!result.length) throw new Error(`${side === "bid" ? "买" : "卖"}盘没有有效数量`);
      return result;
    };
    const bids = normalize(c.bids, "bid"), asks = normalize(c.asks, "ask");
    const bid = bids[0].price, ask = asks[0].price;
    if (ask < bid) throw new Error("参考盘口买卖价格倒挂，无法估算");
    const mid = bid / 2 + ask / 2;
    const notional = risk / (stopPercent / 100);
    const units = notional / mid;
    const proxyQuantity = units / proxyMultiplier;
    const estimatedLots = units / market.multiplier;
    if (![notional, units, proxyQuantity, estimatedLots].every(value => Number.isFinite(value) && value > 0)) {
      throw new Error("输入数值过大或止损距离过小，请调整");
    }
    const buy = core.sweep(asks, proxyQuantity, proxyMultiplier);
    const sell = core.sweep(bids, proxyQuantity, proxyMultiplier);
    if (!buy.complete || !sell.complete || buy.vwap == null || sell.vwap == null) {
      throw new Error("参考盘口深度不足以覆盖所需仓位；不会截仓或外推成本");
    }
    const buyImpactCost = Math.max(0, buy.vwap - ask) * units;
    const sellImpactCost = Math.max(0, bid - sell.vwap) * units;
    const impactCost = method === "conservative"
      ? 2 * Math.max(buyImpactCost, sellImpactCost)
      : buyImpactCost + sellImpactCost;
    const proxySpread = ask - bid;
    const observedReferenceSpreadCost = proxySpread * units;
    const referenceSpreadCost = hasBase ? 0 : observedReferenceSpreadCost;
    const exnessCommissionCost = hasBase ? 0 : roundTripCommission * estimatedLots;
    const baseCost = hasBase ? notional * (configuredBaseBp / 10000) : referenceSpreadCost + exnessCommissionCost;
    const baseBp = hasBase ? configuredBaseBp : baseCost / notional * 10000;
    if (rebateBp > baseBp) throw new Error("返佣率不能超过基础往返成本率，不能抵消扫档冲击");
    const extraSlipCost = notional * (slipBp / 10000);
    const rebateValue = notional * (rebateBp / 10000);
    const cost = Math.max(0, baseCost - rebateValue) + impactCost + extraSlipCost;
    const totalLoss = risk + cost;
    const riskPercent = cost / risk * 100;
    const totalLossR = totalLoss / risk;
    const netBp = cost / notional * 10000;
    if (![mid, baseCost, baseBp, impactCost, buyImpactCost, sellImpactCost, extraSlipCost,
      rebateValue, observedReferenceSpreadCost, exnessCommissionCost, cost, totalLoss,
      riskPercent, totalLossR, netBp].every(Number.isFinite)) {
      throw new Error("输入数值过大或止损距离过小，请调整");
    }
    return { status: "ok", symbol: c.symbol, account: c.account, risk, stopPercent, notional,
      cost, totalLoss, totalLossR, riskPercent, netBp, baseBp, baseCost, impactCost,
      buyImpactCost, sellImpactCost, extraSlipCost, rebateValue, referenceSpreadCost,
      exnessCommissionCost, baselineMode: hasBase ? "configured" : "proxy-spread",
      bid, ask, mid, proxySpread, observedReferenceSpreadCost, proxyQuantity, proxyMultiplier,
      estimatedLots, units, buy, sell, slipBp, rebateBp, method, redline };
  }
  return { checkedAt, accounts, markets, commission, estimate, referenceBp, estimateRatio, estimateProxy };
});
