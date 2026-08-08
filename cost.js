(function runCostEstimator() {
  "use strict";

  const core = window.CostCore;
  const BINANCE_API = "https://fapi.binance.com";
  const HL_INFO = "https://api.hyperliquid.xyz/info";
  const DEFAULT_MAX_SAMPLES = 60;
  const HL_PROFILE_REPROBE_MS = 60_000;
  const HL_DEPTH_PROFILES = [
    { id: "raw", label: "原始20档·精确", params: null, approximate: false },
    { id: "5x2", label: "5位×2聚合·近似", params: { nSigFigs: 5, mantissa: 2 }, approximate: true },
    { id: "5x5", label: "5位×5聚合·近似", params: { nSigFigs: 5, mantissa: 5 }, approximate: true },
    { id: "4sig", label: "4位聚合·近似", params: { nSigFigs: 4 }, approximate: true },
    { id: "3sig", label: "3位聚合·低精度", params: { nSigFigs: 3 }, approximate: true, lowPrecision: true },
  ];
  const STORAGE_KEY = "execution-cost-estimator-v1";
  const CACHE_PREFIX = "execution-cost-markets-v3:";
  const FEE_CHECKED_AT = "2026-08-08";
  const METADATA_SOFT_TTL = 5 * 60 * 1000;
  const METADATA_HARD_TTL = 60 * 60 * 1000;

  const byId = (id) => document.getElementById(id);
  const el = {
    platform: byId("platform"),
    symbol: byId("symbol"),
    symbols: byId("symbols"),
    symbolCount: byId("symbolCount"),
    productNote: byId("productNote"),
    executionNote: byId("executionNote"),
    limitControls: byId("limitControls"),
    methodBlock: byId("methodBlock"),
    limitPrice: byId("limitPrice"),
    resetLimitPrice: byId("resetLimitPrice"),
    stopPercent: byId("stopPercent"),
    risk: byId("risk"),
    takerFee: byId("takerFee"),
    feeNote: byId("feeNote"),
    resetFee: byId("resetFee"),
    makerFee: byId("makerFee"),
    makerFeeNote: byId("makerFeeNote"),
    resetMakerFee: byId("resetMakerFee"),
    bnbRow: byId("bnbRow"),
    bnbDiscount: byId("bnbDiscount"),
    redline: byId("redline"),
    sampleInterval: byId("sampleInterval"),
    sampleWindow: byId("sampleWindow"),
    depthModeBlock: byId("depthModeBlock"),
    depthMode: byId("depthMode"),
    refreshNow: byId("refreshNow"),
    toggleLive: byId("toggleLive"),
    liveState: byId("liveState"),
    liveLabel: byId("liveLabel"),
    liveTime: byId("liveTime"),
    contextPlatform: byId("contextPlatform"),
    contextSymbol: byId("contextSymbol"),
    frameCount: byId("frameCount"),
    heroResult: byId("heroResult"),
    heroLabel: byId("heroLabel"),
    heroValue: byId("heroValue"),
    heroVerdict: byId("heroVerdict"),
    riskFill: byId("riskFill"),
    currentStat: byId("currentStat"),
    medianStat: byId("medianStat"),
    worstStat: byId("worstStat"),
    positionValue: byId("positionValue"),
    quantityValue: byId("quantityValue"),
    costValue: byId("costValue"),
    costRateValue: byId("costRateValue"),
    totalLossValue: byId("totalLossValue"),
    actualRiskValue: byId("actualRiskValue"),
    midValue: byId("midValue"),
    spreadValue: byId("spreadValue"),
    feeBar: byId("feeBar"),
    bookBar: byId("bookBar"),
    feeValue: byId("feeValue"),
    bookValue: byId("bookValue"),
    buySlipValue: byId("buySlipValue"),
    sellSlipValue: byId("sellSlipValue"),
    feeBreakdownLabel: byId("feeBreakdownLabel"),
    bookBreakdownLabel: byId("bookBreakdownLabel"),
    limitAssumption: byId("limitAssumption"),
    copySummary: byId("copySummary"),
    windowAge: byId("windowAge"),
    windowTitle: byId("windowTitle"),
    sparkline: byId("sparkline"),
    sparkArea: byId("sparkArea"),
    sparkPath: byId("sparkPath"),
    sparkRedline: byId("sparkRedline"),
    depthState: byId("depthState"),
    depthQuality: byId("depthQuality"),
    buyLevels: byId("buyLevels"),
    sellLevels: byId("sellLevels"),
    buyLast: byId("buyLast"),
    sellLast: byId("sellLast"),
    buyDepth: byId("buyDepth"),
    sellDepth: byId("sellDepth"),
    message: byId("message"),
    resultsPanel: byId("resultsPanel"),
  };

  const state = {
    platform: "binance",
    markets: [],
    market: null,
    dexMeta: null,
    metadataSource: "live",
    autoFee: null,
    feeManual: false,
    makerFeeManual: false,
    execution: "market",
    side: "long",
    limitPriceManual: false,
    method: "conservative",
    view: "worst",
    samples: [],
    sampleIds: new Set(),
    currentSample: null,
    lastBook: null,
    lastBookMarketId: null,
    liveEnabled: true,
    timer: null,
    inFlight: null,
    abortController: null,
    bookController: null,
    bookRequestToken: 0,
    errorCount: 0,
    loadToken: 0,
    lastSuccessAt: null,
    lastObservedBookId: null,
    lastChangeAt: null,
    bookStale: false,
    metadataFetchedAt: null,
    metadataTimer: null,
    hlDepthProfileIndex: 0,
    hlDepthProfileCheckedAt: 0,
  };

  function numberValue(input) {
    const raw = String(input.value).replace(/[,%\s]/g, "").trim();
    if (!raw) return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  }

  function maxSamples() {
    const value = Number(el.sampleWindow?.value);
    return [20, 60, 120].includes(value) ? value : DEFAULT_MAX_SAMPLES;
  }

  function format(value, digits = 2) {
    if (!Number.isFinite(value)) return "--";
    const absolute = Math.abs(value);
    const maximumFractionDigits = absolute >= 1000 ? Math.min(2, digits) : absolute >= 1 ? digits : 5;
    return new Intl.NumberFormat("en-US", {
      maximumFractionDigits,
      minimumFractionDigits: 0,
    }).format(value);
  }

  function formatPercent(value, digits = 2) {
    return Number.isFinite(value) ? `${format(value, digits)}%` : "--";
  }

  function formatBp(value, digits = 2) {
    return Number.isFinite(value) ? `${format(value, digits)} bp` : "--";
  }

  function formatClock(timestamp) {
    if (!timestamp) return "--:--:--";
    return new Intl.DateTimeFormat("zh-CN", {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).format(new Date(timestamp));
  }

  function setLiveState(kind, label, timestamp = state.lastSuccessAt) {
    el.liveState.dataset.state = kind;
    el.liveLabel.textContent = label;
    el.liveTime.textContent = formatClock(timestamp);
  }

  function setMessage(text, kind = "info") {
    el.message.textContent = text;
    el.message.dataset.kind = kind;
  }

  function savePreferences() {
    const payload = {
      platform: state.platform,
      symbol: el.symbol.value.trim(),
      stopPercent: el.stopPercent.value,
      risk: el.risk.value,
      redline: el.redline.value,
      interval: el.sampleInterval.value,
      sampleWindow: el.sampleWindow.value,
      depthMode: el.depthMode.value,
      bnbDiscount: el.bnbDiscount.checked,
      execution: state.execution,
      side: state.side,
      method: state.method,
      view: state.view,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  }

  function loadPreferences() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
      if (["binance", "hl-main", "hl-xyz"].includes(saved.platform)) {
        state.platform = saved.platform;
        el.platform.value = saved.platform;
      }
      if (saved.symbol) el.symbol.value = saved.symbol;
      if (Number(saved.stopPercent) > 0) el.stopPercent.value = saved.stopPercent;
      if (Number(saved.risk) > 0) el.risk.value = saved.risk;
      if (Number(saved.redline) > 0) el.redline.value = saved.redline;
      if (["2000", "3000", "5000"].includes(saved.interval)) el.sampleInterval.value = saved.interval;
      if (["20", "60", "120"].includes(saved.sampleWindow)) el.sampleWindow.value = saved.sampleWindow;
      if (["auto", "raw"].includes(saved.depthMode)) el.depthMode.value = saved.depthMode;
      if (typeof saved.bnbDiscount === "boolean") el.bnbDiscount.checked = saved.bnbDiscount;
      if (["market", "limit"].includes(saved.execution)) state.execution = saved.execution;
      if (["long", "short"].includes(saved.side)) state.side = saved.side;
      if (["directional", "conservative"].includes(saved.method)) state.method = saved.method;
      if (["current", "median", "worst"].includes(saved.view)) state.view = saved.view;
    } catch {
      localStorage.removeItem(STORAGE_KEY);
    }
  }

  function cacheMarkets(key, payload) {
    try {
      localStorage.setItem(`${CACHE_PREFIX}${key}`, JSON.stringify({ savedAt: Date.now(), payload }));
    } catch {
      // Metadata cache is optional; live data remains authoritative.
    }
  }

  function readMarketCache(key) {
    try {
      const cached = JSON.parse(localStorage.getItem(`${CACHE_PREFIX}${key}`) || "null");
      if (
        !cached?.payload ||
        !cached.savedAt ||
        !Array.isArray(cached.payload.markets) ||
        !cached.payload.markets.every((market) => market && market.id && market.bookSymbol)
      ) {
        localStorage.removeItem(`${CACHE_PREFIX}${key}`);
        return null;
      }
      if (Date.now() - cached.savedAt > METADATA_HARD_TTL) {
        localStorage.removeItem(`${CACHE_PREFIX}${key}`);
        return null;
      }
      return cached;
    } catch {
      return null;
    }
  }

  async function fetchJson(url, options = {}) {
    const { signal: parentSignal, ...requestOptions } = options;
    const controller = new AbortController();
    let timedOut = false;
    const abortFromParent = () => controller.abort();
    if (parentSignal?.aborted) controller.abort();
    else parentSignal?.addEventListener("abort", abortFromParent, { once: true });
    const timeout = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 8000);
    try {
      const response = await fetch(url, {
        mode: "cors",
        credentials: "omit",
        cache: "no-store",
        ...requestOptions,
        signal: controller.signal,
      });
      let body;
      try {
        body = await response.json();
      } catch {
        throw new Error(`HTTP ${response.status}：响应不是JSON`);
      }
      if (!response.ok || (body && Number(body.code) < 0)) {
        throw new Error(body?.msg || `HTTP ${response.status}`);
      }
      return body;
    } catch (error) {
      if (timedOut) throw new Error("请求8秒超时");
      throw error;
    } finally {
      window.clearTimeout(timeout);
      parentSignal?.removeEventListener("abort", abortFromParent);
    }
  }

  function hlInfo(body, signal) {
    return fetchJson(HL_INFO, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  }

  function relevantBinanceFilters(symbol) {
    const lot = symbol.filters?.find((filter) => filter.filterType === "MARKET_LOT_SIZE") ||
      symbol.filters?.find((filter) => filter.filterType === "LOT_SIZE");
    const minNotionalFilter = symbol.filters?.find((filter) => filter.filterType === "MIN_NOTIONAL");
    const priceFilter = symbol.filters?.find((filter) => filter.filterType === "PRICE_FILTER");
    return {
      minQuantity: Number(lot?.minQty || 0),
      maxQuantity: Number(lot?.maxQty || Infinity),
      quantityStep: lot?.stepSize || "0.00000001",
      priceTick: priceFilter?.tickSize || null,
      minNotional: Number(minNotionalFilter?.notional || minNotionalFilter?.minNotional || 0),
    };
  }

  async function loadBinanceMarkets(signal) {
    const exchangeInfo = await fetchJson(`${BINANCE_API}/fapi/v1/exchangeInfo`, { signal });
    return exchangeInfo.symbols
      .filter((symbol) => symbol.status === "TRADING" && symbol.quoteAsset === "USDT")
      .map((symbol) => ({
        id: symbol.symbol,
        bookSymbol: symbol.symbol,
        display: symbol.symbol,
        contractType: symbol.contractType,
        underlyingType: symbol.underlyingType,
        sourceMeta: {
          contractType: symbol.contractType,
          underlyingType: symbol.underlyingType,
        },
        marketTakeBound: Number(symbol.marketTakeBound),
        ...relevantBinanceFilters(symbol),
      }))
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  async function loadHyperliquidMarkets(dex, signal) {
    const isMain = dex === "";
    const requests = [hlInfo(isMain ? { type: "metaAndAssetCtxs" } : { type: "metaAndAssetCtxs", dex }, signal)];
    if (!isMain) requests.push(hlInfo({ type: "perpDexs" }, signal));
    const [pair, perpDexs] = await Promise.all(requests);
    const [meta, contexts] = pair;
    if (!meta?.universe || meta.universe.length !== contexts?.length) {
      throw new Error("Hyperliquid市场元数据与上下文数量不一致");
    }
    const dexMeta = isMain ? null : perpDexs?.find((item) => item?.name === dex) || null;
    const markets = meta.universe
      .map((asset, index) => ({ asset, context: contexts[index] }))
      .filter(({ asset }) => !asset.isDelisted)
      .map(({ asset, context }) => ({
        id: asset.name,
        bookSymbol: asset.name,
        display: asset.name,
        sourceMeta: asset,
        context,
        quantityStep: String(10 ** -Number(asset.szDecimals || 0)),
        minQuantity: 10 ** -Number(asset.szDecimals || 0),
        maxQuantity: Infinity,
        maxNotional: hyperliquidMarketMax(asset.maxLeverage),
        minNotional: 10,
        dex,
        isMain,
      }))
      .sort((left, right) => left.id.localeCompare(right.id));
    return { markets, dexMeta };
  }

  function hyperliquidMarketMax(maxLeverage) {
    const leverage = Number(maxLeverage);
    if (leverage >= 25) return 15_000_000;
    if (leverage >= 20) return 5_000_000;
    if (leverage >= 10) return 2_000_000;
    return 500_000;
  }

  function marketCachePayload(markets, dexMeta) {
    return {
      dexMeta,
      markets: markets.map((market) => ({
        ...market,
        maxQuantity: Number.isFinite(market.maxQuantity) ? market.maxQuantity : null,
      })),
    };
  }

  function restoreCachedMarkets(cached) {
    return {
      dexMeta: cached.payload.dexMeta || null,
      markets: cached.payload.markets.map((market) => ({
        ...market,
        maxQuantity: market.maxQuantity == null ? Infinity : market.maxQuantity,
      })),
    };
  }

  function platformLabel() {
    if (state.platform === "binance") return "BINANCE USDⓈ-M";
    if (state.platform === "hl-main") return "HYPERLIQUID MAIN";
    return "HYPERLIQUID XYZ";
  }

  async function loadMarkets({ preserveManual = false } = {}) {
    const preservedFees = preserveManual
      ? {
          taker: state.feeManual ? el.takerFee.value : null,
          maker: state.makerFeeManual ? el.makerFee.value : null,
        }
      : null;
    state.loadToken += 1;
    const token = state.loadToken;
    cancelBookRequest();
    state.abortController?.abort();
    state.abortController = new AbortController();
    setLiveState("loading", "读取市场");
    setMessage("正在读取可交易标的与数量规则…", "info");
    el.symbol.disabled = true;
    state.market = null;
    state.lastBook = null;
    state.lastObservedBookId = null;
    state.lastChangeAt = null;
    state.bookStale = false;
    state.hlDepthProfileIndex = 0;
    state.hlDepthProfileCheckedAt = 0;
    state.samples = [];
    renderEmpty();

    let loaded;
    try {
      if (state.platform === "binance") {
        const markets = await loadBinanceMarkets(state.abortController.signal);
        loaded = { markets, dexMeta: null };
      } else {
        loaded = await loadHyperliquidMarkets(
          state.platform === "hl-main" ? "" : "xyz",
          state.abortController.signal,
        );
      }
      if (token !== state.loadToken) return;
      state.metadataSource = "live";
      state.metadataFetchedAt = Date.now();
      cacheMarkets(state.platform, marketCachePayload(loaded.markets, loaded.dexMeta));
    } catch (error) {
      if (error.name === "AbortError" || token !== state.loadToken) return;
      const cached = readMarketCache(state.platform);
      if (!cached) {
        state.markets = [];
        el.symbol.disabled = false;
        setLiveState("error", "市场载入失败");
        setMessage(`市场元数据不可达：${error.message}。没有缓存可用。`, "error");
        return;
      }
      loaded = restoreCachedMarkets(cached);
      const cacheAge = Date.now() - cached.savedAt;
      state.metadataSource = `${cacheAge > METADATA_SOFT_TTL ? "stale-cache" : "cache"}:${cached.savedAt}`;
      state.metadataFetchedAt = cached.savedAt;
      setMessage(`实时元数据失败，暂用${formatClock(cached.savedAt)}缓存；盘口仍会实时读取。`, "warning");
    }

    state.markets = loaded.markets;
    state.dexMeta = loaded.dexMeta;
    el.symbol.disabled = false;
    populateSymbols();
    const preferred = el.symbol.value.trim() || defaultSymbol();
    const found = findMarket(preferred) || findMarket(defaultSymbol()) || state.markets[0];
    if (found) selectMarket(found, true, { preservedFees });
    setLiveState(state.liveEnabled ? "loading" : "paused", state.liveEnabled ? "等待盘口" : "已暂停");
  }

  function defaultSymbol() {
    if (state.platform === "binance") return "BEATUSDT";
    if (state.platform === "hl-main") return "BTC";
    return "xyz:MU";
  }

  function populateSymbols() {
    el.symbols.replaceChildren();
    const fragment = document.createDocumentFragment();
    state.markets.forEach((market) => {
      const option = document.createElement("option");
      option.value = market.id;
      fragment.appendChild(option);
    });
    el.symbols.appendChild(fragment);
    el.symbolCount.textContent = `${state.markets.length}个`;
  }

  function findMarket(input) {
    const raw = String(input || "").trim().toUpperCase();
    if (!raw) return null;
    const candidates = [raw];
    if (state.platform === "binance" && !raw.endsWith("USDT")) candidates.push(`${raw}USDT`);
    if (state.platform === "hl-xyz" && !raw.startsWith("XYZ:")) candidates.push(`XYZ:${raw}`);
    return state.markets.find((market) => candidates.includes(market.id.toUpperCase())) || null;
  }

  function selectMarket(market, initial = false, { preservedFees = null } = {}) {
    if (!market) return;
    const changed = state.market?.id !== market.id;
    if (!changed) {
      el.symbol.value = market.id;
      updateContext();
      savePreferences();
      return;
    }
    if (changed) cancelBookRequest();
    state.market = market;
    el.symbol.value = market.id;
    state.lastBook = changed ? null : state.lastBook;
    state.lastBookMarketId = changed ? null : state.lastBookMarketId;
    if (changed) {
      state.lastObservedBookId = null;
      state.lastChangeAt = null;
      state.bookStale = false;
      state.hlDepthProfileIndex = 0;
      state.hlDepthProfileCheckedAt = 0;
      state.limitPriceManual = false;
    }
    resetSamples();
    state.feeManual = false;
    state.makerFeeManual = false;
    applyAutoFee();
    if (preservedFees?.taker != null) {
      state.feeManual = true;
      el.takerFee.value = preservedFees.taker;
    }
    if (preservedFees?.maker != null) {
      state.makerFeeManual = true;
      el.makerFee.value = preservedFees.maker;
    }
    updateFeeNotes();
    updateModeUi();
    updateContext();
    savePreferences();
    if (!initial || state.liveEnabled) void refreshBook(true);
  }

  function applyAutoFee() {
    if (!state.market) return;
    let fee = state.platform === "binance"
      ? core.inferBinanceFees(state.market.sourceMeta, el.bnbDiscount.checked)
      : core.inferHyperliquidFees(
          state.market.sourceMeta,
          state.dexMeta,
          state.platform === "hl-main",
        );
    if (state.metadataSource.startsWith("stale-cache")) {
      fee = {
        ...fee,
        takerRate: null,
        makerRate: null,
        source: "元数据缓存超过5分钟，需手动输入",
      };
    }
    state.autoFee = fee;
    el.bnbRow.hidden = state.platform !== "binance";
    if (Number.isFinite(fee.takerRate)) {
      el.takerFee.value = format(fee.takerRate * 100, 6).replace(/,/g, "");
      state.feeManual = false;
    } else {
      el.takerFee.value = "";
    }
    if (Number.isFinite(fee.makerRate)) {
      el.makerFee.value = format(fee.makerRate * 100, 6).replace(/,/g, "");
      state.makerFeeManual = false;
    } else {
      el.makerFee.value = "";
    }
    updateFeeNotes();
  }

  function feeNoteText(input, isManual, automaticRate, label) {
    const percent = numberValue(input);
    const fee = percent == null ? null : percent / 100;
    if (!Number.isFinite(fee)) return null;
    const bp = fee * 10_000;
    const source = isManual ? "手动覆盖" : `${state.autoFee?.source || "默认估算"} · ${FEE_CHECKED_AT}`;
    return `${label}${format(percent, 6)}% = ${format(bp, 4)}bp = 万${format(bp, 4)} · ${source}`;
  }

  function updateFeeNotes() {
    const percent = numberValue(el.takerFee);
    const fee = percent == null ? null : percent / 100;
    if (!Number.isFinite(fee)) {
      el.feeNote.textContent = "无法自动确认费率，请手动输入单边吃单费率。";
      el.feeNote.classList.add("warning-note");
    } else {
      el.feeNote.textContent = feeNoteText(el.takerFee, state.feeManual, state.autoFee?.takerRate, "");
      el.feeNote.classList.toggle("warning-note", state.feeManual || state.metadataSource !== "live");
    }

    const makerText = feeNoteText(el.makerFee, state.makerFeeManual, state.autoFee?.makerRate, "");
    el.makerFeeNote.textContent = makerText || "无法自动确认挂单费率，请手动输入；返佣请填负数。";
    el.makerFeeNote.classList.toggle(
      "warning-note",
      !makerText || state.makerFeeManual || state.metadataSource !== "live",
    );
  }

  function updateContext() {
    el.contextPlatform.textContent = platformLabel();
    el.contextSymbol.textContent = state.market?.id || "选择标的";
    if (!state.market) return;
    const fee = state.autoFee;
    const growthSuffix = fee?.growth ? " · Growth Mode已开启" : "";
    const metadataSuffix = state.metadataSource === "live" ? "" : " · 元数据来自缓存";
    el.productNote.textContent = `${fee?.product || "产品待识别"}${growthSuffix}${metadataSuffix}`;
    el.productNote.classList.toggle(
      "warning-note",
      state.metadataSource !== "live" || !Number.isFinite(fee?.takerRate),
    );
  }

  function currentInputs({ allowEmptyLimit = false } = {}) {
    const stopPercent = numberValue(el.stopPercent);
    const risk = numberValue(el.risk);
    const feePercent = numberValue(el.takerFee);
    const makerPercent = numberValue(el.makerFee);
    const limitPrice = numberValue(el.limitPrice);
    const redline = numberValue(el.redline);
    if (!(stopPercent > 0)) throw new Error("止损距离必须大于0");
    if (!(risk > 0)) throw new Error("风险必须大于0");
    if (!(feePercent >= 0)) throw new Error("单边吃单费率无效");
    if (state.execution === "limit" && !Number.isFinite(makerPercent)) {
      throw new Error("单边挂单费率无效；返佣可填负数");
    }
    if (state.execution === "limit" && !(limitPrice > 0) && !allowEmptyLimit) {
      throw new Error("限价价格必须大于0");
    }
    if (!(redline > 0)) throw new Error("成本红线必须大于0");
    if (redline > 10) throw new Error("成本红线不得高于10%R");
    return {
      stopPercent,
      risk,
      takerRate: feePercent / 100,
      makerRate: state.execution === "limit" ? makerPercent / 100 : 0,
      limitPrice,
      side: state.side,
      execution: state.execution,
      redline,
    };
  }

  function bookConfig(book) {
    const inputs = currentInputs();
    if (state.platform === "binance" && !(Number.isFinite(state.market.marketTakeBound) && state.market.marketTakeBound >= 0)) {
      throw new Error("币安市价保护参数缺失，禁止估算");
    }
    return {
      ...inputs,
      bids: book.bids,
      asks: book.asks,
      quantityStep: state.market.quantityStep,
      minQuantity: state.market.minQuantity,
      maxQuantity: state.market.maxQuantity,
      maxNotional: state.market.maxNotional,
      minNotional: state.market.minNotional,
      priceTick: state.market.priceTick,
      marketTakeBound: state.market.marketTakeBound,
      markPrice: book.markPrice,
      entryBids: book.entryBids,
      entryAsks: book.entryAsks,
      postOnly: state.execution === "limit",
    };
  }

  function updateAutoLimitPrice(book) {
    if (state.execution !== "limit" || state.limitPriceManual) return;
    if (book.depthProfile?.approximate && !book.entryBids) return;
    const entryBids = book.entryBids || book.bids;
    const entryAsks = book.entryAsks || book.asks;
    const bestBid = Number(Array.isArray(entryBids[0]) ? entryBids[0][0] : entryBids[0]?.px);
    const bestAsk = Number(Array.isArray(entryAsks[0]) ? entryAsks[0][0] : entryAsks[0]?.px);
    const price = state.side === "long" ? bestBid : bestAsk;
    if (Number.isFinite(price) && price > 0) el.limitPrice.value = String(price);
  }

  function estimateBook(book) {
    updateAutoLimitPrice(book);
    const config = bookConfig(book);
    const result = state.execution === "limit"
      ? core.estimateLimitEntryMarketStop(config)
      : core.estimate(config);
    if (result?.status === "ok") {
      result.depthProfileId = book.depthProfile?.id || "binance-raw";
      const baseQuality = book.depthProfile?.label || "1000档原始盘口·精确";
      result.depthQuality = state.execution === "limit"
        ? `${baseQuality} · 当前盘口形状代理`
        : baseQuality;
      result.depthApproximate = Boolean(book.depthProfile?.approximate);
      result.depthLowPrecision = Boolean(book.depthProfile?.lowPrecision);
    }
    return result;
  }

  function normalizeBinanceBook(raw) {
    if (!Array.isArray(raw.bids) || !Array.isArray(raw.asks)) throw new Error("币安盘口结构异常");
    if (!(Number.isFinite(raw.markPrice) && raw.markPrice > 0)) throw new Error("币安标记价格无效");
    return {
      id: `bn:${core.bookSignature(raw.bids, raw.asks)}`,
      time: Date.now(),
      bids: raw.bids,
      asks: raw.asks,
      markPrice: raw.markPrice,
    };
  }

  function normalizeHyperliquidBook(raw, profile = HL_DEPTH_PROFILES[0]) {
    if (!Array.isArray(raw.levels?.[0]) || !Array.isArray(raw.levels?.[1])) {
      throw new Error("Hyperliquid盘口结构异常");
    }
    return {
      id: `hl:${profile.id}:${core.bookSignature(raw.levels[0], raw.levels[1])}`,
      time: Number(raw.time) || Date.now(),
      bids: raw.levels[0],
      asks: raw.levels[1],
      depthProfile: profile,
    };
  }

  async function fetchBook(signal, profile = HL_DEPTH_PROFILES[0]) {
    if (state.platform === "binance") {
      const symbol = encodeURIComponent(state.market.bookSymbol);
      const [raw, premium] = await Promise.all([
        fetchJson(`${BINANCE_API}/fapi/v1/depth?symbol=${symbol}&limit=1000`, { signal }),
        fetchJson(`${BINANCE_API}/fapi/v1/premiumIndex?symbol=${symbol}`, { signal }),
      ]);
      return normalizeBinanceBook({ ...raw, markPrice: Number(premium.markPrice) });
    }
    const body = { type: "l2Book", coin: state.market.bookSymbol };
    if (profile.params) Object.assign(body, profile.params);
    const raw = await hlInfo(body, signal);
    return normalizeHyperliquidBook(raw, profile);
  }

  function needsDepthFallback(result) {
    return ["insufficient_snapshot_depth", "insufficient_stop_depth"].includes(result?.status);
  }

  async function fetchEstimatedBook(signal, manual = false) {
    if (state.platform === "binance") {
      const book = await fetchBook(signal);
      return { book, result: estimateBook(book) };
    }

    const rawOnly = el.depthMode.value === "raw";
    if (state.execution === "limit") {
      const rawBook = await fetchBook(signal, HL_DEPTH_PROFILES[0]);
      const rawResult = estimateBook(rawBook);
      if (rawOnly || !needsDepthFallback(rawResult)) {
        state.hlDepthProfileIndex = 0;
        state.hlDepthProfileCheckedAt = Date.now();
        return { book: rawBook, result: rawResult };
      }
      let lastPair = { book: rawBook, result: rawResult };
      for (let index = 1; index < HL_DEPTH_PROFILES.length; index += 1) {
        const profile = HL_DEPTH_PROFILES[index];
        const book = await fetchBook(signal, profile);
        book.entryBids = rawBook.bids;
        book.entryAsks = rawBook.asks;
        book.id = `${book.id}|entry:${rawBook.id}`;
        book.time = Math.max(book.time, rawBook.time);
        const result = estimateBook(book);
        lastPair = { book, result };
        if (!needsDepthFallback(result)) {
          state.hlDepthProfileIndex = index;
          state.hlDepthProfileCheckedAt = Date.now();
          return lastPair;
        }
      }
      state.hlDepthProfileCheckedAt = Date.now();
      return lastPair;
    }
    const shouldReprobe =
      manual ||
      !state.hlDepthProfileCheckedAt ||
      Date.now() - state.hlDepthProfileCheckedAt > HL_PROFILE_REPROBE_MS;
    const startIndex = rawOnly || shouldReprobe ? 0 : state.hlDepthProfileIndex;
    const lastIndex = rawOnly ? 0 : HL_DEPTH_PROFILES.length - 1;
    let lastPair = null;

    for (let index = startIndex; index <= lastIndex; index += 1) {
      const profile = HL_DEPTH_PROFILES[index];
      const book = await fetchBook(signal, profile);
      const result = estimateBook(book);
      lastPair = { book, result };
      if (!needsDepthFallback(result)) {
        state.hlDepthProfileIndex = index;
        if (startIndex === 0) state.hlDepthProfileCheckedAt = Date.now();
        return lastPair;
      }
    }
    if (startIndex === 0) state.hlDepthProfileCheckedAt = Date.now();
    return lastPair;
  }

  function resetSamples() {
    state.samples = [];
    state.sampleIds.clear();
    state.currentSample = null;
    el.frameCount.textContent = `0 / ${maxSamples()} 帧`;
    el.windowTitle.textContent = `最近${maxSamples()}个不重复盘口`;
    renderSparkline();
  }

  function appendSample(book, result) {
    const previousProfile = state.samples[state.samples.length - 1]?.result?.depthProfileId;
    if (previousProfile && previousProfile !== result.depthProfileId) resetSamples();
    state.currentSample = { id: book.id, time: book.time, result };
    if (state.sampleIds.has(book.id)) return false;
    state.sampleIds.add(book.id);
    state.samples.push(state.currentSample);
    if (state.samples.length > maxSamples()) {
      const removed = state.samples.shift();
      state.sampleIds.delete(removed.id);
    }
    return true;
  }

  function cancelBookRequest() {
    state.bookRequestToken += 1;
    state.bookController?.abort();
    state.bookController = null;
    state.inFlight = null;
  }

  function currentStaleThreshold() {
    return Math.max(15_000, (Number(el.sampleInterval.value) || 3000) * 4);
  }

  function bookIsStale() {
    return Number(state.lastChangeAt) > 0 && Date.now() - state.lastChangeAt > currentStaleThreshold();
  }

  async function refreshBook(manual = false) {
    if (!state.market || (!state.liveEnabled && !manual) || (document.hidden && !manual)) return;
    if (state.inFlight) return state.inFlight;
    let inputs;
    try {
      inputs = currentInputs({ allowEmptyLimit: true });
    } catch (error) {
      setMessage(error.message, "error");
      return;
    }
    if (!Number.isFinite(inputs.takerRate)) return;

    const marketId = state.market.id;
    const platform = state.platform;
    const requestToken = ++state.bookRequestToken;
    const controller = new AbortController();
    state.bookController = controller;
    setLiveState("loading", state.samples.length ? "刷新盘口" : "读取盘口");
    const promise = fetchEstimatedBook(controller.signal, manual)
      .then((pair) => {
        if (
          requestToken !== state.bookRequestToken ||
          state.market?.id !== marketId ||
          state.platform !== platform
        ) return;
        const { book, result } = pair;
        state.lastBook = book;
        state.lastBookMarketId = marketId;
        if (result.status !== "ok") {
          renderInvalid(result);
          return;
        }
        appendSample(book, result);
        const observedChange = book.id !== state.lastObservedBookId;
        if (observedChange) {
          state.lastObservedBookId = book.id;
          state.lastChangeAt = Date.now();
        }
        state.errorCount = 0;
        state.lastSuccessAt = observedChange ? book.time : state.lastSuccessAt;
        state.bookStale = bookIsStale();
        el.resultsPanel.dataset.stale = String(state.bookStale);
        const liveKind = state.bookStale ? "paused" : state.liveEnabled ? "live" : "paused";
        const liveLabel = state.bookStale ? "盘口未更新" : observedChange ? state.liveEnabled ? "实时" : "已暂停" : "盘口未变化";
        setLiveState(liveKind, liveLabel, state.lastSuccessAt || book.time);
        render();
      })
      .catch((error) => {
        if (error.name === "AbortError" || requestToken !== state.bookRequestToken) return;
        state.errorCount += 1;
        state.bookStale = true;
        el.resultsPanel.dataset.stale = "true";
        el.copySummary.disabled = true;
        setLiveState("error", "盘口失败");
        setMessage(`实时盘口读取失败：${error.message}。旧结果已灰化，不会冒充当前值。`, "error");
      })
      .finally(() => {
        if (state.inFlight === promise) state.inFlight = null;
        if (state.bookController === controller) state.bookController = null;
        if (requestToken === state.bookRequestToken) scheduleNext();
      });
    state.inFlight = promise;
    return promise;
  }

  function scheduleNext() {
    window.clearTimeout(state.timer);
    if (!state.liveEnabled || document.hidden) return;
    const base = Number(el.sampleInterval.value) || 3000;
    const delay = state.errorCount ? Math.min(30_000, base * 2 ** Math.min(4, state.errorCount)) : base;
    state.timer = window.setTimeout(() => void refreshBook(false), delay);
  }

  function recomputeFromLastBook() {
    resetSamples();
    if (!state.lastBook || state.lastBookMarketId !== state.market?.id) {
      renderEmpty();
      if (state.liveEnabled) void refreshBook(true);
      return;
    }
    if (
      state.execution === "limit" &&
      state.platform !== "binance" &&
      state.lastBook.depthProfile?.approximate &&
      !state.lastBook.entryBids
    ) {
      renderEmpty();
      if (state.liveEnabled) void refreshBook(true);
      return;
    }
    try {
      const result = estimateBook(state.lastBook);
      if (result.status !== "ok") {
        renderInvalid(result);
        if (needsDepthFallback(result) && state.liveEnabled) {
          state.hlDepthProfileIndex = 0;
          state.hlDepthProfileCheckedAt = 0;
          void refreshBook(true);
        }
        return;
      }
      appendSample(state.lastBook, result);
      render();
    } catch (error) {
      setMessage(error.message, "error");
      renderEmpty();
    }
    if (state.liveEnabled) void refreshBook(true);
  }

  function resultField() {
    if (state.execution === "limit") return "conditionalRiskPercent";
    return state.method === "conservative" ? "conservativeRiskPercent" : "directionalRiskPercent";
  }

  function costField() {
    if (state.execution === "limit") return "conditionalTotalCost";
    return state.method === "conservative" ? "conservativeCost" : "directionalCost";
  }

  function bookCostField() {
    if (state.execution === "limit") return "stopSlipCost";
    return state.method === "conservative" ? "conservativeBookCost" : "directionalBookCost";
  }

  function totalLossField() {
    if (state.execution === "limit") return "conditionalTotalLoss";
    return state.method === "conservative" ? "totalLossConservative" : "totalLossDirectional";
  }

  function rateField() {
    if (state.execution === "limit") return "conditionalRateBp";
    return state.method === "conservative" ? "conservativeRateBp" : "directionalRateBp";
  }

  function selectedSample() {
    if (state.view === "current") return state.currentSample;
    return core.pickSample(state.samples, state.view, resultField());
  }

  function renderStats() {
    const field = resultField();
    const current = state.currentSample;
    const median = core.pickSample(state.samples, "median", field);
    const worst = core.pickSample(state.samples, "worst", field);
    el.currentStat.textContent = current ? formatPercent(current.result[field]) : "--";
    el.medianStat.textContent = median ? formatPercent(median.result[field]) : "--";
    el.worstStat.textContent = worst ? formatPercent(worst.result[field]) : "--";
    el.frameCount.textContent = `${state.samples.length} / ${maxSamples()} 帧`;
  }

  function renderHero(sample) {
    const result = sample.result;
    const value = result[resultField()];
    const redline = numberValue(el.redline) || 5;
    const zone = value > 10 ? "bad" : value <= Math.min(redline, 10) ? "good" : "warn";
    el.heroResult.dataset.zone = zone;
    const labels = { current: "当前成本 / 风险", median: "滚动中位成本 / 风险", worst: "滚动最差成本 / 风险" };
    const methodLabel = state.execution === "limit"
      ? `限价成交后 · ${state.side === "long" ? "做多" : "做空"}`
      : state.method === "conservative" ? "较差侧×2" : "当前买＋卖";
    el.heroLabel.textContent = `${labels[state.view]} · ${methodLabel}`;
    el.heroValue.textContent = format(value, 2);
    el.riskFill.style.width = `${Math.min(100, Math.max(0, value / 10 * 100))}%`;
    if (zone === "good") {
      el.heroVerdict.textContent = `通过 ${format(redline, 2)}%R 红线 · 当前规模可接受`;
    } else if (zone === "warn") {
      el.heroVerdict.textContent = `超过 ${format(redline, 2)}%R 理想线 · 仍低于10%上限`;
    } else {
      el.heroVerdict.textContent = state.execution === "limit"
        ? "超过10%R · 缩仓或放宽止损"
        : "超过10%R · 缩仓、放宽止损或限价入场";
    }
  }

  function renderMetrics(sample) {
    const result = sample.result;
    const cost = result[costField()];
    const bookCost = result[bookCostField()];
    const totalLoss = result[totalLossField()];
    el.positionValue.textContent = `${format(result.actualNotional, 2)} U`;
    el.quantityValue.textContent = `数量 ${format(result.quantity, 8)}`;
    el.costValue.textContent = `${format(cost, 2)} U`;
    el.costRateValue.textContent = `总成本率 ${formatBp(result[rateField()])}`;
    el.totalLossValue.textContent = `${format(totalLoss, 2)} U`;
    el.actualRiskValue.textContent = `实际价格风险 ${format(result.actualPriceRisk, 2)} U`;
    el.midValue.textContent = format(result.mid, 8);
    el.spreadValue.textContent = `完整价差 ${formatBp(result.spreadBp, 3)}`;

    const total = Math.max(1e-12, Math.abs(cost));
    el.feeBar.style.width = `${Math.min(100, Math.max(0, result.feeCost / total * 100))}%`;
    el.bookBar.style.width = `${Math.min(100, Math.max(0, bookCost / total * 100))}%`;
    el.feeValue.textContent = `${format(result.feeCost, 2)}U · ${formatPercent(result.feeRiskPercent, 2)}`;
    el.bookValue.textContent = `${format(bookCost, 2)}U · ${formatPercent(bookCost / result.requestedRisk * 100, 2)}`;
    el.buySlipValue.textContent = formatBp(result.buySlipBp, 3);
    el.sellSlipValue.textContent = formatBp(result.sellSlipBp, 3);

    el.buyLevels.textContent = `${result.buy.levelsUsed} 档`;
    el.sellLevels.textContent = `${result.sell.levelsUsed} 档`;
    el.buyLast.textContent = formatBp(result.buyLastBp, 3);
    el.sellLast.textContent = formatBp(result.sellLastBp, 3);
    el.buyDepth.textContent = `${format(result.buy.totalVisibleNotional, 0)} U`;
    el.sellDepth.textContent = `${format(result.sell.totalVisibleNotional, 0)} U`;
    const lastBp = Math.max(result.buyLastBp, result.sellLastBp);
    el.depthState.textContent = lastBp > 50 ? "扫穿±0.5%" : lastBp > 10 ? "扫穿±0.1%" : "近端承接";
    el.depthQuality.textContent = result.depthApproximate
      ? `${result.depthQuality} · 官方20个聚合价格桶，非原始档位`
      : result.depthQuality;
    el.depthQuality.classList.toggle("warning-note", result.depthApproximate);
    el.feeBreakdownLabel.textContent = state.execution === "limit" ? "挂单进场费＋止损费" : "双边手续费";
    el.bookBreakdownLabel.textContent = state.execution === "limit" ? "止损市价滑点" : "价差与盘口冲击";
    el.limitAssumption.hidden = state.execution !== "limit";
  }

  function renderSparkline() {
    const field = resultField();
    const values = state.samples.map((sample) => sample.result[field]).filter(Number.isFinite);
    if (!values.length) {
      el.sparkPath.setAttribute("d", "");
      el.sparkArea.setAttribute("d", "");
      el.windowAge.textContent = "--";
      return;
    }
    const width = 600;
    const height = 120;
    const redline = numberValue(el.redline) || 5;
    const yMax = Math.max(10, redline * 1.25, ...values) * 1.08;
    const points = values.map((value, index) => {
      const x = values.length === 1 ? 0 : index / (values.length - 1) * width;
      const y = height - value / yMax * height;
      return [x, y];
    });
    const line = points.map(([x, y], index) => `${index ? "L" : "M"}${x.toFixed(2)},${y.toFixed(2)}`).join(" ");
    const area = `${line} L${points[points.length - 1][0].toFixed(2)},${height} L0,${height} Z`;
    el.sparkPath.setAttribute("d", line);
    el.sparkArea.setAttribute("d", area);
    const redlineY = height - redline / yMax * height;
    el.sparkRedline.setAttribute("y1", String(redlineY));
    el.sparkRedline.setAttribute("y2", String(redlineY));
    const age = state.samples.length > 1
      ? (state.samples[state.samples.length - 1].time - state.samples[0].time) / 1000
      : 0;
    el.windowAge.textContent = `${format(age, 0)}秒窗口`;
  }

  function renderMessage(sample) {
    const result = sample.result;
    const value = result[resultField()];
    const redline = numberValue(el.redline) || 5;
    const warnings = [];
    if (state.samples.length < maxSamples()) {
      warnings.push(`正在建立稳健窗口：已有${state.samples.length}/${maxSamples()}帧`);
    }
    if (state.feeManual) warnings.push("当前使用手动费率");
    if (state.execution === "limit" && state.makerFeeManual) warnings.push("当前使用手动挂单费率");
    if (result.depthApproximate) warnings.push(`${result.depthQuality}，成本为聚合近似`);
    if (result.depthLowPrecision) warnings.push("当前为3位聚合低精度兜底，建议拆单复核");
    if (state.execution === "limit") {
      warnings.push("结论仅在Post-only挂单全额成交后成立；未成交则仓位和交易成本均为0");
      warnings.push("止损滑点只把当前盘口形状平移到计划止损价，不是未来成交预测");
      if (Number.isFinite(result.limitDistanceFromMidPercent) && result.limitDistanceFromMidPercent > 0.5) {
        warnings.push("限价距离当前中价超过0.5%，止损盘口代理置信度较低");
      }
    }
    if (state.metadataSource !== "live") warnings.push("产品元数据来自缓存");
    if (state.bookStale) warnings.push("盘口长时间未更新，结果只代表最后可见快照");
    if (state.platform === "hl-xyz" || state.market?.contractType === "TRADIFI_PERPETUAL") {
      warnings.push("外盘休市时RWA内部定价与深度可能明显变化");
    }
    if (Math.max(result.buyLastBp, result.sellLastBp) > 10) warnings.push("该仓位已扫穿±0.1%近端盘口");
    if (value > redline) warnings.push(`成本超过${format(redline, 2)}%R红线`);
    const text = warnings.length ? warnings.join("；") + "。" : "当前盘口、费率和仓位均通过设定红线。";
    setMessage(text, value > 10 ? "error" : value > redline || warnings.length ? "warning" : "success");
  }

  function render() {
    renderStats();
    renderSparkline();
    const sample = selectedSample();
    if (!sample) {
      renderEmpty();
      return;
    }
    el.copySummary.disabled = state.bookStale;
    renderHero(sample);
    renderMetrics(sample);
    renderMessage(sample);
  }

  function renderEmpty() {
    el.resultsPanel.dataset.stale = "false";
    el.heroResult.dataset.zone = "idle";
    el.heroValue.textContent = "--";
    el.heroVerdict.textContent = state.market ? "等待第一帧盘口" : "选择平台和标的";
    el.riskFill.style.width = "0%";
    [el.currentStat, el.medianStat, el.worstStat].forEach((node) => (node.textContent = "--"));
    [
      el.positionValue,
      el.quantityValue,
      el.costValue,
      el.costRateValue,
      el.totalLossValue,
      el.actualRiskValue,
      el.midValue,
      el.spreadValue,
      el.feeValue,
      el.bookValue,
      el.buySlipValue,
      el.sellSlipValue,
      el.buyLevels,
      el.sellLevels,
      el.buyLast,
      el.sellLast,
      el.buyDepth,
      el.sellDepth,
    ].forEach((node) => (node.textContent = "--"));
    el.feeBar.style.width = "0%";
    el.bookBar.style.width = "0%";
    el.depthState.textContent = "--";
    el.depthQuality.textContent = "等待盘口";
    el.limitAssumption.hidden = true;
    el.copySummary.disabled = true;
  }

  function renderInvalid(result) {
    resetSamples();
    renderEmpty();
    const messages = {
      below_min_quantity: "仓位低于该合约最小下单数量。",
      above_market_max: `仓位超过单笔市价数量上限${format(result.maxQuantity, 8)}，已阻断估算，不会静默截断。`,
      above_market_max_notional: `仓位超过该Hyperliquid合约单笔市价名义上限${format(result.maxNotional, 0)}U。`,
      below_min_notional: `实际名义低于最小订单${format(result.minNotional, 2)}U。`,
      insufficient_snapshot_depth: "公开快照档位不足以完整承接此仓位，无法精确估算；禁止按末档价格外推。",
      insufficient_stop_depth: "止损方向的公开盘口不足以承接此仓位；自动扩展后仍不够，禁止外推。",
      market_take_bound: `扫单末档超过币安市价保护边界±${format(result.marketTakeBound * 100, 3)}%，可能无法完整成交。`,
      would_take_liquidity: "该限价会立即吃单，不符合Post-only挂单假设；请把做多价放到卖一以下，或把做空价放到买一以上。",
      post_only_required: "限价模型只接受Post-only挂单成交条件。",
      invalid_limit_tick: `限价不符合该合约最小价格步进${format(result.priceTick, 8)}，请调整后再算。`,
      invalid_stop_price: "止损距离使计划止损价无效，请检查方向与止损百分比。",
    };
    setMessage(messages[result.status] || "当前参数无法形成有效估算。", "error");
    el.resultsPanel.dataset.stale = "false";
    setLiveState("error", "不可估算");
    if (["insufficient_snapshot_depth", "insufficient_stop_depth"].includes(result.status)) {
      el.buyDepth.textContent = `${format(result.buy?.totalVisibleNotional, 0)} U可见`;
      el.sellDepth.textContent = `${format(result.sell?.totalVisibleNotional, 0)} U可见`;
      el.depthState.textContent = "扩展深度仍不足";
    }
  }

  function updateActiveButtons() {
    document.querySelectorAll("[data-execution]").forEach((button) => {
      button.classList.toggle("active", button.dataset.execution === state.execution);
    });
    document.querySelectorAll("[data-side]").forEach((button) => {
      button.classList.toggle("active", button.dataset.side === state.side);
    });
    document.querySelectorAll("[data-method]").forEach((button) => {
      button.classList.toggle("active", button.dataset.method === state.method);
    });
    document.querySelectorAll("[data-view]").forEach((button) => {
      const active = button.dataset.view === state.view;
      button.classList.toggle("active", active);
      button.setAttribute("aria-selected", String(active));
    });
  }

  function updateModeUi() {
    const isLimit = state.execution === "limit";
    el.limitControls.hidden = !isLimit;
    el.methodBlock.hidden = isLimit;
    el.limitAssumption.hidden = true;
    el.depthModeBlock.hidden = state.platform === "binance";
    el.depthModeBlock.parentElement?.classList.toggle("single-column", state.platform === "binance");
    el.executionNote.textContent = isLimit
      ? "条件：Post-only挂单全额成交，进场机械滑点为0；止损成本仅以当前盘口形状做代理。"
      : "双腿均按吃单费率，并计入当前盘口冲击。";
    if (isLimit && state.lastBook) updateAutoLimitPrice(state.lastBook);
    updateActiveButtons();
  }

  function debounce(fn, delay) {
    let timer;
    return (...args) => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => fn(...args), delay);
    };
  }

  function copyFallback(text) {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand("copy");
    textarea.remove();
    return ok;
  }

  async function copySummary() {
    const sample = selectedSample();
    if (!sample || !state.market) return;
    if (state.bookStale) {
      setMessage("盘口已过期，禁止复制为实时结果。请先刷新。", "error");
      return;
    }
    const result = sample.result;
    const value = result[resultField()];
    const cost = result[costField()];
    const text = [
      `${platformLabel()} ${state.market.id}`,
      `止损 ${format(result.stopPercent, 4)}%｜风险 ${format(result.requestedRisk, 2)}U`,
      `仓位 ${format(result.actualNotional, 2)}U｜成本 ${format(cost, 2)}U`,
      `${state.view === "worst" ? "滚动最差" : state.view === "median" ? "滚动中位" : "当前"}成本占风险 ${format(value, 2)}%`,
      `手续费 ${format(result.feeCost, 2)}U｜买滑 ${formatBp(result.buySlipBp)}｜卖滑 ${formatBp(result.sellSlipBp)}`,
      state.execution === "limit"
        ? `口径：Post-only限价进＋市价止（${state.side === "long" ? "做多" : "做空"}），条件为挂单全额成交；止损滑点为当前盘口形状代理，非未来成交预测`
        : `口径：${state.method === "conservative" ? "较差侧×2" : "当前买＋卖"}`,
      `深度：${result.depthQuality || "原始盘口"}｜窗口 ${state.samples.length}/${maxSamples()}帧`,
    ].join("\n");
    try {
      if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(text);
      else if (!copyFallback(text)) throw new Error("copy failed");
      const original = el.copySummary.textContent;
      el.copySummary.textContent = "已复制";
      window.setTimeout(() => (el.copySummary.textContent = original), 1300);
    } catch {
      setMessage("复制失败，请手动记录结果。", "error");
    }
  }

  const handleNumericChange = debounce(() => {
    savePreferences();
    updateFeeNotes();
    recomputeFromLastBook();
  }, 260);

  el.platform.addEventListener("change", () => {
    state.platform = el.platform.value;
    updateModeUi();
    savePreferences();
    void loadMarkets();
  });

  el.symbol.addEventListener("change", () => {
    const market = findMarket(el.symbol.value);
    if (!market) {
      el.symbol.value = state.market?.id || "";
      setMessage("没有找到该合约。请输入完整代码，或从候选列表选择。", "error");
      return;
    }
    selectMarket(market);
  });

  el.symbol.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    el.symbol.blur();
    const market = findMarket(el.symbol.value);
    if (market) selectMarket(market);
    else {
      el.symbol.value = state.market?.id || "";
      setMessage("没有找到该合约。请输入完整代码，或从候选列表选择。", "error");
    }
  });

  [el.stopPercent, el.risk].forEach((input) => input.addEventListener("input", handleNumericChange));
  el.redline.addEventListener("input", debounce(() => {
    savePreferences();
    if ((numberValue(el.redline) || 0) > 10) {
      setMessage("成本红线不得高于10%R。", "error");
      return;
    }
    render();
  }, 120));

  el.takerFee.addEventListener("input", () => {
    state.feeManual = true;
    handleNumericChange();
  });

  el.makerFee.addEventListener("input", () => {
    state.makerFeeManual = true;
    handleNumericChange();
  });

  el.limitPrice.addEventListener("input", () => {
    state.limitPriceManual = true;
    handleNumericChange();
  });

  el.resetFee.addEventListener("click", () => {
    state.feeManual = false;
    applyAutoFee();
    recomputeFromLastBook();
  });

  el.resetMakerFee.addEventListener("click", () => {
    state.makerFeeManual = false;
    applyAutoFee();
    recomputeFromLastBook();
  });

  el.resetLimitPrice.addEventListener("click", () => {
    state.limitPriceManual = false;
    if (state.lastBook) updateAutoLimitPrice(state.lastBook);
    recomputeFromLastBook();
  });

  el.bnbDiscount.addEventListener("change", () => {
    state.feeManual = false;
    state.makerFeeManual = false;
    applyAutoFee();
    savePreferences();
    recomputeFromLastBook();
  });

  document.querySelectorAll("[data-execution]").forEach((button) => {
    button.addEventListener("click", () => {
      state.execution = button.dataset.execution;
      state.limitPriceManual = false;
      if (state.lastBook) updateAutoLimitPrice(state.lastBook);
      updateModeUi();
      savePreferences();
      recomputeFromLastBook();
    });
  });

  document.querySelectorAll("[data-side]").forEach((button) => {
    button.addEventListener("click", () => {
      state.side = button.dataset.side;
      state.limitPriceManual = false;
      if (state.lastBook) updateAutoLimitPrice(state.lastBook);
      updateModeUi();
      savePreferences();
      recomputeFromLastBook();
    });
  });

  document.querySelectorAll("[data-method]").forEach((button) => {
    button.addEventListener("click", () => {
      state.method = button.dataset.method;
      updateActiveButtons();
      savePreferences();
      render();
    });
  });

  document.querySelectorAll("[data-view]").forEach((button) => {
    button.addEventListener("click", () => {
      state.view = button.dataset.view;
      updateActiveButtons();
      savePreferences();
      render();
    });
  });

  el.sampleInterval.addEventListener("change", () => {
    savePreferences();
    scheduleNext();
  });

  el.sampleWindow.addEventListener("change", () => {
    savePreferences();
    recomputeFromLastBook();
  });

  el.depthMode.addEventListener("change", () => {
    state.hlDepthProfileIndex = 0;
    state.hlDepthProfileCheckedAt = 0;
    savePreferences();
    resetSamples();
    renderEmpty();
    if (state.liveEnabled) void refreshBook(true);
  });

  el.refreshNow.addEventListener("click", () => {
    if (state.market) void refreshBook(true);
    else void loadMarkets();
  });
  el.toggleLive.addEventListener("click", () => {
    state.liveEnabled = !state.liveEnabled;
    el.toggleLive.textContent = state.liveEnabled ? "暂停自动刷新" : "继续自动刷新";
    setLiveState(state.liveEnabled ? "loading" : "paused", state.liveEnabled ? "恢复刷新" : "已暂停");
    if (state.liveEnabled) void refreshBook(true);
    else window.clearTimeout(state.timer);
  });

  el.copySummary.addEventListener("click", copySummary);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      window.clearTimeout(state.timer);
      if (state.liveEnabled) setLiveState("paused", "后台暂停");
    } else if (state.liveEnabled) {
      if (!state.metadataFetchedAt || Date.now() - state.metadataFetchedAt > METADATA_SOFT_TTL) {
        void loadMarkets({ preserveManual: true });
      } else {
        void refreshBook(true);
      }
    }
  });

  window.addEventListener("beforeunload", () => {
    window.clearTimeout(state.timer);
    window.clearInterval(state.metadataTimer);
    state.abortController?.abort();
    state.bookController?.abort();
  });

  loadPreferences();
  updateModeUi();
  renderEmpty();
  void loadMarkets();
  state.metadataTimer = window.setInterval(() => {
    if (
      state.liveEnabled &&
      !document.hidden &&
      Date.now() - (state.metadataFetchedAt || 0) > METADATA_SOFT_TTL
    ) {
      void loadMarkets({ preserveManual: true });
    }
  }, METADATA_SOFT_TTL);

  if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }
})();
