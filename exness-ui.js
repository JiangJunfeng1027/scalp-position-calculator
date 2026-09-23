(function () {
  "use strict";
  window.createExnessView = function ({ el, state, format, renderEmpty, setLiveState, setMessage }) {
    const core = window.ExnessCore;
    const ids = ["exAccount", "exBaseBp", "exSlipBp", "exRebateBp", "exReset", "exRateNote", "exNetRate", "exCostPer100", "exMinStop", "exTotalR", "exThresholdLabel", "exReferenceNote"];
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
      [ui.exNetRate, ui.exCostPer100, ui.exMinStop, ui.exTotalR].forEach(node => node.textContent = "--");
      const custom = ui.exBaseBp.value !== String(reference() ?? "");
      const source = custom ? "自设费用情景" : "历史费用情景";
      el.contextPlatform.textContent = `EXNESS · ${core.accounts[ui.exAccount.value]}`;
      el.contextSymbol.textContent = m.id;
      el.productNote.textContent = `${m.name} · ${core.accounts[ui.exAccount.value]} · 参考费率，非实时`;
      el.productNote.classList.add("warning-note");
      el.frameCount.textContent = "只填止损 · 比例估算";
      el.heroLabel.textContent = "参考成本 / 风险";
      el.heroVerdict.textContent = "等待止损距离";
      setLiveState("paused", "参考估算", null);
      const missing = !ui.exBaseBp.value.trim();
      ui.exRateNote.textContent = missing
        ? "完整往返成本率待确认；确认一次并保存后，日常只填止损距离。"
        : `往返成本基准：万${ui.exBaseBp.value} · ${source}，可展开修改。`;
      ui.exReferenceNote.textContent = reference() == null
        ? "该账户/标的暂无已核实的完整成本率。请填写点差＋双边佣金的总费率，不要只填佣金；未确认时不输出数字。"
        : `历史讨论情景：${m.id === "BTCUSD" ? "比特币按80,000美元" : "黄金按4,000美元"}折算的往返点差＋佣金，未计返佣、额外滑点与隔夜。不是今天的实测费率。`;
      ui.exReset.disabled = reference() == null;
      ui.exThresholdLabel.textContent = `满足${el.redline.value}%R红线所需止损`;
      if (missing) {
        el.heroVerdict.textContent = "完整费用率待确认";
        setMessage("已简化为止损距离计算。该账户/标的缺少可靠的完整成本基准，暂不猜测结果；在费用设置中填一次总费率，之后会自动记住。", "warning");
        return;
      }
      try {
        result = core.estimateRatio({ stopPercent: el.stopPercent.value, baseBp: ui.exBaseBp.value,
          slipBp: ui.exSlipBp.value, rebateBp: ui.exRebateBp.value, redline: el.redline.value });
        const r = result;
        el.heroResult.dataset.zone = r.riskPercent > r.redline ? "bad" : "warn";
        el.heroValue.textContent = format(r.riskPercent, 2);
        el.heroVerdict.textContent = `参考值${r.riskPercent > r.redline ? "超过" : "不高于"}${format(r.redline)}%R红线 · 以费用基准成立为前提`;
        el.riskFill.style.width = `${Math.min(100, r.riskPercent / 10 * 100)}%`;
        ui.exNetRate.textContent = `万${format(r.netBp, 5)}`;
        ui.exCostPer100.textContent = `${format(r.costPer100Risk, 2)} U`;
        ui.exMinStop.textContent = `${format(r.minStopPercent, 5)}%`;
        ui.exTotalR.textContent = `${format(r.totalLossR, 5)} R`;
        el.copySummary.disabled = false;
        setMessage(`计算：往返成本率÷止损距离。${source}；${r.rebateBp > 0 ? "已扣除手动返佣假设，到账未验证。" : "未计返佣。"}不需要本金或买卖报价。未计手数取整、实际大单冲击及隔夜；费用随行情变化，结果是参考值。`, "warning");
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
      return [`EXNESS ${market().id} · ${core.accounts[ui.exAccount.value]} · 参考费用情景，非实时`,
        `止损 ${r.stopPercent}%｜往返成本 万${format(r.netBp, 5)}｜成本占风险 ${format(r.riskPercent, 2)}%`,
        `基准 万${format(r.baseBp, 5)}＋额外滑点 万${format(r.slipBp, 5)}−假设返佣 万${format(r.rebateBp, 5)}`,
        `每100U价格风险对应成本 ${format(r.costPer100Risk, 2)}U｜含摩擦总亏 ${format(r.totalLossR, 5)}R`,
        `满足${r.redline}%R红线所需止损≥${format(r.minStopPercent, 5)}%`,
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
