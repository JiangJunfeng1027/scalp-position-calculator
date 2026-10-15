(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.HyperliquidCatalog = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function preipoEntries(annotations) {
    if (!Array.isArray(annotations)) throw new Error("Hyperliquid分类数据无效");
    const seen = new Set();
    return annotations.flatMap(row => {
      if (!Array.isArray(row) || row[1]?.category !== "preipo") return [];
      const [id, annotation] = row;
      if (typeof id !== "string" || !id.trim() || seen.has(id)) throw new Error("Pre-IPO标的名称无效或重复");
      seen.add(id);
      return [{ id, dex: id.includes(":") ? id.split(":")[0] : "",
        displayName: typeof annotation.displayName === "string" ? annotation.displayName.trim() : "",
        keywords: Array.isArray(annotation.keywords) ? annotation.keywords.filter(x => typeof x === "string" && x.trim()) : [] }];
    });
  }

  function collectPreipo(entries, snapshots) {
    const markets = [], unavailable = [];
    for (const entry of entries) {
      const snapshot = snapshots.find(x => x.dex === entry.dex);
      if (!snapshot) throw new Error(`缺少${entry.dex || "主市场"}元数据`);
      if (snapshot.delistedIds.includes(entry.id)) {
        unavailable.push({ id: entry.id, reason: "delisted" });
        continue;
      }
      const market = snapshot.markets.find(x => x.id === entry.id);
      if (!market) {
        unavailable.push({ id: entry.id, reason: "missing" });
        continue;
      }
      // This calculator's U budget has no conversion model for other collateral.
      if (snapshot.collateralToken !== 0) {
        unavailable.push({ id: entry.id, reason: "unsupported-quote" });
        continue;
      }
      const shortName = entry.id.split(":").at(-1);
      const extraName = entry.displayName && entry.displayName.toUpperCase() !== shortName.toUpperCase()
        ? ` · ${entry.displayName}` : "";
      markets.push({ ...market, feeDexMeta: snapshot.dexMeta, isPreipo: true,
        display: `${entry.id}${extraName} · Pre-IPO`, quickLabel: `${entry.id}${extraName}`,
        searchAliases: [shortName, entry.displayName,
          entry.displayName && `${entry.dex}:${entry.displayName}`, ...entry.keywords].filter(Boolean) });
    }
    markets.sort((a, b) => a.id.localeCompare(b.id));
    const delisted = unavailable.filter(x => x.reason === "delisted").map(x => x.id);
    const other = unavailable.filter(x => x.reason !== "delisted").map(x => x.id);
    const catalogNote = ["上市前相关永续，非公司股权；分类来自部署方标签。USDC按1美元近似。",
      delisted.length ? `已下架：${delisted.join("、")}。` : "",
      other.length ? `当前元数据缺失或非USDC，暂不可估算：${other.join("、")}。` : ""].join("");
    return { markets, dexMeta: null, catalogNote, unavailable };
  }

  function matchingMarkets(markets, input) {
    const normalize = value => String(value || "").trim().toUpperCase().replace(/[-/]USDC$/, "");
    const wanted = normalize(input);
    if (!wanted) return [];
    const exact = markets.filter(m => normalize(m.id) === wanted);
    return exact.length ? exact : markets.filter(m => m.searchAliases?.some(alias => normalize(alias) === wanted));
  }
  return { preipoEntries, collectPreipo, matchingMarkets };
});
