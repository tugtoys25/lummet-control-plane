// =====================================================
// AI MANAGEMENT CHAT (Phase 3 UI)
// Plain server-rendered shell (renderShell, same as every
// other dashboard page) + vanilla JS talking to the Phase
// 1/2 API (/api/ai/chat, /api/ai/conversations,
// /api/ai/confirm/:id). No new CSS framework and no new
// design tokens -- reuses layout.js's existing dark theme
// (--accent, --panel, --danger, .card/.btn/.badge) so this
// reads as part of the same product, not a bolted-on demo.
//
// The active-tenant indicator is NOT duplicated here -- the
// shell's topbar tenant switcher (layout.js) is already
// visible on every page including this one, which already
// satisfies "always display the active tenant".
// =====================================================

import { renderShell, escapeHtml } from "../layout.js";
import { onClick, onSubmit, nonceToken, BROWSER_HELPER } from "../../csp.js";

export async function renderAiChatPage(env, admin) {
  const activeKey = "ai-chat";
  const title = "AI Chat";

  const noActiveTenantNotice = admin.activeTenantId
    ? ""
    : `<div class="flash flash-error" id="no-tenant-notice">No active tenant is selected. You can still ask schema questions, but reading or changing tenant data needs a tenant picked from the switcher above.</div>`;

  const body = `
    <h1>${title}</h1>
    <p class="subtitle">Ask about or change anything you could already do from the dashboard. Writes always show a preview and need your confirmation before anything changes.</p>
    ${noActiveTenantNotice}

    <div class="ai-shell">
      <div class="ai-mobile-topbar">
        <button class="btn btn-secondary btn-small"${onClick("aiToggleDrawer", [])}>☰ Conversations</button>
      </div>

      <div class="ai-drawer-backdrop"${onClick("aiToggleDrawer", [])}></div>
      <aside class="ai-conversations card">
        <button class="btn btn-secondary" style="width:100%;margin-bottom:12px;"${onClick("aiNewConversation", [])}>+ New chat</button>
        <div id="ai-conversation-list" class="ai-conversation-list">
          <div class="empty">Loading…</div>
        </div>
      </aside>

      <section class="ai-main card">
        <div id="ai-messages" class="ai-messages">
          <div class="empty">Ask something like "Show me all casinos", or type /help to see shortcut commands.</div>
        </div>
        <form id="ai-composer" class="ai-composer"${onSubmit("aiSendMessage", ["$ev"])}>
          <input id="ai-input" type="text" placeholder="Ask, or try /help for shortcut commands…" autocomplete="off" />
          <button class="btn" type="submit" id="ai-send-btn">Send</button>
        </form>
      </section>
    </div>

    <style>
      .ai-shell { display: flex; gap: 20px; align-items: flex-start; height: calc(100vh - 220px); min-height: 420px; position: relative; }
      .ai-mobile-topbar { display: none; }
      .ai-drawer-backdrop { display: none; }
      .ai-conversations { width: 220px; flex-shrink: 0; overflow-y: auto; height: 100%; }
      .ai-conversation-list a { display: block; padding: 8px 10px; margin-bottom: 4px; border-radius: 7px; color: var(--text); font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .ai-conversation-list a:hover, .ai-conversation-list a.active { background: var(--accent-soft); text-decoration: none; }
      .ai-main { flex: 1; display: flex; flex-direction: column; min-width: 0; height: 100%; padding: 0; overflow: hidden; }
      .ai-messages { flex: 1; overflow-y: auto; padding: 20px; display: flex; flex-direction: column; gap: 14px; }
      .ai-bubble { max-width: 80%; padding: 10px 14px; border-radius: 10px; font-size: 14px; line-height: 1.5; white-space: pre-wrap; }
      .ai-bubble-user { align-self: flex-end; background: var(--accent); color: #fff; }
      .ai-bubble-assistant { align-self: flex-start; background: var(--bg); border: 1px solid var(--panel-border); }
      .ai-bubble-error { align-self: flex-start; background: rgba(240, 82, 107, 0.1); border: 1px solid rgba(240, 82, 107, 0.3); color: var(--danger-text); }
      .ai-composer { display: flex; gap: 10px; padding: 16px 20px; border-top: 1px solid var(--panel-border); }
      .ai-composer input { margin: 0; }
      .ai-composer button { flex-shrink: 0; }

      .ai-preview-card { align-self: stretch; border: 1px solid var(--panel-border); border-radius: var(--radius); padding: 14px 16px; background: var(--bg); font-size: 13px; }
      .ai-preview-card.destructive { border-color: var(--danger); }
      .ai-preview-title { font-weight: 700; font-size: 13px; margin-bottom: 8px; display: flex; align-items: center; gap: 8px; }
      .ai-preview-meta { color: var(--text-dim); margin-bottom: 10px; }
      .ai-diff-table { width: 100%; margin-bottom: 10px; }
      .ai-diff-table td { padding: 6px 8px; font-size: 13px; border-bottom: 1px solid var(--panel-border); }
      .ai-diff-field { color: var(--text-dim); white-space: nowrap; }
      .ai-diff-current { color: var(--danger-text); text-decoration: line-through; }
      .ai-diff-proposed { color: var(--ok); }
      .ai-preview-actions { display: flex; gap: 8px; margin-top: 10px; }
      .ai-preview-resolved { color: var(--text-dim); font-style: italic; }

      /* Chat-first mobile layout: the conversation rail becomes a
         slide-over drawer (triggered by the "☰ Conversations" button
         above the thread) instead of a permanent side column, so a
         narrow phone screen gives the message thread + composer the
         full width by default. */
      @media (max-width: 760px) {
        .ai-shell { flex-direction: column; height: calc(100vh - 260px); min-height: 380px; gap: 0; }
        .ai-mobile-topbar { display: flex; margin-bottom: 10px; }
        .ai-conversations {
          display: none;
          position: fixed; top: 0; left: 0; bottom: 0; z-index: 50;
          width: 78vw; max-width: 300px; height: 100vh;
          border-radius: 0; box-shadow: 2px 0 18px rgba(0,0,0,0.4);
        }
        .ai-conversations.open { display: block; }
        .ai-drawer-backdrop.open { display: block; position: fixed; inset: 0; background: rgba(0,0,0,0.5); z-index: 40; }
        .ai-main { width: 100%; }
      }
    </style>

    <script nonce="${nonceToken()}">
      ${BROWSER_HELPER}
      let aiCurrentConversationId = null;

      function aiToggleDrawer() {
        document.querySelector(".ai-conversations").classList.toggle("open");
        document.querySelector(".ai-drawer-backdrop").classList.toggle("open");
      }

      function aiCloseDrawer() {
        document.querySelector(".ai-conversations").classList.remove("open");
        document.querySelector(".ai-drawer-backdrop").classList.remove("open");
      }

      function aiSetUrlConversation(id) {
        const url = new URL(location.href);
        if (id) url.searchParams.set("conversation", id);
        else url.searchParams.delete("conversation");
        history.replaceState(null, "", url.toString());
      }

      function aiEscapeHtml(s) {
        return String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
      }

      function aiScrollToBottom() {
        const el = document.getElementById("ai-messages");
        el.scrollTop = el.scrollHeight;
      }

      async function aiLoadConversations() {
        const listEl = document.getElementById("ai-conversation-list");
        try {
          const res = await fetch("/api/ai/conversations");
          const data = await res.json();
          if (!data.success || !data.data.length) {
            listEl.innerHTML = '<div class="empty" style="padding:8px 0;">No conversations yet.</div>';
            return;
          }
          listEl.innerHTML = data.data.map(c =>
            '<a href="?conversation=' + encodeURIComponent(c.id) + '" class="' + (c.id === aiCurrentConversationId ? "active" : "") + '"' + lummetAttrs('click', 'aiOpenConversation', [c.id], { prevent: true }) + '>' +
              aiEscapeHtml(c.title || "Untitled") +
            '</a>'
          ).join("");
        } catch (e) {
          listEl.innerHTML = '<div class="empty">Could not load conversations.</div>';
        }
      }

      function aiRenderMessage(role, content) {
        const el = document.createElement("div");
        el.className = "ai-bubble " + (role === "user" ? "ai-bubble-user" : role === "error" ? "ai-bubble-error" : "ai-bubble-assistant");
        el.textContent = content;
        document.getElementById("ai-messages").appendChild(el);
      }

      function aiRenderWritePreview(result, state) {
        const wrap = document.createElement("div");
        wrap.className = "ai-preview-card" + (result.destructive ? " destructive" : "");

        const rows = (result.changes || []).map(c =>
          '<tr><td class="ai-diff-field">' + aiEscapeHtml(c.field) + '</td>' +
          '<td class="ai-diff-current">' + aiEscapeHtml(JSON.stringify(c.current)) + '</td>' +
          '<td class="ai-diff-proposed">' + aiEscapeHtml(JSON.stringify(c.proposed)) + '</td></tr>'
        ).join("");

        let snapshotHtml = "";
        if (result.destructive && result.recordSnapshot) {
          snapshotHtml = '<div class="ai-preview-meta">This record will be permanently deleted:</div>' +
            '<pre class="mono" style="white-space:pre-wrap;background:var(--panel);padding:8px;border-radius:7px;">' +
            aiEscapeHtml(JSON.stringify(result.recordSnapshot, null, 2)) + '</pre>';
        }

        wrap.innerHTML =
          '<div class="ai-preview-title">' +
            (result.destructive ? '<span class="badge badge-danger">DESTRUCTIVE</span>' : '<span class="badge badge-dim">' + aiEscapeHtml(result.operation.toUpperCase()) + '</span>') +
            aiEscapeHtml(result.resourceKey) + (result.recordId ? " · " + aiEscapeHtml(result.recordId) : "") +
          '</div>' +
          '<div class="ai-preview-meta">Tenant: ' + aiEscapeHtml(result.tenant.name) + '</div>' +
          (rows ? '<table class="ai-diff-table">' + rows + '</table>' : "") +
          snapshotHtml +
          '<div class="ai-preview-meta">No other fields will be changed. An audit record will be created.</div>' +
          '<div class="ai-preview-actions">' +
            '<button class="btn' + (result.destructive ? ' btn-danger' : '') + '"' + lummetAttrs('click', 'aiConfirmWrite', ['$el']) + '>Confirm write</button>' +
            '<button class="btn btn-secondary"${onClick("aiDismissPreview", ["$el"])}>Dismiss</button>' +
          '</div>';

        wrap.dataset.pendingOperationId = result.pendingOperationId;
        wrap.dataset.payloadHash = result.payloadHash;
        // A card rebuilt from history may no longer be actionable.
        if (state && state !== "pending") {
          const labels = { executed: "Already executed.", expired: "Expired — ask again for a fresh preview.", superseded: "Superseded — the record changed; ask again.", rejected: "Was rejected — nothing changed." };
          wrap.querySelector(".ai-preview-actions").outerHTML = '<div class="ai-preview-resolved">' + aiEscapeHtml(labels[state] || ("Status: " + state)) + '</div>';
        }
        document.getElementById("ai-messages").appendChild(wrap);
      }

      function aiDismissPreview(btn) {
        const card = btn.closest(".ai-preview-card");
        const actions = card.querySelector(".ai-preview-actions");
        actions.outerHTML = '<div class="ai-preview-resolved">Dismissed — nothing was changed. It will expire on its own.</div>';
      }

      async function aiConfirmWrite(btn) {
        const card = btn.closest(".ai-preview-card");
        const id = card.dataset.pendingOperationId;
        const hash = card.dataset.payloadHash;
        const actions = card.querySelector(".ai-preview-actions");
        actions.innerHTML = '<span class="ai-preview-meta">Executing…</span>';

        try {
          const res = await fetch("/api/ai/confirm/" + encodeURIComponent(id), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ payloadHash: hash })
          });
          const data = await res.json();
          if (data.success) {
            actions.outerHTML = '<div class="ai-preview-resolved" style="color:var(--ok);">Write completed.</div>';
          } else {
            let failText = data.message || data.error || "The write failed.";
            if (data.error && data.error !== data.message) failText += " (reason: " + data.error + ")";
            actions.outerHTML = '<div class="ai-preview-resolved" style="color:var(--danger-text);">' + aiEscapeHtml(failText) + '</div>';
          }
        } catch (e) {
          actions.outerHTML = '<div class="ai-preview-resolved" style="color:var(--danger-text);">Could not reach the server.</div>';
        }
        aiScrollToBottom();
      }

      async function aiSendMessage(evt) {
        evt.preventDefault();
        const input = document.getElementById("ai-input");
        const message = input.value.trim();
        if (!message) return false;

        document.querySelector(".ai-messages .empty")?.remove();
        aiRenderMessage("user", message);
        input.value = "";
        aiScrollToBottom();

        const sendBtn = document.getElementById("ai-send-btn");
        sendBtn.disabled = true;

        try {
          const res = await fetch("/api/ai/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ conversationId: aiCurrentConversationId, message })
          });
          const data = await res.json();

          if (!data.success) {
            aiRenderMessage("error", data.message || "Something went wrong.");
          } else {
            const isNewConversation = aiCurrentConversationId !== data.data.conversationId;
            aiCurrentConversationId = data.data.conversationId;
            if (isNewConversation) aiSetUrlConversation(aiCurrentConversationId);
            if (data.data.result && data.data.result.kind === "write_preview") {
              aiRenderWritePreview(data.data.result);
            } else {
              aiRenderMessage(data.data.result && data.data.result.ok === false ? "error" : "assistant", data.data.reply);
            }
            aiLoadConversations();
          }
        } catch (e) {
          aiRenderMessage("error", "Could not reach the server.");
        }

        sendBtn.disabled = false;
        aiScrollToBottom();
        return false;
      }

      async function aiOpenConversation(id) {
        aiCurrentConversationId = id;
        aiSetUrlConversation(id);
        aiCloseDrawer();
        const messagesEl = document.getElementById("ai-messages");
        messagesEl.innerHTML = '<div class="empty">Loading…</div>';
        try {
          const res = await fetch("/api/ai/conversations/" + encodeURIComponent(id));
          const data = await res.json();
          messagesEl.innerHTML = "";
          if (!data.success) {
            aiRenderMessage("error", "Could not load that conversation.");
          } else if (!data.data.messages.length) {
            messagesEl.innerHTML = '<div class="empty">No messages yet.</div>';
          } else {
            for (const m of data.data.messages) {
              if (m.pending) aiRenderWritePreview(m.pending, m.pending.state);
              else aiRenderMessage(m.role === "user" ? "user" : "assistant", m.content);
            }
          }
        } catch (e) {
          messagesEl.innerHTML = "";
          aiRenderMessage("error", "Could not load that conversation.");
        }
        aiLoadConversations();
        aiScrollToBottom();
      }

      function aiNewConversation() {
        aiCurrentConversationId = null;
        aiSetUrlConversation(null);
        aiCloseDrawer();
        document.getElementById("ai-messages").innerHTML = '<div class="empty">Ask something like "Show me all casinos", or type /help to see shortcut commands.</div>';
        aiLoadConversations();
      }

      const aiDeepLinkedConversation = new URLSearchParams(location.search).get("conversation");
      if (aiDeepLinkedConversation) {
        aiOpenConversation(aiDeepLinkedConversation);
      } else {
        aiLoadConversations();
      }
    </script>
  `;

  return renderShell({ title, activeKey, admin, bodyHtml: body, env });
}
