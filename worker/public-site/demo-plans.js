// PUBLIC SITE — plans on the /demo page (flag DEMO_PAGE_PLANS=on; default off).
// Under the demo form, up to three buyable plans of one product, each linking to /app/signup?plan=&period= (the same
// route the pricing page uses, so the choice is kept through signup), and a "View all plans" link to /pricing.
// Only plans with an active Stripe price are shown, so a visitor never clicks a plan that cannot be bought.
import * as pricingRepo from "../repositories/pricing.js";
import { cardRequiredTrial, withEffectiveTrial } from "../billing-config.js";
import { pricingGroups } from "./pages.js";

export function demoPlansMode(env) {
  return String((env && env.DEMO_PAGE_PLANS) || "off").trim().toLowerCase() === "on";
}

/** The view model for the demo page, or null when the flag is off or there is nothing to show. Never throws. */
export async function demoPlans(ctx) {
  try {
    if (!demoPlansMode(ctx.env)) return null;
    const ui = ctx.siteCtx.ui || {};
    const plans = withEffectiveTrial(ctx.env, await pricingRepo.listPricing(ctx.env, { requirePrice: true }));
    const groups = pricingGroups(plans, "monthly", ui).filter((g) => g.plans.length);
    // DEMO_PLANS_PRODUCT (a product id) picks the family to show; otherwise the first one.
    const wanted = String(ctx.env.DEMO_PLANS_PRODUCT || "").trim();
    const group = (wanted && groups.find((g) => g.id === wanted)) || groups[0];
    if (!group) return null;
    const shown = group.plans.slice(0, 3).map((p) => ({
      name: p.name,
      price: p.price,
      period: p.period,
      trial: p.trial,
      features: p.features.slice(0, 4),
      href: `/app/signup?plan=${encodeURIComponent(p.planId)}&period=${encodeURIComponent(p.signupPeriod)}`
    }));
    return {
      title: ui.demo_plans_title || "Prefer to try it yourself?",
      intro: ui.demo_plans_intro || "Start a free trial on any plan. No sales call needed.",
      note: cardRequiredTrial(ctx.env) ? (ui.demo_plans_card_note || "A card is needed to start the trial. You are not charged until it ends, and you can cancel before then.") : "",
      cta: ui.pricing_cta || "Start free trial",
      viewAll: ui.demo_plans_view_all || "View all plans",
      plans: shown
    };
  } catch (err) {
    console.error("demo page plans failed:", err?.message || err);
    return null;
  }
}
