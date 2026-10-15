"use strict";
const assert = require("node:assert/strict");
const core = require("../hl-catalog.js");
const annotations = [
  ["io:ANTH", { category: "preipo" }],
  ["io:OAI", { category: "preipo", displayName: "OPENAI", keywords: ["openai", "oai"] }],
  ["xyz:OURA", { category: "preipo" }],
  ["para:ANTH", { category: "preipo" }],
  ["vntl:OPENAI", { category: "preipo" }],
  ["xyz:MU", { category: "equity" }],
];
const snapshot = (dex, ids, collateralToken = 0, delistedIds = []) => ({ dex, collateralToken, delistedIds,
  dexMeta: { name: dex, deployerFeeScale: dex === "io" ? "1.0" : "0.5" },
  markets: ids.map(id => ({ id, bookSymbol: id, dex, isMain: false, quantityStep: "0.001" })) });
const entries = core.preipoEntries(annotations);
assert.equal(entries.length, 5);
const snapshots = [snapshot("io", ["io:ANTH", "io:OAI"]), snapshot("xyz", ["xyz:OURA"]),
  snapshot("para", [], 0, ["para:ANTH"]), snapshot("vntl", ["vntl:OPENAI"], 360)];
const result = core.collectPreipo(entries, snapshots);
assert.deepEqual(result.markets.map(x => x.id), ["io:ANTH", "io:OAI", "xyz:OURA"]);
assert.equal(result.unavailable.find(x => x.id === "para:ANTH").reason, "delisted");
assert.equal(result.unavailable.find(x => x.id === "vntl:OPENAI").reason, "unsupported-quote");
assert.equal(result.markets[1].bookSymbol, "io:OAI");
assert.equal(result.markets[1].feeDexMeta.name, "io");
assert.equal(result.markets[2].feeDexMeta.name, "xyz");
for (const input of ["OPENAI", "OPENAI-USDC", "io:OPENAI", "IO:OAI", "oai"]) {
  assert.equal(core.matchingMarkets(result.markets, input)[0].id, "io:OAI");
}
const activePara = core.collectPreipo(entries, snapshots.map(x => x.dex === "para" ? snapshot("para", ["para:ANTH"]) : x));
assert.equal(core.matchingMarkets(activePara.markets, "ANTH").length, 2);
assert.deepEqual(core.matchingMarkets(activePara.markets, "para:ANTH").map(x => x.id), ["para:ANTH"]);
assert.equal(core.matchingMarkets(result.markets, "para:ANTH").length, 0);
assert.equal(core.matchingMarkets(result.markets, "").length, 0);
assert.throws(() => core.preipoEntries(null), /无效/);
assert.throws(() => core.preipoEntries([...annotations, annotations[0]]), /重复/);
assert.throws(() => core.collectPreipo(entries, snapshots.slice(1)), /缺少/);
assert.equal(core.collectPreipo([], []).markets.length, 0);
const missing = core.collectPreipo(entries, snapshots.map(x => x.dex === "io" ? { ...x, markets: [] } : x));
assert.equal(missing.unavailable.filter(x => x.reason === "missing").length, 2);
console.log("Hyperliquid Pre-IPO catalog tests passed (dynamic category, canonical names, per-dex metadata, aliases, ambiguity, delisting, collateral).");
