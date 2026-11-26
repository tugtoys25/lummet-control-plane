// Browser-side editor for an advertisement's slider (settings + slides), shown on /cms/advertisements/:id/edit.
//
// Shipped as one string inside a <script nonce> the Worker writes. Rules it follows (see worker/csp.js):
//   * no inline event handlers: addEventListener only;
//   * nothing from the server is parsed as HTML except the preview, which is our own escaped markup read through DOMParser
//     (scripts in it never run) and contains no script;
//   * no template literals and no dollar-brace sequences, so this file can be embedded without escaping.
export const AD_SLIDER_CLIENT = String.raw`
(function () {
  'use strict';
  var data = JSON.parse(document.getElementById('adSliderData').textContent);
  var root = document.getElementById('adSliderEditor');
  var state = { settings: data.settings, slides: data.slides };
  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === 'text') n.textContent = attrs[k]; else if (k === 'class') n.className = attrs[k]; else if (attrs[k] !== false && attrs[k] !== null && attrs[k] !== undefined) n.setAttribute(k, attrs[k] === true ? '' : attrs[k]);
    });
    (kids || []).forEach(function (c) { if (c) n.appendChild(c); });
    return n;
  }
  var status = document.getElementById('adSliderStatus');
  function say(msg, bad, list) {
    status.textContent = ''; status.className = 'flash ' + (bad ? 'flash-error' : 'flash-success'); status.hidden = false;
    status.appendChild(el('strong', { text: msg }));
    if (list && list.length) { var ul = el('ul', {}); list.forEach(function (m) { ul.appendChild(el('li', { text: m })); }); status.appendChild(ul); }
  }
  function field(label, input, hint) { return el('label', { class: 'adx-f' }, [el('span', { text: label }), input, hint ? el('small', { text: hint }) : null]); }
  function text(obj, key, max, ph) {
    var i = el('input', { type: 'text', maxlength: max || 200, placeholder: ph || '' }); i.value = obj[key] || '';
    i.addEventListener('input', function () { if (i.value) obj[key] = i.value; else delete obj[key]; }); return i;
  }
  function number(obj, key, min, max, step) {
    var i = el('input', { type: 'number', min: min, max: max, step: step || 1 }); i.value = obj[key] === undefined ? '' : obj[key];
    i.addEventListener('input', function () { if (i.value === '') delete obj[key]; else obj[key] = Number(i.value); }); return i;
  }
  function check(obj, key, label) {
    var i = el('input', { type: 'checkbox' }); i.checked = !!obj[key];
    i.addEventListener('change', function () { if (i.checked) obj[key] = true; else if (key in data.defaults) obj[key] = false; else delete obj[key]; });
    return el('label', { class: 'adx-c' }, [i, el('span', { text: label })]);
  }
  function select(obj, key, list, labels) {
    var s = el('select', {}); list.forEach(function (v) { var o = el('option', { value: v, text: (labels && labels[v]) || v }); if ((obj[key] || '') === v) o.selected = true; s.appendChild(o); });
    s.addEventListener('change', function () { if (s.value) obj[key] = s.value; else delete obj[key]; }); return s;
  }
  function when(obj, key) {
    var i = el('input', { type: 'datetime-local' }); i.value = (obj[key] || '').slice(0, 16).replace(' ', 'T');
    i.addEventListener('input', function () { if (i.value) obj[key] = i.value; else delete obj[key]; }); return i;
  }
  function picture(obj, key, label, required) {
    var url = text(obj, key, 2048, '/brand-media/… or https://…');
    var file = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', 'aria-label': 'Upload ' + label });
    var note = el('small', { text: '' });
    file.addEventListener('change', function () {
      if (!file.files || !file.files[0]) return;
      var fd = new FormData(); fd.append('file', file.files[0]); note.textContent = 'Uploading…';
      fetch('/cms/advertisements/image', { method: 'POST', body: fd }).then(function (r) { return r.json(); }).then(function (d) {
        if (d && d.success) { url.value = d.url; obj[key] = d.url; note.textContent = 'Uploaded (' + d.width + ' × ' + d.height + ').'; }
        else note.textContent = 'Could not upload: ' + ((d && d.error) || 'unknown error');
      }).catch(function () { note.textContent = 'Could not upload: network error'; });
    });
    return el('div', { class: 'adx-f' }, [el('span', { text: label + (required ? ' (required)' : '') }), el('div', { class: 'adx-pic' }, [url, data.mediaOk ? file : null]), note]);
  }
  function newKey() { return 's' + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36); }
  function fig(s) { var f = data.stats.slides[s.key]; if (!f) return ''; return f.views + ' views · ' + f.clicks + ' clicks · ' + (f.views ? Math.round(f.clicks / f.views * 1000) / 10 : 0) + '% CTR'; }

  function slideCard(s, i) {
    var d = el('details', { class: 'adx-slide' }); if (!s.image || state.slides.length < 3) d.open = true;
    var thumb = el('img', { class: 'adx-thumb', alt: '', width: 64, height: 36 }); if (s.image) thumb.src = s.image; else thumb.hidden = true;
    d.appendChild(el('summary', {}, [thumb, el('span', { text: 'Slide ' + (i + 1) + (s.title ? ' — ' + s.title : '') }), el('span', { class: 'adx-fig', text: fig(s) })]));
    var swap = function (to) { if (to < 0 || to >= state.slides.length) return; state.slides.splice(to, 0, state.slides.splice(i, 1)[0]); draw(); };
    var btn = function (label, fn, cls) { var b = el('button', { type: 'button', class: 'btn btn-secondary ' + (cls || ''), text: label }); b.addEventListener('click', fn); return b; };
    d.appendChild(el('div', { class: 'adx-body' }, [
      picture(s, 'image', 'Picture', true), picture(s, 'image_mobile', 'Picture for phones (optional, for example a square or 4:3 crop)'),
      field('Picture description for screen readers (alt text)', text(s, 'alt', 160)),
      field('Headline (optional)', text(s, 'title', 120)), field('Short text under the headline (optional)', text(s, 'subtitle', 200)), field('Badge, e.g. NEW (optional)', text(s, 'badge', 30)),
      field('Link when clicked (/path, https:// or mailto:)', text(s, 'url', 2048), 'Every slide with a link is clickable as a whole.'),
      field('Button text (optional)', text(s, 'cta_label', 40)), check(s, 'new_tab', 'Open the link in a new tab'), check(s, 'sponsored', 'Mark an internal link as paid too (external links always carry rel="sponsored")'),
      field('Text position', select(s, 'text_pos', data.choices.text_pos, { left: 'Left', center: 'Centre', right: 'Right' })),
      field('Seconds on screen (empty = slider default)', number(s, 'duration', 2, 60)),
      field('Show from (UTC, empty = now)', when(s, 'start_at')), field('Show until (UTC, empty = no end)', when(s, 'end_at')),
      el('div', { class: 'adx-tools' }, [btn('↑ Up', function () { swap(i - 1); }), btn('↓ Down', function () { swap(i + 1); }),
        btn('Duplicate', function () { if (state.slides.length >= data.limits.maxSlides) { say('A slider holds at most ' + data.limits.maxSlides + ' slides.', true); return; } var c = JSON.parse(JSON.stringify(s)); c.key = newKey(); state.slides.splice(i + 1, 0, c); draw(); }),
        btn('Remove', function () { state.slides.splice(i, 1); draw(); }, 'adx-danger')])
    ]));
    return d;
  }
  function settingsForm() {
    var s = state.settings, c = data.choices, L = {
      transition: { fade: 'Fade', slide: 'Slide', zoom: 'Zoom and fade', kenburns: 'Fade with slow zoom (Ken Burns)' }, fit: { cover: 'Fill the frame (crops edges)', contain: 'Show the whole picture' },
      overlay: { soft: 'Soft', strong: 'Strong', none: 'None' }, nav: { dots: 'Dots', bars: 'Bars', none: 'Hidden' }, mobile_ratio: { same: 'Same as desktop' }
    };
    return el('div', { class: 'adx-grid' }, [
      check(s, 'autoplay', 'Rotate automatically'), field('Seconds per slide (a slide can override this)', number(s, 'interval', 2, 30)),
      field('Animation', select(s, 'transition', c.transition, L.transition)), field('Animation length (milliseconds)', number(s, 'speed', 200, 2000, 50)),
      field('Shape on desktop and tablet (width : height)', select(s, 'ratio', c.ratio)), field('Shape on phones', select(s, 'mobile_ratio', c.mobile_ratio, L.mobile_ratio)),
      field('Picture fit', select(s, 'fit', c.fit, L.fit)), field('Shade behind text', select(s, 'overlay', c.overlay, L.overlay)),
      check(s, 'arrows', 'Previous / next arrows'), field('Slide indicators', select(s, 'nav', c.nav, L.nav)),
      check(s, 'progress', 'Progress bar'), check(s, 'counter', 'Slide counter (1 / 5)'), check(s, 'pause_hover', 'Pause while the mouse is over it'), check(s, 'loop', 'Loop back to the first slide'),
      check(s, 'swipe', 'Swipe on touch screens'), check(s, 'keyboard', 'Arrow keys work when focused'),
      check(s, 'ad_label', 'Show an advertising label on every slide'), field('Label text', text(s, 'ad_text', 12))
    ]);
  }
  var slidesBox = document.getElementById('adSliderSlides');
  function draw() {
    slidesBox.textContent = '';
    state.slides.forEach(function (s, i) { slidesBox.appendChild(slideCard(s, i)); });
    if (!state.slides.length) slidesBox.appendChild(el('p', { class: 'adx-empty', text: 'No slides yet. Until you add one, this advertisement shows its own picture and link (from the form above) as a single banner.' }));
  }
  document.getElementById('adSliderSettings').appendChild(settingsForm());
  draw();
  document.getElementById('adSliderAdd').addEventListener('click', function () {
    if (state.slides.length >= data.limits.maxSlides) { say('A slider holds at most ' + data.limits.maxSlides + ' slides.', true); return; }
    state.slides.push({ key: newKey() }); draw();
  });

  function send(path, then) {
    fetch('/cms/advertisements/' + data.adId + '/' + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ settings: state.settings, slides: state.slides }) })
      .then(function (r) { return r.json().then(function (j) { return { status: r.status, body: j }; }); }).then(then)
      .catch(function () { say('Network error. Nothing was saved.', true); });
  }
  document.getElementById('adSliderSave').addEventListener('click', function () {
    send('slider', function (r) {
      if (r.body && r.body.success) say('Saved. The homepage shows the new slider within a minute.', false);
      else say('Not saved.', true, (r.body && r.body.errors) || [(r.body && r.body.error) || 'Unknown error']);
    });
  });
  document.getElementById('adSliderPreview').addEventListener('click', function () {
    send('slider-preview', function (r) {
      var box = document.getElementById('adSliderPreviewBox'); box.textContent = '';
      if (!(r.body && r.body.success)) { say('Preview not available.', true, (r.body && r.body.errors) || [(r.body && r.body.error) || 'Unknown error']); return; }
      if (!r.body.html) { box.appendChild(el('p', { class: 'adx-empty', text: 'Nothing to show yet: add a slide with a picture.' })); return; }
      var doc = new DOMParser().parseFromString(r.body.html, 'text/html');
      Array.prototype.slice.call(doc.body.childNodes).forEach(function (n) { box.appendChild(document.importNode(n, true)); });
      status.hidden = true;
    });
  });
})();
`;
