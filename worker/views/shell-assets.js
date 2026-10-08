// =====================================================
// DASHBOARD SHELL ASSETS
// The stylesheet, icons and small client scripts used by
// layout.js. Kept apart from the navigation data so the look
// can change without touching what a staff member may see.
//
// Layout model
//   >= 901px  docked sidebar; the topbar menu button collapses
//             and restores it (the choice is remembered).
//   <= 900px  the sidebar is an off-canvas drawer opened by the
//             same button, closed by the backdrop, Escape, or
//             choosing a link.
// Colors are tokens. Dark is the default; a light theme is
// selected by the user (remembered) or by the system setting.
// =====================================================

const svg = (inner) =>
  `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${inner}</svg>`;

export const ICONS = {
  workspace: svg(`<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>`),
  tenants: svg(`<rect x="3" y="3" width="18" height="7" rx="2"/><rect x="3" y="14" width="18" height="7" rx="2"/><path d="M7 6.5h.01M7 17.5h.01"/>`),
  content: svg(`<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h6"/>`),
  research: svg(`<path d="M2 5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v15a2 2 0 0 0-2-2H2z"/><path d="M22 5a2 2 0 0 0-2-2h-6a2 2 0 0 0-2 2v15a2 2 0 0 1 2-2h8z"/>`),
  seo: svg(`<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>`),
  money: svg(`<circle cx="12" cy="12" r="9"/><path d="M14.5 9.5c-.5-1-1.5-1.5-2.5-1.5-1.4 0-2.5.8-2.5 2s1 1.7 2.5 2 2.5.8 2.5 2-1.1 2-2.5 2c-1 0-2-.5-2.5-1.5M12 6v2m0 8v2"/>`),
  insights: svg(`<path d="M4 20V10M10 20V4M16 20v-8M22 20H2"/>`),
  engagement: svg(`<path d="M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>`),
  system: svg(`<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>`),
  globe: svg(`<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>`),
  layout: svg(`<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/>`),
  forms: svg(`<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.5 5h13L22 12v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6z"/>`),
  platform: svg(`<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/>`),
  menu: svg(`<path d="M4 6h16M4 12h16M4 18h16"/>`),
  chevron: svg(`<path d="m9 6 6 6-6 6"/>`),
  sun: svg(`<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>`),
  moon: svg(`<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>`),
  close: svg(`<path d="M6 6l12 12M18 6 6 18"/>`)
};

// Runs in <head> before first paint so there is no flash of the
// wrong theme or of the sidebar opening and closing.
export const BOOT_SCRIPT = `
(function () {
  var root = document.documentElement;
  try {
    var theme = localStorage.getItem("lummet.theme");
    if (theme !== "light" && theme !== "dark") {
      theme = window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
    }
    root.setAttribute("data-theme", theme);
    if (window.innerWidth > 900 && localStorage.getItem("lummet.nav") === "closed") {
      root.classList.add("nav-collapsed");
    }
  } catch (e) {
    root.setAttribute("data-theme", "dark");
  }
})();
`;

export const CLIENT_SCRIPT = `
(function () {
  var root = document.documentElement;
  var mobileQuery = window.matchMedia("(max-width: 900px)");
  var toggle = document.getElementById("nav-toggle");
  var sidebar = document.getElementById("sidebar");
  var backdrop = document.getElementById("nav-backdrop");
  var closeBtn = document.getElementById("nav-close");
  var filter = document.getElementById("nav-filter");
  var groups = Array.prototype.slice.call(document.querySelectorAll(".nav-group"));

  function store(key, value) { try { localStorage.setItem(key, value); } catch (e) {} }
  function read(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }

  function isMobile() { return mobileQuery.matches; }
  function isOpen() {
    return isMobile() ? root.classList.contains("nav-open") : !root.classList.contains("nav-collapsed");
  }
  function sync() { if (toggle) toggle.setAttribute("aria-expanded", String(isOpen())); }
  function setOpen(open) {
    if (isMobile()) {
      root.classList.toggle("nav-open", open);
      if (open && filter) { /* keep focus on the toggle; typing is opt-in */ }
      if (!open && toggle) toggle.focus({ preventScroll: true });
    } else {
      root.classList.toggle("nav-collapsed", !open);
      store("lummet.nav", open ? "open" : "closed");
    }
    sync();
  }

  if (toggle) toggle.addEventListener("click", function () { setOpen(!isOpen()); });
  if (backdrop) backdrop.addEventListener("click", function () { setOpen(false); });
  if (closeBtn) closeBtn.addEventListener("click", function () { setOpen(false); });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && isMobile() && root.classList.contains("nav-open")) setOpen(false);
  });
  if (sidebar) {
    sidebar.addEventListener("click", function (e) {
      var link = e.target.closest ? e.target.closest("a[href]") : null;
      if (link && isMobile()) root.classList.remove("nav-open");
    });
  }
  var onQueryChange = function () { root.classList.remove("nav-open"); sync(); };
  if (mobileQuery.addEventListener) mobileQuery.addEventListener("change", onQueryChange);
  else if (mobileQuery.addListener) mobileQuery.addListener(onQueryChange);
  sync();

  var saved = {};
  try { saved = JSON.parse(read("lummet.navgroups") || "{}") || {}; } catch (e) { saved = {}; }
  groups.forEach(function (group) {
    var id = group.getAttribute("data-group");
    if (!group.hasAttribute("data-has-active") && Object.prototype.hasOwnProperty.call(saved, id)) {
      group.open = !!saved[id];
    }
    group.addEventListener("toggle", function () {
      if (filter && filter.value) return;
      saved[id] = group.open;
      store("lummet.navgroups", JSON.stringify(saved));
    });
  });

  if (filter) {
    var restore = null;
    filter.addEventListener("input", function () {
      var query = filter.value.trim().toLowerCase();
      if (query && !restore) {
        restore = groups.map(function (g) { return g.open; });
      }
      groups.forEach(function (group) {
        var shown = 0;
        Array.prototype.forEach.call(group.querySelectorAll("a"), function (link) {
          var match = !query || link.textContent.toLowerCase().indexOf(query) !== -1;
          link.hidden = !match;
          if (match) shown += 1;
        });
        group.hidden = shown === 0;
        if (query && shown) group.open = true;
      });
      if (!query && restore) {
        groups.forEach(function (g, i) { g.open = restore[i]; });
        restore = null;
      }
      var empty = document.getElementById("nav-empty");
      if (empty) empty.hidden = !query || groups.some(function (g) { return !g.hidden; });
    });
  }

  var themeBtn = document.getElementById("theme-toggle");
  if (themeBtn) {
    themeBtn.addEventListener("click", function () {
      var next = root.getAttribute("data-theme") === "light" ? "dark" : "light";
      root.setAttribute("data-theme", next);
      store("lummet.theme", next);
      themeBtn.setAttribute("aria-pressed", String(next === "light"));
    });
    themeBtn.setAttribute("aria-pressed", String(root.getAttribute("data-theme") === "light"));
  }

  var logout = document.getElementById("logout-btn");
  if (logout) {
    logout.addEventListener("click", function () {
      fetch("/api/auth/logout", { method: "POST" }).then(function () { location.href = "/login"; });
    });
  }

  var content = document.querySelector(".content");
  if (content) {
    var wrap = function () {
      Array.prototype.forEach.call(content.querySelectorAll("table"), function (table) {
        var parent = table.parentNode;
        if (parent && parent.classList && parent.classList.contains("table-wrap")) return;
        var holder = document.createElement("div");
        holder.className = "table-wrap";
        parent.insertBefore(holder, table);
        holder.appendChild(table);
      });
    };
    wrap();
    if (window.MutationObserver) {
      new MutationObserver(wrap).observe(content, { childList: true, subtree: true });
    }
  }

  document.addEventListener("click", function (e) {
    var menu = document.getElementById("user-menu");
    if (menu && menu.open && !menu.contains(e.target)) menu.open = false;
  });
})();
`;

export const STYLES = `
  :root {
    color-scheme: dark;
    --bg: #0b0e14;
    --surface: #10141d;
    --panel: #151a26;
    --panel-2: #1a2030;
    --panel-border: #252c3d;
    --text: #e8ebf3;
    --text-dim: #93a0b9;
    --accent: #7c6cf6;
    --accent-strong: #6a59ee;
    --accent-ink: #ffffff;
    --accent-soft: rgba(124, 108, 246, 0.15);
    --ok: #3ecf8e;
    --warn: #f5a623;
    --danger: #f0526b;
    --danger-text: #ff8fa3;
    --overlay: rgba(4, 6, 12, 0.62);
    --shadow: 0 10px 30px rgba(0, 0, 0, 0.35);
    --radius: 12px;
    --radius-sm: 8px;
    --sidebar-w: 276px;
    --topbar-h: 60px;
    --success: var(--ok);
    --warning: var(--warn);
    --border-color: var(--panel-border);
  }
  :root[data-theme="light"] {
    color-scheme: light;
    --bg: #f3f5fa;
    --surface: #ffffff;
    --panel: #ffffff;
    --panel-2: #f7f8fc;
    --panel-border: #dfe4ee;
    --text: #151a26;
    --text-dim: #586178;
    --accent: #5b4ae0;
    --accent-strong: #4a3acb;
    --accent-soft: rgba(91, 74, 224, 0.1);
    --ok: #0f7a55;
    --warn: #a35f00;
    --danger: #d12c48;
    --danger-text: #b3203a;
    --overlay: rgba(15, 20, 35, 0.45);
    --shadow: 0 10px 30px rgba(20, 30, 60, 0.14);
  }

  * { box-sizing: border-box; }
  html { -webkit-text-size-adjust: 100%; }
  body {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, sans-serif;
    font-size: 15px;
    line-height: 1.5;
    background: var(--bg);
    color: var(--text);
    min-height: 100vh;
    min-height: 100dvh;
  }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
  :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  [hidden] { display: none !important; }
  .skip-link {
    position: absolute; left: 12px; top: -48px; z-index: 200;
    background: var(--accent); color: var(--accent-ink); padding: 8px 14px; border-radius: var(--radius-sm);
  }
  .skip-link:focus { top: 10px; text-decoration: none; }
  .icon { display: inline-flex; flex-shrink: 0; }

  .app { display: grid; grid-template-columns: var(--sidebar-w) minmax(0, 1fr); min-height: 100vh; min-height: 100dvh; transition: grid-template-columns .22s ease; }
  html.nav-collapsed .app { grid-template-columns: 0 minmax(0, 1fr); }

  .sidebar {
    position: sticky; top: 0; align-self: start;
    height: 100vh; height: 100dvh; overflow: hidden;
    background: var(--surface);
    border-right: 1px solid var(--panel-border);
    display: flex; flex-direction: column;
    width: var(--sidebar-w);
    z-index: 60;
    transition: transform .22s ease, visibility 0s linear 0s;
  }
  html.nav-collapsed .sidebar { transform: translateX(-100%); visibility: hidden; transition: transform .22s ease, visibility 0s linear .22s; }
  .sidebar-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 14px 16px 8px; flex-shrink: 0; }
  .brand { font-size: 19px; font-weight: 700; letter-spacing: -0.02em; display: flex; align-items: center; gap: 9px; color: var(--text); }
  .brand:hover { text-decoration: none; }
  .brand .dot { width: 26px; height: 26px; border-radius: 8px; background: linear-gradient(135deg, var(--accent), #4cc3ff); display: inline-block; box-shadow: 0 4px 14px var(--accent-soft); }
  .sidebar .nav-close { display: none; }
  .nav-filter-wrap { padding: 6px 16px 10px; flex-shrink: 0; }
  .nav-filter-wrap input { margin: 0; padding: 8px 12px; font-size: 13px; background: var(--bg); }
  .nav-scroll { flex: 1; overflow-y: auto; padding: 4px 10px 18px; overscroll-behavior: contain; scrollbar-width: thin; }
  .nav-group { margin: 2px 0; }
  .nav-group > summary {
    list-style: none; cursor: pointer; display: flex; align-items: center; gap: 10px;
    padding: 9px 10px; border-radius: var(--radius-sm); color: var(--text); font-size: 13px; font-weight: 600; user-select: none;
  }
  .nav-group > summary::-webkit-details-marker { display: none; }
  .nav-group > summary:hover { background: var(--accent-soft); }
  .nav-group .group-icon { color: var(--text-dim); }
  .nav-group[data-has-active] .group-icon { color: var(--accent); }
  .nav-group .group-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .nav-group .group-count { font-size: 11px; color: var(--text-dim); background: var(--panel-2); border-radius: 999px; padding: 1px 7px; font-weight: 500; }
  .nav-group .chevron { transition: transform .15s ease; color: var(--text-dim); }
  .nav-group[open] > summary .chevron { transform: rotate(90deg); }
  .nav-links { margin: 2px 0 8px 22px; padding-left: 12px; border-left: 1px solid var(--panel-border); display: flex; flex-direction: column; gap: 1px; }
  .nav-links a {
    display: block; padding: 7px 10px; border-radius: var(--radius-sm);
    color: var(--text-dim); font-size: 13.5px;
  }
  .nav-links a:hover { color: var(--text); background: var(--accent-soft); text-decoration: none; }
  .nav-links a.active { color: var(--accent); background: var(--accent-soft); font-weight: 600; }
  .nav-empty { padding: 14px 12px; color: var(--text-dim); font-size: 13px; }

  .main { display: flex; flex-direction: column; min-width: 0; }
  .topbar {
    position: sticky; top: 0; z-index: 40;
    min-height: var(--topbar-h);
    display: flex; align-items: center; gap: 12px;
    padding: 8px clamp(12px, 2.5vw, 28px);
    background: color-mix(in srgb, var(--bg) 88%, transparent);
    backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);
    border-bottom: 1px solid var(--panel-border);
  }
  .icon-btn {
    display: inline-flex; align-items: center; justify-content: center;
    width: 40px; height: 40px; flex-shrink: 0; padding: 0;
    border: 1px solid var(--panel-border); background: var(--panel); color: var(--text);
    border-radius: var(--radius-sm); cursor: pointer;
  }
  .icon-btn:hover { background: var(--accent-soft); }
  .page-crumb { min-width: 0; flex: 1; font-size: 14px; color: var(--text-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .page-crumb strong { color: var(--text); font-weight: 600; }
  .topbar-right { display: flex; align-items: center; gap: 10px; margin-left: auto; }
  .switcher { display: flex; align-items: center; gap: 8px; }
  .switcher label { margin: 0; white-space: nowrap; font-size: 12px; }
  .switcher select { width: auto; min-width: 170px; max-width: 260px; margin: 0; padding: 8px 10px; }
  .theme-toggle .moon { display: none; }
  :root[data-theme="light"] .theme-toggle .sun { display: none; }
  :root[data-theme="light"] .theme-toggle .moon { display: inline-flex; }

  .user-menu { position: relative; }
  .user-menu > summary { list-style: none; cursor: pointer; display: flex; align-items: center; gap: 8px; height: 40px; padding: 0 12px; border: 1px solid var(--panel-border); background: var(--panel); border-radius: var(--radius-sm); font-size: 13px; }
  .user-menu > summary::-webkit-details-marker { display: none; }
  .avatar { width: 24px; height: 24px; border-radius: 50%; background: var(--accent-soft); color: var(--accent); display: inline-flex; align-items: center; justify-content: center; font-weight: 700; font-size: 12px; text-transform: uppercase; }
  .user-menu .who-name { max-width: 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .menu-pop { position: absolute; right: 0; top: calc(100% + 8px); min-width: 230px; background: var(--panel); border: 1px solid var(--panel-border); border-radius: var(--radius); box-shadow: var(--shadow); padding: 8px; z-index: 70; }
  .menu-pop .who-full { padding: 8px 10px 10px; border-bottom: 1px solid var(--panel-border); margin-bottom: 6px; font-size: 13px; word-break: break-all; }
  .menu-pop a, .menu-pop button { display: block; width: 100%; text-align: left; padding: 9px 10px; border: 0; background: none; color: var(--text); font: inherit; font-size: 13.5px; border-radius: var(--radius-sm); cursor: pointer; }
  .menu-pop a:hover, .menu-pop button:hover { background: var(--accent-soft); text-decoration: none; }
  .role-badge { display: inline-block; margin-top: 4px; padding: 2px 8px; border-radius: 999px; font-size: 11px; background: var(--accent-soft); color: var(--accent); text-transform: uppercase; letter-spacing: 0.03em; }

  .content { padding: clamp(16px, 3vw, 32px); width: 100%; max-width: 1480px; margin: 0 auto; min-width: 0; }
  h1 { font-size: clamp(1.35rem, 2.2vw, 1.7rem); letter-spacing: -0.02em; margin: 0 0 4px; line-height: 1.25; }
  .subtitle { color: var(--text-dim); font-size: 14px; margin: 0 0 24px; }

  .card {
    background: var(--panel);
    border: 1px solid var(--panel-border);
    border-radius: var(--radius);
    padding: clamp(14px, 2vw, 22px);
    margin-bottom: 20px;
    min-width: 0;
  }
  .card h2 { font-size: 15px; margin: 0 0 14px; }

  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 14px; }
  .stat { background: var(--panel); border: 1px solid var(--panel-border); border-radius: var(--radius); padding: 16px; position: relative; overflow: hidden; }
  .stat::before { content: ""; position: absolute; inset: 0 auto 0 0; width: 3px; background: var(--accent); opacity: .85; }
  .stat .num { font-size: clamp(1.4rem, 3vw, 1.9rem); font-weight: 700; letter-spacing: -0.02em; }
  .stat .label { font-size: 12px; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.05em; margin-top: 4px; }

  .table-wrap { width: 100%; overflow-x: auto; -webkit-overflow-scrolling: touch; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th { text-align: left; color: var(--text-dim); font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; padding: 9px 12px; border-bottom: 1px solid var(--panel-border); white-space: nowrap; }
  td { padding: 11px 12px; border-bottom: 1px solid var(--panel-border); vertical-align: middle; }
  tbody tr:hover td { background: var(--accent-soft); }
  tr:last-child td { border-bottom: none; }

  .badge { display: inline-block; padding: 2px 9px; border-radius: 999px; font-size: 12px; font-weight: 600; }
  .badge-ok { background: color-mix(in srgb, var(--ok) 16%, transparent); color: var(--ok); }
  .badge-warn { background: color-mix(in srgb, var(--warn) 16%, transparent); color: var(--warn); }
  .badge-danger { background: color-mix(in srgb, var(--danger) 16%, transparent); color: var(--danger-text); }
  .badge-dim { background: color-mix(in srgb, var(--text-dim) 16%, transparent); color: var(--text-dim); }
  .badge-toggle-btn { border: none; cursor: pointer; font-family: inherit; transition: filter 0.15s ease; }
  .badge-toggle-btn:hover { filter: brightness(0.9); }
  .badge-toggle-btn:disabled { opacity: 0.6; cursor: default; }

  .btn {
    display: inline-flex; align-items: center; justify-content: center; gap: 6px;
    background: var(--accent); color: var(--accent-ink);
    border: 1px solid transparent; border-radius: var(--radius-sm);
    padding: 9px 16px; min-height: 38px; font: inherit; font-size: 14px; font-weight: 600; cursor: pointer;
  }
  .btn:hover { background: var(--accent-strong); text-decoration: none; }
  .btn-secondary { background: transparent; border-color: var(--panel-border); color: var(--text); }
  .btn-secondary:hover { background: var(--accent-soft); }
  .btn-danger { background: var(--danger); color: #fff; }
  .btn-danger:hover { background: var(--danger); filter: brightness(0.92); }
  .btn-small { padding: 5px 10px; min-height: 30px; font-size: 12px; }

  input, textarea, select {
    width: 100%; font: inherit; font-size: 14px;
    background: var(--bg); border: 1px solid var(--panel-border); border-radius: var(--radius-sm);
    padding: 9px 12px; color: var(--text); margin-bottom: 14px;
  }
  input:focus, textarea:focus, select:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
  input[type="checkbox"], input[type="radio"] { width: auto; margin: 0 6px 0 0; accent-color: var(--accent); }
  label { display: block; font-size: 13px; color: var(--text-dim); margin-bottom: 6px; }

  .empty { color: var(--text-dim); font-size: 14px; padding: 24px 0; text-align: center; }
  .flash { padding: 12px 16px; border-radius: var(--radius); margin-bottom: 20px; font-size: 14px; }
  .flash-error { background: color-mix(in srgb, var(--danger) 10%, transparent); border: 1px solid color-mix(in srgb, var(--danger) 35%, transparent); color: var(--danger-text); }
  .flash-success { background: color-mix(in srgb, var(--ok) 10%, transparent); border: 1px solid color-mix(in srgb, var(--ok) 35%, transparent); color: var(--ok); }
  .mono { font-family: "SF Mono", Consolas, monospace; font-size: 13px; }
  .actions { display: flex; gap: 8px; flex-wrap: wrap; }

  .rte-toolbar { display: flex; gap: 4px; flex-wrap: wrap; margin-bottom: 6px; }
  .rte-toolbar button {
    background: var(--bg); border: 1px solid var(--panel-border); color: var(--text);
    border-radius: 6px; padding: 5px 9px; font-size: 12px; cursor: pointer;
  }
  .rte-toolbar button:hover { background: var(--accent-soft); }
  .rte-editor {
    min-height: 180px; max-height: 480px; overflow-y: auto;
    background: var(--bg); border: 1px solid var(--panel-border); border-radius: var(--radius-sm);
    padding: 12px 14px; margin-bottom: 14px; font-size: 14px; line-height: 1.6;
  }
  .rte-editor:focus { outline: none; border-color: var(--accent); }
  .rte-editor h2, .rte-editor h3 { margin: 0.6em 0 0.3em; }
  .rte-editor blockquote { border-left: 3px solid var(--accent); margin: 0.6em 0; padding-left: 12px; color: var(--text-dim); }
  .rte-editor ul, .rte-editor ol { padding-left: 22px; }

  .media-field .media-preview { margin-bottom: 8px; }
  .media-picker-panel { background: var(--bg); }

  .nav-backdrop { display: none; }

  @media (max-width: 1100px) {
    .switcher label { display: none; }
    .switcher select { min-width: 140px; }
  }
  @media (max-width: 900px) {
    .app, html.nav-collapsed .app { grid-template-columns: minmax(0, 1fr); }
    .sidebar, html.nav-collapsed .sidebar {
      position: fixed; inset: 0 auto 0 0; width: min(86vw, 320px);
      transform: translateX(-102%); visibility: hidden;
      box-shadow: none;
      transition: transform .24s ease, visibility 0s linear .24s;
    }
    html.nav-open .sidebar { transform: none; visibility: visible; box-shadow: var(--shadow); transition: transform .24s ease, visibility 0s linear 0s; }
    html.nav-open body { overflow: hidden; }
    .sidebar .nav-close { display: inline-flex; }
    .nav-backdrop { position: fixed; inset: 0; background: var(--overlay); z-index: 55; opacity: 0; pointer-events: none; transition: opacity .2s ease; }
    html.nav-open .nav-backdrop { display: block; opacity: 1; pointer-events: auto; }
    .topbar { flex-wrap: wrap; row-gap: 8px; }
    .page-crumb { order: 2; flex-basis: auto; }
    .topbar-right { order: 3; margin-left: auto; }
    .switcher { order: 4; flex-basis: 100%; }
    .switcher select { width: 100%; max-width: none; }
    .user-menu .who-name { display: none; }
  }
  @media (max-width: 560px) {
    body { font-size: 14.5px; }
    input, textarea, select { font-size: 16px; }
    .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
    .stat { padding: 14px; }
    th, td { padding-left: 9px; padding-right: 9px; }
    .actions .btn { flex: 1 1 auto; }
  }
  @media (prefers-reduced-motion: reduce) {
    .app, .sidebar, .nav-backdrop, .nav-group .chevron { transition: none !important; }
  }
  @media print {
    .sidebar, .topbar, .nav-backdrop { display: none !important; }
    .app { display: block; }
  }
`;
