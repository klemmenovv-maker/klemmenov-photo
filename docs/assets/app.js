/* Klemmenov — app.js
   Reveal on scroll, hero parallax, mobile menu, lightbox, price calculator. No dependencies. */
(function () {
  var root = document.documentElement;
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var $ = function (s, c) { return (c || document).querySelector(s); };
  var $$ = function (s, c) { return Array.prototype.slice.call((c || document).querySelectorAll(s)); };

  // entrance: hero + name letters
  requestAnimationFrame(function () { requestAnimationFrame(function () { root.classList.add('ready'); }); });
  $$('.name[data-split]').forEach(function (el) {
    var t = el.textContent; el.setAttribute('aria-label', t); el.textContent = '';
    t.split('').forEach(function (ch, k) {
      var s = document.createElement('span'); s.textContent = ch; s.style.setProperty('--k', k); s.setAttribute('aria-hidden', 'true'); el.appendChild(s);
    });
  });

  // reveal: plain scroll check (no IntersectionObserver, so it also works in throttled/hidden tabs)
  var targets = $$('.rv, .masonry a, .pf-lead a, .pf-grid a');
  targets.forEach(function (t, i) { if (t.matches('.masonry a, .pf-lead a, .pf-grid a')) t.style.transitionDelay = ((i % 4) * 70) + 'ms'; });
  var pending = targets.slice();
  function reveal() {
    var vh = window.innerHeight || 800;
    pending = pending.filter(function (t) {
      var r = t.getBoundingClientRect();
      if (r.top < vh * 0.94 && r.bottom > -40) { t.classList.add('in'); return false; }
      return true;
    });
  }
  reveal();
  window.addEventListener('scroll', reveal, { passive: true });
  window.addEventListener('resize', reveal);
  window.addEventListener('load', reveal);
  [200, 700, 1500, 3000].forEach(function (ms) { setTimeout(reveal, ms); });

  // mobile menu
  var burger = $('.burger');
  if (burger) {
    burger.addEventListener('click', function () {
      var open = root.classList.toggle('menu-open'); burger.setAttribute('aria-expanded', open);
    });
    $$('.bar ul a').forEach(function (a) { a.addEventListener('click', function () { root.classList.remove('menu-open'); burger.setAttribute('aria-expanded', false); }); });
  }

  // lightbox
  var items = $$('.masonry a, .pf-lead a, .pf-grid a');
  if (items.length) {
    var lb = document.createElement('div');
    lb.className = 'lb'; lb.setAttribute('role', 'dialog'); lb.setAttribute('aria-modal', 'true'); lb.setAttribute('aria-label', 'Photo viewer');
    lb.innerHTML = '<button class="x" aria-label="Close">✕</button><button class="p" aria-label="Previous">←</button><button class="n" aria-label="Next">→</button><img alt=""><div class="c" aria-live="polite"></div>';
    document.body.appendChild(lb);
    var img = $('img', lb), cap = $('.c', lb), cur = 0, last = null;
    var show = function (i) {
      cur = (i + items.length) % items.length;
      img.src = items[cur].href; img.alt = $('img', items[cur]).alt;
      cap.textContent = (cur + 1) + ' / ' + items.length;
      var nx = new Image(); nx.src = items[(cur + 1) % items.length].href;
    };
    var open = function (i) { last = document.activeElement; show(i); lb.classList.add('open'); document.body.style.overflow = 'hidden'; $('.x', lb).focus(); };
    var close = function () { lb.classList.remove('open'); document.body.style.overflow = ''; if (last) last.focus(); };
    items.forEach(function (a, i) { a.addEventListener('click', function (e) { e.preventDefault(); open(i); }); });
    $('.x', lb).addEventListener('click', close);
    $('.p', lb).addEventListener('click', function () { show(cur - 1); });
    $('.n', lb).addEventListener('click', function () { show(cur + 1); });
    lb.addEventListener('click', function (e) { if (e.target === lb) close(); });
    document.addEventListener('keydown', function (e) {
      if (!lb.classList.contains('open')) return;
      if (e.key === 'Escape') close();
      else if (e.key === 'ArrowLeft') show(cur - 1);
      else if (e.key === 'ArrowRight') show(cur + 1);
      else if (e.key === 'Tab') { // keep focus inside
        var f = $$('button', lb), a = document.activeElement, i = f.indexOf(a);
        e.preventDefault(); f[(i + (e.shiftKey ? -1 : 1) + f.length) % f.length].focus();
      }
    });
    var sx = null;
    lb.addEventListener('pointerdown', function (e) { sx = e.clientX; });
    lb.addEventListener('pointerup', function (e) {
      if (sx === null) return; var d = e.clientX - sx; sx = null;
      if (Math.abs(d) > 50) show(cur + (d < 0 ? 1 : -1));
    });
  }

  // price calculator
  $$('[data-calc]').forEach(function (box) {
    var cfg = JSON.parse(box.getAttribute('data-calc'));
    var svc = cfg.services, wa = cfg.wa, base = cfg.text, c = cfg.c, ru = cfg.lang === 'ru';
    var state = { s: 0, h: svc[0].min };
    var seg = $('.seg', box), out = $('output', box), total = $('.calc-total', box), note = $('.calc-note', box), book = $('.calc-book', box);
    var fmt = function (n) { return n.toLocaleString(cfg.locale).replace(/\u202f/g, '\u00a0'); };
    var hours = function (n) {
      if (!ru) return n + ' ' + (n === 1 ? c.hour1 : c.hourN);
      var m10 = n % 10, m100 = n % 100;
      return n + ' ' + (m10 === 1 && m100 !== 11 ? c.hour1 : (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? c.hourN : c.hourM));
    };
    svc.forEach(function (s, i) {
      var b = document.createElement('button'); b.type = 'button'; b.textContent = s.label; b.setAttribute('aria-pressed', i === 0);
      b.addEventListener('click', function () { state.s = i; state.h = Math.max(state.h, svc[i].min); render(); });
      seg.appendChild(b);
    });
    function render() {
      var s = svc[state.s], sum = s.rate * state.h;
      $$('button', seg).forEach(function (b, i) { b.setAttribute('aria-pressed', i === state.s); });
      out.textContent = hours(state.h);
      total.textContent = fmt(sum) + ' AED';
      note.textContent = fmt(s.rate) + ' ' + c.per + (s.min > 1 ? ', ' + c.min + ' ' + s.min + ' ' + c.min_h : '') + '. ' + s.note;
      var msg = base + ' ' + cfg.shoot + ' ' + s.title + ', ' + out.textContent + ' (' + fmt(sum) + ' AED).';
      book.href = 'https://wa.me/' + wa + '?text=' + encodeURIComponent(msg);
    }
    $('.minus', box).addEventListener('click', function () { state.h = Math.max(svc[state.s].min, state.h - 1); render(); });
    $('.plus', box).addEventListener('click', function () { state.h = Math.min(12, state.h + 1); render(); });
    render();
  });

  // mobile book bar: tuck away while the footer is on screen (without JS it simply stays)
  var bar = $('.bookbar'), foot = $('footer');
  if (bar && foot && 'IntersectionObserver' in window) {
    new IntersectionObserver(function (en) { bar.classList.toggle('away', en[0].isIntersecting); }).observe(foot);
  }

  // footer year
  $$('[data-year]').forEach(function (e) { e.textContent = new Date().getFullYear(); });
})();
