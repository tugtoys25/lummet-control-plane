// =====================================================
// PUBLIC BRAND CONFIGURATION
//
// This is deliberately NOT the tenant registry (registry.js /
// the `tenants` table in LUMMET_DB). That table holds internal
// control-plane metadata — hosts, encrypted credentials, health
// state, internal IDs — none of which belongs on a public page.
//
// This file is the single source of truth for what the public
// marketing site is allowed to say about each connected brand:
// name, category, a short description, and a link to the
// brand's own public site. Adding a future brand to the
// homepage means adding an entry here — it never requires
// touching the tenant DB or the control-plane API.
//
// No traffic, revenue, licensing, or customer-count claims are
// stored here on purpose — the homepage must never display
// numbers that were invented rather than sourced.
// =====================================================

export const PUBLIC_BRANDS = [
  {
    name: "Level.casino",
    category: "iGaming & Casino Intelligence",
    description:
      "Premium casino reviews, comparisons, GEO-focused rankings, affiliate content and iGaming publishing.",
    url: "https://level.casino/en",
    status: "active"
  },
  {
    name: "NeuroOdds.com",
    category: "Sports Betting & Odds Intelligence",
    description: "Sports betting, odds, analysis and sports-focused editorial content.",
    url: "https://neuroodds.com",
    status: "active"
  },
  {
    name: "Cluster.casino",
    category: "iGaming & Casino Platform",
    description: "Casino-focused digital publishing and comparison infrastructure.",
    url: "https://cluster.casino",
    status: "active"
  },
  {
    name: "LegendOdds.com",
    category: "Sports Betting & Odds",
    description: "Sports betting and odds-focused digital publishing.",
    url: "https://legendodds.com",
    status: "active"
  },
  {
    name: "BrilliantOdds.com",
    category: "Sports & Betting Intelligence",
    description: "Sports, odds and betting-focused digital content.",
    url: "https://brilliantodds.com",
    status: "active"
  },
  {
    name: "Freewin.xyz",
    category: "Digital iGaming Property",
    description: "iGaming publishing, casino content and affiliate infrastructure.",
    url: "https://freewin.xyz",
    status: "active"
  }
];

export function listPublicBrands() {
  return PUBLIC_BRANDS.filter((b) => b.status === "active");
}
