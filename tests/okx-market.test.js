"use strict";

const assert = require("node:assert/strict");
const okx = require("../okx-market.js");
const core = require("../cost-core.js");
const selectedListings = require("../okx-selected-listings.js");

const wrap = (data, code = "0") => ({ code, data, msg: "" });
const listings = {
  AAPL: { name: "Apple Inc.", etf: false, listedSymbol: "AAPL" },
  QQQ: { name: "Invesco QQQ Trust", etf: true, listedSymbol: "QQQ" },
  MSFT: { name: "Microsoft Corporation", etf: false, listedSymbol: "MSFT" },
};
function instrument(overrides = {}) {
  return {
    instId: "AAPL-USDT-SWAP", instType: "SWAP", instCategory: "3", state: "live",
    ctType: "linear", settleCcy: "USDT", ctValCcy: "AAPL", ctVal: "10", ctMult: "1",
    lotSz: "0.5", minSz: "0.5", tickSz: "0.01",
    maxMktSz: "20", maxStopSz: "12", maxLmtSz: "100",
    maxMktAmt: "", maxLmtAmt: "20000000", groupId: "4", futureField: "preserved",
    ...overrides,
  };
}
function market(overrides = {}) {
  return okx.normalizeMarkets(wrap([instrument(overrides)]), listings).markets[0];
}
function close(actual, expected) {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);
}

// Exchange errors and malformed envelopes never become empty successful catalogs.
const rows = [];
assert.equal(okx.unwrap(wrap(rows)), rows);
assert.equal(okx.unwrap(wrap(rows, 0)), rows);
for (const code of [false, null, undefined, "", "00", 1, "50000"]) {
  assert.throws(() => okx.unwrap({ code, data: [] }), /接口/);
}
for (const data of [null, undefined, {}, "[]"]) {
  assert.throws(() => okx.unwrap({ code: "0", data }), /接口/);
}
assert.throws(() => okx.unwrap(null), /接口/);
assert.throws(() => okx.normalizeMarkets(wrap([]), null), /精选标的名单/);

// Category 3 alone includes foreign stocks; intersect exact US listings and tradable swaps.
const catalog = okx.normalizeMarkets(wrap([
  instrument({ ctValCcy: "QQQ", instId: "QQQ-USDT-SWAP", ctVal: "1" }),
  instrument(),
  instrument({ ctValCcy: "0700", instId: "0700-USDT-SWAP" }),
  instrument({ ctValCcy: "BTC", instId: "BTC-USDT-SWAP", instCategory: "1" }),
  instrument({ ctValCcy: "MSFT", instId: "MSFT-USDT-SWAP", state: "suspend" }),
  instrument({ state: "post_only" }),
  instrument({ state: "rebase" }),
  instrument({ instType: "FUTURES" }),
  instrument({ settleCcy: "USDC" }),
  instrument({ ctType: "inverse" }),
  instrument({ instId: "AAPL-USDC-SWAP" }),
  null,
]), listings);
assert.deepEqual(catalog.markets.map((row) => row.id), ["AAPL-USDT-SWAP", "QQQ-USDT-SWAP"]);
assert.equal(catalog.excludedCount, 10);
assert.equal(catalog.unavailable.length, 0);
assert.equal(catalog.dexMeta, null);
assert.match(catalog.catalogNote, /2个精选股票/);
const apple = catalog.markets[0];
assert.equal(apple.bookSymbol, "AAPL-USDT-SWAP");
assert.equal(apple.contractMultiplier, 10);
assert.equal(apple.quantityStep, "0.5");
assert.equal(apple.minQuantity, 0.5);
assert.equal(apple.maxQuantity, 12);
assert.equal(apple.maxLimitQuantity, 100);
assert.equal(apple.maxNotional, Infinity);
assert.equal(apple.maxLimitNotional, 20_000_000);
assert.equal(apple.minNotional, 0);
assert.equal(apple.priceTick, "0.01");
assert.equal(apple.isEtf, false);
assert.equal(apple.underlyingName, "Apple Inc.");
assert.equal(catalog.markets[1].isEtf, true);
assert.match(catalog.markets[1].quickLabel, /ETF/);
assert.deepEqual(apple.sourceMeta, instrument());
assert.equal(market({ maxMktSz: "8", maxStopSz: "12" }).maxQuantity, 8);
assert.equal(market({ maxMktAmt: "1234" }).maxNotional, 1234);
assert.equal(market({ maxLmtAmt: undefined }).maxLimitNotional, Infinity);
assert.equal(market({ maxMktAmt: null }).maxNotional, Infinity);
assert.throws(() => okx.normalizeMarkets(wrap([instrument(), instrument()]), listings), /重复/);

// The user's exact selection includes Korean SKHYNIX and explicitly excludes KORU.
const selectedTickers = ["MU", "SKHYNIX", "SNDK", "SOXL", "SPCX"];
assert.deepEqual(Object.keys(selectedListings).sort(), selectedTickers);
assert.equal(selectedListings.SKHYNIX.market, "KR");
const selectedCatalog = okx.normalizeMarkets(wrap([
  ...selectedTickers.map((ticker) => instrument({ ctValCcy: ticker, instId: `${ticker}-USDT-SWAP` })),
  instrument({ ctValCcy: "KORU", instId: "KORU-USDT-SWAP" }),
  instrument(),
]), selectedListings);
assert.deepEqual(selectedCatalog.markets.map((row) => row.ticker), selectedTickers);
assert.equal(selectedCatalog.excludedCount, 2);
assert.equal(selectedCatalog.markets.find((row) => row.ticker === "SKHYNIX").listedSymbol, "000660");
assert.ok(!selectedCatalog.markets.some((row) => row.ticker === "KORU"));

// Invalid candidate specifications are counted and excluded, never repaired with a default of one.
const requiredNumbers = ["ctVal", "lotSz", "minSz", "tickSz", "maxMktSz", "maxLmtSz", "maxStopSz"];
for (const field of requiredNumbers) {
  for (const value of ["", " ", null, undefined, 0, -1, false, true, [], {}, Infinity, "0x10"]) {
    const result = okx.normalizeMarkets(wrap([instrument({ [field]: value })]), listings);
    assert.equal(result.markets.length, 0, `${field} should reject ${String(value)}`);
    assert.equal(result.unavailable.length, 1);
    assert.match(result.catalogNote, /1个候选合约规格无效/);
  }
}
for (const ctMult of ["", null, undefined, "0", "2", false, [], Infinity]) {
  assert.equal(okx.normalizeMarkets(wrap([instrument({ ctMult })]), listings).unavailable.length, 1);
}
for (const field of ["maxMktAmt", "maxLmtAmt"]) {
  for (const value of [0, "0", -1, " ", false, [], Infinity]) {
    assert.equal(okx.normalizeMarkets(wrap([instrument({ [field]: value })]), listings).markets.length, 0);
  }
}
assert.equal(market({ minSz: "13" }), undefined);
assert.equal(market({ maxLmtSz: "0.1" }), undefined);
assert.equal(okx.normalizeMarkets(wrap([instrument()]), {
  AAPL: { name: "", etf: false, listedSymbol: "AAPL" },
}).unavailable.length, 1);

// Only the verified ordinary stock-swap fee group has an automatic reference rate.
const regularFees = okx.fees(apple);
close(regularFees.takerRate, 0.0005);
close(regularFees.makerRate, 0.0002);
close(regularFees.rate, regularFees.takerRate);
assert.equal(regularFees.product, "OKX精选股票/ETF永续");
assert.match(regularFees.source, /非账户实测/);
for (const groupId of [null, undefined, "", "6", "7", false, ["4"]]) {
  const fees = okx.fees(market({ groupId }));
  assert.equal(fees.rate, null);
  assert.equal(fees.takerRate, null);
  assert.equal(fees.makerRate, null);
}
for (const invalidMarket of [null, {}, { ...apple, id: "BTC-USDT-SWAP" },
  { ...apple, sourceMeta: { ...apple.sourceMeta, instCategory: "1" } },
  { ...apple, sourceMeta: { ...apple.sourceMeta, state: "suspend" } }]) {
  assert.equal(okx.fees(invalidMarket).rate, null);
}

const now = 1_792_500_000_000;
function bookResponse(overrides = {}) {
  return wrap([{
    ts: String(now - 100),
    bids: [["99", "1", "0", "2"], ["98", "2", "0", "3"], ["97", "20", "0", "4"]],
    asks: [["101", "1", "0", "2"], ["102", "2", "0", "3"], ["103", "20", "0", "4"]],
    ...overrides,
  }]);
}
function limitResponse(overrides = {}) {
  return wrap([{
    instId: apple.id, ts: String(now - 200), enabled: true, buyLmt: "102", sellLmt: "98",
    ...overrides,
  }]);
}
function book(bookOverrides = {}, limitOverrides = {}, options = {}) {
  return okx.normalizeBook(bookResponse(bookOverrides), limitResponse(limitOverrides), apple,
    options.now ?? now, options.maxAge ?? 15_000);
}
const normalized = book();
assert.deepEqual(normalized.bids, [[99, 1], [98, 2], [97, 20]]);
assert.deepEqual(normalized.asks, [[101, 1], [102, 2], [103, 20]]);
assert.equal(normalized.time, now - 200);
assert.deepEqual(normalized.priceLimits, {
  instId: apple.id, enabled: true, buyLmt: 102, sellLmt: 98, ts: now - 200,
});
assert.deepEqual(normalized.depthProfile, {
  id: "okx-400", label: "OKX原始盘口·最多400档", approximate: false,
});
assert.equal(book({ instId: apple.id }).asks[1][1], 2);
assert.throws(() => book({ instId: "MSFT-USDT-SWAP" }), /合约不匹配/);
assert.throws(() => book({ instId: undefined }), /合约不匹配/);
assert.throws(() => book({}, { instId: "MSFT-USDT-SWAP" }), /合约不匹配/);
assert.throws(() => book({}, { instId: undefined }), /合约不匹配/);

// Both sources need their own valid timestamp; neither receipt time nor the newer source hides staleness.
assert.equal(book({ ts: now - 15_000 }).time, now - 15_000);
assert.throws(() => book({ ts: now - 15_001 }), /盘口已过期/);
assert.throws(() => book({}, { ts: now - 15_001 }), /限价已过期/);
assert.doesNotThrow(() => book({ ts: now + 5_000 }, { ts: now + 5_000 }));
assert.throws(() => book({ ts: now + 5_001 }), /晚于/);
assert.throws(() => book({}, { ts: now + 5_001 }), /晚于/);
for (const ts of ["", null, undefined, false, [], 0, -1, Infinity, now + 0.5]) {
  assert.throws(() => book({ ts }), /来源时间/);
  assert.throws(() => book({}, { ts }), /来源时间/);
}
assert.throws(() => okx.normalizeBook(bookResponse(), limitResponse(), apple, null), /当前时间/);
assert.throws(() => okx.normalizeBook(bookResponse(), limitResponse(), apple, now, -1), /有效时长/);
assert.throws(() => okx.normalizeBook(wrap([]), limitResponse(), apple, now), /快照/);
assert.throws(() => okx.normalizeBook(wrap([{}, {}]), limitResponse(), apple, now), /快照/);
assert.throws(() => okx.normalizeBook(bookResponse(), wrap([], "50000"), apple, now), /接口/);

for (const side of ["bids", "asks"]) {
  for (const invalid of [[], null, {}, [[99]], [[0, 2]], [[99, -1]], [[99, ""]],
    [[99, false]], [[99, []]], [[Infinity, 1]], [[99, 0]]]) {
    assert.throws(() => book({ [side]: invalid }), /OKX/);
  }
}
assert.deepEqual(book({ bids: [[99, 0], [98, 2]] }).bids, [[99, 0], [98, 2]]);
for (const enabled of ["true", 1, null, undefined]) {
  assert.throws(() => book({}, { enabled }), /启用状态/);
}
for (const bad of ["", null, 0, false, [], -1, Infinity]) {
  assert.throws(() => book({}, { buyLmt: bad }), /买入限价/);
  assert.throws(() => book({}, { sellLmt: bad }), /卖出限价/);
}
assert.throws(() => book({}, { buyLmt: "98", sellLmt: "99" }), /限价倒挂/);
const disabledLimitsBook = book({}, { enabled: false, buyLmt: "", sellLmt: "" });
assert.equal(disabledLimitsBook.priceLimits.buyLmt, null);
assert.equal(disabledLimitsBook.priceLimits.sellLmt, null);

// Three contracts at a 10-share face value are 30 shares, not 3 or 300.
// The second book column stays incremental contract counts throughout the core sweep.
function estimate(overrides = {}) {
  return core.estimate({
    ...apple, bids: normalized.bids, asks: normalized.asks, risk: 30, stopPercent: 1,
    takerRate: regularFees.takerRate, ...overrides,
  });
}
const estimate3 = estimate();
assert.equal(estimate3.status, "ok");
close(estimate3.quantity, 3);
close(estimate3.actualNotional, 3_000);
close(estimate3.actualPriceRisk, 30);
close(estimate3.buy.visibleNotional, 3_050);
close(estimate3.sell.visibleNotional, 2_950);
close(estimate3.feeCost, 3);
close(estimate3.spreadCost, 60);
close(estimate3.buyImpactCost, 20);
close(estimate3.sellImpactCost, 20);
assert.equal(estimate3.buy.levelsUsed, 2);
assert.equal(estimate3.sell.levelsUsed, 2);
assert.equal(estimate({ risk: 4.99 }).status, "below_min_quantity");
assert.equal(estimate({ risk: 125 }).status, "above_market_max");
const rounded = estimate({ risk: 30.5 });
close(rounded.rawQuantity, 3.05);
close(rounded.quantity, 3);
close(rounded.actualNotional, 3_000);
assert.ok(rounded.actualPriceRisk <= rounded.requestedRisk);
assert.equal(estimate({ risk: 30, maxNotional: 2_999 }).status, "above_market_max_notional");
assert.equal(estimate({
  asks: [[101, 2]], bids: [[99, 2]],
}).status, "insufficient_snapshot_depth");

// A market entry/exit proxy must fit both current bands, including its worst consumed level.
assert.equal(okx.checkPriceLimits(estimate3, normalized, "market"), estimate3);
const deeper = estimate({ risk: 35 });
assert.equal(deeper.status, "ok");
const blocked = okx.checkPriceLimits(deeper, normalized, "market");
assert.equal(blocked.status, "okx_price_limit");
assert.equal(deeper.status, "ok"); // The core result is not mutated.
close(blocked.quantity, deeper.quantity);
assert.equal(okx.checkPriceLimits(deeper, disabledLimitsBook, "market"), deeper);
assert.equal(okx.checkPriceLimits({
  ...estimate3, buy: { ...estimate3.buy, lastPrice: 102.000001 },
}, normalized, "market").status, "okx_price_limit");
assert.equal(okx.checkPriceLimits({
  ...estimate3, sell: { ...estimate3.sell, lastPrice: 97.999999 },
}, normalized, "market").status, "okx_price_limit");
const insufficient = { status: "insufficient_snapshot_depth" };
assert.equal(okx.checkPriceLimits(insufficient, null, "market"), insufficient);

// Current limits validate limit entry only; they are not a forecast of future stop protections.
const limitLong = core.estimateLimitEntryMarketStop({
  ...apple, bids: normalized.bids, asks: normalized.asks,
  risk: 29.7, stopPercent: 1, side: "long", limitPrice: 99, postOnly: true,
  takerRate: regularFees.takerRate, makerRate: regularFees.makerRate,
});
assert.equal(limitLong.status, "ok");
assert.ok(limitLong.stopProxyPrice < normalized.priceLimits.sellLmt);
assert.equal(okx.checkPriceLimits(limitLong, normalized, "limit", "long"), limitLong);
const limitShort = { status: "ok", limitPrice: 102, side: "short" };
assert.equal(okx.checkPriceLimits(limitShort, normalized, "limit", "short"), limitShort);
assert.equal(okx.checkPriceLimits({ ...limitLong, limitPrice: 102.01 },
  normalized, "limit", "long").status, "okx_price_limit");
assert.equal(okx.checkPriceLimits({ ...limitShort, limitPrice: 97.99 },
  normalized, "limit", "short").status, "okx_price_limit");
assert.throws(() => okx.checkPriceLimits(estimate3, {}, "market"), /限价状态/);
assert.throws(() => okx.checkPriceLimits(limitLong, normalized, "limit", "invalid"), /方向/);
assert.throws(() => okx.checkPriceLimits(estimate3, normalized, "unknown"), /成交方式/);

console.log("OKX market tests passed (selected scope, strict contracts, contract-sized depth, fees, source time, order limits).");
