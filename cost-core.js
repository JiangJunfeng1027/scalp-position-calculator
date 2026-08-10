(function attachCostCore(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.CostCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function buildCostCore() {
  "use strict";

  const BP = 10_000;

  function asPositive(value, name) {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) {
      throw new Error(`${name}必须大于0`);
    }
    return number;
  }

  function decimalPlaces(value) {
    const text = String(value).toLowerCase();
    if (text.includes("e-")) {
      const [coefficient, exponentText] = text.split("e-");
      const coefficientDecimals = (coefficient.split(".")[1] || "").length;
      return Number(exponentText) + coefficientDecimals;
    }
    return (text.split(".")[1] || "").replace(/0+$/, "").length;
  }

  function floorToStep(value, stepValue) {
    const step = asPositive(stepValue, "数量步进");
    const decimals = Math.min(12, decimalPlaces(stepValue));
    const scale = 10 ** decimals;
    const stepInt = Math.max(1, Math.round(step * scale));
    const valueInt = Math.floor((Number(value) + Number.EPSILON) * scale);
    return Math.floor(valueInt / stepInt) * stepInt / scale;
  }

  function isStepAligned(value, stepValue) {
    const number = Number(value);
    const step = asPositive(stepValue, "价格步进");
    if (!Number.isFinite(number)) return false;
    const units = number / step;
    return Math.abs(units - Math.round(units)) <= 1e-8 * Math.max(1, Math.abs(units));
  }

  function normalizeLevels(levels, side) {
    if (!Array.isArray(levels) || levels.length === 0) {
      throw new Error(`${side === "bid" ? "买" : "卖"}盘为空`);
    }

    const normalized = levels.map((level) => {
      const price = Number(Array.isArray(level) ? level[0] : level.px);
      const size = Number(Array.isArray(level) ? level[1] : level.sz);
      if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(size) || size < 0) {
        throw new Error("盘口包含无效价格或数量");
      }
      return { price, size };
    });

    for (let index = 1; index < normalized.length; index += 1) {
      const previous = normalized[index - 1].price;
      const current = normalized[index].price;
      if (side === "ask" && current < previous) throw new Error("卖盘排序异常");
      if (side === "bid" && current > previous) throw new Error("买盘排序异常");
    }
    return normalized;
  }

  function bookSignature(bids, asks) {
    let fnv = 0x811c9dc5;
    let djb = 5381;
    const push = (value) => {
      const text = String(value);
      for (let index = 0; index < text.length; index += 1) {
        const code = text.charCodeAt(index);
        fnv = Math.imul(fnv ^ code, 0x01000193);
        djb = Math.imul(djb, 33) ^ code;
      }
      fnv = Math.imul(fnv ^ 124, 0x01000193);
      djb = Math.imul(djb, 33) ^ 124;
    };
    [bids, asks].forEach((side, sideIndex) => {
      push(sideIndex);
      side.forEach((level) => {
        push(Array.isArray(level) ? level[0] : level.px);
        push(Array.isArray(level) ? level[1] : level.sz);
      });
    });
    return `${(fnv >>> 0).toString(36)}:${(djb >>> 0).toString(36)}:${bids.length}:${asks.length}`;
  }

  function resolveBybitServerWallTime(rawWallTimeValue, receivedAtValue, futureToleranceMs = 5_000) {
    const rawWallTime = asPositive(rawWallTimeValue, "Bybit服务器报价时间");
    const receivedAt = asPositive(receivedAtValue, "Bybit报价接收时间");
    const tolerance = Number(futureToleranceMs);
    if (!Number.isFinite(tolerance) || tolerance < 0) throw new Error("未来时间容差不能为负数");

    // tsE3 is an MT5 server wall-clock value encoded as an epoch. Bybit uses
    // UTC+3 from the second Sunday of March until the first Sunday of November,
    // and UTC+2 otherwise. Validate each candidate against that rule before
    // comparing it with the receive timestamp; choosing the newest candidate
    // alone can make a one-hour-old quote look current.
    const hour = 60 * 60 * 1_000;
    const nthSundayAt02Utc = (year, month, ordinal) => {
      const firstDay = new Date(Date.UTC(year, month, 1)).getUTCDay();
      const firstSunday = 1 + ((7 - firstDay) % 7);
      return Date.UTC(year, month, firstSunday + (ordinal - 1) * 7, 2);
    };
    const officialOffsetAtUtc = (timestamp) => {
      const year = new Date(timestamp).getUTCFullYear();
      const summerStart = nthSundayAt02Utc(year, 2, 2);
      const summerEnd = nthSundayAt02Utc(year, 10, 1);
      return timestamp >= summerStart && timestamp < summerEnd ? 3 : 2;
    };
    const candidates = [2, 3]
      .map((offset) => ({ offset, timestamp: rawWallTime - offset * hour }))
      .filter(({ offset, timestamp }) => (
        officialOffsetAtUtc(timestamp) === offset && timestamp <= receivedAt + tolerance
      ));
    if (candidates.length !== 1) {
      throw new Error(candidates.length
        ? "Bybit服务器报价时间处于夏令时重叠区间，已拒绝估算"
        : "Bybit服务器报价时间异常地晚于接收时间");
    }
    return candidates[0].timestamp;
  }

  function sweep(levels, targetQuantity, contractMultiplierValue = 1) {
    const contractMultiplier = asPositive(contractMultiplierValue, "合约乘数");
    let remaining = targetQuantity;
    let filledQuantity = 0;
    let value = 0;
    let levelsUsed = 0;
    let lastPrice = null;

    for (const level of levels) {
      if (remaining <= 1e-12) break;
      const take = Math.min(remaining, level.size);
      if (take <= 0) continue;
      value += take * level.price;
      filledQuantity += take;
      remaining -= take;
      lastPrice = level.price;
      levelsUsed += 1;
    }

    return {
      complete: remaining <= Math.max(1e-12, targetQuantity * 1e-12),
      filledQuantity,
      remainingQuantity: Math.max(0, remaining),
      vwap: filledQuantity > 0 ? value / filledQuantity : null,
      visibleNotional: value * contractMultiplier,
      levelsUsed,
      lastPrice,
      totalVisibleQuantity: levels.reduce((sum, level) => sum + level.size, 0),
      totalVisibleNotional:
        levels.reduce((sum, level) => sum + level.size * level.price, 0) * contractMultiplier,
    };
  }

  function estimate(config) {
    const stopPercent = asPositive(config.stopPercent, "止损距离");
    const requestedRisk = asPositive(config.risk, "风险");
    const takerRate = Number(config.takerRate);
    if (!Number.isFinite(takerRate) || takerRate < 0) throw new Error("费率无效");
    const contractMultiplier = asPositive(config.contractMultiplier ?? 1, "合约乘数");
    const fixedRoundTripCommissionPerQuantity = Number(
      config.fixedRoundTripCommissionPerQuantity ?? 0,
    );
    if (
      !Number.isFinite(fixedRoundTripCommissionPerQuantity) ||
      fixedRoundTripCommissionPerQuantity < 0
    ) {
      throw new Error("完整往返固定佣金无效");
    }

    const bids = normalizeLevels(config.bids, "bid");
    const asks = normalizeLevels(config.asks, "ask");
    const bestBid = bids[0].price;
    const bestAsk = asks[0].price;
    const allowLockedBook = config.allowLockedBook === true;
    if (bestAsk < bestBid || (!allowLockedBook && bestAsk === bestBid)) {
      throw new Error("盘口交叉或倒挂");
    }

    const mid = (bestBid + bestAsk) / 2;
    const stopFraction = stopPercent / 100;
    const theoreticalNotional = requestedRisk / stopFraction;
    const rawQuantity = theoreticalNotional / (mid * contractMultiplier);
    const quantityStep = config.quantityStep || 1e-8;
    const quantity = floorToStep(rawQuantity, quantityStep);
    const minQuantity = Number(config.minQuantity || 0);
    const maxQuantity = Number(config.maxQuantity ?? Infinity);
    const maxNotional = Number(config.maxNotional ?? Infinity);
    const minNotional = Number(config.minNotional || 0);

    if (!(quantity > 0) || quantity < minQuantity) {
      return {
        status: "below_min_quantity",
        mid,
        theoreticalNotional,
        rawQuantity,
        quantity,
        contractMultiplier,
      };
    }
    if (quantity > maxQuantity + 1e-12) {
      return {
        status: "above_market_max",
        mid,
        theoreticalNotional,
        rawQuantity,
        quantity,
        maxQuantity,
        contractMultiplier,
      };
    }

    const actualNotional = quantity * contractMultiplier * mid;
    const actualPriceRisk = actualNotional * stopFraction;
    if (actualNotional > maxNotional + 1e-9) {
      return {
        status: "above_market_max_notional",
        mid,
        theoreticalNotional,
        rawQuantity,
        quantity,
        actualNotional,
        maxNotional,
        contractMultiplier,
      };
    }
    if (actualNotional < minNotional) {
      return {
        status: "below_min_notional",
        mid,
        theoreticalNotional,
        rawQuantity,
        quantity,
        actualNotional,
        minNotional,
        contractMultiplier,
      };
    }

    const buy = sweep(asks, quantity, contractMultiplier);
    const sell = sweep(bids, quantity, contractMultiplier);
    if (!buy.complete || !sell.complete) {
      return {
        status: "insufficient_snapshot_depth",
        mid,
        theoreticalNotional,
        rawQuantity,
        quantity,
        actualNotional,
        actualPriceRisk,
        buy,
        sell,
        contractMultiplier,
      };
    }

    const marketTakeBound = Number(config.marketTakeBound);
    const markPrice = Number(config.markPrice);
    if (Number.isFinite(marketTakeBound) && marketTakeBound >= 0 && Number.isFinite(markPrice) && markPrice > 0) {
      const buyLimit = markPrice * (1 + marketTakeBound);
      const sellLimit = markPrice * (1 - marketTakeBound);
      if (buy.lastPrice > buyLimit + 1e-12 || sell.lastPrice < sellLimit - 1e-12) {
        return {
          status: "market_take_bound",
          mid,
          markPrice,
          marketTakeBound,
          buyLimit,
          sellLimit,
          theoreticalNotional,
          rawQuantity,
          quantity,
          actualNotional,
          actualPriceRisk,
          buy,
          sell,
          contractMultiplier,
        };
      }
    }

    const buySlip = (buy.vwap - mid) / mid;
    const sellSlip = (mid - sell.vwap) / mid;
    if (buySlip < 0 || sellSlip < 0) throw new Error("盘口滑点方向异常");

    const proportionalFeeCost =
      quantity * contractMultiplier * takerRate * (buy.vwap + sell.vwap);
    // This input is already the fee for the complete entry/exit cycle.
    // Charge it once per rounded contract quantity; never double it by leg.
    const fixedCommissionCost = quantity * fixedRoundTripCommissionPerQuantity;
    const feeCost = proportionalFeeCost + fixedCommissionCost;
    const directionalBookCost = quantity * contractMultiplier * (buy.vwap - sell.vwap);
    const conservativeBookCost =
      2 * quantity * contractMultiplier * Math.max(buy.vwap - mid, mid - sell.vwap);
    const directionalCost = feeCost + directionalBookCost;
    const conservativeCost = feeCost + conservativeBookCost;
    const spreadCost = quantity * contractMultiplier * (bestAsk - bestBid);
    const buyImpactCost = quantity * contractMultiplier * Math.max(0, buy.vwap - bestAsk);
    const sellImpactCost = quantity * contractMultiplier * Math.max(0, bestBid - sell.vwap);

    return {
      status: "ok",
      mid,
      bestBid,
      bestAsk,
      spreadBp: ((bestAsk - bestBid) / mid) * BP,
      stopPercent,
      requestedRisk,
      theoreticalNotional,
      rawQuantity,
      quantity,
      quantityStep: Number(quantityStep),
      contractMultiplier,
      actualNotional,
      actualPriceRisk,
      takerRate,
      buy,
      sell,
      buySlipBp: buySlip * BP,
      sellSlipBp: sellSlip * BP,
      buyLastBp: ((buy.lastPrice - mid) / mid) * BP,
      sellLastBp: ((mid - sell.lastPrice) / mid) * BP,
      fixedRoundTripCommissionPerQuantity,
      fixedCommissionCost,
      proportionalFeeCost,
      feeCost,
      feeRiskPercent: (feeCost / requestedRisk) * 100,
      spreadCost,
      buyImpactCost,
      sellImpactCost,
      directionalBookCost,
      conservativeBookCost,
      directionalCost,
      conservativeCost,
      directionalRiskPercent: (directionalCost / requestedRisk) * 100,
      conservativeRiskPercent: (conservativeCost / requestedRisk) * 100,
      directionalRateBp: (directionalCost / actualNotional) * BP,
      conservativeRateBp: (conservativeCost / actualNotional) * BP,
      totalLossDirectional: actualPriceRisk + directionalCost,
      totalLossConservative: actualPriceRisk + conservativeCost,
    };
  }

  function estimateLimitEntryMarketStop(config) {
    const stopPercent = asPositive(config.stopPercent, "止损距离");
    const requestedRisk = asPositive(config.risk, "风险");
    const limitPrice = asPositive(config.limitPrice, "限价");
    const side = String(config.side || "").toLowerCase();
    if (side !== "long" && side !== "short") throw new Error("方向必须是long或short");

    const makerRate = Number(config.makerRate);
    const takerRate = Number(config.takerRate);
    if (!Number.isFinite(makerRate)) throw new Error("Maker费率无效");
    if (!Number.isFinite(takerRate) || takerRate < 0) throw new Error("Taker费率无效");
    const contractMultiplier = asPositive(config.contractMultiplier ?? 1, "合约乘数");
    const fixedRoundTripCommissionPerQuantity = Number(
      config.fixedRoundTripCommissionPerQuantity ?? 0,
    );
    if (
      !Number.isFinite(fixedRoundTripCommissionPerQuantity) ||
      fixedRoundTripCommissionPerQuantity < 0
    ) {
      throw new Error("完整往返固定佣金无效");
    }

    const bids = normalizeLevels(config.bids, "bid");
    const asks = normalizeLevels(config.asks, "ask");
    const entryBids = config.entryBids ? normalizeLevels(config.entryBids, "bid") : bids;
    const entryAsks = config.entryAsks ? normalizeLevels(config.entryAsks, "ask") : asks;
    const bestBid = entryBids[0].price;
    const bestAsk = entryAsks[0].price;
    if (bestAsk <= bestBid) throw new Error("盘口交叉或倒挂");
    const mid = (bestBid + bestAsk) / 2;
    const bookBestBid = bids[0].price;
    const bookBestAsk = asks[0].price;
    if (bookBestAsk <= bookBestBid) throw new Error("止损代理盘口交叉或倒挂");
    const bookMid = (bookBestBid + bookBestAsk) / 2;

    const common = {
      executionMode: "limit_maker_market_stop",
      side,
      postOnly: config.postOnly === true,
      conditionalOnFullFill: true,
      fillAssumption: "post_only_full_fill",
      unfilledCost: 0,
      unfilledQuantity: 0,
      requestedRisk,
      stopPercent,
      limitPrice,
      bestBid,
      bestAsk,
      mid,
      bookBestBid,
      bookBestAsk,
      bookMid,
      makerRate,
      takerRate,
      contractMultiplier,
      fixedRoundTripCommissionPerQuantity,
    };

    if (config.postOnly !== true) return { ...common, status: "post_only_required" };
    if (
      (side === "long" && limitPrice >= bestAsk - 1e-12) ||
      (side === "short" && limitPrice <= bestBid + 1e-12)
    ) {
      return { ...common, status: "would_take_liquidity" };
    }

    if (config.priceTick != null && config.priceTick !== "" && !isStepAligned(limitPrice, config.priceTick)) {
      return {
        ...common,
        status: "invalid_limit_tick",
        priceTick: Number(config.priceTick),
      };
    }

    const stopFraction = stopPercent / 100;
    const theoreticalNotional = requestedRisk / stopFraction;
    const rawQuantity = theoreticalNotional / (limitPrice * contractMultiplier);
    const quantityStep = config.quantityStep || 1e-8;
    const quantity = floorToStep(rawQuantity, quantityStep);
    const minQuantity = Number(config.minQuantity || 0);
    const maxQuantity = Number(config.maxQuantity ?? Infinity);
    const minNotional = Number(config.minNotional || 0);
    const maxNotional = Number(config.maxNotional ?? Infinity);
    const sized = {
      ...common,
      theoreticalNotional,
      rawQuantity,
      quantity,
      quantityStep: Number(quantityStep),
    };

    if (!(quantity > 0) || quantity < minQuantity) {
      return { ...sized, status: "below_min_quantity", minQuantity };
    }
    if (quantity > maxQuantity + 1e-12) {
      return { ...sized, status: "above_market_max", maxQuantity };
    }

    const actualNotional = quantity * contractMultiplier * limitPrice;
    const actualPriceRisk = actualNotional * stopFraction;
    const stopReferencePrice = side === "long"
      ? limitPrice * (1 - stopFraction)
      : limitPrice * (1 + stopFraction);
    const positioned = {
      ...sized,
      actualNotional,
      actualPriceRisk,
      stopReferencePrice,
    };

    if (!(stopReferencePrice > 0)) return { ...positioned, status: "invalid_stop_price" };
    if (actualNotional > maxNotional + 1e-9) {
      return { ...positioned, status: "above_market_max_notional", maxNotional };
    }
    if (actualNotional < minNotional) {
      return { ...positioned, status: "below_min_notional", minNotional };
    }

    // The stop model consumes one side only, but keep both sweeps in the
    // result as an informational depth diagnostic for the shared UI.
    const buy = sweep(asks, quantity, contractMultiplier);
    const sell = sweep(bids, quantity, contractMultiplier);
    const buySlip = buy.vwap == null ? null : Math.max(0, (buy.vwap - bookMid) / bookMid);
    const sellSlip = sell.vwap == null ? null : Math.max(0, (bookMid - sell.vwap) / bookMid);
    const buyLastBp = buy.lastPrice == null ? null : ((buy.lastPrice - bookMid) / bookMid) * BP;
    const sellLastBp = sell.lastPrice == null ? null : ((bookMid - sell.lastPrice) / bookMid) * BP;
    const stopBookSide = side === "long" ? "bid" : "ask";
    const stopSweep = side === "long" ? sell : buy;
    if (!stopSweep.complete) {
      return {
        ...positioned,
        status: "insufficient_stop_depth",
        stopBookSide,
        stopSweep,
        buy,
        sell,
      };
    }

    const rawStopSideSlip = side === "long"
      ? (bookMid - stopSweep.vwap) / bookMid
      : (stopSweep.vwap - bookMid) / bookMid;
    if (rawStopSideSlip < -1e-12) throw new Error("止损侧滑点方向异常");
    const stopSideSlip = Math.max(0, rawStopSideSlip);
    const stopL2ProxyPrice = stopReferencePrice * (stopSweep.vwap / bookMid);
    const stopL2ProxyLastPrice = stopReferencePrice * (stopSweep.lastPrice / bookMid);

    const extraGapBp = Number(config.extraGapBp || 0);
    if (!Number.isFinite(extraGapBp) || extraGapBp < 0 || extraGapBp >= BP) {
      throw new Error("额外跳空bp必须在0到10000之间");
    }
    const extraGapFraction = extraGapBp / BP;
    const gapMultiplier = side === "long" ? 1 - extraGapFraction : 1 + extraGapFraction;
    const stopProxyPrice = stopL2ProxyPrice * gapMultiplier;
    const stopProxyLastPrice = stopL2ProxyLastPrice * gapMultiplier;

    const configuredStopMarkPrice = Number(config.stopMarkPrice);
    const currentMarkPrice = Number(config.markPrice);
    const stopProtectionReference = Number.isFinite(configuredStopMarkPrice) && configuredStopMarkPrice > 0
      ? configuredStopMarkPrice
      : Number.isFinite(currentMarkPrice) && currentMarkPrice > 0
        ? stopReferencePrice * (currentMarkPrice / mid)
        : stopReferencePrice;
    const hasMarketTakeBound = config.marketTakeBound != null && config.marketTakeBound !== "";
    const marketTakeBound = hasMarketTakeBound ? Number(config.marketTakeBound) : NaN;
    if (Number.isFinite(marketTakeBound) && marketTakeBound < 0) {
      throw new Error("市价保护边界不能为负");
    }
    if (Number.isFinite(marketTakeBound)) {
      const stopSellLimit = stopProtectionReference * (1 - marketTakeBound);
      const stopBuyLimit = stopProtectionReference * (1 + marketTakeBound);
      const violatesBound = side === "long"
        ? stopProxyLastPrice < stopSellLimit - 1e-12
        : stopProxyLastPrice > stopBuyLimit + 1e-12;
      if (violatesBound) {
        return {
          ...positioned,
          status: "market_take_bound",
          stopBookSide,
          stopSweep,
          stopSideSlipBp: stopSideSlip * BP,
          stopL2ProxyPrice,
          stopL2ProxyLastPrice,
          stopProxyPrice,
          stopProxyLastPrice,
          stopProtectionReference,
          marketTakeBound,
          stopSellLimit,
          stopBuyLimit,
          extraGapBp,
        };
      }
    }

    const stopBookSlipCost =
      quantity * contractMultiplier * Math.abs(stopL2ProxyPrice - stopReferencePrice);
    const stopGapCost =
      quantity * contractMultiplier * Math.abs(stopProxyPrice - stopL2ProxyPrice);
    const stopSlipCost = stopBookSlipCost + stopGapCost;
    const entryFeeOrRebate = quantity * contractMultiplier * limitPrice * makerRate;
    const stopTakerFeeCost = quantity * contractMultiplier * stopProxyPrice * takerRate;
    const stopNotional = quantity * contractMultiplier * stopProxyPrice;
    const proportionalFeeCost = entryFeeOrRebate + stopTakerFeeCost;
    // As above, this is a complete-cycle commission even though the broker
    // may debit it at entry, so it is added exactly once after a full fill.
    const fixedCommissionCost = quantity * fixedRoundTripCommissionPerQuantity;
    const feeCost = proportionalFeeCost + fixedCommissionCost;
    const conditionalTotalCost = feeCost + stopSlipCost;
    const entryQueueLevels = side === "long" ? entryBids : entryAsks;
    const entryVisibleQueueAheadQuantity = entryQueueLevels.reduce((sum, level) => {
      const ahead = side === "long" ? level.price >= limitPrice : level.price <= limitPrice;
      return ahead ? sum + level.size : sum;
    }, 0);

    return {
      ...positioned,
      status: "ok",
      spreadBp: ((bestAsk - bestBid) / mid) * BP,
      limitDistanceFromMidPercent: Math.abs(limitPrice - mid) / mid * 100,
      buy,
      sell,
      buySlipBp: buySlip == null ? null : buySlip * BP,
      sellSlipBp: sellSlip == null ? null : sellSlip * BP,
      buyLastBp,
      sellLastBp,
      stopBookSide,
      stopSweep,
      stopSideSlipBp: stopSideSlip * BP,
      stopLastSlipBp: side === "long"
        ? ((bookMid - stopSweep.lastPrice) / bookMid) * BP
        : ((stopSweep.lastPrice - bookMid) / bookMid) * BP,
      stopL2ProxyPrice,
      stopL2ProxyLastPrice,
      stopProxyPrice,
      stopProxyLastPrice,
      stopProtectionReference,
      marketTakeBound: Number.isFinite(marketTakeBound) ? marketTakeBound : null,
      extraGapBp,
      entryBookCost: 0,
      stopBookSlipCost,
      stopGapCost,
      stopSlipCost,
      entryFeeOrRebate,
      entryMakerFeeCost: Math.max(0, entryFeeOrRebate),
      entryMakerRebate: Math.max(0, -entryFeeOrRebate),
      stopTakerFeeCost,
      stopNotional,
      fixedCommissionCost,
      proportionalFeeCost,
      feeCost,
      feeRiskPercent: (feeCost / requestedRisk) * 100,
      conditionalTotalCost,
      conditionalRiskPercent: (conditionalTotalCost / requestedRisk) * 100,
      conditionalRateBp: (conditionalTotalCost / actualNotional) * BP,
      conditionalTotalLoss: actualPriceRisk + conditionalTotalCost,
      totalLossConditional: actualPriceRisk + conditionalTotalCost,
      entryVisibleQueueAheadQuantity,
      entryVisibleQueueAheadNotional:
        entryVisibleQueueAheadQuantity * contractMultiplier * limitPrice,
    };
  }

  function median(values) {
    if (!values.length) return null;
    const sorted = [...values].sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2
      ? sorted[middle]
      : (sorted[middle - 1] + sorted[middle]) / 2;
  }

  function pickSample(samples, mode, field) {
    const valid = samples.filter((sample) => Number.isFinite(sample.result?.[field]));
    if (!valid.length) return null;
    if (mode === "current") return valid[valid.length - 1];
    const sorted = [...valid].sort((left, right) => left.result[field] - right.result[field]);
    if (mode === "worst") return sorted[sorted.length - 1];
    const middle = Math.floor(sorted.length / 2);
    if (sorted.length % 2) return sorted[middle];
    const left = sorted[middle - 1];
    const right = sorted[middle];
    return {
      id: `median:${left.id}:${right.id}`,
      time: (Number(left.time) + Number(right.time)) / 2,
      synthetic: true,
      result: averageRecords(left.result, right.result),
    };
  }

  function averageRecords(left, right) {
    const output = {};
    const keys = new Set([...Object.keys(left || {}), ...Object.keys(right || {})]);
    keys.forEach((key) => {
      const leftValue = left?.[key];
      const rightValue = right?.[key];
      if (Number.isFinite(leftValue) && Number.isFinite(rightValue)) {
        output[key] = (leftValue + rightValue) / 2;
      } else if (
        leftValue &&
        rightValue &&
        typeof leftValue === "object" &&
        typeof rightValue === "object" &&
        !Array.isArray(leftValue) &&
        !Array.isArray(rightValue)
      ) {
        output[key] = averageRecords(leftValue, rightValue);
      } else {
        output[key] = rightValue ?? leftValue;
      }
    });
    return output;
  }

  function inferBinanceFees(symbolMeta, bnbEnabled) {
    const withDiscount = bnbEnabled !== false;
    if (symbolMeta?.contractType === "TRADIFI_PERPETUAL") {
      const takerRate = withDiscount ? 0.00036 : 0.0004;
      // Binance currently lists a zero maker fee for TradFi perpetuals.
      // Keep this separate from the crypto-perpetual BNB maker discount.
      const makerRate = 0;
      return {
        rate: takerRate,
        takerRate,
        makerRate,
        product: "TradFi永续",
        source: withDiscount ? "VIP0＋BNB默认值" : "VIP0默认值",
      };
    }
    if (symbolMeta?.contractType === "PERPETUAL" && symbolMeta?.underlyingType === "COIN") {
      const takerRate = withDiscount ? 0.00045 : 0.0005;
      const makerRate = withDiscount ? 0.00018 : 0.0002;
      return {
        rate: takerRate,
        takerRate,
        makerRate,
        product: "币圈永续",
        source: withDiscount ? "VIP0＋BNB默认值" : "VIP0默认值",
      };
    }
    return {
      rate: null,
      takerRate: null,
      makerRate: null,
      product: "未识别产品",
      source: "需要手动费率",
    };
  }

  function inferBinanceTaker(symbolMeta, bnbEnabled) {
    return inferBinanceFees(symbolMeta, bnbEnabled);
  }

  function inferHyperliquidFees(asset, dexMeta, isMain) {
    const baseTaker = 0.00045;
    const baseMaker = 0.00015;
    if (isMain) {
      return {
        rate: baseTaker,
        takerRate: baseTaker,
        makerRate: baseMaker,
        product: "HL主市场永续",
        source: "Tier 0默认值",
        growth: false,
      };
    }

    const rawScale = asset?.deployerFeeScale ?? dexMeta?.deployerFeeScale;
    const scale = Number(rawScale);
    if (!Number.isFinite(scale) || scale < 0) {
      return {
        rate: null,
        takerRate: null,
        makerRate: null,
        product: "HIP-3永续",
        source: "部署费率未知",
      };
    }
    const hip3Scale = scale < 1 ? 1 + scale : 2 * scale;
    const growth = asset?.growthMode === "enabled" || asset?.growthMode === true;
    const growthScale = growth ? 0.1 : 1;
    const takerRate = baseTaker * hip3Scale * growthScale;
    const makerRate = baseMaker * hip3Scale * growthScale;
    return {
      rate: takerRate,
      takerRate,
      makerRate,
      product: growth ? "HIP-3增长模式" : "HIP-3标准模式",
      source: asset?.deployerFeeScale != null ? "资产级链上参数" : "DEX级回退参数",
      growth,
      deployerFeeScale: scale,
    };
  }

  function inferHyperliquidTaker(asset, dexMeta, isMain) {
    return inferHyperliquidFees(asset, dexMeta, isMain);
  }

  return {
    BP,
    decimalPlaces,
    floorToStep,
    isStepAligned,
    normalizeLevels,
    bookSignature,
    resolveBybitServerWallTime,
    sweep,
    estimate,
    estimateLimitEntryMarketStop,
    median,
    pickSample,
    averageRecords,
    inferBinanceFees,
    inferBinanceTaker,
    inferHyperliquidFees,
    inferHyperliquidTaker,
  };
});
