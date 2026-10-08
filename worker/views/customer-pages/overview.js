import { escapeHtml } from "../customer-layout.js";

function trialCountdown(trialEndsAt) {
  if (!trialEndsAt) return null;
  const msLeft = new Date(trialEndsAt).getTime() - Date.now();
  const daysLeft = Math.ceil(msLeft / (1000 * 60 * 60 * 24));
  if (daysLeft <= 0) return "Trial has ended";
  return `${daysLeft} day${daysLeft === 1 ? "" : "s"} left in trial`;
}

export function renderOverviewPage({ organization, subscription, plan, usage, sites }) {
  const statusBadge = subscription
    ? `<span class="badge badge-${escapeHtml(subscription.status)}">${escapeHtml(subscription.status)}</span>`
    : `<span class="badge badge-canceled">no plan</span>`;

  const trialNote = subscription?.status === "trialing" ? trialCountdown(subscription.trial_ends_at) : null;

  const upgradeCta = !subscription
    ? `<div class="card">
         <h2>Get started</h2>
         <p style="color:var(--text-dim);font-size:14px;">This organization has no plan yet — start a trial to create your first site.</p>
         <a class="btn" href="/app/billing">Choose a plan</a>
       </div>`
    : "";

  const sitesRows = sites.length
    ? sites
        .map(
          (site) => `
          <tr>
            <td><a href="/app/sites#${escapeHtml(site.id)}">${escapeHtml(site.name)}</a></td>
            <td>${escapeHtml(site.product_name || "")}</td>
            <td><span class="badge badge-${escapeHtml(site.status)}">${escapeHtml(site.status)}</span></td>
            <td class="mono">${escapeHtml(site.primary_domain || "—")}</td>
          </tr>`
        )
        .join("")
    : `<tr><td colspan="4" class="empty">No sites yet.</td></tr>`;

  return `
    <h1>Overview</h1>
    <p class="subtitle">${escapeHtml(organization.name)}</p>

    ${upgradeCta}

    <div class="grid">
      <div class="card stat">
        <div class="value">${usage.sites.used}${usage.sites.limit != null ? " / " + usage.sites.limit : ""}</div>
        <div class="label">Sites</div>
      </div>
      <div class="card stat">
        <div class="value">${usage.users.used}${usage.users.limit != null ? " / " + usage.users.limit : ""}</div>
        <div class="label">Team members</div>
      </div>
      <div class="card stat">
        <div class="value">${usage.customDomains.used}${usage.customDomains.limit != null ? " / " + usage.customDomains.limit : ""}</div>
        <div class="label">Custom domains</div>
      </div>
      <div class="card stat">
        <div class="value">${statusBadge}</div>
        <div class="label">${plan ? escapeHtml(plan.name) : "Plan"}${trialNote ? "<br/>" + escapeHtml(trialNote) : ""}</div>
      </div>
    </div>

    <div class="card">
      <h2>Sites</h2>
      <table>
        <thead><tr><th>Name</th><th>Product</th><th>Status</th><th>Domain</th></tr></thead>
        <tbody>${sitesRows}</tbody>
      </table>
    </div>
  `;
}

export { trialCountdown };
