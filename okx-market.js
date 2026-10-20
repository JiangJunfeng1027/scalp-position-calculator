(function attachOKXMarket(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.OKXMarket = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function buildOKXMarket() {
  "use strict";

  const DECIMAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;
  const own = (value, key) => value != null && Object.prototype.hasOwnProperty.call(value, key);

  function numberValue(value, label, allowZero = false) {
    const numeric = typeof value === "number" ||
      (typeof value === "string" && DECIMAL.test(value.trim()));
    const result = numeric ? Number(value) : NaN;
    if (!Number.isFinite(result) || (allowZero ? result < 0 : result <= 0)) {
      throw new Error(`OKX${label}无效`);
    }
    return result;
  }

  function optionalLimit(value, label) {
    if (value == null || value === "") return Infinity;
    return numberValue(value, label);
  }

  function unwrap(response) {
    if (!response || (response.code !== "0" && response.code !== 0) || !Array.isArray(response.data)) {
      throw new Error("OKX接口返回失败或数据结构无效");
    }
    return response.data;
  }

  function isStockSwap(instrument) {
    return instrument != null &&
      (instrument.instCategory === "3" || instrument.instCategory === 3) &&
      instrument.instType === "SWAP" &&
      instrument.state === "live" &&
      instrument.ctType === "linear" &&
      instrument.settleCcy === "USDT";
  }

  function normalizeMarkets(response, listings) {
    if (!listings || typeof listings !== "object" || Array.isArray(listings)) {
      throw new Error("OKX精选标的名单无效");
    }
    const rows = unwrap(response);
    const markets = [];
    const unavailable = [];
    const seen = new Set();
    let excluded = 0;
    for (const instrument of rows) {
      const ticker = instrument?.ctValCcy;
      if (!isStockSwap(instrument) || typeof ticker !== "string" ||
          !own(listings, ticker) || instrument.instId !== `${ticker}-USDT-SWAP`) {
        excluded += 1;
        continue;
      }
      if (seen.has(instrument.instId)) throw new Error(`OKX合约重复：${instrument.instId}`);
      seen.add(instrument.instId);
      try {
        const listing = listings[ticker];
        if (!listing || typeof listing.name !== "string" || !listing.name.trim() ||
            typeof listing.etf !== "boolean" ||
            typeof listing.listedSymbol !== "string" || !listing.listedSymbol.trim()) {
          throw new Error("OKX精选标的名称或上市资料无效");
        }
        if (numberValue(instrument.ctMult, "合约乘数") !== 1) {
          throw new Error("OKX暂不支持此合约乘数");
        }
        const contractMultiplier = numberValue(instrument.ctVal, "合约面值");
        numberValue(instrument.lotSz, "数量步进");
        numberValue(instrument.tickSz, "价格步进");
        const minQuantity = numberValue(instrument.minSz, "最小张数");
        const maxMarketQuantity = numberValue(instrument.maxMktSz, "市价最大张数");
        const maxStopQuantity = numberValue(instrument.maxStopSz, "止损最大张数");
        const maxLimitQuantity = numberValue(instrument.maxLmtSz, "限价最大张数");
        const maxQuantity = Math.min(maxMarketQuantity, maxStopQuantity);
        if (minQuantity > maxQuantity || minQuantity > maxLimitQuantity) {
          throw new Error("OKX最小张数超过单笔上限");
        }
        const maxNotional = optionalLimit(instrument.maxMktAmt, "市价最大金额");
        const maxLimitNotional = optionalLimit(instrument.maxLmtAmt, "限价最大金额");
        markets.push({
          id: instrument.instId,
          bookSymbol: instrument.instId,
          display: `${ticker} · ${listing.name.trim()}${listing.etf ? " · ETF" : ""}`,
          quickLabel: `${ticker}${listing.etf ? " · ETF" : ""}`,
          ticker,
          isEtf: listing.etf,
          underlyingName: listing.name.trim(),
          listedSymbol: listing.listedSymbol.trim(),
          contractMultiplier,
          quantityStep: String(instrument.lotSz).trim(),
          minQuantity,
          maxQuantity,
          maxLimitQuantity,
          maxNotional,
          maxLimitNotional,
          minNotional: 0,
          priceTick: String(instrument.tickSz).trim(),
          sourceMeta: { ...instrument },
        });
      } catch (error) {
        unavailable.push({ id: instrument.instId, reason: error.message });
      }
    }
    markets.sort((left, right) => left.id.localeCompare(right.id));
    const catalogNote = [
      `当前显示${markets.length}个精选股票/ETF永续合约；按指定名单筛选，非股票所有权。`,
      unavailable.length ? `${unavailable.length}个候选合约规格无效，已排除。` : "",
    ].join("");
    return {
      markets,
      dexMeta: null,
      catalogNote,
      unavailable,
      excludedCount: excluded,
    };
  }

  function oneSnapshot(response, label) {
    const rows = unwrap(response);
    if (rows.length !== 1 || !rows[0] || typeof rows[0] !== "object" || Array.isArray(rows[0])) {
      throw new Error(`OKX${label}快照无效`);
    }
    return rows[0];
  }

  function sourceTime(value, label, now, maxAge) {
    const time = numberValue(value, `${label}来源时间`);
    if (!Number.isSafeInteger(time)) throw new Error(`OKX${label}来源时间无效`);
    if (time > now + 5_000) throw new Error(`OKX${label}来源时间晚于当前时间`);
    if (now - time > maxAge) throw new Error(`OKX${label}已过期`);
    return time;
  }

  function levels(value, label) {
    if (!Array.isArray(value) || !value.length) throw new Error(`OKX${label}盘为空`);
    const result = value.map((row) => {
      if (!Array.isArray(row) || row.length < 2) throw new Error(`OKX${label}盘档位无效`);
      // OKX derivatives sizes are incremental contract counts, not shares or cumulative sizes.
      return [numberValue(row[0], `${label}盘价格`), numberValue(row[1], `${label}盘张数`, true)];
    });
    if (!result.some((row) => row[1] > 0)) throw new Error(`OKX${label}盘没有可用张数`);
    return result;
  }

  function normalizeBook(books, priceLimits, market, now = Date.now(), maxAge = 15_000) {
    const currentTime = numberValue(now, "当前时间");
    const ageLimit = numberValue(maxAge, "报价有效时长", true);
    const symbol = market?.bookSymbol;
    if (typeof symbol !== "string" || !symbol || symbol !== market.id) {
      throw new Error("OKX盘口合约名称无效");
    }
    const rawBook = oneSnapshot(books, "盘口");
    if (own(rawBook, "instId") && rawBook.instId !== symbol) {
      throw new Error("OKX盘口合约不匹配");
    }
    const bookTime = sourceTime(rawBook.ts, "盘口", currentTime, ageLimit);
    const bids = levels(rawBook.bids, "买");
    const asks = levels(rawBook.asks, "卖");
    const rawLimits = oneSnapshot(priceLimits, "限价");
    if (rawLimits.instId !== symbol) throw new Error("OKX限价合约不匹配");
    if (typeof rawLimits.enabled !== "boolean") throw new Error("OKX限价启用状态无效");
    const limitTime = sourceTime(rawLimits.ts, "限价", currentTime, ageLimit);
    const buyLmt = rawLimits.enabled ? numberValue(rawLimits.buyLmt, "买入限价") : null;
    const sellLmt = rawLimits.enabled ? numberValue(rawLimits.sellLmt, "卖出限价") : null;
    if (rawLimits.enabled && sellLmt > buyLmt) throw new Error("OKX买卖限价倒挂");
    return {
      bids,
      asks,
      // Both inputs must remain fresh; a newer book must not hide older price protection data.
      time: Math.min(bookTime, limitTime),
      priceLimits: { instId: symbol, enabled: rawLimits.enabled, buyLmt, sellLmt, ts: limitTime },
      depthProfile: { id: "okx-400", label: "OKX原始盘口·最多400档", approximate: false },
    };
  }

  function fees(market) {
    const instrument = market?.sourceMeta;
    if (!isStockSwap(instrument) || !market.ticker ||
        instrument.ctValCcy !== market.ticker ||
        instrument.instId !== `${market.ticker}-USDT-SWAP` ||
        market.id !== instrument.instId ||
        (instrument.groupId !== "4" && instrument.groupId !== 4)) {
      return {
        rate: null,
        takerRate: null,
        makerRate: null,
        product: "OKX精选股票/ETF永续",
        source: "费率组未知，请手动输入",
      };
    }
    return {
      rate: 0.0005,
      takerRate: 0.0005,
      makerRate: 0.0002,
      product: "OKX精选股票/ETF永续",
      source: "普通用户公开参考 · 非账户实测",
    };
  }

  function checkPriceLimits(result, book, execution, side) {
    if (result?.status !== "ok") return result;
    const limits = book?.priceLimits;
    if (!limits || typeof limits.enabled !== "boolean") throw new Error("OKX缺少有效限价状态");
    if (!limits.enabled) return result;
    const buyLmt = numberValue(limits.buyLmt, "买入限价");
    const sellLmt = numberValue(limits.sellLmt, "卖出限价");
    if (sellLmt > buyLmt) throw new Error("OKX买卖限价倒挂");
    let outside;
    if (execution === "market") {
      const buyLast = numberValue(result.buy?.lastPrice, "买入末档价格");
      const sellLast = numberValue(result.sell?.lastPrice, "卖出末档价格");
      outside = buyLast > buyLmt || sellLast < sellLmt;
    } else if (execution === "limit") {
      const direction = side ?? result.side;
      if (direction !== "long" && direction !== "short") throw new Error("OKX限价方向无效");
      const entryPrice = numberValue(result.limitPrice, "进场限价");
      // Current price bands constrain entry only; future stop bands cannot be known now.
      outside = direction === "long" ? entryPrice > buyLmt : entryPrice < sellLmt;
    } else {
      throw new Error("OKX成交方式无效");
    }
    return outside ? { ...result, status: "okx_price_limit" } : result;
  }

  return { unwrap, normalizeMarkets, normalizeBook, fees, checkPriceLimits };
});
