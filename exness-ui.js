(function () {
  "use strict";
  window.createExnessView = function ({ el, state, format, numberValue, renderEmpty, setLiveState, setMessage }) {
    const core = window.ExnessCore;
    const ids = ["exAccount", "exBaseBp", "exSlipBp", "exRebateBp", "exReset", "exRateNote", "exPosition", "exCost", "exNetRate", "exMinStop", "exTotalLoss", "exTotalR", "exThresholdLabel", "exReferenceNote", "exScaleNote", "exRiskEquation"];
    const ui = Object.fromEntries(ids.map(id => [id, document.getElementById(id)]));
    const key = "execution-cost-exness-ratio-v2";
    let prefs = {}, result = null;
    try { prefs = JSON.parse(localStorage.getItem(key) || "{}"); } catch { /* Optional settings. */ }
    if (!prefs || typeof prefs !== "object" || Array.isArray(prefs)) prefs = {};
    if (Object.hasOwn(core.accounts, prefs.account)) ui.exAccount.value = prefs.account;
    const market = () => core.markets.find(m => m.id === state.market?.id);
    const pairKey = () => `${ui.exAccount.value}:${market()?.id}`;
    const reference = () => core.referenceBp[ui.exAccount.value]?.[market()?.id];
    function save() {
      prefs.account = ui.exAccount.value;
      prefs[pairKey()] = { baseBp: ui.exBaseBp.value, slipBp: ui.exSlipBp.value, rebateBp: ui.exRebateBp.value };
      try { localStorage.setItem(key, JSON.stringify(prefs)); } catch { /* Storage may be unavailable. */ }
    }
    function resetMarket() {
      const saved = prefs[pairKey()];
      ui.exBaseBp.value = saved?.baseBp ?? reference() ?? "";
      ui.exSlipBp.value = saved?.slipBp ?? "0";
      ui.exRebateBp.value = saved?.rebateBp ?? "0";
      render();
    }
    function render() {
      if (state.platform !== "exness" || !market()) return;
      const m = market();
      renderEmpty(); result = null;
      ui.exScaleNote.hidden = true;
      ui.exRiskEquation.textContent = "--";
      [ui.exPosition, ui.exCost, ui.exNetRate, ui.exMinStop, ui.exTotalLoss, ui.exTotalR].forEach(node => node.textContent = "--");
      const custom = ui.exBaseBp.value !== String(reference() ?? "");
      const source = custom ? "自设费用情景" : "历史费用情景";
      el.contextPlatform.textContent = `EXNESS · ${core.accounts[ui.exAccount.value]}`;
      el.contextSymbol.textContent = m.id;
      el.productNote.textContent = `${m.name} · ${core.accounts[ui.exAccount.value]} · 参考费率，非实时`;
      el.productNote.classList.add("warning-note");
      el.frameCount.textContent = "固定费率 · 规模影响未评估";
      el.heroLabel.textContent = "固定费率情景成本 / 风险";
      el.heroVerdict.textContent = "等待止损距离与风险预算";
      setLiveState("paused", "固定费率估算", null);
      const missing = !ui.exBaseBp.value.trim();
      ui.exRateNote.textContent = missing
        ? "完整往返成本率待确认；确认一次并保存后，日常只填止损距离和风险预算。"
        : `往返成本基准：万${ui.exBaseBp.value} · ${source}，可展开修改。`;
      ui.exReferenceNote.textContent = reference() == null
        ? "该账户/标的暂无已核实的完整成本率。请填写点差＋双边佣金的总费率，不要只填佣金；未确认时不输出数字。"
        : `历史讨论情景：${m.id === "BTCUSD" ? "比特币按80,000美元" : "黄金按4,000美元"}折算的往返点差＋佣金，未计返佣、额外滑点与隔夜。不是今天的实测费率。`;
      ui.exReset.disabled = reference() == null;
      ui.exThresholdLabel.textContent = `固定费率下满足${el.redline.value}%R的止损`;
      if (missing) {
        el.heroVerdict.textContent = "完整费用率待确认";
        setMessage("该账户/标的缺少可靠的完整成本基准，暂不猜测结果；在费用设置中填一次总费率，之后会自动记住。", "warning");
        return;
      }
      try {
        result = core.estimateRatio({ stopPercent: numberValue(el.stopPercent), risk: numberValue(el.risk), baseBp: ui.exBaseBp.value,
          slipBp: ui.exSlipBp.value, rebateBp: ui.exRebateBp.value, redline: numberValue(el.redline) });
        const r = result;
        const zone = window.CostCore.costRiskZone(r.riskPercent, r.redline);
        el.heroResult.dataset.zone = zone;
        el.heroValue.textContent = format(r.riskPercent, 2);
        const verdict = zone === "bad" ? "情景成本超过10%R上限"
          : zone === "warn" ? `情景成本超过${format(r.redline)}%R · 不高于10%上限`
          : `情景成本不高于${format(r.redline)}%R理想线`;
        el.heroVerdict.textContent = verdict;
        ui.exRiskEquation.textContent = `成本 ${format(r.cost, 2)} U ÷ 风险预算 ${format(r.risk, 2)} U ≈ ${format(r.riskPercent, 2)}%`;
        ui.exScaleNote.hidden = false;
        el.riskFill.style.width = `${Math.min(100, r.riskPercent / 10 * 100)}%`;
        ui.exPosition.textContent = `${format(r.notional, 2)} U`;
        ui.exCost.textContent = `${format(r.cost, 2)} U`;
        ui.exNetRate.textContent = `固定往返成本率 万${format(r.netBp, 5)}`;
        ui.exMinStop.textContent = `${format(r.minStopPercent, 5)}%`;
        ui.exTotalLoss.textContent = `${format(r.totalLoss, 2)} U`;
        ui.exTotalR.textContent = `价格风险 ${format(r.risk, 2)} U · 总亏 ${format(r.totalLossR, 5)} R`;
        el.copySummary.disabled = false;
        setMessage(`情景总亏＝风险预算＋按固定费率计算的成本。${source}；${r.rebateBp > 0 ? "已扣除手动返佣假设，到账未验证。" : "未计返佣。"}${r.slipBp > 0 ? "滑点是手动设定的固定比率，不会随仓位自动变化。" : "额外滑点设为0不代表实际滑点为0。"}当前没有规模相关成交数据，无法判断大单容量或实际总成本；未计手数取整与隔夜。`, zone === "bad" ? "error" : "warning");
      } catch (error) {
        result = null;
        el.heroVerdict.textContent = error.message;
        setMessage(error.message, "warning");
      }
    }
    function summary() {
      render();
      if (!result) return null;
      const r = result;
      return [`EXNESS ${market().id} · ${core.accounts[ui.exAccount.value]} · 固定费率情景，非实时`,
        `止损 ${r.stopPercent}%｜固定往返成本 万${format(r.netBp, 5)}｜情景成本占风险 ${format(r.riskPercent, 2)}%`,
        `基准 万${format(r.baseBp, 5)}＋额外滑点 万${format(r.slipBp, 5)}−假设返佣 万${format(r.rebateBp, 5)}`,
        `风险预算（不含成本）${format(r.risk, 2)}U｜估算名义仓位 ${format(r.notional, 2)}U`,
        `情景成本 ${format(r.cost, 2)}U｜情景总亏 ${format(r.totalLoss, 2)}U（${format(r.totalLossR, 5)}R）`,
        ui.exRiskEquation.textContent,
        `固定费率下满足${r.redline}%R所需止损≥${format(r.minStopPercent, 5)}%`,
        "止损与费率不变时，预算和费用等比例变化，成本占风险不变。",
        "实际总成本占风险：未评估；缺少规模相关成交数据，手动滑点率不会随仓位自动变化。",
        "条件：参考费率成立；非账户实测，不含手数取整、实际大单冲击、隔夜或未来跳空。"].join("\n");
    }
    ui.exAccount.addEventListener("change", () => { prefs.account = ui.exAccount.value; resetMarket(); save(); });
    ["exBaseBp", "exSlipBp", "exRebateBp"].forEach(k => ui[k].addEventListener("input", () => { save(); render(); }));
    ui.exReset.addEventListener("click", () => {
      ui.exBaseBp.value = reference() ?? ""; ui.exSlipBp.value = "0"; ui.exRebateBp.value = "0";
      save(); render();
    });
    return { resetMarket, render, summary };
  };
})();
