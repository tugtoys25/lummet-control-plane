// =====================================================
// PUBLIC SITE — PLANS TEASER (homepage)
// A short, factual preview of the buyable plans so a visitor can start without leaving the homepage: up to three plans
// of one product family (DEMO_PLANS_PRODUCT picks it, otherwise the first), each linking to the same signup route the
// pricing page uses, plus the cheapest monthly price and the trial length for the hero note. Everything comes from the
// plans table; when there is nothing to sell this returns null and the homepage simply has no plans block. Never throws.
// =====================================================
import * as pricingRepo from "../repositories/pricing.js";
import { cardRequiredTrial } from "../billing-config.js";
import { pricingGroups, MONEY } from "./pages.js";

export async function plansTeaser(ctx) {
  try {
    const ui = ctx.siteCtx.ui || {};
    const all = await pricingRepo.listPricing(ctx.env, { requirePrice: cardRequiredTrial(ctx.env) });
    const monthly = all.filter((p) => p.billing_period === "monthly");
    if (!monthly.length) return null;

    const groups = pricingGroups(all, "monthly", ui).filter((g) => g.plans.length);
    const wanted = String(ctx.env.DEMO_PLANS_PRODUCT || "").trim();
    const group = (wanted && groups.find((g) => g.id === wanted)) || groups[0];
    if (!group) return null;

    const cheapest = monthly.reduce((a, b) => (b.price_cents < a.price_cents ? b : a));
    const minTrial = Math.min(...monthly.map((p) => Number(p.trial_days) || 0));
    return {
      family: group.name,
      family_count: groups.length,
      plans: group.plans.slice(0, 3).map((p) => ({ ...p, href: `/app/signup?plan=${encodeURIComponent(p.planId)}&period=${encodeURIComponent(p.signupPeriod)}` })),
      from_price: MONEY(cheapest.price_cents, cheapest.currency),
      from_note: (ui.hero_from_price || "Plans from {price} per month").replace("{price}", MONEY(cheapest.price_cents, cheapest.currency)),
      trial_note: minTrial > 0 ? (ui.pricing_trial || "{n}-day free trial").replace("{n}", String(minTrial)) : ""
    };
  } catch (err) {
    console.error("plans teaser failed:", err?.message || err);
    return null;
  }
}
