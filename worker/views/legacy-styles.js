// The previous staff-console stylesheet, kept ONLY for the customer portal (views/customer-layout.js),
// which still uses its class names. The staff console itself now uses shell-assets.js.
export const STYLES = `
  :root {
    --bg: #0f1117;
    --panel: #171a23;
    --panel-border: #262a38;
    --text: #e7e9f0;
    --text-dim: #9096ac;
    --accent: #7c6cf6;
    --accent-soft: rgba(124, 108, 246, 0.14);
    --ok: #3ecf8e;
    --warn: #f5a623;
    --danger: #f0526b;
    --radius: 10px;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, sans-serif;
    background: var(--bg);
    color: var(--text);
    display: flex;
    min-height: 100vh;
  }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }

  .sidebar {
    width: 240px;
    flex-shrink: 0;
    background: var(--panel);
    border-right: 1px solid var(--panel-border);
    padding: 20px 0;
    display: flex;
    flex-direction: column;
  }
  .brand {
    padding: 0 20px 20px;
    font-size: 20px;
    font-weight: 700;
    letter-spacing: -0.02em;
    display: flex;
    align-items: baseline;
    gap: 8px;
  }
  .brand .dot { color: var(--accent); }
  .nav-section { margin-top: 18px; }
  .nav-section h4 {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-dim);
    padding: 0 20px;
    margin: 0 0 6px;
  }
  .nav-section a {
    display: block;
    padding: 7px 20px;
    color: var(--text-dim);
    font-size: 14px;
  }
  .nav-section a:hover { color: var(--text); text-decoration: none; background: var(--accent-soft); }
  .nav-section a.active {
    color: var(--text);
    background: var(--accent-soft);
    border-right: 2px solid var(--accent);
  }

  .main { flex: 1; display: flex; flex-direction: column; min-width: 0; }
  .topbar {
    height: 56px;
    border-bottom: 1px solid var(--panel-border);
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 24px;
    flex-shrink: 0;
  }
  .topbar .who { font-size: 13px; color: var(--text-dim); }
  .role-badge { display: inline-block; margin-left: 6px; padding: 2px 8px; border-radius: 999px; font-size: 11px; background: var(--accent-soft); color: var(--accent); text-transform: uppercase; letter-spacing: 0.03em; }
  .topbar .logout { font-size: 13px; }
  .content { padding: 28px; overflow-y: auto; }

  h1 { font-size: 22px; margin: 0 0 4px; }
  .subtitle { color: var(--text-dim); font-size: 14px; margin: 0 0 24px; }

  .card {
    background: var(--panel);
    border: 1px solid var(--panel-border);
    border-radius: var(--radius);
    padding: 20px;
    margin-bottom: 20px;
  }
  .card h2 { font-size: 15px; margin: 0 0 14px; }

  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 16px; }
  .stat { background: var(--panel); border: 1px solid var(--panel-border); border-radius: var(--radius); padding: 16px; }
  .stat .num { font-size: 28px; font-weight: 700; }
  .stat .label { font-size: 12px; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.05em; margin-top: 4px; }

  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th { text-align: left; color: var(--text-dim); font-weight: 500; font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; padding: 8px 10px; border-bottom: 1px solid var(--panel-border); }
  td { padding: 10px; border-bottom: 1px solid var(--panel-border); vertical-align: middle; }
  tr:last-child td { border-bottom: none; }

  .badge { display: inline-block; padding: 2px 9px; border-radius: 999px; font-size: 12px; font-weight: 600; }
  .badge-ok { background: rgba(62, 207, 142, 0.14); color: var(--ok); }
  .badge-warn { background: rgba(245, 166, 35, 0.14); color: var(--warn); }
  .badge-danger { background: rgba(240, 82, 107, 0.14); color: var(--danger); }
  .badge-dim { background: rgba(144, 150, 172, 0.14); color: var(--text-dim); }
  .badge-toggle-btn { border: none; cursor: pointer; font-family: inherit; transition: filter 0.15s ease; }
  .badge-toggle-btn:hover { filter: brightness(0.9); }
  .badge-toggle-btn:disabled { opacity: 0.6; cursor: default; }

  .btn {
    display: inline-block;
    background: var(--accent);
    color: #fff;
    border: none;
    border-radius: 7px;
    padding: 9px 16px;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
  }
  .btn:hover { opacity: 0.9; text-decoration: none; }
  .btn-secondary { background: transparent; border: 1px solid var(--panel-border); color: var(--text); }
  .btn-danger { background: var(--danger); }
  .btn-small { padding: 5px 10px; font-size: 12px; }

  input, textarea, select {
    width: 100%;
    background: var(--bg);
    border: 1px solid var(--panel-border);
    border-radius: 7px;
    padding: 9px 12px;
    color: var(--text);
    font-size: 14px;
    margin-bottom: 14px;
  }
  label { display: block; font-size: 13px; color: var(--text-dim); margin-bottom: 6px; }

  .empty { color: var(--text-dim); font-size: 14px; padding: 24px 0; text-align: center; }
  .flash { padding: 12px 16px; border-radius: var(--radius); margin-bottom: 20px; font-size: 14px; }
  .flash-error { background: rgba(240, 82, 107, 0.1); border: 1px solid rgba(240, 82, 107, 0.3); color: #ff8fa3; }
  .flash-success { background: rgba(62, 207, 142, 0.1); border: 1px solid rgba(62, 207, 142, 0.3); color: var(--ok); }
  .mono { font-family: "SF Mono", Consolas, monospace; font-size: 13px; }
  .actions { display: flex; gap: 8px; flex-wrap: wrap; }

  .rte-toolbar { display: flex; gap: 4px; flex-wrap: wrap; margin-bottom: 6px; }
  .rte-toolbar button {
    background: var(--bg); border: 1px solid var(--panel-border); color: var(--text);
    border-radius: 5px; padding: 5px 9px; font-size: 12px; cursor: pointer;
  }
  .rte-toolbar button:hover { background: var(--accent-soft); }
  .rte-editor {
    min-height: 180px; max-height: 480px; overflow-y: auto;
    background: var(--bg); border: 1px solid var(--panel-border); border-radius: 7px;
    padding: 12px 14px; margin-bottom: 14px; font-size: 14px; line-height: 1.6;
  }
  .rte-editor:focus { outline: none; border-color: var(--accent); }
  .rte-editor h2, .rte-editor h3 { margin: 0.6em 0 0.3em; }
  .rte-editor blockquote { border-left: 3px solid var(--accent); margin: 0.6em 0; padding-left: 12px; color: var(--text-dim); }
  .rte-editor ul, .rte-editor ol { padding-left: 22px; }

  .media-field .media-preview { margin-bottom: 8px; }
  .media-picker-panel { background: var(--bg); }
`;
