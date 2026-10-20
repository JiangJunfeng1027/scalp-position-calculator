// User-selected scope: SOXL, SNDK, MU, SKHYNIX, SPCX. KORU explicitly excluded.
// US listings verified via Nasdaq Trader; SKHYNIX selected explicitly as Korean equity.
(function (root, factory) {
  const data = factory();
  if (typeof module === "object" && module.exports) module.exports = data;
  else root.OKXSelectedListings = data;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  return {
  "SOXL": {
    "name": "Direxion Daily Semiconductor Bull 3X ETF",
    "etf": true,
    "listedSymbol": "SOXL"
  },
  "SNDK": {
    "name": "Sandisk Corporation - Common Stock When-Issued",
    "etf": false,
    "listedSymbol": "SNDK"
  },
  "MU": {
    "name": "Micron Technology, Inc. - Common Stock",
    "etf": false,
    "listedSymbol": "MU"
  },
  "SKHYNIX": {
    "name": "SK hynix（SK海力士，韩国股票）",
    "etf": false,
    "listedSymbol": "000660",
    "market": "KR"
  },
  "SPCX": {
    "name": "Space Exploration Technologies Corp. - Class A Common Stock",
    "etf": false,
    "listedSymbol": "SPCX"
  }
};
});
