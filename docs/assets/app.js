/* Klemmenov — app.js
   Reveal on scroll, mobile menu, lightbox, ready-message buttons (copy + language). No dependencies. */
(function () {
  var root = document.documentElement;
  var $ = function (s, c) { return (c || document).querySelector(s); };
  var $$ = function (s, c) { return Array.prototype.slice.call((c || document).querySelectorAll(s)); };
  var ru = root.lang === 'ru';

  // entrance: hero frames
  requestAnimationFrame(function () { requestAnimationFrame(function () { root.classList.add('ready'); }); });

  // reveal: plain scroll check (no IntersectionObserver, so it also works in throttled/hidden tabs)
  var targets = $$('.rv, .masonry a, .pf-lead a, .pf-grid a');
  targets.forEach(function (t, i) { if (t.matches('.masonry a, .pf-lead a, .pf-grid a')) t.style.transitionDelay = ((i % 4) * 70) + 'ms'; });
  var pending = targets.slice();
  function reveal() {
    var vh = window.innerHeight || 800;
    pending = pending.filter(function (t) {
      var r = t.getBoundingClientRect();
      if (r.top < vh * 0.94) { t.classList.add('in'); return false; }
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
    var setMenu = function (open) { root.classList.toggle('menu-open', open); burger.setAttribute('aria-expanded', open); };
    burger.addEventListener('click', function () { setMenu(!root.classList.contains('menu-open')); });
    $$('.bar ul a').forEach(function (a) { a.addEventListener('click', function () { setMenu(false); }); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && root.classList.contains('menu-open')) { setMenu(false); burger.focus(); } });
  }

  // lightbox
  var items = $$('.masonry a, .pf-lead a, .pf-grid a');
  if (items.length) {
    var T = ru ? { v: 'Просмотр фото', x: 'Закрыть', p: 'Назад', n: 'Вперёд' } : { v: 'Photo viewer', x: 'Close', p: 'Previous', n: 'Next' };
    var lb = document.createElement('div');
    lb.className = 'lb'; lb.setAttribute('role', 'dialog'); lb.setAttribute('aria-modal', 'true'); lb.setAttribute('aria-label', T.v);
    lb.innerHTML = '<button class="x" aria-label="' + T.x + '">✕</button><button class="p" aria-label="' + T.p + '">←</button><button class="n" aria-label="' + T.n + '">→</button><img alt=""><div class="c" aria-live="polite"></div>';
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
      else if (e.key === 'Tab') {
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

  // ready messages: Telegram and Instagram cannot pre-fill text, so the text is copied on tap and the chat opens
  var status = $('[data-msg-status]');
  var copyText = function (text) {
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text);
    return Promise.reject(new Error('no clipboard'));
  };
  window.klemCopy = copyText;
  $$('[data-copy]').forEach(function (el) {
    el.addEventListener('click', function () {
      var ok = ru ? 'Текст скопирован. Вставьте его в чат.' : 'Text copied. Paste it in the chat.';
      var bad = ru ? 'Выделите текст выше и скопируйте его.' : 'Select the text above and copy it.';
      copyText(el.getAttribute('data-copy')).then(function () { if (status) status.textContent = ok; }, function () { if (status) status.textContent = bad; });
    });
  });
  // EN / RU switch of the ready messages (both stay visible without JS)
  $$('.msg-card').forEach(function (card) {
    var btns = $$('.langsw button', card), blocks = $$('.msg', card);
    var pick = function (lg) {
      btns.forEach(function (b) { b.setAttribute('aria-pressed', b.getAttribute('data-lang') === lg); });
      blocks.forEach(function (m) { m.hidden = m.getAttribute('data-msg') !== lg; });
    };
    btns.forEach(function (b) { b.addEventListener('click', function () { pick(b.getAttribute('data-lang')); }); });
    if (btns.length) pick(ru ? 'ru' : 'en');
  });

  // footer year
  $$('[data-year]').forEach(function (e) { e.textContent = new Date().getFullYear(); });
})();
