document.documentElement.classList.remove('no-js');
/* Поведение страницы, ТЗ 10.1. ES2020, без библиотек. */
(() => {
  'use strict';

  // Строки интерфейса только из ТЗ 7.3.
  const TXT = {
    expand: 'Развернуть всё',
    collapse: 'Свернуть детали',
    hint: 'Таблица шире экрана, листайте вбок →',
  };
  const WIDE_QUERY = '(min-width: 1280px)';
  const TOC_ROOT_MARGIN = '-20% 0px -70% 0px';
  const CURRENT_LINE = 0.3;
  const RESIZE_DELAY = 150;
  const SCROLL_SETTLE = 120;
  const HEADER_GAP = 12;
  const WIDE_GAP = 24;
  const LIST_PAD = 16;

  const html = document.documentElement;
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  let folds = [];
  let tables = [];
  let expandButtons = [];
  let dialog = null;
  let rail = null;
  let barTitle = null;
  let barTitleDefault = '';
  let currentEl = null;
  let dialogAnchor = null;

  function idFromHref(href) {
    if (!href || href.charAt(0) !== '#' || href.length < 2) return '';
    try { return decodeURIComponent(href.slice(1)); } catch (err) { return href.slice(1); }
  }

  function targetFromHref(href) {
    const id = idFromHref(href);
    return id ? document.getElementById(id) : null;
  }

  const isRendered = (el) => el.getClientRects().length > 0;

  // Без плавной прокрутки.
  function jump(fn) {
    const s = html.style;
    const prev = s.scrollBehavior;
    s.scrollBehavior = 'auto';
    try { fn(); } finally { requestAnimationFrame(() => { s.scrollBehavior = prev; }); }
  }

  function scrollerWithin(el, box) {
    for (let n = el.parentElement; n; n = n.parentElement) {
      if (n.scrollHeight > n.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(n).overflowY)) return n;
      if (n === box) break;
    }
    return null;
  }

  function ensureVisible(el, sc, center) {
    const r = el.getBoundingClientRect();
    const s = sc.getBoundingClientRect();
    if (center) sc.scrollTop += r.top - s.top - (sc.clientHeight - r.height) / 2;
    else if (r.top < s.top + LIST_PAD) sc.scrollTop -= s.top + LIST_PAD - r.top;
    else if (r.bottom > s.bottom - LIST_PAD) sc.scrollTop += r.bottom - s.bottom + LIST_PAD;
  }

  function textOf(node) {
    const parts = [];
    (function walk(n) {
      if (n.nodeType === 3) parts.push(n.nodeValue);
      else if (n.nodeType === 1 && n.getAttribute('aria-hidden') !== 'true') n.childNodes.forEach(walk);
    })(node);
    return parts.join(' ').replace(/\s+/g, ' ').trim();
  }

  const pending = new Set();
  let frame = 0;
  function schedule(...tasks) {
    tasks.forEach((t) => pending.add(t));
    if (!frame) frame = requestAnimationFrame(flush);
  }
  function flush() {
    frame = 0;
    const tasks = new Set(pending);
    pending.clear();
    if (tasks.has('hints')) updateHints();
    if (tasks.has('expand')) syncExpandButtons();
    if (tasks.has('toc')) updateCurrent();
  }

  /* 1. Хэш */
  function revealTarget(target) {
    let changed = false;
    const open = (d) => { if (!d.open) { d.open = true; changed = true; } };
    for (let d = target.parentElement && target.parentElement.closest('details'); d;
      d = d.parentElement && d.parentElement.closest('details')) open(d);
    if (target.tagName === 'DETAILS') open(target);
    if (target.tagName === 'H2' || target.tagName === 'H3') {
      const next = target.nextElementSibling;
      if (next && next.matches('details.fold')) open(next);
    }
    if (changed) updateHints();
    return changed;
  }

  function onHashChange() {
    const target = targetFromHref(location.hash);
    if (target && revealTarget(target)) target.scrollIntoView();
    schedule('toc');
  }

  function onDocumentClick(e) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const el = e.target instanceof Element ? e.target : null;
    if (!el) return;
    const actionEl = el.closest('[data-action]');
    if (actionEl && runAction(actionEl.getAttribute('data-action'))) {
      e.preventDefault();
      return;
    }
    const link = el.closest('a[href^="#"]');
    if (!link) return;
    // До перехода: повторный клик не даёт hashchange.
    const target = targetFromHref(link.getAttribute('href'));
    if (target) revealTarget(target);
    if (dialog && dialog.contains(link)) closeDialog();
  }

  function runAction(name) {
    switch (name) {
      case 'expand-all': toggleAll(); return true;
      case 'toc-open': openDialog(); return true;
      case 'toc-close': closeDialog(); return true;
      case 'print': window.print(); return true;
      default: return false;
    }
  }

  /* 2. Развернуть всё */
  const allOpen = () => folds.length > 0 && folds.every((d) => d.open);

  function syncExpandButtons() {
    const on = allOpen();
    const text = on ? TXT.collapse : TXT.expand;
    // Без aria-pressed: состояние в надписи.
    expandButtons.forEach((b) => {
      b.toggleAttribute('data-open', on);
      const label = b.querySelector('[data-label]') || b;
      if (label.textContent.trim() !== text) label.textContent = text;
    });
  }

  function toggleAll() {
    const open = !allOpen();
    keepPlace(!open, () => {
      folds.forEach((d) => { d.open = open; });
      updateHints();
    });
    syncExpandButtons();
  }

  // Держим место чтения.
  function keepPlace(collapsing, mutate) {
    const anchor = findAnchor(collapsing);
    const before = anchor ? anchor.el.getBoundingClientRect().top : 0;
    mutate();
    if (!anchor || !isRendered(anchor.el)) return;
    const after = anchor.el.getBoundingClientRect().top;
    const dest = anchor.toTop ? Math.max(before, topOffset()) : before;
    if (Math.abs(after - dest) > 1) jump(() => window.scrollBy(0, after - dest));
  }

  function probeReadingPoint() {
    const article = document.getElementById('answer');
    if (!article) return null;
    const r = article.getBoundingClientRect();
    const x = Math.min(Math.max(r.left + Math.max(24, r.width * 0.3), 0), window.innerWidth - 1);
    for (const f of [0.25, 0.4, 0.55]) {
      const el = document.elementFromPoint(x, window.innerHeight * f);
      if (el && el !== article && article.contains(el)) return el;
    }
    return null;
  }

  function findAnchor(collapsing) {
    let el = isDialogOpen() ? dialogAnchor : probeReadingPoint();
    let toTop = false;
    if (!el || !el.isConnected) {
      el = currentEl;
      toTop = collapsing;
    }
    if (!el) return null;
    if (collapsing) {
      let outer = null;
      for (let d = el.closest('details.fold'); d; d = d.parentElement && d.parentElement.closest('details.fold')) outer = d;
      if (outer) {
        el = outer;
        toTop = true;
      }
    }
    return { el, toTop };
  }

  function topOffset() {
    const bar = document.querySelector('.topbar');
    if (bar) {
      const r = bar.getBoundingClientRect();
      const pos = getComputedStyle(bar).position;
      if (r.height > 0 && (pos === 'sticky' || pos === 'fixed')) return r.bottom + HEADER_GAP;
    }
    return WIDE_GAP;
  }

  /* 3. Печать */
  let printSnapshot = null;
  let printScrollY = 0;

  function beforePrint() {
    if (printSnapshot) return;
    printScrollY = window.scrollY;
    printSnapshot = $$('details').map((d) => [d, d.open]);
    printSnapshot.forEach(([d]) => { d.open = true; });
  }

  function afterPrint() {
    if (!printSnapshot) return;
    printSnapshot.forEach(([d, wasOpen]) => { d.open = wasOpen; });
    printSnapshot = null;
    jump(() => window.scrollTo(0, printScrollY));
  }

  /* 4. Оглавление */
  const tocLinks = new Map();
  const headings = [];
  let marked = { links: [], items: [] };

  function initToc() {
    $$('.toc a[href^="#"], .toc-dialog a[href^="#"]').forEach((a) => {
      const id = idFromHref(a.getAttribute('href'));
      if (!id || id === 'top' || id === 'answer') return;
      if (!tocLinks.has(id)) tocLinks.set(id, []);
      tocLinks.get(id).push(a);
    });
    tocLinks.forEach((_, id) => {
      const el = document.getElementById(id);
      if (el) headings.push(el);
    });
    headings.sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
    if (!headings.length) return;
    if ('IntersectionObserver' in window) {
      const io = new IntersectionObserver(() => schedule('toc'), { rootMargin: TOC_ROOT_MARGIN });
      headings.forEach((h) => io.observe(h));
    }
    // Страховка для далёких переходов.
    let settle = 0;
    window.addEventListener('scroll', () => {
      clearTimeout(settle);
      settle = setTimeout(() => schedule('toc'), SCROLL_SETTLE);
    }, { passive: true });
  }

  function findCurrent() {
    const line = window.innerHeight * CURRENT_LINE;
    const atBottom = window.innerHeight + window.scrollY >= html.scrollHeight - 2;
    let cur = null;
    for (const h of headings) {
      if (!isRendered(h)) continue;
      const top = h.getBoundingClientRect().top;
      if (top <= line || (atBottom && top < window.innerHeight)) cur = h;
      else break;
    }
    return cur;
  }

  function sectionOf(h) {
    if (h.tagName !== 'H3') return h;
    for (let i = headings.indexOf(h) - 1; i >= 0; i--) {
      if (headings[i].tagName !== 'H3') return headings[i];
    }
    return h;
  }

  function updateCurrent() {
    if (!headings.length) return;
    const cur = findCurrent();
    if (cur === currentEl) return;
    currentEl = cur;
    marked.links.forEach((a) => a.removeAttribute('aria-current'));
    marked.items.forEach((li) => li.classList.remove('is-active'));
    marked = { links: [], items: [] };
    if (!cur) {
      setBarTitle('');
      return;
    }
    const links = tocLinks.get(cur.id) || [];
    const sectionLinks = tocLinks.get(sectionOf(cur).id) || [];
    const items = sectionLinks.map((a) => a.closest('li') || a);
    links.forEach((a) => a.setAttribute('aria-current', 'true'));
    items.forEach((li) => li.classList.add('is-active'));
    marked = { links, items };
    const label = sectionLinks.find((a) => rail && rail.contains(a)) || sectionLinks[0];
    setBarTitle(label ? textOf(label) : '');
    revealInRail(links);
  }

  function setBarTitle(text) {
    if (!barTitle) return;
    const value = text || barTitleDefault;
    if (barTitle.textContent !== value) barTitle.textContent = value;
  }

  function revealInRail(links) {
    if (!rail) return;
    const a = links.find((l) => rail.contains(l));
    if (!a || !isRendered(a)) return;
    const sc = scrollerWithin(a, rail);
    if (sc) ensureVisible(a, sc, false);
  }

  /* 5. Диалог */
  let pressStartedOnDialog = false;
  const isDialogOpen = () => !!dialog && dialog.hasAttribute('open');

  function setTocButtons(expanded) {
    $$('[data-action="toc-open"]').forEach((b) => b.setAttribute('aria-expanded', String(expanded)));
  }

  function openDialog() {
    if (!dialog || isDialogOpen()) return;
    dialogAnchor = probeReadingPoint();
    try { dialog.showModal(); } catch (err) { dialog.setAttribute('open', ''); }
    setTocButtons(true);
    const cur = dialog.querySelector('a[aria-current="true"]');
    if (!cur) return;
    cur.focus({ preventScroll: true });
    const sc = scrollerWithin(cur, dialog);
    if (sc) ensureVisible(cur, sc, true);
  }

  function closeDialog() {
    if (!isDialogOpen()) return;
    if (typeof dialog.close === 'function') dialog.close();
    else dialog.removeAttribute('open');
    onDialogClosed();
  }

  function onDialogClosed() {
    setTocButtons(false);
    dialogAnchor = null;
  }

  function isBackdropPoint(e) {
    const r = dialog.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) return true;
    const bg = getComputedStyle(dialog).backgroundColor;
    return bg === 'transparent' || /(,|\/)\s*0\)$/.test(bg);
  }

  function initDialog() {
    if (!dialog) return;
    setTocButtons(false);
    dialog.addEventListener('close', onDialogClosed);
    dialog.addEventListener('pointerdown', (e) => { pressStartedOnDialog = e.target === dialog; });
    dialog.addEventListener('click', (e) => {
      if (e.target === dialog && pressStartedOnDialog && isBackdropPoint(e)) closeDialog();
    });
    const wide = window.matchMedia(WIDE_QUERY);
    if (wide.addEventListener) wide.addEventListener('change', (e) => { if (e.matches) closeDialog(); });
  }

  /* 6. Широкие таблицы */
  function makeHint() {
    const p = document.createElement('p');
    p.className = 'table-hint';
    p.setAttribute('data-ui', '');
    p.textContent = TXT.hint;
    return p;
  }

  function updateHints() {
    const wide = tables.map((t) => t.scrollWidth > t.clientWidth + 1);
    tables.forEach((t, i) => {
      const prev = t.previousElementSibling;
      const hasHint = !!prev && prev.classList.contains('table-hint');
      if (wide[i] && !hasHint) t.before(makeHint());
      else if (!wide[i] && hasHint) prev.remove();
      // Tab только у широких.
      if (wide[i]) t.setAttribute('tabindex', '0');
      else t.removeAttribute('tabindex');
    });
  }

  function init() {
    folds = $$('details.fold');
    tables = $$('.table-scroll');
    expandButtons = $$('[data-action="expand-all"]');
    dialog = document.querySelector('dialog.toc-dialog');
    rail = document.querySelector('.toc--rail');
    barTitle = document.querySelector('.topbar__title');
    barTitleDefault = barTitle ? barTitle.textContent.trim() : '';

    syncExpandButtons();
    updateHints();
    const target = targetFromHref(location.hash);
    if (target) {
      revealTarget(target);
      jump(() => target.scrollIntoView()); // без плавной прокрутки от начала страницы
    }
    initToc();
    initDialog();
    updateCurrent();

    document.addEventListener('click', onDocumentClick);
    window.addEventListener('hashchange', onHashChange);
    document.addEventListener('toggle', (e) => {
      if (e.target && e.target.tagName === 'DETAILS') schedule('hints', 'expand', 'toc');
    }, true);
    window.addEventListener('beforeprint', beforePrint);
    window.addEventListener('afterprint', afterPrint);
    let resizeTimer = 0;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => schedule('hints', 'toc'), RESIZE_DELAY);
    });
    window.addEventListener('load', () => schedule('hints', 'toc'));
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
