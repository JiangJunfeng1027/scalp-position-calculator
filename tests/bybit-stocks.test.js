"use strict";
const assert = require("node:assert/strict");
const bybit = require("../bybit-stocks.js");
const core = require("../cost-core.js");
const wrap = result => ({ retCode: 0, result });
function instrument(ticker) {
  return { symbol: `${ticker}USDT`, baseCoin: ticker, quoteCoin: "USDT", settleCoin: "USDT",
    contractType: "LinearPerpetual", status: "Trading", isPreListing: false,
    symbolType: ticker === "SOXL" ? "ETF" : "stock",
    lotSizeFilter: { minOrderQty: "0.01", qtyStep: "0.01", maxMktOrderQty: "1000", maxOrderQty: "2000", minNotionalValue: "5" },
    priceFilter: { tickSize: "0.01" }, leverageFilter: { maxLeverage: "100" } };
}
function responses() { return bybit.tickers.map(ticker => wrap({ category: "linear", list: [instrument(ticker)] })); }
const catalog = bybit.normalizeMarkets(responses());
assert.deepEqual(catalog.markets.map(x => x.id), ["SOXLUSDT", "SNDKUSDT", "MUUSDT", "SKHYNIXUSDT", "SPCXUSDT"]);
const market = catalog.markets[0];
assert.equal(market.contractMultiplier, 1);
assert.equal(market.maxQuantity, 1000);
assert.equal(market.maxLimitQuantity, 2000);
assert.equal(bybit.fees(market).takerRate, 0.000275);
assert.equal(bybit.fees(market).makerRate, 0);
assert.equal(bybit.fees({ ...market, sourceMeta: { ...market.sourceMeta, symbolType: "crypto" } }).takerRate, null);
for (const patch of [{ symbol: "KORUUSDT" }, { symbol: "BTCUSDT" }]) {
  const data = responses(); Object.assign(data[0].result.list[0], patch);
  assert.throws(() => bybit.normalizeMarkets(data), /不匹配/);
}
for (const patch of [{ status: "Settling" }, { isPreListing: true }, { contractType: "LinearFutures" }, { settleCoin: "USDC" }, { symbolType: "crypto" }]) {
  const data = responses(); Object.assign(data[0].result.list[0], patch);
  assert.equal(bybit.normalizeMarkets(data).markets.length, 4);
}
for (const value of [undefined, null, "", false, "0", "-1", "NaN"]) {
  const data = responses();data[0].result.list[0].lotSizeFilter.qtyStep = value;
  assert.equal(bybit.normalizeMarkets(data).markets.length, 4);
}
assert.throws(() => bybit.normalizeMarkets([]), /不完整/);
const error = responses();error[0].retCode = 10006;
assert.throws(() => bybit.normalizeMarkets(error), /失败/);
const absent = responses();absent[0].result.list = [];
assert.equal(bybit.normalizeMarkets(absent).markets.length, 4);
const now = 1792499327000;
const raw = () => wrap({ s: market.id, ts: now - 50, cts: now - 100, b: [["99.99", "10"], ["99.9", "990"]], a: [["100.01", "10"], ["100.1", "990"]] });
const limits = () => wrap({ symbol: market.id, ts: String(now - 200), buyLmt: "103", sellLmt: "97" });
const book = bybit.normalizeBook(raw(), limits(), market, now);
assert.equal(book.time, now - 200);
assert.deepEqual(book.bids[0], [99.99, 10]);
for (const patch of [{ s: "MUUSDT" }, { ts: now - 15001 }, { cts: now - 15001 }, { ts: now + 6000 }, { b: [] }, { a: [["99", "10"]] }, { b: [["99", "1"], ["100", "1"]] }]) {
  const bad = raw();Object.assign(bad.result, patch);
  assert.throws(() => bybit.normalizeBook(bad, limits(), market, now));
}
for (const patch of [{ symbol: "MUUSDT" }, { ts: String(now - 15001) }, { buyLmt: "" }, { buyLmt: "90" }]) {
  const bad = limits();Object.assign(bad.result, patch);
  assert.throws(() => bybit.normalizeBook(raw(), bad, market, now));
}
const config = { ...market, bids: book.bids, asks: book.asks, stopPercent: 1, risk: 100, takerRate: 0.000275, makerRate: 0 };
const result = core.estimate(config);
assert.equal(result.status, "ok");
assert.equal(result.quantity, 100);
assert.ok(Math.abs(result.feeCost - 5.5) < 1e-9);
assert.equal(bybit.checkPriceLimits(result, book, "market", "long").status, "ok");
assert.equal(bybit.checkPriceLimits(result, { ...book, priceLimits: { buyLmt: 100.05, sellLmt: 97 } }, "market", "long").status, "bybit_price_limit");
assert.equal(core.estimate({ ...config, risk: 2000 }).status, "above_market_max");
assert.ok(core.estimate({ ...config, risk: 200 }).buySlipBp > result.buySlipBp);
for (const side of ["long", "short"]) {
  const limitPrice = side === "long" ? 99.99 : 100.01;
  const estimate = core.estimateLimitEntryMarketStop({ ...config, limitPrice, side, postOnly: true });
  assert.equal(estimate.status, "ok");
  assert.equal(bybit.checkPriceLimits(estimate, book, "limit", side).status, "ok");
  assert.ok(estimate.feeCost > 2.6 && estimate.feeCost < 2.9);
}
console.log("Bybit stocks: selection, spec validation, fee model, depth identity/freshness, size limits and market/limit calculations passed");
