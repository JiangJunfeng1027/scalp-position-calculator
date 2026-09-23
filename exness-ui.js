(function () {
  "use strict";
  window.createExnessView = function ({ el, state, format, numberValue, renderEmpty, setLiveState, setMessage, sources, loadBook, closeSource }) {
    const core = window.ExnessCore;
    const ids = ["exAccount", "exBaseBp", "exSlipBp", "exRebateBp", "exReset", "exRateNote", "exPosition", "exCost", "exNetRate", "exImpact", "exDepthDetails", "exTotalLoss", "exTotalR", "exReferenceNote", "exScaleNote", "exRiskEquation", "exProxyDescription", "exProxyBreakdown"];
    const ui = Object.fromEntries(ids.map(id => [id, document.getElementById(id)]));
    const key = "execution-cost-exness-ratio-v2";
    const MAX_AGE = 15_000;
    let prefs = {}, result = null, book = null, failure = "";
    let controller = null, inFlight = null, timer = null, expiry = null, generation = 0, errors = 0;
    try { prefs = JSON.parse(localStorage.getItem(key) || "{}"); } catch { /* Optional settings. */ }
    if (!prefs || typeof prefs !== "object" || Array.isArray(prefs)) prefs = {};
    if (Object.hasOwn(core.accounts, prefs.account)) ui.exAccount.value = prefs.account;
    const market = () => core.markets.find(m => m.id === state.market?.id);
    const source = () => sources[market()?.id];
    const pairKey = () => `${ui.exAccount.value}:${market()?.id}`;
    const reference = () => core.referenceBp[ui.exAccount.value]?.[market()?.id];
    function save() {
      prefs.account = ui.exAccount.value;
      prefs[pairKey()] = { baseBp: ui.exBaseBp.value, slipBp: ui.exSlipBp.value, rebateBp: ui.exRebateBp.value };
      try { localStorage.setItem(key, JSON.stringify(prefs)); } catch { /* Storage may be unavailable. */ }
    }
    function applySettings() {
      const saved = prefs[pairKey()];
      ui.exBaseBp.value = saved?.baseBp ?? reference() ?? "";
      ui.exSlipBp.value = saved?.slipBp ?? "0";
      ui.exRebateBp.value = saved?.rebateBp ?? "0";
    }
    function stop() {
      generation += 1;
      controller?.abort(); controller = null; inFlight = null;
      window.clearTimeout(timer); window.clearTimeout(expiry);
      timer = null; expiry = null;
      closeSource();
    }
    function armExpiry() {
      window.clearTimeout(expiry);
      if (!book) return;
      const remaining = MAX_AGE - (Date.now() - book.time);
      if (remaining >= 0) expiry = window.setTimeout(() => render(), remaining + 30);
    }
    function pause() {
      stop();
      render();
      armExpiry();
    }
    function resetMarket() {
      stop(); book = null; result = null; failure = ""; errors = 0;
      applySettings(); render();
      if (state.liveEnabled) void refresh(true);
    }
    function schedule() {
      window.clearTimeout(timer);
      if (state.platform !== "exness" || !state.liveEnabled || document.hidden) return;
      const base = Number(el.sampleInterval.value) || 3000;
      const delay = errors ? Math.min(30_000, base * 2 ** Math.min(4, errors)) : base;
      timer = window.setTimeout(() => void refresh(false), delay);
    }
    function refresh(manual = false) {
      if (state.platform !== "exness" || !market() || (!manual && (!state.liveEnabled || document.hidden))) return Promise.resolve();
      if (inFlight) return inFlight;
      window.clearTimeout(timer);
      const token = generation, selected = market();
      controller = new AbortController();
      const requestController = controller;
      setLiveState("loading", "读取参考盘口", book?.time);
      const promise = loadBook(selected, requestController.signal)
        .then(next => {
          if (token !== generation || state.platform !== "exness" || market()?.id !== selected.id) return;
          const age = Date.now() - Number(next.time);
          if (!Number.isFinite(age) || age < -5000 || age > MAX_AGE) throw new Error("参考盘口时间异常或已过期，可能休市");
          if (next.symbol !== sources[selected.id].symbol) throw new Error("参考盘口标的与所选合约不匹配");
          book = next; failure = ""; errors = 0;
          render(); armExpiry();
        })
        .catch(error => {
          if (token !== generation || error.name === "AbortError") return;
          failure = error.message; book = null; errors += 1;
          window.clearTimeout(expiry);
          render();
        })
        .finally(() => {
          if (token !== generation) return;
          if (inFlight === promise) inFlight = null;
          if (controller === requestController) controller = null;
          schedule();
        });
      inFlight = promise;
      return promise;
    }
    function render() {
      if (state.platform !== "exness" || !market()) return;
      const m = market(), proxy = source();
      renderEmpty(); result = null;
      ui.exScaleNote.hidden = true;
      ui.exRiskEquation.textContent = "--";
      ui.exProxyBreakdown.textContent = "等待参考盘口…";
      [ui.exPosition, ui.exCost, ui.exNetRate, ui.exImpact, ui.exDepthDetails, ui.exTotalLoss, ui.exTotalR].forEach(node => node.textContent = "--");
      const autoBase = !ui.exBaseBp.value.trim();
      const historical = !autoBase && ui.exBaseBp.value === String(reference() ?? "");
      const baseLabel = autoBase ? "参考点差＋Exness佣金" : historical ? "历史基础费率" : "自设基础费率";
      el.contextPlatform.textContent = `EXNESS · ${core.accounts[ui.exAccount.value]}`;
      el.contextSymbol.textContent = m.id;
      el.productNote.textContent = `${m.name} · ${core.accounts[ui.exAccount.value]} · 深度参考${proxy.label}`;
      el.productNote.classList.add("warning-note");
      el.frameCount.textContent = `${proxy.label} · 跨平台近似`;
      el.heroLabel.textContent = "代理深度估算成本 / 风险";
      el.heroVerdict.textContent = "等待参考盘口";
      ui.exRateNote.textContent = autoBase
        ? `基础费用自动采用${proxy.label}点差＋Exness每手往返佣金，未实测Exness点差。`
        : `基础费用：万${ui.exBaseBp.value}（${baseLabel}），另加参考盘口逐档冲击。`;
      ui.exReferenceNote.textContent = reference() == null
        ? `可留空自动用参考点差＋Exness佣金近似；也可填写不含扫档冲击的完整基础费率。${proxy.label}不是Exness盘口。`
        : `历史讨论基准按${m.id === "BTCUSD" ? "比特币80,000美元" : "黄金4,000美元"}折算，含点差＋双边佣金；填入后不再重复叠加参考盘口点差。清空则自动用参考点差＋Exness佣金。`;
      ui.exReset.disabled = false;
      ui.exProxyDescription.textContent = `基础费用＋${proxy.label}同名义仓位的较差侧额外冲击×2。${proxy.venue === "binance" ? "USDT按1美元近似。" : "Bybit为流动性提供商的指示性深度。"}`;
      const age = book ? Date.now() - book.time : Infinity;
      if (failure || !book || age > MAX_AGE || age < -5000) {
        const stale = Boolean(book || failure);
        el.resultsPanel.dataset.stale = String(stale);
        el.heroVerdict.textContent = failure ? "参考盘口不可用" : book ? "参考盘口已过期" : "等待参考盘口";
        setLiveState(stale ? "error" : "paused", stale ? "参考盘口不可用" : state.liveEnabled ? "等待参考盘口" : "已暂停", book?.time);
        setMessage(`${failure || (book ? "参考盘口超过15秒未更新，结果已清空" : `等待${proxy.label}实时深度`)}。${stale ? "请刷新；无可用深度时不回退成固定费率结果。" : "日常只需填写止损距离和风险预算。"}`, stale ? "warning" : "info");
        return;
      }
      try {
        result = core.estimateProxy({ symbol: m.id, account: ui.exAccount.value,
          stopPercent: numberValue(el.stopPercent), risk: numberValue(el.risk),
          baseBp: ui.exBaseBp.value, slipBp: ui.exSlipBp.value, rebateBp: ui.exRebateBp.value,
          redline: numberValue(el.redline), bids: book.bids, asks: book.asks,
          proxyMultiplier: proxy.multiplier, method: "conservative" });
        const r = result;
        const zone = window.CostCore.costRiskZone(r.riskPercent, r.redline);
        el.heroResult.dataset.zone = zone;
        el.heroValue.textContent = format(r.riskPercent, 2);
        el.heroVerdict.textContent = zone === "bad" ? "近似成本超过10%R上限"
          : zone === "warn" ? `近似成本超过${format(r.redline)}%R · 不高于10%上限`
          : `近似成本不高于${format(r.redline)}%R理想线`;
        ui.exRiskEquation.textContent = `成本 ${format(r.cost, 2)} U ÷ 风险预算 ${format(r.risk, 2)} U ≈ ${format(r.riskPercent, 2)}%`;
        ui.exScaleNote.hidden = false;
        el.riskFill.style.width = `${Math.min(100, Math.max(0, r.riskPercent / 10 * 100))}%`;
        ui.exPosition.textContent = `${format(r.notional, 2)} U`;
        ui.exCost.textContent = `${format(r.cost, 2)} U`;
        ui.exNetRate.textContent = `含冲击总成本率 万${format(r.netBp, 5)}`;
        ui.exImpact.textContent = `${format(r.impactCost, 2)} U`;
        ui.exDepthDetails.textContent = `买侧${r.buy.levelsUsed}档 · 卖侧${r.sell.levelsUsed}档`;
        ui.exTotalLoss.textContent = `${format(r.totalLoss, 2)} U`;
        ui.exTotalR.textContent = `价格风险 ${format(r.risk, 2)} U · 总亏 ${format(r.totalLossR, 5)} R`;
        ui.exProxyBreakdown.textContent = `${baseLabel} ${format(r.baseCost, 2)} U ＋ 参考盘口冲击 ${format(r.impactCost, 2)} U ＋ 额外滑点 ${format(r.extraSlipCost, 2)} U − 假设返佣 ${format(r.rebateValue, 2)} U`;
        const live = state.liveEnabled && !document.hidden;
        setLiveState(live ? "live" : "paused", live ? "参考盘口实时" : "已暂停 · 快照", book.time);
        el.copySummary.disabled = false;
        setMessage(`按同名义金额映射到${proxy.label}，不计币安或Bybit手续费。${autoBase ? "基础点差也使用参考平台，Exness佣金按当前账户类型计。" : "基础费率已含点差与佣金，仅叠加参考盘口额外冲击。"}结果为用户指定的跨平台近似；不保证Exness成交能力，未计手数取整、未来跳空与隔夜。`, zone === "bad" ? "error" : "warning");
      } catch (error) {
        result = null;
        el.heroVerdict.textContent = error.message;
        setLiveState("paused", "无法估算", book.time);
        setMessage(error.message, "warning");
      }
    }
    function summary() {
      render();
      if (!result) return null;
      const r = result, proxy = source();
      return [`EXNESS ${market().id} · ${core.accounts[ui.exAccount.value]} · 跨平台代理深度估算`,
        `参考盘口：${proxy.label}｜报价时间 ${new Date(book.time).toISOString()}`,
        `止损 ${r.stopPercent}%｜风险预算 ${format(r.risk, 2)}U｜估算名义仓位 ${format(r.notional, 2)}U`,
        `总成本 ${format(r.cost, 2)}U｜成本占风险 ${format(r.riskPercent, 2)}%｜止损总亏 ${format(r.totalLoss, 2)}U`,
        ui.exProxyBreakdown.textContent, ui.exRiskEquation.textContent,
        `买侧${r.buy.levelsUsed}档／卖侧${r.sell.levelsUsed}档；额外冲击按较差侧×2。`,
        `基础费用：${r.baselineMode === "proxy-spread" ? "参考平台点差＋Exness佣金" : "设定的完整基础费率（含点差与佣金）"}；不收参考平台手续费。`,
        `条件：${proxy.venue === "binance" ? "USDT约等于USD；" : "Bybit为指示性深度；"}不是Exness真实盘口，不保证成交，不含手数取整、隔夜与未来跳空。`].join("\n");
    }
    ui.exAccount.addEventListener("change", () => { prefs.account = ui.exAccount.value; applySettings(); save(); render(); });
    ["exBaseBp", "exSlipBp", "exRebateBp"].forEach(k => ui[k].addEventListener("input", () => { save(); render(); }));
    ui.exReset.addEventListener("click", () => {
      ui.exBaseBp.value = reference() ?? ""; ui.exSlipBp.value = "0"; ui.exRebateBp.value = "0";
      save(); render();
    });
    return { resetMarket, render, summary, refresh, pause, stop };
  };
})();
