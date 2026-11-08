// =====================================================
// CUSTOMER DEPLOYMENTS PAGE (roadmap 1.1)
//
// Customers never supply script content: "update" deploys the
// currently-published tenant template release, and "roll back"
// re-deploys the stored release for that earlier version. Both go
// through routes in index.js that resolve the script server-side
// (tenant-template.js), so this page only ever sends a site and,
// for rollback, a target deployment id.
// =====================================================
import { escapeHtml } from "../customer-layout.js";
import { nonceToken, onClick } from "../../csp.js";
import { liveAttrs, DEPLOYMENT_TRANSIENT } from "../../live.js";

const STATUS_LABEL = {
  queued: "Queued",
  building: "Building",
  migrating: "Migrating",
  deploying: "Deploying",
  checking: "Checking",
  active: "Live",
  failed: "Failed",
  rolled_back: "Rolled back"
};

const IN_PROGRESS = new Set(["queued", "building", "migrating", "deploying", "checking"]);

function badgeClass(status) {
  if (status === "active") return "badge-active";
  if (status === "failed") return "badge-failed";
  if (status === "rolled_back") return "badge-suspended";
  return "badge-trialing";
}

function rowActions(site, deployment, canManage) {
  if (!canManage || site.status !== "active") return "";
  if (deployment.status !== "active" || deployment.is_current || deployment.is_rollback) return "";
  return `<button class="btn"${onClick("lummetRollback", [site.id, deployment.id])}>Roll back to this</button>`;
}

function siteCard(site, deployments, latestVersion, canManage) {
  const current = deployments.find((d) => d.is_current === 1);
  const busy = deployments.some((d) => IN_PROGRESS.has(d.status));
  const outOfDate = latestVersion && (!current || current.version !== latestVersion);

  let banner = "";
  if (busy) {
    banner = `<div class="flash">A deployment is in progress. Reload in a minute to see the result.</div>`;
  } else if (site.status !== "active" && site.status !== "provisioned") {
    banner = `<div class="flash">This site is ${escapeHtml(site.status)}, so it can't be deployed right now.</div>`;
  } else if (outOfDate && canManage) {
    banner = `<div class="flash">Version ${escapeHtml(latestVersion)} is available${current ? ` (this site runs ${escapeHtml(current.version)})` : ""}.
      <button class="btn"${onClick("lummetDeployLatest", [site.id])}>Update to ${escapeHtml(latestVersion)}</button></div>`;
  } else if (current) {
    banner = `<p class="subtitle">Running ${escapeHtml(current.version)}${latestVersion && current.version === latestVersion ? " — up to date" : ""}.</p>`;
  }

  if (canManage && site.status === "active" && site.template_line === "brokerage") {
    banner += `<p><a class="btn" href="/app/sites/${encodeURIComponent(site.id)}/admin-setup">Admin setup</a></p>`;
  }

  const rows = deployments.length
    ? deployments.map((d) => `
        <tr>
          <td class="mono">${escapeHtml(d.version)}${d.is_current ? ' <span class="badge">current</span>' : ""}</td>
          <td>${d.is_rollback ? "Rollback" : "Deploy"}</td>
          <td><span class="badge ${badgeClass(d.status)}">${escapeHtml(STATUS_LABEL[d.status] || d.status)}</span></td>
          <td>${escapeHtml(d.created_at || "")}</td>
          <td>${d.error_message ? escapeHtml(d.error_message) : ""}</td>
          <td class="actions">${rowActions(site, d, canManage)}</td>
        </tr>`).join("")
    : `<tr><td colspan="6" class="empty">No deployments yet for this site.</td></tr>`;

  return `
    <div class="card">
      <h2>${escapeHtml(site.name)}</h2>
      ${banner}
      <table>
        <thead><tr><th>Version</th><th>Type</th><th>Status</th><th>Started</th><th>Error</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

/** The site cards. Used by the page and by the live-cards endpoint, so a refresh can never show something the page would not. */
export function renderDeploymentCards({ sites, deploymentsBySite, latestVersion, latestByLine = null, canManage }) {
  return sites.length
    ? sites.map((s) => siteCard(s, deploymentsBySite[s.id] || [], (latestByLine && latestByLine[s.template_line || "casino"]) || latestVersion, canManage)).join("")
    : `<div class="card"><p class="empty">Create a site first. Its deployments will show up here.</p></div>`;
}

/** True while any deployment is in flight (queued, building, migrating, deploying, checking): the page refreshes itself quickly. */
export function deploymentsAreBusy(deploymentsBySite) {
  return Object.values(deploymentsBySite || {}).some((list) => (list || []).some((d) => DEPLOYMENT_TRANSIENT.has(d.status)));
}

export function renderDeploymentsPage({ sites, deploymentsBySite, latestVersion, latestByLine = null, canManage, organizationId = null }) {
  const cards = renderDeploymentCards({ sites, deploymentsBySite, latestVersion, latestByLine, canManage });
  const liveSrc = organizationId ? `/api/organizations/${encodeURIComponent(organizationId)}/deployments/live-cards` : null;

  return `
    <h1>Deployments</h1>
    <p class="subtitle">See what version each site runs, update to the latest release, or go back to an earlier working version.</p>
    <div id="deployments-live"${liveSrc ? liveAttrs(liveSrc, cards) : ""}>${cards}</div>
    <script nonce="${nonceToken()}">
      function lummetActiveOrgId() { var el = document.getElementById('org-switcher'); return el ? el.value : null; }

      // After an action, fetch the cards again right now (no page reload, no flash); fall back to a reload without the live runtime.
      function lummetRefreshCards() {
        var box = document.getElementById('deployments-live');
        if (window.lummetLiveRefresh && box && box.getAttribute('data-live-src')) { window.lummetLiveRefresh(box); } else { location.reload(); }
      }

      function lummetDeployPost(url, body, done) {
        fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })
          .then(function (r) { return r.json(); })
          .then(function (data) {
            if (data.success) lummetRefreshCards();
            else alert(done + ': ' + (data.error || 'unknown error'));
          });
      }

      function lummetDeployLatest(siteId) {
        if (!confirm('Deploy the latest release to this site? Pending database migrations will run first.')) return;
        lummetDeployPost('/api/organizations/' + lummetActiveOrgId() + '/sites/' + siteId + '/deployments/latest', {}, 'Could not start the update');
      }

      function lummetRollback(siteId, deploymentId) {
        if (!confirm('Redeploy this earlier version? Database changes from newer versions are not undone.')) return;
        lummetDeployPost('/api/organizations/' + lummetActiveOrgId() + '/sites/' + siteId + '/deployments/' + deploymentId + '/rollback', {}, 'Could not start the rollback');
      }
    </script>
  `;
}
