(function attachBybitStocks(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.BybitStocks = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const tickers = Object.freeze(["SOXL", "SNDK", "MU", "SKHYNIX", "SPCX"]);
  const names = { SOXL: "半导体三倍ETF", SNDK: "闪迪", MU: "美光", SKHYNIX: "SK海力士", SPCX: "SpaceX" };
  function positive(value, label, zero = false) {
    if (!(typeof value === "number" || typeof value === "string" && /^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value))) throw new Error(`Bybit${label}无效`);
    const n = Number(value);
    if (!Number.isFinite(n) || (zero ? n < 0 : n <= 0)) throw new Error(`Bybit${label}无效`);
    return n;
  }
  function unwrap(raw) {
    if (raw?.retCode !== 0 || !raw.result || typeof raw.result !== "object" || Array.isArray(raw.result)) throw new Error("Bybit接口返回失败");
    return raw.result;
  }
  function eligible(row) {
    return row && tickers.includes(row.baseCoin) && row.symbol === `${row.baseCoin}USDT` &&
      row.contractType === "LinearPerpetual" && row.status === "Trading" &&
      row.quoteCoin === "USDT" && row.settleCoin === "USDT" && row.isPreListing === false &&
      row.symbolType === (row.baseCoin === "SOXL" ? "ETF" : "stock");
  }
  function normalizeMarkets(responses) {
    if (!Array.isArray(responses) || responses.length !== tickers.length) throw new Error("Bybit精选合约响应不完整");
    const markets = [], unavailable = [];
    responses.forEach((raw, i) => {
      const result = unwrap(raw), symbol = `${tickers[i]}USDT`;
      if (result.category !== "linear" || !Array.isArray(result.list) || result.list.length > 1 ||
          result.list.some(row => row?.symbol !== symbol)) throw new Error("Bybit合约响应不匹配");
      const row = result.list[0];
      if (!eligible(row)) { unavailable.push(symbol); return; }
      try {
        const lot = row.lotSizeFilter, price = row.priceFilter;
        const minQuantity = positive(lot?.minOrderQty, "最小数量");
        const maxQuantity = positive(lot?.maxMktOrderQty, "市价数量上限");
        const maxLimitQuantity = positive(lot?.maxOrderQty, "限价数量上限");
        positive(lot?.qtyStep, "数量步长"); positive(price?.tickSize, "价格步长");
        if (minQuantity > Math.min(maxQuantity, maxLimitQuantity)) throw new Error("Bybit数量范围无效");
        markets.push({
          id: symbol, bookSymbol: symbol, ticker: row.baseCoin, isEtf: row.baseCoin === "SOXL",
          display: `${row.baseCoin} · ${names[row.baseCoin]}`, quickLabel: row.baseCoin,
          contractMultiplier: 1, quantityStep: String(lot.qtyStep), minQuantity, maxQuantity,
          maxLimitQuantity, maxNotional: Infinity, maxLimitNotional: Infinity,
          minNotional: positive(lot.minNotionalValue, "最小名义金额", true), priceTick: String(price.tickSize),
          leverage: positive(row.leverageFilter?.maxLeverage, "最大杠杆"), sourceMeta: { ...row },
        });
      } catch (error) { unavailable.push(`${symbol}（${error.message}）`); }
    });
    return { markets, dexMeta: null, catalogNote: `仅显示${markets.length}个指定股票/ETF永续；非证券持仓。${unavailable.length ? `暂不可用：${unavailable.join("、")}。` : ""}` };
  }
  function time(value, now, maxAge) {
    const n = positive(value, "来源时间");
    if (!Number.isSafeInteger(n) || n > now + 5000 || now - n > maxAge) throw new Error("Bybit盘口或价格保护数据已过期或时间无效");
    return n;
  }
  function levels(rows, isBid) {
    if (!Array.isArray(rows) || !rows.length) throw new Error("Bybit盘口为空");
    const output = rows.map(row => {
      if (!Array.isArray(row) || row.length < 2) throw new Error("Bybit盘口档位无效");
      return [positive(row[0], "档位价格"), positive(row[1], "档位数量", true)];
    }).filter(row => row[1] > 0);
    if (!output.length || output.some((row, i) => i && (isBid ? row[0] >= output[i - 1][0] : row[0] <= output[i - 1][0]))) throw new Error("Bybit盘口档位顺序无效");
    return output;
  }
  function normalizeBook(raw, rawLimits, market, now = Date.now(), maxAge = 15_000) {
    if (!eligible(market?.sourceMeta) || market.id !== market.sourceMeta.symbol || market.bookSymbol !== market.id) throw new Error("Bybit合约无效");
    const book = unwrap(raw), limits = unwrap(rawLimits);
    if (book.s !== market.bookSymbol || limits.symbol !== market.bookSymbol) throw new Error("Bybit盘口合约不匹配");
    const bookTime = time(book.ts, now, maxAge);
    // cts is the matching engine time; a fresh response must not hide an old book.
    const engineTime = book.cts == null ? bookTime : time(book.cts, now, maxAge);
    const limitTime = time(limits.ts, now, maxAge);
    const bids = levels(book.b, true), asks = levels(book.a, false);
    if (bids[0][0] >= asks[0][0]) throw new Error("Bybit买卖盘口倒挂或锁定");
    const buyLmt = positive(limits.buyLmt, "买入保护价"), sellLmt = positive(limits.sellLmt, "卖出保护价");
    if (sellLmt > buyLmt) throw new Error("Bybit保护价倒挂");
    return { bids, asks, time: Math.min(bookTime, engineTime, limitTime),
      priceLimits: { buyLmt, sellLmt },
      depthProfile: { id: "bybit-stocks-500", label: "Bybit原始盘口·最多500档", approximate: false } };
  }
  function fees(market) {
    const known = eligible(market?.sourceMeta) && market.id === market.sourceMeta.symbol;
    return { rate: known ? 0.000275 : null, takerRate: known ? 0.000275 : null,
      makerRate: known ? 0 : null, product: "Bybit精选股票/ETF永续",
      source: known ? "普通用户TradFi活动参考 · 未含MNT/VIP优惠 · 非账户实测" : "产品费率未知，请手动输入" };
  }
  function checkPriceLimits(result, book, execution, side) {
    if (result?.status !== "ok") return result;
    const buyLmt = positive(book?.priceLimits?.buyLmt, "买入保护价"), sellLmt = positive(book?.priceLimits?.sellLmt, "卖出保护价");
    if (sellLmt > buyLmt) throw new Error("Bybit保护价倒挂");
    let outside;
    if (execution === "market") outside = positive(result.buy?.lastPrice, "买入末档") > buyLmt || positive(result.sell?.lastPrice, "卖出末档") < sellLmt;
    else if (execution === "limit" && ["long", "short"].includes(side)) {
      const entry = positive(result.limitPrice, "进场限价");
      outside = side === "long" ? entry > buyLmt : entry < sellLmt;
    } else throw new Error("Bybit成交方式无效");
    return outside ? { ...result, status: "bybit_price_limit" } : result;
  }
  return { tickers, normalizeMarkets, normalizeBook, fees, checkPriceLimits };
});
