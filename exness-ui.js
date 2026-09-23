(function () {
  "use strict";
  window.createExnessView = function ({ el, state, format, renderEmpty, setLiveState, setMessage }) {
    const core = window.ExnessCore;
    const ids = ["exAccount", "exBid", "exAsk", "exCommission", "exRebate", "exSlippage", "exStep", "exMaxLots", "exSpec", "exQuoteTime", "exReset"];
    const ui = Object.fromEntries(ids.map(id => [id, document.getElementById(id)]));
    const key = "execution-cost-exness-v1";
    let prefs = {}, result = null, quoteAt = null;
    try { prefs = JSON.parse(localStorage.getItem(key) || "{}"); } catch { /* Optional settings. */ }
    if (!prefs || typeof prefs !== "object" || Array.isArray(prefs)) prefs = {};
    if (Object.hasOwn(core.accounts, prefs.account)) ui.exAccount.value = prefs.account;
    const market = () => core.markets.find(m => m.id === state.market?.id);
    const pairKey = () => `${ui.exAccount.value}:${market()?.id}`;
    function save() {
      prefs.account = ui.exAccount.value;
      prefs[pairKey()] = Object.fromEntries(["exCommission", "exRebate", "exSlippage", "exStep", "exMaxLots"].map(k => [k, ui[k].value]));
      try { localStorage.setItem(key, JSON.stringify(prefs)); } catch { /* Storage may be unavailable. */ }
    }
    function resetMarket() {
      const m = market();
      result = null; quoteAt = null;
      ui.exBid.value = ""; ui.exAsk.value = "";
      ui.exCommission.value = core.commission(m, ui.exAccount.value);
      ui.exRebate.value = "0"; ui.exSlippage.value = "0";
      ui.exStep.value = m.step; ui.exMaxLots.value = m.max;
      const saved = prefs[pairKey()];
      if (saved && typeof saved === "object") {
        ["exCommission", "exRebate", "exSlippage", "exStep", "exMaxLots"].forEach(k => {
          if (typeof saved[k] === "string" && saved[k].trim() !== "" && Number(saved[k]) >= 0) ui[k].value = saved[k];
        });
      }
      ui.exSpec.textContent = `1手＝${m.multiplier}${m.unit}；最小${m.min}手。佣金默认值已折算为完整往返。${["XAGUSD", "USTEC"].includes(m.id) ? "上限默认采用夜间较低值，可按终端规格修改。" : ""}手数步进请按实际终端复核；不估算保证金。规格核验 ${core.checkedAt}。`;
      el.productNote.textContent = `${m.name} · ${core.accounts[ui.exAccount.value]} · 手动报价，非实时行情`;
      el.productNote.classList.add("warning-note");
      render();
    }
    function render() {
      if (state.platform !== "exness") return;
      const m = market();
      if (!m) return;
      renderEmpty(); result = null;
      document.getElementById("exRebateValue").textContent = "--";
      document.getElementById("exSlipValue").textContent = "--";
      el.contextPlatform.textContent = `EXNESS · ${core.accounts[ui.exAccount.value]}`;
      el.contextSymbol.textContent = m.id;
      el.frameCount.textContent = "手动情景 · 无实时深度";
      el.heroLabel.textContent = "情景成本 / 风险";
      el.feeBreakdownLabel.textContent = "往返佣金（返佣前）";
      el.bookBreakdownLabel.textContent = "完整买卖价差";
      el.heroVerdict.textContent = "填写同一账户的买入价和卖出价";
      setLiveState("paused", "手动报价", quoteAt);
      ui.exQuoteTime.textContent = quoteAt ? `报价录入：${new Date(quoteAt).toLocaleString("zh-CN", { hour12: false })}，请自行确认仍有效。` : "报价不保存，每次切换标的、账户或重开页面需重新填写。";
      if (!ui.exBid.value.trim() || !ui.exAsk.value.trim()) {
        setMessage("请从所选Exness账户抄入同一时刻的卖出价和买入价。此模式不会自动更新报价，也不代表可成交深度。", "info");
        return;
      }
      try {
        const redline = Number(el.redline.value);
        if (!(redline > 0 && redline <= 10)) throw new Error("成本红线须大于0且不高于10%R");
        result = core.estimate({ symbol: m.id, bid: ui.exBid.value, ask: ui.exAsk.value,
          risk: el.risk.value, stopPercent: el.stopPercent.value, commission: ui.exCommission.value,
          rebate: ui.exRebate.value, slippage: ui.exSlippage.value, step: ui.exStep.value, maxLots: ui.exMaxLots.value });
        const r = result;
        el.heroResult.dataset.zone = r.riskPercent > redline ? "bad" : "warn";
        el.heroValue.textContent = format(r.riskPercent, 2);
        el.heroVerdict.textContent = `${r.riskPercent > redline ? "情景超过" : "情景低于"}${format(redline)}%R红线 · 实际滑点与容量未验证`;
        el.riskFill.style.width = `${Math.min(100, r.riskPercent / 10 * 100)}%`;
        el.positionValue.textContent = `${format(r.notional, 2)} U`;
        el.quantityValue.textContent = `${format(r.lots, 4)} 手 · ${format(r.units, 4)}${m.unit}`;
        el.costValue.textContent = `${format(r.cost, 2)} U`;
        el.costRateValue.textContent = `万${format(r.costBp, 4)} · 返佣前 ${format(r.gross, 2)} U`;
        el.totalLossValue.textContent = `${format(r.totalLoss, 2)} U`;
        el.actualRiskValue.textContent = `情景总亏 · 价格风险 ${format(r.priceRisk, 2)} U`;
        el.midValue.textContent = format(r.mid, 8);
        el.spreadValue.textContent = `手动完整价差 ${format(r.spread, 8)} · 只计一次`;
        el.feeBreakdownLabel.textContent = "往返佣金（返佣前）";
        el.bookBreakdownLabel.textContent = "完整买卖价差";
        el.feeValue.textContent = `${format(r.feeCost, 2)} U`;
        el.bookValue.textContent = `${format(r.spreadCost, 2)} U`;
        const base = Math.max(1e-10, r.gross);
        el.feeBar.style.width = `${r.feeCost / base * 100}%`;
        el.bookBar.style.width = `${r.spreadCost / base * 100}%`;
        document.getElementById("exRebateValue").textContent = `${r.rebateValue ? "−" : ""}${format(r.rebateValue, 2)} U`;
        document.getElementById("exSlipValue").textContent = `${format(r.slipCost, 2)} U`;
        el.copySummary.disabled = false;
        setMessage(`按手动报价计算：价差＋往返佣金＋所填滑点−所填返佣。${r.rebateValue > 0 ? "返佣为手动假设，未验证资格或到账。" : "未计任何返佣。"}${r.slipCost === 0 ? "额外滑点填0不代表实际零滑点。" : "所填滑点为情景值，非实测。"}未计隔夜费、资金转换、未来跳空；无实时盘口，无法验证大单容量。`, "warning");
      } catch (error) {
        result = null;
        el.heroVerdict.textContent = error.message;
        setMessage(error.message, "warning");
      }
    }
    function summary() {
      render(); // Recheck current inputs even if the shared risk-field debounce is pending.
      if (!result) return null;
      const r = result;
      return [`EXNESS ${market().id} · ${core.accounts[ui.exAccount.value]} · 手动情景，非实时`,
        `报价录入 ${new Date(quoteAt).toLocaleString("zh-CN", { hour12: false })}｜卖出 ${ui.exBid.value}｜买入 ${ui.exAsk.value}`,
        `止损 ${el.stopPercent.value}%｜价格风险 ${el.risk.value}U｜${format(r.lots, 4)}手｜名义 ${format(r.notional, 2)}U`,
        `成本 ${format(r.cost, 2)}U＝价差${format(r.spreadCost, 2)}＋往返佣金${format(r.feeCost, 2)}＋假设滑点${format(r.slipCost, 2)}−假设返佣${format(r.rebateValue, 2)}`,
        `成本占风险 ${format(r.riskPercent, 2)}%｜万${format(r.costBp, 4)}｜返佣前${format(r.gross, 2)}U`,
        "未验证实时行情、实际返佣、滑点及可成交容量；未计隔夜与未来跳空。"].join("\n");
    }
    ui.exAccount.addEventListener("change", () => { prefs.account = ui.exAccount.value; resetMarket(); save(); });
    ["exBid", "exAsk", "exCommission", "exRebate", "exSlippage", "exStep", "exMaxLots"].forEach(k => ui[k].addEventListener("input", () => {
      if (k === "exBid" || k === "exAsk") quoteAt = Date.now();
      save(); render();
    }));
    ui.exReset.addEventListener("click", () => { ui.exCommission.value = core.commission(market(), ui.exAccount.value); save(); render(); });
    return { resetMarket, render, summary };
  };
})();
