// =====================================================
// PUBLIC SITE — HERO NETWORK GRAPH
// The homepage hero visual: the control plane in the middle and one
// node per PUBLISHED brand around it, drawn as inline SVG from the
// database. Add or unpublish a brand and the picture changes with it.
// =====================================================

import { escapeHtml } from "./template.js";
import { truncate, fill } from "./format.js";

const W = 480;
const H = 400;
const CX = W / 2;
const CY = H / 2;
const RX = 150;
const RY = 112;
const MAX_NODES = 6;

export function heroGraphSvg(centerName, brands, ui = {}) {
  const nodes = brands.slice(0, MAX_NODES);
  if (!nodes.length) return "";

  const label = fill(nodes.length === 1 ? ui.graph_label_one : ui.graph_label_many, {
    center: centerName,
    count: nodes.length,
    names: nodes.map((b) => b.name).join(", ")
  });

  const points = nodes.map((b, i) => {
    const angle = -Math.PI / 2 + (i * 2 * Math.PI) / nodes.length;
    return { name: b.name, x: CX + RX * Math.cos(angle), y: CY + RY * Math.sin(angle), below: Math.sin(angle) > -0.2 };
  });

  const links = points
    .map(
      (p, i) =>
        `<line class="hg-link" style="--i:${i}" x1="${CX}" y1="${CY}" x2="${p.x.toFixed(1)}" y2="${p.y.toFixed(1)}"/>`
    )
    .join("");

  const dots = points
    .map((p, i) => {
      const ty = p.below ? p.y + 26 : p.y - 16;
      return `<g class="hg-node" style="--i:${i}">
      <circle class="hg-halo" cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="14"/>
      <circle class="hg-dot" cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="7"/>
      <text class="hg-label" x="${p.x.toFixed(1)}" y="${ty.toFixed(1)}" text-anchor="middle">${escapeHtml(truncate(p.name, 18))}</text>
    </g>`;
    })
    .join("");

  return `<svg class="hero-graph" viewBox="0 0 ${W} ${H}" role="img" aria-label="${escapeHtml(label)}" xmlns="http://www.w3.org/2000/svg">
    <ellipse class="hg-ring" cx="${CX}" cy="${CY}" rx="${RX}" ry="${RY}"/>
    <ellipse class="hg-ring hg-ring-outer" cx="${CX}" cy="${CY}" rx="${RX + 34}" ry="${RY + 30}"/>
    ${links}
    <circle class="hg-hub-halo" cx="${CX}" cy="${CY}" r="46"/>
    <circle class="hg-hub" cx="${CX}" cy="${CY}" r="34"/>
    <text class="hg-hub-label" x="${CX}" y="${CY + 4}" text-anchor="middle">${escapeHtml(truncate(centerName, 10))}</text>
    ${dots}
  </svg>`;
}
