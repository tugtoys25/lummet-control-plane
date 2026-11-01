// Browser-side code for /platform/saas/plans (the plan catalog manager).
//
// Shipped as one string, inside a <script nonce> the Worker writes. Rules it follows (see worker/csp.js):
//   * no inline event handlers: everything is addEventListener / event delegation on data-* attributes;
//   * nothing from the API is ever parsed as HTML: every node is built with createElement + textContent;
//   * no template literals and no `${`, so this file can be embedded without escaping.
// Server-rendered: the table, filters, paging and selection checkboxes. This script adds the editor drawer, bulk actions,
// the publish switch, label and product managers, toasts and confirmation dialogs.

export const PLAN_CATALOG_CLIENT = String.raw`
(function () {
  'use strict';
  var API = '/api/platform/saas';
  var root = document.getElementById('pc-root');
  if (!root) return;

  var ERR = {
    invalid_name: 'Give it a name of at least 2 characters.', invalid_key: 'The key must be lower_snake_case, starting with a letter.', key_already_exists: 'That key is already used.',
    key_is_immutable: 'The key cannot change after creation: price lookup keys are built from it.', invalid_price_cents: 'Enter a valid price.', price_required: 'Monthly and annual plans need a price.',
    price_managed_by_versions: 'This plan has a price history. Add a new price version on the Pricing tab instead.', invalid_trial_days: 'Trial length must be 0 to 90 days.',
    product_not_found: 'Pick a product.', product_not_active: 'That product is retired. Reactivate it first.', product_locked_after_sales: 'The product cannot change once a plan has prices or subscribers.',
    billing_period_locked_after_sales: 'The billing period cannot change once a plan has prices or subscribers.', currency_locked_after_sales: 'The currency cannot change once a plan has prices or subscribers.',
    plan_in_use: 'This plan has subscribers or price history, so it cannot be deleted. Retire it instead.', unpublish_before_delete: 'Unpublish or retire the plan before deleting it.',
    invalid_stripe_price_id: 'Stripe price ids look like price_1AbC...', stripe_price_already_used: 'That Stripe price is already attached to a plan.', reason_required: 'A reason is required.',
    stripe_price_not_found: 'Stripe does not know that price id (check the id and the Stripe mode).', stripe_price_amount_mismatch: 'The amount does not match the price in Stripe.',
    stripe_price_currency_mismatch: 'The currency does not match the price in Stripe.', stripe_price_interval_mismatch: 'The billing interval does not match the price in Stripe.',
    stripe_price_inactive: 'That Stripe price is archived in Stripe.', stripe_price_not_recurring: 'That Stripe price is not recurring.', stripe_unreachable: 'Stripe could not be reached. Nothing was saved.',
    price_mode_mismatch: 'That price belongs to the other Stripe mode (test vs live).', plan_not_recurring: 'Custom plans have no Stripe price.', too_many_features: 'At most 30 feature lines.',
    too_many_labels: 'At most 8 labels per plan.', label_already_exists: 'A label with that name exists.', invalid_color: 'Pick one of the colours.', invalid_badge_text: 'Badge text needs 2 to 40 characters.',
    ends_before_start: 'The end must be after the start.', coupon_not_found: 'That coupon no longer exists.', coupon_is_organization_scoped: 'Organization-only coupons cannot be promoted publicly.',
    entitlement_type_mismatch: 'That key has a fixed type.', invalid_number: 'Entitlement numbers must be whole numbers.', invalid_boolean: 'Pick on or off.', duplicate_key: 'Duplicate entitlement key.',
    not_archived: 'Only retired plans can be restored.', nothing_selected: 'Select at least one plan.', too_many_selected: 'Select up to 100 plans at a time.', invalid_category: 'Pick a category.',
    cross_site_request_blocked: 'Blocked: reload the page and try again.'
  };
  function errText(code) { return ERR[code] || ('Failed: ' + (code || 'unknown error')); }

  // ---------------------------------------------------------------- tiny DOM helpers
  function el(tag, attrs) {
    var n = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v === false || v === null || v === undefined) return;
      if (k === 'class') n.className = v; else if (k === 'text') n.textContent = v; else if (k === 'value') n.value = v; else if (k === 'checked') n.checked = !!v; else if (k === 'disabled') n.disabled = !!v;
      else n.setAttribute(k, v === true ? '' : v);
    });
    for (var i = 2; i < arguments.length; i++) {
      var c = arguments[i];
      if (c === null || c === undefined || c === false) continue;
      if (Array.isArray(c)) c.forEach(function (x) { if (x) n.appendChild(typeof x === 'string' ? document.createTextNode(x) : x); });
      else n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return n;
  }
  function field(label, input, hint) {
    return el('div', { class: 'pc-field' }, el('label', null, label), input, hint ? el('div', { class: 'pc-hint', text: hint }) : null);
  }
  function api(method, path, body) {
    var opts = { method: method, headers: { 'Content-Type': 'application/json' } };
    if (body !== undefined) opts.body = JSON.stringify(body);
    return fetch(API + path, opts).then(function (r) { return r.json().catch(function () { return { success: false, error: 'bad_response' }; }); })
      .catch(function () { return { success: false, error: 'network_error' }; });
  }
  function money(cents, cur) {
    if (cents === null || cents === undefined) return 'custom';
    try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: String(cur || 'USD').toUpperCase() }).format(cents / 100); } catch (e) { return (cents / 100).toFixed(2); }
  }
  function toCents(v) { var n = Number(String(v).replace(/,/g, '')); return isFinite(n) && String(v).trim() !== '' ? Math.round(n * 100) : null; }
  function fromCents(c) { return c === null || c === undefined ? '' : (c / 100).toFixed(2); }
  function sqlToLocal(s) { return s ? String(s).replace(' ', 'T').slice(0, 16) : ''; }
  function localToSql(s) { return s ? s : null; }

  // ---------------------------------------------------------------- toast + live region
  var live = el('div', { class: 'pc-toasts', role: 'status', 'aria-live': 'polite' });
  document.body.appendChild(live);
  function toast(msg, kind) {
    var t = el('div', { class: 'pc-toast pc-toast-' + (kind || 'ok'), text: msg });
    live.appendChild(t);
    setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, kind === 'err' ? 9000 : 4500);
  }

  // ---------------------------------------------------------------- modal (confirm / form)
  var openModals = [];
  function modal(title, bodyNodes, buttons, opts) {
    opts = opts || {};
    var prev = document.activeElement;
    var overlay = el('div', { class: 'pc-overlay' });
    var box = el('div', { class: 'pc-modal' + (opts.wide ? ' pc-modal-wide' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-label': title });
    var head = el('div', { class: 'pc-modal-head' }, el('h2', { text: title }));
    var closeBtn = el('button', { type: 'button', class: 'pc-x', 'aria-label': 'Close', text: '×' });
    head.appendChild(closeBtn);
    var foot = el('div', { class: 'pc-modal-foot' });
    box.appendChild(head); box.appendChild(el('div', { class: 'pc-modal-body' }, bodyNodes)); box.appendChild(foot);
    overlay.appendChild(box); document.body.appendChild(overlay);
    var api_ = { close: close, box: box, setBusy: setBusy };
    function close() {
      if (!overlay.parentNode) return;
      overlay.parentNode.removeChild(overlay);
      openModals = openModals.filter(function (m) { return m !== api_; });
      if (prev && prev.focus) { try { prev.focus(); } catch (e) {} }
    }
    function setBusy(b) { foot.querySelectorAll('button').forEach(function (x) { x.disabled = !!b; }); }
    closeBtn.addEventListener('click', close);
    overlay.addEventListener('mousedown', function (e) { if (e.target === overlay && !opts.sticky) close(); });
    (buttons || []).forEach(function (b) {
      var btn = el('button', { type: 'button', class: 'btn ' + (b.kind === 'danger' ? 'btn-danger' : b.kind === 'ghost' ? 'btn-secondary' : '') , text: b.label });
      btn.addEventListener('click', function () { b.onClick(api_, btn); });
      foot.appendChild(btn);
    });
    openModals.push(api_);
    var first = box.querySelector('input,select,textarea,button.btn');
    if (first) first.focus();
    return api_;
  }
  function confirmBox(title, message, okLabel, danger) {
    return new Promise(function (resolve) {
      var done = false;
      function fin(v, m) { if (done) return; done = true; m.close(); resolve(v); }
      modal(title, [el('p', { text: message, class: 'pc-p' })], [
        { label: 'Cancel', kind: 'ghost', onClick: function (m) { fin(false, m); } },
        { label: okLabel || 'Confirm', kind: danger ? 'danger' : '', onClick: function (m) { fin(true, m); } }
      ]);
    });
  }
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && openModals.length) { openModals[openModals.length - 1].close(); }
  });

  // ---------------------------------------------------------------- selection + bulk bar
  var table = document.getElementById('pc-table');
  var bulk = document.getElementById('pc-bulk');
  var countEl = document.getElementById('pc-bulk-count');
  var master = document.getElementById('pc-select-all');
  function rowBoxes() { return table ? Array.prototype.slice.call(table.querySelectorAll('input.pc-row-check')) : []; }
  function selectedIds() { return rowBoxes().filter(function (b) { return b.checked; }).map(function (b) { return b.value; }); }
  function refreshSelection() {
    var ids = selectedIds(), all = rowBoxes();
    if (bulk) bulk.hidden = ids.length === 0;
    if (countEl) countEl.textContent = ids.length + ' selected';
    if (master) { master.checked = all.length > 0 && ids.length === all.length; master.indeterminate = ids.length > 0 && ids.length < all.length; }
    all.forEach(function (b) { var tr = b.closest('tr'); if (tr) tr.classList.toggle('pc-selected', b.checked); });
  }
  if (table) {
    table.addEventListener('change', function (e) { if (e.target.classList.contains('pc-row-check')) refreshSelection(); });
  }
  if (master) master.addEventListener('change', function () { rowBoxes().forEach(function (b) { b.checked = master.checked; }); refreshSelection(); });
  var clearBtn = document.getElementById('pc-bulk-clear');
  if (clearBtn) clearBtn.addEventListener('click', function () { rowBoxes().forEach(function (b) { b.checked = false; }); refreshSelection(); });
  refreshSelection();

  var BULK_COPY = {
    publish: ['Publish', 'Publish {n} plan(s)? They become visible on the pricing page and can be bought.', false],
    unpublish: ['Unpublish', 'Move {n} plan(s) back to draft? They disappear from the pricing page and from new checkouts. Current subscribers are not affected.', false],
    archive: ['Retire', 'Retire {n} plan(s)? No new sales. Current subscribers keep the plan.', false],
    restore: ['Restore', 'Restore {n} retired plan(s) as drafts?', false],
    duplicate: ['Duplicate', 'Create a draft copy of {n} plan(s)? Prices and promotions are not copied.', false],
    feature: ['Feature', 'Mark {n} plan(s) as recommended? Only one plan per product and billing period can be recommended, so siblings are un-featured.', false],
    unfeature: ['Remove highlight', 'Remove the recommended highlight from {n} plan(s)?', false],
    delete: ['Delete', 'Permanently delete {n} plan(s)? Plans with subscribers or price history are skipped and should be retired instead. This cannot be undone.', true]
  };
  function summarizeBulk(res, action) {
    if (!res.success) { toast(errText(res.error), 'err'); return; }
    var msg = res.done + ' plan(s) updated' + (res.failed ? ', ' + res.failed + ' skipped' : '') + '.';
    var bad = (res.results || []).filter(function (r) { return !r.ok; }).slice(0, 3).map(function (r) { return r.id.replace(/^plan_/, '') + ': ' + errText(r.error); });
    var warns = (res.results || []).filter(function (r) { return r.ok && r.warnings && r.warnings.length; }).length;
    if (bad.length) msg += ' ' + bad.join(' | ');
    if (action === 'publish' && warns) msg += ' ' + warns + ' published with warnings (see the warning chips).';
    toast(msg, res.failed ? 'warn' : 'ok');
    setTimeout(function () { location.reload(); }, res.failed ? 2800 : 900);
  }
  function runBulk(action, extra) {
    var ids = selectedIds();
    if (!ids.length) { toast(errText('nothing_selected'), 'err'); return Promise.resolve(); }
    var body = { action: action, ids: ids };
    if (extra) Object.keys(extra).forEach(function (k) { body[k] = extra[k]; });
    return api('POST', '/plan-catalog/bulk', body).then(function (r) { summarizeBulk(r, action); });
  }
  if (bulk) bulk.addEventListener('click', function (e) {
    var b = e.target.closest('[data-bulk]'); if (!b) return;
    var action = b.getAttribute('data-bulk'), n = selectedIds().length;
    if (!n) { toast(errText('nothing_selected'), 'err'); return; }
    if (action === 'add_label' || action === 'remove_label') return pickLabelForBulk(action);
    if (action === 'set_trial_days') return trialForBulk();
    var c = BULK_COPY[action]; if (!c) return;
    confirmBox(c[0] + ' ' + n + ' plan' + (n === 1 ? '' : 's'), c[1].replace('{n}', String(n)), c[0], c[2]).then(function (ok) { if (ok) runBulk(action); });
  });
  function pickLabelForBulk(action) {
    loadOptions().then(function (opt) {
      var sel = el('select', null, opt.labels.map(function (l) { return el('option', { value: l.id, text: l.name }); }));
      var n = selectedIds().length;
      modal((action === 'add_label' ? 'Add label to ' : 'Remove label from ') + n + ' plan(s)', [field('Label', sel)], [
        { label: 'Cancel', kind: 'ghost', onClick: function (m) { m.close(); } },
        { label: action === 'add_label' ? 'Add label' : 'Remove label', onClick: function (m) { m.setBusy(true); m.close(); runBulk(action, { labelId: sel.value }); } }
      ]);
    });
  }
  function trialForBulk() {
    var inp = el('input', { type: 'number', min: '0', max: '90', step: '1', value: '14' });
    modal('Set trial length for ' + selectedIds().length + ' plan(s)', [field('Trial days', inp, '0 turns the trial off. Maximum 90.')], [
      { label: 'Cancel', kind: 'ghost', onClick: function (m) { m.close(); } },
      { label: 'Apply', onClick: function (m) { m.close(); runBulk('set_trial_days', { trialDays: parseInt(inp.value, 10) }); } }
    ]);
  }

  // ---------------------------------------------------------------- shared option data
  var optionsPromise = null;
  function loadOptions(force) {
    if (!optionsPromise || force) optionsPromise = api('GET', '/plan-catalog/options').then(function (r) { if (!r.success) { optionsPromise = null; toast(errText(r.error), 'err'); return { products: [], labels: [], coupons: [], entitlementCatalog: [], labelColors: [], categories: [] }; } return r.data; });
    return optionsPromise;
  }

  // ---------------------------------------------------------------- row actions (publish switch, menu)
  function planAction(id, action, confirmCopy) {
    var go = function () { return api('POST', '/plan-catalog/' + encodeURIComponent(id) + '/' + action, {}).then(function (r) {
      if (!r.success) { toast(errText(r.error) + (r.blockers ? ' (' + Object.keys(r.blockers).filter(function (k) { return r.blockers[k]; }).map(function (k) { return r.blockers[k] + ' ' + k; }).join(', ') + ')' : ''), 'err'); return false; }
      var w = (r.warnings || []).length ? ' Published with ' + r.warnings.length + ' warning(s).' : '';
      toast('Done.' + w, w ? 'warn' : 'ok'); setTimeout(function () { location.reload(); }, w ? 1800 : 600); return true;
    }); };
    if (!confirmCopy) return go();
    return confirmBox(confirmCopy[0], confirmCopy[1], confirmCopy[2], confirmCopy[3]).then(function (ok) { return ok ? go() : false; });
  }
  function rowInfo(id) {
    var tr = table && table.querySelector('tr[data-plan="' + id.replace(/"/g, '') + '"]');
    return { name: tr ? tr.getAttribute('data-name') : id, live: tr ? parseInt(tr.getAttribute('data-live') || '0', 10) : 0 };
  }
  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-pc]'); if (!t) return;
    var act = t.getAttribute('data-pc'), id = t.getAttribute('data-id');
    var info = id ? rowInfo(id) : null;
    var details = t.closest('details'); if (details) details.removeAttribute('open');
    if (act === 'edit') openEditor(id);
    else if (act === 'new') openEditor(null);
    else if (act === 'labels') openLabelManager();
    else if (act === 'product') openProductModal();
    else if (act === 'toggle') {
      var on = t.getAttribute('aria-checked') === 'true';
      if (on) planAction(id, 'unpublish', ['Unpublish ' + info.name + '?', 'It returns to draft: hidden from the pricing page and from new checkouts.' + (info.live ? ' ' + info.live + ' live subscription(s) keep working unchanged.' : ''), 'Unpublish', false]);
      else planAction(id, 'publish');
    }
    else if (act === 'duplicate') planAction(id, 'duplicate');
    else if (act === 'archive') planAction(id, 'archive', ['Retire ' + info.name + '?', 'No new sales.' + (info.live ? ' ' + info.live + ' live subscription(s) keep the plan.' : ' Nobody is subscribed right now.'), 'Retire', false]);
    else if (act === 'restore') planAction(id, 'restore');
    else if (act === 'delete') planAction(id, 'delete', ['Delete ' + info.name + '?', 'This permanently removes the plan, its feature lines, entitlements, labels and promotions. It only works for plans that never had a price or a subscriber. This cannot be undone.', 'Delete plan', true]);
  });

  // ---------------------------------------------------------------- label manager
  function colorSelect(opt, value) {
    return el('select', null, opt.labelColors.map(function (c) { return el('option', { value: c, text: c, selected: c === value ? 'selected' : false }); }));
  }
  function chip(label) { return el('span', { class: 'pc-chip pc-chip-' + (label.color || 'neutral'), text: label.name }); }
  function openLabelManager() {
    loadOptions(true).then(function (opt) {
      var list = el('div', { class: 'pc-list' });
      function draw() {
        list.textContent = '';
        opt.labels.forEach(function (l) {
          var name = el('input', { value: l.name, maxlength: '30', 'aria-label': 'Label name' });
          var col = colorSelect(opt, l.color);
          var save = el('button', { type: 'button', class: 'btn btn-secondary btn-small', text: 'Save' });
          var del = el('button', { type: 'button', class: 'btn btn-secondary btn-small', text: 'Delete' });
          save.addEventListener('click', function () { api('POST', '/plan-labels/' + encodeURIComponent(l.id), { name: name.value, color: col.value }).then(function (r) { if (r.success) { toast('Label saved.'); loadOptions(true); } else toast(errText(r.error), 'err'); }); });
          del.addEventListener('click', function () { confirmBox('Delete label ' + l.name + '?', 'It is removed from ' + l.plan_count + ' plan(s).', 'Delete label', true).then(function (ok) { if (!ok) return; api('POST', '/plan-labels/' + encodeURIComponent(l.id) + '/delete', {}).then(function (r) { if (r.success) { opt.labels = opt.labels.filter(function (x) { return x.id !== l.id; }); draw(); toast('Label deleted.'); } else toast(errText(r.error), 'err'); }); }); });
          list.appendChild(el('div', { class: 'pc-row' }, chip(l), name, col, el('span', { class: 'pc-dim', text: l.plan_count + ' plan(s)' }), save, del));
        });
        if (!opt.labels.length) list.appendChild(el('p', { class: 'pc-dim', text: 'No labels yet.' }));
      }
      draw();
      var nn = el('input', { placeholder: 'New label, e.g. Best for agencies', maxlength: '30', 'aria-label': 'New label name' });
      var nc = colorSelect(opt, 'blue');
      var add = el('button', { type: 'button', class: 'btn', text: 'Add label' });
      add.addEventListener('click', function () { api('POST', '/plan-labels', { name: nn.value, color: nc.value }).then(function (r) { if (!r.success) return toast(errText(r.error), 'err'); toast('Label added.'); nn.value = ''; loadOptions(true).then(function (o) { opt = o; draw(); }); }); });
      modal('Labels', [el('p', { class: 'pc-p', text: 'Labels are reusable chips shown on plans. Pick them from the plan editor or add them to many plans at once from the bulk bar.' }), list, el('div', { class: 'pc-row pc-addrow' }, nn, nc, add)], [{ label: 'Done', kind: 'ghost', onClick: function (m) { m.close(); location.reload(); } }], { wide: true });
    });
  }

  // ---------------------------------------------------------------- product modal
  function openProductModal() {
    loadOptions().then(function (opt) {
      var name = el('input', { maxlength: '80', placeholder: 'e.g. Casino Reviews' });
      var cat = el('select', null, opt.categories.map(function (c) { return el('option', { value: c, text: c }); }));
      modal('New product', [el('p', { class: 'pc-p', text: 'A product is a family of plans (for example Casino News). Plans are grouped by product on the pricing page.' }), field('Name', name), field('Category', cat)], [
        { label: 'Cancel', kind: 'ghost', onClick: function (m) { m.close(); } },
        { label: 'Create product', onClick: function (m) { m.setBusy(true); api('POST', '/products', { name: name.value, category: cat.value }).then(function (r) { m.setBusy(false); if (!r.success) return toast(errText(r.error), 'err'); toast('Product created.'); m.close(); loadOptions(true); setTimeout(function () { location.reload(); }, 600); }); } }
      ]);
    });
  }

  // ---------------------------------------------------------------- editor drawer
  var drawer = null;
  function openEditor(planId, tab) {
    closeEditor();
    Promise.all([loadOptions(), planId ? api('GET', '/plan-catalog/' + encodeURIComponent(planId)) : Promise.resolve(null)]).then(function (res) {
      var opt = res[0], detail = res[1];
      if (planId && (!detail || !detail.success)) return toast(errText(detail && detail.error), 'err');
      buildEditor(opt, detail ? detail.data : null, tab || 'details');
    });
  }
  function closeEditor() { if (drawer && drawer.parentNode) drawer.parentNode.removeChild(drawer); drawer = null; document.body.classList.remove('pc-lock'); }

  var WARN_TEXT = {
    no_active_stripe_price: 'No active Stripe price: customers cannot pay for this plan yet. Add one on the Pricing tab.',
    price_differs_from_stripe: 'The list price differs from the active Stripe price. Checkout charges the Stripe price.',
    product_not_active: 'The product is retired, so this plan is hidden from the pricing page.',
    no_features: 'No feature lines or entitlements: the card will look empty.',
    seo_description_missing: 'No SEO description yet.',
    not_listed_on_pricing_page: 'Free, contract and custom-period plans are not listed on the public pricing page.'
  };

  function buildEditor(opt, d, startTab) {
    var isNew = !d;
    var plan = d ? d.plan : { name: '', key: '', product_id: (opt.products.filter(function (p) { return p.status === 'active'; })[0] || {}).id || '', billing_period: 'monthly', price_cents: 0, currency: 'USD', trial_days: 0, status: 'draft', sort_order: 0, is_featured: 0, tagline: '', description: '', cta_label: '', seo_title: '', seo_description: '' };
    var locked = d && (plan.price_versions > 0 || plan.total_subscriptions > 0);
    var overlay = el('div', { class: 'pc-overlay pc-overlay-drawer' });
    var panel = el('aside', { class: 'pc-drawer', role: 'dialog', 'aria-modal': 'true', 'aria-label': isNew ? 'New plan' : 'Edit ' + plan.name });
    var statusBadge = el('span', { class: 'pc-badge pc-badge-' + plan.status, text: plan.status === 'active' ? 'Published' : plan.status === 'retired' ? 'Retired' : 'Draft' });
    var closeBtn = el('button', { type: 'button', class: 'pc-x', 'aria-label': 'Close editor', text: '×' });
    var head = el('header', { class: 'pc-drawer-head' }, el('div', null, el('h2', { text: isNew ? 'New plan' : plan.name }), el('div', { class: 'pc-dim' }, isNew ? 'Created as a draft. Publish it when it is ready.' : [plan.key, ' · ', plan.product])), statusBadge, closeBtn);
    var tabsBar = el('nav', { class: 'pc-tabs', role: 'tablist' });
    var body = el('div', { class: 'pc-drawer-body' });
    var foot = el('footer', { class: 'pc-drawer-foot' });
    panel.appendChild(head); panel.appendChild(tabsBar);
    var warnBox = el('div', { class: 'pc-warns' });
    (d ? d.warnings : []).forEach(function (w) { warnBox.appendChild(el('div', { class: 'pc-warn', text: WARN_TEXT[w] || w })); });
    panel.appendChild(warnBox); panel.appendChild(body); panel.appendChild(foot);
    overlay.appendChild(panel); document.body.appendChild(overlay); document.body.classList.add('pc-lock');
    drawer = overlay;
    closeBtn.addEventListener('click', closeEditor);
    overlay.addEventListener('mousedown', function (e) { if (e.target === overlay) closeEditor(); });
    panel.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !openModals.length) closeEditor(); });

    var TABS = [['details', 'Details'], ['pricing', 'Pricing'], ['features', 'Features'], ['entitlements', 'Entitlements'], ['labels', 'Labels'], ['promotions', 'Promotions'], ['seo', 'SEO']];
    var panes = {};
    TABS.forEach(function (t) {
      var b = el('button', { type: 'button', role: 'tab', class: 'pc-tab', 'data-tab': t[0], text: t[1], disabled: isNew && t[0] !== 'details' });
      tabsBar.appendChild(b);
    });
    function show(name) {
      Array.prototype.forEach.call(tabsBar.children, function (b) { var on = b.getAttribute('data-tab') === name; b.classList.toggle('pc-tab-on', on); b.setAttribute('aria-selected', on ? 'true' : 'false'); });
      body.textContent = ''; body.appendChild(panes[name]);
    }
    tabsBar.addEventListener('click', function (e) { var b = e.target.closest('.pc-tab'); if (b && !b.disabled) show(b.getAttribute('data-tab')); });

    function saveBar(label, onSave) {
      var btn = el('button', { type: 'button', class: 'btn', text: label });
      btn.addEventListener('click', function () { btn.disabled = true; Promise.resolve(onSave()).then(function () { btn.disabled = false; }); });
      return el('div', { class: 'pc-savebar' }, btn);
    }
    function reopen(tab) { openEditor(plan.id, tab); }

    // ---- Details
    (function () {
      var f = {};
      f.name = el('input', { value: plan.name, maxlength: '80' });
      f.key = el('input', { value: plan.key, maxlength: '64', disabled: !isNew, placeholder: 'auto from product + name' });
      f.product = el('select', { disabled: !!locked }, opt.products.map(function (p) { return el('option', { value: p.id, text: p.name + (p.status !== 'active' ? ' (retired)' : ''), selected: p.id === plan.product_id ? 'selected' : false }); }));
      f.period = el('select', { disabled: !!locked }, ['monthly', 'annual', 'custom'].map(function (p) { return el('option', { value: p, text: p, selected: p === plan.billing_period ? 'selected' : false }); }));
      f.currency = el('input', { value: String(plan.currency || 'USD').toUpperCase(), maxlength: '3', disabled: !!locked });
      var priceLocked = d && plan.price_versions > 0;
      f.price = el('input', { type: 'number', step: '0.01', min: '0', value: fromCents(plan.price_cents), disabled: !!priceLocked });
      f.trial = el('input', { type: 'number', min: '0', max: '90', step: '1', value: String(plan.trial_days || 0) });
      f.sort = el('input', { type: 'number', step: '1', value: String(plan.sort_order || 0) });
      f.featured = el('input', { type: 'checkbox', checked: !!plan.is_featured });
      f.tagline = el('input', { value: plan.tagline || '', maxlength: '120', placeholder: 'One line under the plan name' });
      f.description = el('textarea', { rows: '4', maxlength: '800' }); f.description.value = plan.description || '';
      f.cta = el('input', { value: plan.cta_label || '', maxlength: '40', placeholder: 'Default button text' });
      var grid = el('div', { class: 'pc-grid2' },
        field('Plan name', f.name), field('Product', f.product, opt.products.length ? null : 'Create a product first.'),
        field('Key', f.key, isNew ? 'Lower_snake_case. Cannot be changed later (price lookup keys are built from it).' : 'Fixed after creation.'),
        field('Billing period', f.period, locked ? 'Locked: this plan has prices or subscribers.' : null),
        field('Currency', f.currency, locked ? 'Locked after the first sale.' : 'ISO code, e.g. USD.'),
        field(priceLocked ? 'List price (read only)' : 'List price', f.price, priceLocked ? 'Change the price by adding a new version on the Pricing tab.' : 'Shown until a Stripe price is attached. Attach one on the Pricing tab so checkout can charge it.'),
        field('Free trial (days)', f.trial, '0 to 90. A platform-wide trial setting may override this.'), field('Sort order', f.sort, 'Lower numbers appear first within the product.'));
      var feat = el('label', { class: 'pc-check' }, f.featured, 'Highlight as the recommended plan (one per product and billing period)');
      var pane = el('div', null, grid, field('Tagline', f.tagline), field('Description', f.description), field('Button text', f.cta), feat);
      function payload() {
        var p = { name: f.name.value, tagline: f.tagline.value, description: f.description.value, ctaLabel: f.cta.value, trialDays: parseInt(f.trial.value, 10) || 0, sortOrder: parseInt(f.sort.value, 10) || 0, isFeatured: f.featured.checked };
        if (!locked) { p.billingPeriod = f.period.value; p.currency = f.currency.value; p.productId = f.product.value; }
        if (!priceLocked) p.priceCents = f.period.value === 'custom' ? null : toCents(f.price.value);
        if (isNew) { p.key = f.key.value; p.productId = f.product.value; p.billingPeriod = f.period.value; p.currency = f.currency.value; }
        return p;
      }
      pane.appendChild(saveBar(isNew ? 'Create draft plan' : 'Save details', function () {
        var p = payload();
        if (isNew && !p.key) delete p.key;
        if (p.priceCents === null && p.billingPeriod !== 'custom' && !priceLocked) { toast('Enter a price (0 for free).', 'err'); return; }
        return api('POST', isNew ? '/plan-catalog' : '/plan-catalog/' + encodeURIComponent(plan.id), p).then(function (r) {
          if (!r.success) return toast(errText(r.error), 'err');
          toast(isNew ? 'Draft created. Add features, labels and a price next.' : 'Saved.');
          if (isNew) openEditor(r.planId, 'pricing'); else { reopen('details'); }
        });
      }));
      panes.details = pane;
    })();

    function needsPlan(msg) { return el('p', { class: 'pc-dim', text: msg || 'Save the plan first.' }); }

    if (!isNew) {
      // ---- Pricing
      (function () {
        var pane = el('div');
        var recurring = plan.billing_period !== 'custom';
        var active = plan.active_price_id;
        pane.appendChild(el('div', { class: 'pc-kv' },
          el('div', null, el('span', { class: 'pc-dim', text: 'List price' }), el('strong', { text: money(plan.price_cents, plan.currency) + (recurring ? ' / ' + (plan.billing_period === 'annual' ? 'year' : 'month') : '') })),
          el('div', null, el('span', { class: 'pc-dim', text: 'Active Stripe price' }), el('strong', { text: active || 'none' })),
          el('div', null, el('span', { class: 'pc-dim', text: 'Live subscribers' }), el('strong', { text: String(plan.live_subscriptions) }))));
        var versions = d.prices;
        if (versions.length) {
          var t = el('table', { class: 'pc-mini' }, el('thead', null, el('tr', null, ['Version', 'Amount', 'Interval', 'Stripe price', 'Mode', 'State'].map(function (h) { return el('th', { text: h }); }))),
            el('tbody', null, versions.map(function (v) { return el('tr', null, el('td', { text: 'v' + v.version }), el('td', { text: money(v.unit_amount_cents, v.currency) }), el('td', { text: v.interval }), el('td', null, el('code', { text: v.stripe_price_id })), el('td', { text: v.stripe_mode }), el('td', { text: v.active ? 'selling' : 'previous' })); })));
          pane.appendChild(el('h3', { text: 'Price history' })); pane.appendChild(el('div', { class: 'table-wrap' }, t));
          pane.appendChild(el('p', { class: 'pc-dim', text: 'Prices are never edited. A change is a new version; existing subscribers keep the price they bought, new checkouts use the newest.' }));
        } else {
          pane.appendChild(el('p', { class: 'pc-dim', text: recurring ? 'No Stripe price is attached yet. Until one is, this plan can be published but customers cannot pay for it.' : 'Custom plans are sold by contract and have no self-serve price.' }));
        }
        if (recurring) {
          var amt = el('input', { type: 'number', step: '0.01', min: '0', placeholder: fromCents(plan.price_cents) || '29.00' });
          var sid = el('input', { placeholder: 'price_1AbC...', autocomplete: 'off', spellcheck: 'false' });
          var tax = el('select', null, ['unspecified', 'exclusive', 'inclusive'].map(function (x) { return el('option', { value: x, text: x }); }));
          var why = el('input', { maxlength: '300', placeholder: 'Why is the price changing? (audit log)' });
          pane.appendChild(el('h3', { text: versions.length ? 'Add a new price version' : 'Attach the first Stripe price' }));
          pane.appendChild(el('p', { class: 'pc-dim', text: 'Create the recurring price in Stripe first, then paste its id. When Stripe is connected, Lummet checks the amount, currency and interval against Stripe and refuses a mismatch.' }));
          pane.appendChild(el('div', { class: 'pc-grid2' }, field('Amount (' + String(plan.currency).toUpperCase() + ' / ' + (plan.billing_period === 'annual' ? 'year' : 'month') + ')', amt), field('Stripe price id', sid), field('Tax behavior', tax, 'Cannot be changed later once exclusive or inclusive.'), field('Reason', why)));
          pane.appendChild(saveBar('Make this the selling price', function () {
            var cents = toCents(amt.value);
            if (cents === null) { toast(errText('invalid_price_cents'), 'err'); return; }
            return confirmBox('Change the selling price?', 'New checkouts will charge ' + money(cents, plan.currency) + '. ' + (plan.live_subscriptions ? plan.live_subscriptions + ' current subscriber(s) stay on their existing price.' : 'Nobody is subscribed yet.'), 'Change price', false).then(function (ok) {
              if (!ok) return;
              return api('POST', '/plan-catalog/' + encodeURIComponent(plan.id) + '/price', { amountCents: cents, stripePriceId: sid.value, taxBehavior: tax.value, reason: why.value }).then(function (r) {
                if (!r.success) return toast(errText(r.error) + (r.error === 'stripe_price_amount_mismatch' ? '' : ''), 'err');
                toast('Price v' + r.version + ' is live' + (r.verified ? ' (verified with Stripe).' : ' (Stripe is not connected here, so it was not verified).'), r.verified ? 'ok' : 'warn');
                reopen('pricing');
              });
            });
          }));
        }
        panes.pricing = pane;
      })();

      // ---- Features
      (function () {
        var pane = el('div');
        pane.appendChild(el('p', { class: 'pc-dim', text: 'What visitors read on the pricing card. When this list is empty the card falls back to a list built from the entitlements.' }));
        var rows = d.features.map(function (f) { return { label: f.label, included: !!f.included, highlight: !!f.highlight }; });
        var list = el('div', { class: 'pc-list' });
        function draw() {
          list.textContent = '';
          rows.forEach(function (r, i) {
            var inp = el('input', { value: r.label, maxlength: '100', 'aria-label': 'Feature line ' + (i + 1) });
            inp.addEventListener('input', function () { r.label = inp.value; });
            var inc = el('input', { type: 'checkbox', checked: r.included, 'aria-label': 'Included' }); inc.addEventListener('change', function () { r.included = inc.checked; });
            var hi = el('input', { type: 'checkbox', checked: r.highlight, 'aria-label': 'Highlight' }); hi.addEventListener('change', function () { r.highlight = hi.checked; });
            var up = el('button', { type: 'button', class: 'btn btn-secondary btn-small', text: '↑', 'aria-label': 'Move up', disabled: i === 0 });
            var dn = el('button', { type: 'button', class: 'btn btn-secondary btn-small', text: '↓', 'aria-label': 'Move down', disabled: i === rows.length - 1 });
            var rm = el('button', { type: 'button', class: 'btn btn-secondary btn-small', text: 'Remove' });
            up.addEventListener('click', function () { rows.splice(i - 1, 0, rows.splice(i, 1)[0]); draw(); });
            dn.addEventListener('click', function () { rows.splice(i + 1, 0, rows.splice(i, 1)[0]); draw(); });
            rm.addEventListener('click', function () { rows.splice(i, 1); draw(); });
            list.appendChild(el('div', { class: 'pc-row' }, inp, el('label', { class: 'pc-check' }, inc, 'Included'), el('label', { class: 'pc-check' }, hi, 'Bold'), up, dn, rm));
          });
          if (!rows.length) list.appendChild(el('p', { class: 'pc-dim', text: 'No custom lines. The auto-generated list is shown.' }));
        }
        draw();
        var add = el('button', { type: 'button', class: 'btn btn-secondary', text: '+ Add line' });
        add.addEventListener('click', function () { if (rows.length >= 30) return toast(errText('too_many_features'), 'err'); rows.push({ label: '', included: true, highlight: false }); draw(); var ins = list.querySelectorAll('input[type=text],input:not([type])'); if (ins.length) ins[ins.length - 1].focus(); });
        pane.appendChild(list); pane.appendChild(add);
        pane.appendChild(saveBar('Save features', function () {
          return api('POST', '/plan-catalog/' + encodeURIComponent(plan.id) + '/features', { features: rows }).then(function (r) { if (!r.success) return toast(errText(r.error), 'err'); toast('Features saved.'); reopen('features'); });
        }));
        panes.features = pane;
      })();

      // ---- Entitlements
      (function () {
        var pane = el('div');
        pane.appendChild(el('p', { class: 'pc-dim', text: 'What the product actually enforces for subscribers of this plan. A key that is left unset falls back to the platform default (usually none/off). Changes apply to current subscribers at once.' }));
        var current = {}; d.entitlements.forEach(function (e) { current[e.key] = e; });
        var known = {}; opt.entitlementCatalog.forEach(function (c) { known[c.key] = c; });
        var custom = d.entitlements.filter(function (e) { return !known[e.key]; }).map(function (e) { return { key: e.key, type: e.value_type }; });
        var inputs = {};
        var groups = {};
        opt.entitlementCatalog.forEach(function (c) { (groups[c.group] = groups[c.group] || []).push(c); });
        function rowFor(c) {
          var cur = current[c.key];
          var use = el('input', { type: 'checkbox', checked: !!cur, 'aria-label': 'Set ' + c.key });
          var val;
          if (c.type === 'boolean') { val = el('select', null, [el('option', { value: 'true', text: 'On' }), el('option', { value: 'false', text: 'Off' })]); val.value = cur ? String(cur.value === 'true' || cur.value === '1') : 'true'; }
          else if (c.options) { val = el('select', null, c.options.map(function (o) { return el('option', { value: o, text: o }); })); val.value = cur ? cur.value : c.options[0]; }
          else if (c.type === 'number') { val = el('input', { type: 'number', min: '0', step: '1', value: cur ? cur.value : '' }); }
          else { val = el('input', { value: cur ? cur.value : '', maxlength: '200' }); }
          val.disabled = !use.checked;
          use.addEventListener('change', function () { val.disabled = !use.checked; });
          inputs[c.key] = { use: use, val: val, type: c.type };
          return el('div', { class: 'pc-ent' }, el('label', { class: 'pc-check' }, use, el('span', null, el('strong', { text: c.label }), el('span', { class: 'pc-dim', text: ' ' + c.key }))), val);
        }
        Object.keys(groups).forEach(function (g) { pane.appendChild(el('h3', { text: g })); groups[g].forEach(function (c) { pane.appendChild(rowFor(c)); }); });
        pane.appendChild(el('h3', { text: 'Custom keys' }));
        var customBox = el('div');
        custom.forEach(function (c) { customBox.appendChild(rowFor({ key: c.key, label: c.key, type: c.type })); });
        pane.appendChild(customBox);
        var ck = el('input', { placeholder: 'feature.name', 'aria-label': 'Custom key' });
        var ct = el('select', null, ['boolean', 'number', 'text'].map(function (x) { return el('option', { value: x, text: x }); }));
        var ca = el('button', { type: 'button', class: 'btn btn-secondary', text: 'Add custom key' });
        ca.addEventListener('click', function () { var k = ck.value.trim(); if (!/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/.test(k)) return toast(errText('invalid_key'), 'err'); if (inputs[k]) return toast(errText('duplicate_key'), 'err'); var r = rowFor({ key: k, label: k, type: ct.value }); customBox.appendChild(r); inputs[k].use.checked = true; inputs[k].val.disabled = false; ck.value = ''; });
        pane.appendChild(el('div', { class: 'pc-row pc-addrow' }, ck, ct, ca));
        pane.appendChild(saveBar('Save entitlements', function () {
          var out = [];
          Object.keys(inputs).forEach(function (k) { var i = inputs[k]; if (i.use.checked) out.push({ key: k, valueType: i.type, value: i.val.value }); });
          return api('POST', '/plan-catalog/' + encodeURIComponent(plan.id) + '/entitlements', { entitlements: out }).then(function (r) { if (!r.success) return toast(errText(r.error) + (r.key ? ' (' + r.key + ')' : ''), 'err'); toast('Entitlements saved.'); reopen('entitlements'); });
        }));
        panes.entitlements = pane;
      })();

      // ---- Labels
      (function () {
        var pane = el('div');
        pane.appendChild(el('p', { class: 'pc-dim', text: 'Pick up to 8. Labels show as chips on the pricing card.' }));
        var chosen = {}; d.labels.forEach(function (l) { chosen[l.id] = true; });
        var wrap = el('div', { class: 'pc-chips' });
        function draw() {
          wrap.textContent = '';
          opt.labels.forEach(function (l) {
            var cb = el('input', { type: 'checkbox', checked: !!chosen[l.id] });
            cb.addEventListener('change', function () { if (cb.checked) chosen[l.id] = true; else delete chosen[l.id]; });
            wrap.appendChild(el('label', { class: 'pc-pick pc-chip-' + l.color }, cb, l.name));
          });
          if (!opt.labels.length) wrap.appendChild(el('p', { class: 'pc-dim', text: 'No labels yet. Add one below.' }));
        }
        draw(); pane.appendChild(wrap);
        var nn = el('input', { placeholder: 'Create a new label', maxlength: '30', 'aria-label': 'New label name' });
        var nc = colorSelect(opt, 'blue');
        var na = el('button', { type: 'button', class: 'btn btn-secondary', text: 'Create and select' });
        na.addEventListener('click', function () { api('POST', '/plan-labels', { name: nn.value, color: nc.value }).then(function (r) { if (!r.success) return toast(errText(r.error), 'err'); chosen[r.labelId] = true; nn.value = ''; loadOptions(true).then(function (o) { opt = o; draw(); }); }); });
        pane.appendChild(el('div', { class: 'pc-row pc-addrow' }, nn, nc, na));
        pane.appendChild(saveBar('Save labels', function () {
          return api('POST', '/plan-catalog/' + encodeURIComponent(plan.id) + '/labels', { labelIds: Object.keys(chosen) }).then(function (r) { if (!r.success) return toast(errText(r.error), 'err'); toast('Labels saved.'); reopen('labels'); });
        }));
        panes.labels = pane;
      })();

      // ---- Promotions
      (function () {
        var pane = el('div');
        pane.appendChild(el('p', { class: 'pc-dim', text: 'A promotion is a time-boxed banner on the plan. It never changes what is charged: link a coupon (Coupons page) and the pricing page tells visitors which code to enter.' }));
        var list = el('div', { class: 'pc-list' });
        function state(p) {
          var now = new Date().toISOString().replace('T', ' ').slice(0, 19);
          if (p.status === 'paused') return 'paused';
          if (p.starts_at && p.starts_at > now) return 'scheduled';
          if (p.ends_at && p.ends_at <= now) return 'ended';
          return 'live';
        }
        d.promotions.forEach(function (p) {
          var st = state(p);
          var tog = el('button', { type: 'button', class: 'btn btn-secondary btn-small', text: p.status === 'active' ? 'Pause' : 'Resume' });
          var del = el('button', { type: 'button', class: 'btn btn-secondary btn-small', text: 'Delete' });
          tog.addEventListener('click', function () { api('POST', '/plan-catalog/promotions/' + encodeURIComponent(p.id), { status: p.status === 'active' ? 'paused' : 'active' }).then(function (r) { if (r.success) reopen('promotions'); else toast(errText(r.error), 'err'); }); });
          del.addEventListener('click', function () { confirmBox('Delete promotion?', 'Remove "' + p.name + '" from this plan.', 'Delete', true).then(function (ok) { if (ok) api('POST', '/plan-catalog/promotions/' + encodeURIComponent(p.id) + '/delete', {}).then(function (r) { if (r.success) reopen('promotions'); else toast(errText(r.error), 'err'); }); }); });
          list.appendChild(el('div', { class: 'pc-row' }, el('span', { class: 'pc-badge pc-badge-' + (st === 'live' ? 'active' : st === 'scheduled' ? 'draft' : 'retired'), text: st }),
            el('span', null, el('strong', { text: p.name }), el('span', { class: 'pc-dim', text: ' “' + p.badge_text + '”' + (p.coupon_code ? ' · code ' + p.coupon_code : '') + (p.ends_at ? ' · ends ' + p.ends_at + ' UTC' : '') })), tog, del));
        });
        if (!d.promotions.length) list.appendChild(el('p', { class: 'pc-dim', text: 'No promotions on this plan.' }));
        pane.appendChild(list);
        pane.appendChild(el('h3', { text: 'New promotion' }));
        var nm = el('input', { maxlength: '60', placeholder: 'Internal name, e.g. Black Friday 2026' });
        var bt = el('input', { maxlength: '40', placeholder: 'Shown to visitors, e.g. 20% off year one' });
        var cp = el('select', null, [el('option', { value: '', text: 'No coupon (announcement only)' })].concat(opt.coupons.map(function (c) { return el('option', { value: c.id, text: c.code + ' · ' + (c.percent_off != null ? c.percent_off + '% off' : money(c.amount_off_cents, plan.currency) + ' off') + (c.status !== 'active' ? ' (' + c.status + ')' : '') }); })));
        var s = el('input', { type: 'datetime-local' }); var en = el('input', { type: 'datetime-local' });
        pane.appendChild(el('div', { class: 'pc-grid2' }, field('Name', nm), field('Banner text', bt), field('Coupon', cp, 'The code is shown to visitors. Disabled or expired coupons hide the banner automatically.'), field('Starts (UTC, optional)', s), field('Ends (UTC, optional)', en)));
        pane.appendChild(saveBar('Add promotion', function () {
          return api('POST', '/plan-catalog/' + encodeURIComponent(plan.id) + '/promotions', { name: nm.value, badgeText: bt.value, couponId: cp.value || null, startsAt: localToSql(s.value), endsAt: localToSql(en.value) }).then(function (r) { if (!r.success) return toast(errText(r.error), 'err'); toast('Promotion added.'); reopen('promotions'); });
        }));
        panes.promotions = pane;
      })();

      // ---- SEO
      (function () {
        var pane = el('div');
        var t = el('input', { value: plan.seo_title || '', maxlength: '70', placeholder: plan.name });
        var ds = el('textarea', { rows: '3', maxlength: '170' }); ds.value = plan.seo_description || '';
        var tc = el('span', { class: 'pc-count' }), dc = el('span', { class: 'pc-count' });
        var pv = el('div', { class: 'pc-serp' });
        function upd() {
          tc.textContent = t.value.length + '/60 recommended'; tc.className = 'pc-count' + (t.value.length > 60 ? ' pc-over' : '');
          dc.textContent = ds.value.length + '/160 recommended'; dc.className = 'pc-count' + (ds.value.length > 160 ? ' pc-over' : '');
          pv.textContent = '';
          pv.appendChild(el('div', { class: 'pc-serp-url', text: location.host + ' › pricing' }));
          pv.appendChild(el('div', { class: 'pc-serp-title', text: (t.value || plan.name) + ' – Pricing' }));
          pv.appendChild(el('div', { class: 'pc-serp-desc', text: ds.value || plan.tagline || 'Add a description so search engines and AI answers describe this plan accurately.' }));
        }
        t.addEventListener('input', upd); ds.addEventListener('input', upd); upd();
        pane.appendChild(el('p', { class: 'pc-dim', text: 'Used for the plan’s structured data (Offer description) on the pricing page that search engines read, and shown here as a preview. Keep the description factual: it must match what the plan actually includes.' }));
        pane.appendChild(field('SEO title', t)); pane.appendChild(tc);
        pane.appendChild(field('SEO description', ds)); pane.appendChild(dc);
        pane.appendChild(el('h3', { text: 'Search preview' })); pane.appendChild(pv);
        pane.appendChild(saveBar('Save SEO', function () {
          return api('POST', '/plan-catalog/' + encodeURIComponent(plan.id), { seoTitle: t.value, seoDescription: ds.value }).then(function (r) { if (!r.success) return toast(errText(r.error), 'err'); toast('SEO saved.'); reopen('seo'); });
        }));
        panes.seo = pane;
      })();

      // ---- footer lifecycle actions
      var pub = plan.status === 'active';
      var primary = el('button', { type: 'button', class: 'btn', text: pub ? 'Unpublish' : plan.status === 'retired' ? 'Restore as draft' : 'Publish' });
      primary.addEventListener('click', function () {
        if (pub) planAction(plan.id, 'unpublish', ['Unpublish ' + plan.name + '?', 'It returns to draft and disappears from the pricing page and new checkouts.' + (plan.live_subscriptions ? ' ' + plan.live_subscriptions + ' live subscription(s) are not affected.' : ''), 'Unpublish', false]);
        else if (plan.status === 'retired') planAction(plan.id, 'restore');
        else planAction(plan.id, 'publish');
      });
      var dup = el('button', { type: 'button', class: 'btn btn-secondary', text: 'Duplicate' });
      dup.addEventListener('click', function () { planAction(plan.id, 'duplicate'); });
      foot.appendChild(primary); foot.appendChild(dup);
      if (plan.status !== 'retired') {
        var ret = el('button', { type: 'button', class: 'btn btn-secondary', text: 'Retire' });
        ret.addEventListener('click', function () { planAction(plan.id, 'archive', ['Retire ' + plan.name + '?', 'No new sales.' + (plan.live_subscriptions ? ' ' + plan.live_subscriptions + ' live subscription(s) keep the plan.' : ''), 'Retire', false]); });
        foot.appendChild(ret);
      }
      var rm = el('button', { type: 'button', class: 'btn btn-danger pc-push', text: 'Delete' });
      rm.addEventListener('click', function () { planAction(plan.id, 'delete', ['Delete ' + plan.name + '?', 'Permanently removes the plan. Only possible if it never had a price or a subscriber.', 'Delete plan', true]); });
      foot.appendChild(rm);
    } else {
      TABS.slice(1).forEach(function (t) { panes[t[0]] = needsPlan(); });
      foot.appendChild(el('span', { class: 'pc-dim', text: 'Create the draft first; then price, features, labels, promotions and SEO unlock.' }));
    }
    show(startTab && panes[startTab] ? startTab : 'details');
  }

  // open the editor from a deep link: ?edit=<plan id> or ?new=1
  var qs = new URLSearchParams(location.search);
  if (qs.get('edit')) openEditor(qs.get('edit'));
  else if (qs.get('new')) openEditor(null);

  // keyboard: "/" focuses search
  document.addEventListener('keydown', function (e) {
    if (e.key === '/' && !/INPUT|TEXTAREA|SELECT/.test((document.activeElement || {}).tagName || '') && !openModals.length && !drawer) { var s = document.getElementById('pc-q'); if (s) { e.preventDefault(); s.focus(); } }
  });
})();
`;
