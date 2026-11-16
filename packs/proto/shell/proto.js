(function () {
  'use strict';
  var body = document.getElementById('proto-body');
  var data = JSON.parse(document.getElementById('proto-data').textContent);
  var outline = data.outline || {};
  var sections = document.querySelectorAll('section.pg');
  var bySlug = Object.create(null);
  var byTitle = Object.create(null);
  var history = [];
  var toastTimer = null;
  var j;

  for (j = 0; j < sections.length; j++) {
    var slug = sections[j].getAttribute('data-slug') || '';
    var title = sections[j].getAttribute('data-title') || '';
    bySlug[slug] = sections[j];
    if (title && !byTitle[title]) byTitle[title] = sections[j];
  }

  function post(type, extra) {
    var m = { type: type };
    for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) m[k] = extra[k];
    window.parent.postMessage(m, '*');
  }

  var current = '';
  function setActiveNav() {
    var items = document.querySelectorAll('.nav-item');
    for (var i = 0; i < items.length; i++) {
      if (items[i].getAttribute('data-goto') === current) items[i].classList.add('on');
      else items[i].classList.remove('on');
    }
  }

  function show(section, slug, announce) {
    for (var i = 0; i < sections.length; i++) sections[i].classList.add('hidden');
    var missing = document.getElementById('proto-missing');
    if (missing) missing.classList.add('hidden');
    if (section) {
      section.classList.remove('hidden');
      current = section.getAttribute('data-slug') || slug || '';
    } else {
      if (!missing) {
        missing = document.createElement('div');
        missing.setAttribute('id', 'proto-missing');
        missing.setAttribute('class', 'empty');
        var a = document.createElement('div');
        a.textContent = '这一页还没有设计';
        missing.appendChild(a);
        var b = document.createElement('div');
        b.textContent = '可以在对话里让它补上';
        missing.appendChild(b);
        body.appendChild(missing);
      }
      missing.classList.remove('hidden');
      current = slug || '';
    }
    location.hash = '#/' + current;
    var titleEl = document.getElementById('proto-title');
    if (titleEl) titleEl.textContent = section ? (section.getAttribute('data-title') || '') : '未设计';
    setActiveNav();
    if (announce) post('proto:page', { slug: current });
  }

  function go(slug, push) {
    if (slug == null || slug === '') return;
    var target = bySlug[slug] || byTitle[slug] || null;
    show(target, String(slug), true);
    if (push !== false) history.push(current);
  }

  function goBack() {
    if (history.length > 1) history.pop();
    var prev = history.length ? history[history.length - 1] : (sections[0] ? sections[0].getAttribute('data-slug') : '');
    go(prev, false);
  }

  function toast(text) {
    var el = document.getElementById('proto-toast');
    if (!el) return;
    el.textContent = text || '';
    el.classList.add('on');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('on'); }, 2000);
  }

  function setTab(value) {
    if (typeof value !== 'string' || value.indexOf(':') < 0) return;
    var group = value.slice(0, value.indexOf(':')) + ':';
    var tabs = document.querySelectorAll('.tab');
    for (var i = 0; i < tabs.length; i++) {
      var v = tabs[i].getAttribute('data-tab') || '';
      if (v.indexOf(group) === 0) {
        if (v === value) tabs[i].classList.add('on');
        else tabs[i].classList.remove('on');
      }
    }
    var panels = document.querySelectorAll('.tab-panel');
    for (var k = 0; k < panels.length; k++) {
      if ((panels[k].getAttribute('data-tab-panel') || '') === value) panels[k].classList.add('on');
      else panels[k].classList.remove('on');
    }
  }

  function buildHeader() {
    var h = document.getElementById('proto-header');
    if (!h) return;
    h.textContent = '';
    var back = document.createElement('button');
    back.setAttribute('class', 'back');
    back.setAttribute('data-back', '');
    back.textContent = '返回';
    h.appendChild(back);
    var title = document.createElement('span');
    title.setAttribute('id', 'proto-title');
    title.setAttribute('class', 'title');
    h.appendChild(title);
  }

  function buildNav() {
    var nav = document.getElementById('proto-nav');
    if (!nav) return;
    nav.textContent = '';
    var names = outline.nav || [];
    for (var i = 0; i < names.length && i < 5; i++) {
      var slug = names[i];
      if (!bySlug[slug]) continue;
      var b = document.createElement('button');
      b.setAttribute('class', 'nav-item');
      b.setAttribute('data-goto', slug);
      b.textContent = bySlug[slug].getAttribute('data-title') || slug;
      nav.appendChild(b);
    }
    setActiveNav();
  }

  function buildNotes() {
    var pages = outline.pages || [];
    for (var i = 0; i < sections.length; i++) {
      var slug = sections[i].getAttribute('data-slug');
      var meta = null;
      for (var k = 0; k < pages.length; k++) if (pages[k] && pages[k].slug === slug) { meta = pages[k]; break; }
      if (!meta) continue;
      var card = document.createElement('div');
      card.setAttribute('class', 'note-card');
      card.textContent = (meta.purpose || '') + '\n' + (meta.content || '');
      var slot = document.getElementById('proto-note-' + slug);
      if (slot) slot.appendChild(card);
      else sections[i].appendChild(card);
    }
    var map = document.createElement('div');
    map.setAttribute('id', 'proto-map');
    map.setAttribute('class', 'map');
    var heading = document.createElement('h4');
    heading.textContent = '页面地图';
    map.appendChild(heading);
    for (var m = 0; m < sections.length; m++) {
      var item = document.createElement('div');
      item.setAttribute('class', 'map-item');
      var label = document.createElement('span');
      label.textContent = sections[m].getAttribute('data-title') || '';
      item.appendChild(label);
      var links = sections[m].querySelectorAll('[data-goto]');
      for (var n = 0; n < links.length; n++) {
        var to = links[n].getAttribute('data-goto') || '';
        var btn = document.createElement('button');
        btn.textContent = ' → ' + to;
        if (bySlug[to] || byTitle[to]) btn.setAttribute('data-goto', to);
        else btn.setAttribute('class', 'bad');
        item.appendChild(btn);
      }
      map.appendChild(item);
    }
    body.appendChild(map);
  }

  function setNotes(on, embedded) {
    if (on) body.classList.add('notes');
    else body.classList.remove('notes');
    if (embedded) body.classList.add('embedded');
  }

  function setDevice(device) {
    if (device !== 'phone' && device !== 'desktop') return;
    if (device === 'phone') { body.classList.add('phone'); body.classList.remove('desktop'); }
    else { body.classList.add('desktop'); body.classList.remove('phone'); }
    buildNav();
  }

  body.addEventListener('click', function (e) {
    var t = e.target;
    if (!t || !t.closest) return;
    var noteBtn = t.closest('[id="proto-notes-toggle"]');
    if (noteBtn) { setNotes(!body.classList.contains('notes'), false); return; }
    var toastEl = t.closest('[data-toast]');
    if (toastEl) toast(toastEl.getAttribute('data-toast'));
    var gotoEl = t.closest('[data-goto]');
    if (gotoEl) { go(gotoEl.getAttribute('data-goto'), true); return; }
    var backEl = t.closest('[data-back]');
    if (backEl) { goBack(); return; }
    var openEl = t.closest('[data-open]');
    if (openEl) {
      var panel = document.getElementById(openEl.getAttribute('data-open') || '');
      if (panel) panel.classList.add('open');
      return;
    }
    var closeEl = t.closest('[data-close]');
    if (closeEl) {
      var box = closeEl.closest('.sheet, .dialog');
      if (box) box.classList.remove('open');
      return;
    }
    var tabEl = t.closest('[data-tab]');
    if (tabEl) { setTab(tabEl.getAttribute('data-tab')); return; }
    var toggleEl = t.closest('[data-toggle]');
    if (toggleEl) toggleEl.classList.toggle('on');
  });

  body.addEventListener('submit', function (e) {
    if (e.preventDefault) e.preventDefault();
    var f = e.target;
    var msg = f.getAttribute && f.getAttribute('data-toast');
    if (msg) toast(msg);
    var slug = f.getAttribute && f.getAttribute('data-goto');
    if (slug) go(slug, true);
  });

  window.addEventListener('message', function (e) {
    if (!e || e.source !== window.parent) return;
    var m = e.data || {};
    if (m.type === 'proto:goto') go(m.slug, true);
    else if (m.type === 'proto:device') setDevice(m.device);
    else if (m.type === 'proto:notes') setNotes(!!m.on, true);
  });

  buildHeader();
  buildNav();
  buildNotes();
  var want = (location.hash || '').indexOf('#/') === 0 ? location.hash.slice(2) : '';
  var first = sections.length ? sections[0] : null;
  var target = (bySlug[want] || byTitle[want]) || first;
  if (target) history.push(target.getAttribute('data-slug') || '');
  show(target, want, false);
  var ready = [];
  for (j = 0; j < sections.length; j++) ready.push(sections[j].getAttribute('data-slug'));
  post('proto:ready', { pages: ready });
})();
