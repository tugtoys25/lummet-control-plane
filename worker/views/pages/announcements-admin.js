// =====================================================
// STAFF: write an announcement to everyone, one person, an organization, a site or billing contacts - in the dashboard and/or by email.
// The text is HTML (cleaned on the way in) or plain text; photos and documents upload first and are attached or placed in the text.
// =====================================================
import { renderShell, escapeHtml as h } from "../layout.js";
import { nonceToken } from "../../csp.js";
import * as announcements from "../../announcements.js";
import { MAX_BYTES } from "../../private-files.js";

export async function renderAnnouncementsAdminPage(env, admin) {
  const [{ organizations, sites }, history] = await Promise.all([announcements.pickers(env), announcements.listForStaff(env)]);
  const orgOpts = organizations.map((o) => `<option value="${h(o.id)}">${h(o.name)}</option>`).join("");
  const siteOpts = sites.map((s) => `<option value="${h(s.id)}">${h(s.name)} - ${h(s.organization)}</option>`).join("");
  const rows = history.map((a) => {
    let ch = []; try { ch = JSON.parse(a.channels); } catch { /* ignore */ }
    const email = ch.includes("email") ? `${a.emails_queued}/${a.email_total} queued${a.emails_failed ? `, ${a.emails_failed} failed` : ""}` : "-";
    return `<tr><td>${h(a.subject)}</td><td>${h(a.audience_label)}</td><td>${h(ch.join(" + "))}</td><td>${h(a.recipient_count)}</td><td>${h(email)}</td><td>${h(a.reads)}</td><td>${h(a.created_at || "")}</td></tr>`;
  }).join("");
  const body = `
    <p style="color:var(--text-dim)">Send a message to customers. It appears under Announcements in their dashboard and/or arrives by email. This is separate from the automatic billing and reminder emails, which are not changed.</p>
    <div id="an-msg"></div>
    <div class="card">
      <label for="an-kind">Who should get it?</label>
      <select id="an-kind"><option value="all">Everyone</option><option value="user">One person (by email)</option><option value="organization">One organization</option><option value="site">One site</option><option value="billing">Billing contacts (owners and billing role)</option></select>
      <div id="an-ref-user" style="display:none"><label for="an-user">Email address</label><input type="text" id="an-user" placeholder="person@example.com" style="width:100%" /></div>
      <div id="an-ref-organization" style="display:none"><label for="an-org">Organization</label><select id="an-org">${orgOpts}</select></div>
      <div id="an-ref-billing" style="display:none"><label for="an-bill">Organization</label><select id="an-bill"><option value="">All organizations</option>${orgOpts}</select></div>
      <div id="an-ref-site" style="display:none"><label for="an-site">Site</label><select id="an-site">${siteOpts}</select></div>
      <label>Send it</label>
      <label style="font-weight:normal"><input type="checkbox" id="an-ch-dashboard" checked /> In the customer dashboard</label>
      <label style="font-weight:normal"><input type="checkbox" id="an-ch-email" /> By email</label>
      <label for="an-subject">Subject</label><input type="text" id="an-subject" maxlength="140" style="width:100%" />
      <label for="an-format">Message format</label>
      <select id="an-format"><option value="html">Formatted text (HTML)</option><option value="text">Plain text</option></select>
      <div id="an-toolbar" style="margin:6px 0"><button class="btn" type="button" data-tag="b">Bold</button> <button class="btn" type="button" data-tag="i">Italic</button> <button class="btn" type="button" data-tag="h2">Heading</button> <button class="btn" type="button" data-tag="ul">List</button> <button class="btn" type="button" data-tag="a">Link</button></div>
      <textarea id="an-body" rows="12" style="width:100%;font-family:monospace" placeholder="Write the message. In HTML mode you can use headings, bold, links, lists, tables and pictures. Scripts and styles are removed automatically."></textarea>
      <label for="an-files">Photos and documents (optional, ${MAX_BYTES / 1048576} MB each)</label>
      <input type="file" id="an-files" multiple />
      <div id="an-uploaded"></div>
      <p class="muted" style="color:var(--text-dim)">Pictures can be placed inside the text; everything else is listed as a download under the message. Emails carry attachments as secure links and need PORTAL_BASE_URL to be set.</p>
      <p><button class="btn" type="button" id="an-preview">Preview audience</button> <button class="btn" type="button" id="an-send">Send announcement</button></p>
      <div id="an-preview-out"></div>
    </div>
    <h2>Sent announcements</h2>
    <table><thead><tr><th>Subject</th><th>To</th><th>Where</th><th>People</th><th>Emails</th><th>Opened</th><th>Sent</th></tr></thead><tbody>${rows || `<tr><td colspan="7" style="color:var(--text-dim)">Nothing sent yet.</td></tr>`}</tbody></table>
    <script nonce="${nonceToken()}">
    (function () {
      var $ = function (id) { return document.getElementById(id); };
      var uploaded = []; // {id, filename, isImage, url, inline}
      function esc(s) { var d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }
      function msg(html, bad) { $('an-msg').innerHTML = html ? '<div class="flash ' + (bad ? 'flash-error' : '') + '" style="padding:8px;margin:8px 0;border:1px solid ' + (bad ? '#c0392b' : '#2e8b57') + '">' + html + '</div>' : ''; }
      function kind() { return $('an-kind').value; }
      function ref() { var k = kind(); return k === 'user' ? $('an-user').value.trim() : k === 'organization' ? $('an-org').value : k === 'billing' ? $('an-bill').value : k === 'site' ? $('an-site').value : ''; }
      function showRef() { ['user', 'organization', 'billing', 'site'].forEach(function (k) { $('an-ref-' + k).style.display = kind() === k ? 'block' : 'none'; }); }
      $('an-kind').addEventListener('change', showRef); showRef();
      function payload() {
        var ch = []; if ($('an-ch-dashboard').checked) ch.push('dashboard'); if ($('an-ch-email').checked) ch.push('email');
        return { kind: kind(), ref: ref(), subject: $('an-subject').value, body: $('an-body').value, format: $('an-format').value, channels: ch, fileIds: uploaded.map(function (f) { return f.id; }) };
      }
      function post(url, body, ok) {
        fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(function (r) { return r.json(); }).then(function (d) {
          if (d.success) ok(d); else msg(esc(d.error || 'failed') + (d.detail ? ': ' + esc(d.detail) : ''), true);
        }).catch(function () { msg('Could not reach the server.', true); });
      }
      $('an-toolbar').addEventListener('click', function (e) {
        var tag = e.target && e.target.getAttribute && e.target.getAttribute('data-tag'); if (!tag) return;
        var ta = $('an-body'), a = ta.selectionStart, b = ta.selectionEnd, sel = ta.value.slice(a, b) || 'text', out;
        if (tag === 'a') { var u = prompt('Link address (https://…)'); if (!u) return; out = '<a href="' + u.replace(/"/g, '') + '">' + sel + '</a>'; }
        else if (tag === 'ul') out = '<ul>\\n<li>' + sel.split('\\n').join('</li>\\n<li>') + '</li>\\n</ul>';
        else out = '<' + tag + '>' + sel + '</' + tag + '>';
        ta.value = ta.value.slice(0, a) + out + ta.value.slice(b); $('an-format').value = 'html';
      });
      function renderUploaded() {
        $('an-uploaded').innerHTML = uploaded.map(function (f, i) {
          return '<div>' + (f.isImage ? '&#128247; ' : '&#128206; ') + esc(f.filename) + (f.inline ? ' <em>(placed in text)</em>' : '') +
            (f.isImage && !f.inline ? ' <button class="btn" type="button" data-ins="' + i + '">Put in text</button>' : '') + ' <button class="btn" type="button" data-del="' + i + '">Remove</button></div>';
        }).join('');
      }
      $('an-uploaded').addEventListener('click', function (e) {
        var ins = e.target.getAttribute && e.target.getAttribute('data-ins'), del = e.target.getAttribute && e.target.getAttribute('data-del');
        if (ins != null) { var f = uploaded[+ins]; $('an-body').value += (($('an-body').value && '\\n') || '') + '<img src="' + f.url + '" alt="' + f.filename.replace(/"/g, '') + '">'; $('an-format').value = 'html'; f.inline = true; renderUploaded(); }
        if (del != null) { uploaded.splice(+del, 1); renderUploaded(); }
      });
      $('an-files').addEventListener('change', function () {
        var list = Array.prototype.slice.call($('an-files').files || []);
        (function next(i) {
          if (i >= list.length) { $('an-files').value = ''; renderUploaded(); return; }
          var fd = new FormData(); fd.append('file', list[i]); fd.append('purpose', 'announcement'); msg('Uploading ' + esc(list[i].name) + '…');
          fetch('/api/platform/saas/files', { method: 'POST', body: fd }).then(function (r) { return r.json(); }).then(function (d) {
            if (d.success) { uploaded.push({ id: d.file.id, filename: d.file.filename, isImage: d.file.isImage, url: d.file.url, inline: false }); msg(''); next(i + 1); }
            else { msg(esc(list[i].name) + ': ' + esc(d.detail || d.error), true); next(i + 1); }
          }).catch(function () { msg('Upload failed.', true); });
        })(0);
      });
      $('an-preview').addEventListener('click', function () {
        post('/api/platform/saas/announcements/preview', payload(), function (d) {
          $('an-preview-out').innerHTML = '<div class="card"><strong>' + esc(d.label) + '</strong>: ' + d.count + ' people' + (d.sample.length ? ' (e.g. ' + d.sample.map(esc).join(', ') + ')' : '') + '<hr><div>' + d.bodyHtml + '</div></div>'; msg('');
        });
      });
      $('an-send').addEventListener('click', function () {
        post('/api/platform/saas/announcements/preview', payload(), function (d) {
          if (!confirm('Send to ' + d.label + ' (' + d.count + ' people)?')) return;
          post('/api/platform/saas/announcements', payload(), function (r) {
            var w = (r.warnings || []).map(esc).join(' '); msg('Sent to ' + r.recipients + ' people. ' + w); setTimeout(function () { location.reload(); }, 1500);
          });
        });
      });
    })();
    </script>`;
  return renderShell({ title: "Announcements", activeKey: "saas-announcements", admin, env, bodyHtml: `<h1>Announcements</h1>${body}` });
}
