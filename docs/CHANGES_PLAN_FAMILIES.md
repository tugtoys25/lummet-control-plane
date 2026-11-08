# Generic, editable plan families (migration 0089)

## What changed
- A product used to be both the **plan family** on the pricing page (Casino Affiliate: Starter, Growth, Pro) and the **site type** a customer picks when creating a site. They are now two independent switches on each product, in the staff console under **Plans & pricing > Plan families & site types**:
  - *Show as a plan family on the public pricing page* (`show_on_pricing`)
  - *Offer as a site type when a customer creates a site* (`show_in_site_creation`)
- Each product also has a **public name** (what customers see; the internal name stays a staff label), an editable **slug**, a description and a sort order. The internal `id` and `key` never change (price lookup keys and Stripe objects are built from them).
- Renaming a slug keeps the old one in `product_slug_history`: `/pricing?family=<old-slug>` still resolves, and a slug is never reused for another product. Reserved words (admin, api, pricing, ...) are refused.
- **Clone as generic family**: creates a new family with a *draft* copy of every monthly plan (name, limits, feature lines, labels). Prices, Stripe objects and subscriptions are never copied. The clone is a plan family only, so customers choose the kind of site when they create one.
- The pricing page lists only families marked "on pricing page", under their public name, in staff order; with a single family the family filter is hidden. `/app/sites` lists only site types; the plan chooser for new customers lists only plan families.
- Every default reproduces the old behaviour (both switches on, no public name, slug = key with hyphens), so nothing changes until staff change something. All new reads fall back to the old query if the migration is not applied yet.

## Going generic: the steps (nothing is sold until step 4)
1. Plans & pricing > **Plan families & site types** > **Clone as generic** on a family (for example Casino Affiliate). Name it (for example "Platform").
2. Open each draft plan and set its price (Pricing tab). Prices stay immutable versions as before.
3. Attach each plan's Stripe price the way the Pricing tab asks (I did not verify the Stripe step end to end; test it in Stripe test mode first).
4. Publish the three plans. In the manager, switch **off** "Show on pricing page" for the vertical families (Casino Affiliate, Sports Affiliate, ...). **Leave "site type" on**, so customers still pick the kind of site.
5. Existing subscribers keep their current plan and price; hiding a family only removes it from the public page.

## Not changed / open
- Plan switching for existing subscribers is still within their own family (`/app/billing`). Moving subscribers from a vertical family to the generic one is a manual decision (not automated here).
- The commercial catalog file (`catalog/plans.v1.json`) is not changed: generic plans created in the console live in the database, like any other plan made there. If you want them in the catalog file for `stripe-sync`, add them as you would any new plan.
- Two tests (`load-d1-policies-6-5c`, `phase6-gate`) need files from the monorepo root (`PLACEHOLDERS.md`, `RELEASE_ID`) and fail the same way on the unmodified code when run from this folder alone.
