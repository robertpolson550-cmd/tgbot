/* app.js — интерфейс мини-приложения. Логика игры живёт в game.js. */
(function () {
  'use strict';

  const G = window.Game;
  const tg = (window.Telegram && window.Telegram.WebApp) || null;
  const CFG = Object.assign({ shareUrl: '' }, window.APP_CONFIG || {});
  const R = G.RARITIES;
  const PLURAL = ['Обычные', 'Необычные', 'Редкие', 'Эпические', 'Легендарные', 'Мифические'];
  const KIND_NAME = { plate: 'автономер', phone: 'телефон' };

  const $ = (sel, root) => (root || document).querySelector(sel);
  const fmt = (n) => Number(n).toLocaleString('ru-RU');
  const plural = (n, [one, few, many]) => {
    const a = n % 10, b = n % 100;
    if (a === 1 && b !== 11) return one;
    if (a >= 2 && a <= 4 && (b < 10 || b >= 20)) return few;
    return many;
  };

  // Небольшой конструктор DOM. Тексты ставятся через textContent, поэтому подставить разметку нельзя.
  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'html') el.innerHTML = v; // только для статичных SVG-строк из этого файла
      else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }

  // replaceChildren превращает null в текст «null», поэтому пустые значения отфильтровываем
  function fill(el, ...kids) {
    el.replaceChildren(...kids.flat().filter((k) => k != null && k !== false));
  }

  /* ========================= Состояние ========================= */

  let state = G.newState();
  let kind = 'plate';
  let tab = 'pull';
  let lastFound = null;
  const filters = { kind: 'all', tier: 'all', limit: 60 };

  /* ========================= Telegram ========================= */

  function haptic(type, style) {
    try {
      if (!tg || !tg.HapticFeedback) return;
      if (type === 'impact') tg.HapticFeedback.impactOccurred(style || 'light');
      else tg.HapticFeedback.notificationOccurred(style || 'success');
    } catch (e) { /* старые клиенты */ }
  }

  function applyTheme() {
    const dark = tg ? tg.colorScheme === 'dark' : window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    try {
      const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
      if (tg && bg) { tg.setHeaderColor(bg); tg.setBackgroundColor(bg); tg.setBottomBarColor && tg.setBottomBarColor(bg); }
    } catch (e) { /* не поддерживается */ }
  }

  function initTelegram() {
    applyTheme();
    if (!tg) return;
    try { tg.ready(); tg.expand(); } catch (e) { /* ignore */ }
    try { tg.disableVerticalSwipes && tg.disableVerticalSwipes(); } catch (e) { /* ignore */ }
    try { tg.onEvent('themeChanged', applyTheme); } catch (e) { /* ignore */ }
    try { tg.BackButton.onClick(() => popLayer()); } catch (e) { /* ignore */ }
  }

  function askConfirm(msg, cb) {
    if (tg && tg.showConfirm) {
      try { tg.showConfirm(msg, cb); return; } catch (e) { /* упадём в window.confirm */ }
    }
    cb(window.confirm(msg));
  }

  let toastTimer = null;
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2400);
  }

  /* ========================= Сохранение ========================= */
  // Основное хранилище — Telegram CloudStorage (синхронизируется между устройствами),
  // запасное — localStorage. Значение в CloudStorage не больше 4096 символов, поэтому режем на куски.

  const Store = (function () {
    const LS_KEY = 'ltg_state_v1', CHUNK = 3500;
    const cloud = tg && tg.CloudStorage && tg.isVersionAtLeast && tg.isVersionAtLeast('6.9') ? tg.CloudStorage : null;
    const call = (fn) => new Promise((res, rej) => fn((err, val) => (err ? rej(new Error(String(err))) : res(val))));
    let cloudN = 0, timer = null, pending = null, chain = Promise.resolve();

    const pack = (st) => Date.now() + '|' + G.serialize(st);
    function unpack(s) {
      if (typeof s !== 'string') return null;
      const i = s.indexOf('|');
      if (i < 1) return null;
      const ts = Number(s.slice(0, i)), st = G.deserialize(s.slice(i + 1));
      return st && Number.isFinite(ts) ? { ts, st } : null;
    }

    async function readCloud() {
      if (!cloud) return null;
      try {
        const n = parseInt(await call((cb) => cloud.getItem('n', cb)), 10);
        if (!(n > 0 && n <= 200)) return null;
        cloudN = n;
        const keys = Array.from({ length: n }, (_, i) => 's' + i);
        const vals = await call((cb) => cloud.getItems(keys, cb));
        return unpack(keys.map((k) => vals[k] || '').join(''));
      } catch (e) { return null; }
    }
    function readLocal() {
      try { return unpack(localStorage.getItem(LS_KEY)); } catch (e) { return null; }
    }
    function writeLocal(s) { try { localStorage.setItem(LS_KEY, s); } catch (e) { /* ignore */ } }

    async function writeCloud(s) {
      if (!cloud) return;
      const chunks = [];
      for (let i = 0; i < s.length; i += CHUNK) chunks.push(s.slice(i, i + CHUNK));
      await Promise.all(chunks.map((c, i) => call((cb) => cloud.setItem('s' + i, c, cb))));
      await call((cb) => cloud.setItem('n', String(chunks.length), cb)); // счётчик пишем последним
      if (cloudN > chunks.length) {
        const extra = [];
        for (let i = chunks.length; i < cloudN; i++) extra.push('s' + i);
        try { await call((cb) => cloud.removeItems(extra, cb)); } catch (e) { /* ignore */ }
      }
      cloudN = chunks.length;
    }

    function flush() {
      if (timer) { clearTimeout(timer); timer = null; }
      if (!pending) return;
      const s = pack(pending);
      pending = null;
      writeLocal(s);
      chain = chain.then(() => writeCloud(s)).catch(() => {});
    }
    function schedule(st) {
      pending = st;
      clearTimeout(timer);
      timer = setTimeout(flush, 400);
    }

    // Берём более свежую копию. Если свежее локальная (облако не успело записаться) — досинхронизируем.
    async function load() {
      const c = await readCloud(), l = readLocal();
      const best = c && l ? (l.ts > c.ts ? l : c) : c || l;
      return { state: best ? best.st : null, needsSync: !!(cloud && best && best === l) };
    }
    return { load, schedule, flush };
  })();

  const save = () => Store.schedule(state);

  /* ========================= Отрисовка объектов ========================= */

  const STARS = (function () {
    let s = '<svg viewBox="-12 -12 24 24" aria-hidden="true">';
    for (let i = 0; i < 12; i++) {
      const a = (i * Math.PI) / 6;
      s += `<circle cx="${(8.6 * Math.sin(a)).toFixed(2)}" cy="${(-8.6 * Math.cos(a)).toFixed(2)}" r="1.55" fill="#f4c20d"/>`;
    }
    return s + '</svg>';
  })();
  const PHONE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#fff" d="M6.6 10.8c1.4 2.8 3.8 5.1 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.1.4 2.3.6 3.6.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1C10.6 21 3 13.4 3 4c0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.3.2 2.5.6 3.6.1.3 0 .7-.2 1l-2.3 2.2z"/></svg>';

  const display = (info) => (info.kind === 'plate' ? G.formatPlate(info.value) : G.formatPhone(info.value));

  function objectNode(info, size, opts) {
    opts = opts || {};
    const cls = `obj r${info.tier} s-${size}${opts.drop ? ' drop' : ''}${opts.sheen && info.tier >= 3 ? ' sheen' : ''}`;
    const label = `${info.kind === 'plate' ? 'Автономер' : 'Телефон'} ${display(info)}, ${R[info.tier].name.toLowerCase()}`;
    if (info.kind === 'plate') {
      return h('div', { class: cls + ' plate', role: 'img', 'aria-label': label },
        h('div', { class: 'eu' }, h('span', { class: 'stars', html: STARS }), h('span', { class: 'lt', text: 'LT' })),
        h('div', { class: 'chars', text: G.formatPlate(info.value) }));
    }
    return h('div', { class: cls + ' phone', role: 'img', 'aria-label': label },
      h('div', { class: 'flag' }, h('i'), h('i'), h('i')),
      h('div', { class: 'num' }, h('span', { class: 'cc', text: '+370' }), G.formatPhone(info.value).slice(5)),
      h('div', { class: 'call', html: PHONE_ICON }));
  }

  const pips = (tier) => h('span', { class: 'pips', 'aria-hidden': 'true' }, R.map((_, i) => h('i', { class: i <= tier ? 'on' : '' })));
  const rarLine = (tier, cls) => h('div', { class: 'rar-line ' + (cls || '') }, pips(tier), h('span', { class: 'rar-name', text: R[tier].name }));
  const tagsText = (info) => info.tags.join(', ') || 'Без особых признаков';
  const coinIcon = () => h('span', { class: 'coin', 'aria-hidden': 'true' });

  function row(info, opts) {
    opts = opts || {};
    return h(opts.onClick ? 'button' : 'div', { class: `row r${info.tier}`, type: opts.onClick ? 'button' : null, onClick: opts.onClick },
      objectNode(info, 'sm'),
      h('div', { class: 'row-meta' }, rarLine(info.tier), h('div', { class: 'row-tags', text: opts.dup ? 'Дубликат, продан автоматически' : tagsText(info) })));
  }

  /* ========================= Слои (результат, шторки) ========================= */

  const layers = [];

  function updateBack() {
    try { layers.length ? tg.BackButton.show() : tg.BackButton.hide(); } catch (e) { /* нет BackButton */ }
  }
  function pushLayer(node, opts) {
    opts = opts || {};
    const layer = h('div', { class: 'layer' }, opts.full ? null : h('div', { class: 'scrim', onClick: () => popLayer() }), node);
    layers.push({ el: layer, onClose: opts.onClose, prevFocus: document.activeElement });
    $('#layers').append(layer);
    $('#app').setAttribute('inert', '');
    updateBack();
    const f = layer.querySelector('button');
    if (f) f.focus({ preventScroll: true });
  }
  function popLayer() {
    const l = layers.pop();
    if (!l) return;
    l.el.remove();
    if (!layers.length) $('#app').removeAttribute('inert');
    updateBack();
    if (l.prevFocus && l.prevFocus.focus) l.prevFocus.focus({ preventScroll: true });
    if (l.onClose) l.onClose();
  }
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') popLayer(); });

  /* ========================= Выбивание ========================= */

  function doPull(count) {
    const res = G.pullMany(state, kind, count);
    if (!res) {
      toast('Не хватает монет. Заберите бонус или продайте ненужные номера.');
      haptic('notify', 'error');
      return;
    }
    lastFound = res.results.reduce((a, b) => (b.info.tier > a.info.tier ? b : a)).info;
    save();
    renderHeader();
    openReveal(res.results);
  }

  function openReveal(results) {
    const total = results.length;
    let i = 0;
    const node = h('div', { class: 'reveal', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Результат' });

    function again(count) {
      popLayer();
      doPull(count);
    }

    function showSummary() {
      const best = results.reduce((a, b) => (b.info.tier > a.info.tier ? b : a));
      const sorted = [...results].sort((a, b) => b.info.tier - a.info.tier || b.info.score - a.info.score);
      const dups = results.filter((r) => r.isDup);
      const refund = dups.reduce((s, r) => s + r.refund, 0);
      node.className = 'reveal r' + best.info.tier;
      fill(node,
        h('h2', { class: 'sum-title', text: 'Итоги пака' }),
        h('div', { class: 'sum-list' }, sorted.map((r) => row(r.info, { dup: r.isDup }))),
        dups.length ? h('p', { class: 'note', text: `Дубликатов: ${dups.length}. Возвращено ${fmt(refund)} монет.` }) : null,
        h('div', { class: 'reveal-actions' },
          h('button', { class: 'btn primary', type: 'button', onClick: () => popLayer(), 'data-autofocus': '' }, 'Готово'),
          h('button', { class: 'btn', type: 'button', 'aria-disabled': state.coins >= G.PRICES[10] ? null : 'true', onClick: () => (state.coins >= G.PRICES[10] ? again(10) : toast('Не хватает монет для пака')) }, `Ещё пак за ${fmt(G.PRICES[10])}`)));
    }

    function step() {
      const r = results[i], info = r.info, last = i === total - 1;
      node.className = 'reveal r' + info.tier;
      fill(node,
        h('div', { class: 'reveal-count', text: total > 1 ? `${i + 1} из ${total}` : '' }),
        h('div', { class: 'reveal-stage' },
          objectNode(info, 'lg', { drop: true, sheen: true }),
          h('div', { class: 'reveal-meta' },
            rarLine(info.tier, 'big'),
            h('p', { class: 'tags', text: tagsText(info) }),
            r.isDup ? h('p', { class: 'note', text: `Такой номер уже есть. Продан автоматически: +${fmt(r.refund)} монет.` }) : null,
            r.pity ? h('p', { class: 'note', text: 'Сработала гарантия редкости.' }) : null,
            r.guaranteed ? h('p', { class: 'note', text: 'Гарантированный редкий номер из пака.' }) : null)),
        h('div', { class: 'reveal-actions' },
          total > 1
            ? [h('button', { class: 'btn primary', type: 'button', onClick: () => (last ? showSummary() : (i++, step())) }, last ? 'Итоги' : 'Дальше'),
               last ? null : h('button', { class: 'btn', type: 'button', onClick: showSummary }, 'Пропустить')]
            : [h('button', { class: 'btn primary', type: 'button', onClick: () => popLayer() }, 'Готово'),
               h('button', { class: 'btn', type: 'button', 'aria-disabled': state.coins >= G.PRICES[1] ? null : 'true', onClick: () => (state.coins >= G.PRICES[1] ? again(1) : toast('Не хватает монет')) }, `Ещё раз за ${fmt(G.PRICES[1])}`)]));
      const btn = node.querySelector('.btn.primary');
      if (btn) btn.focus({ preventScroll: true });
      if (info.tier >= 4) { haptic('impact', 'heavy'); haptic('notify', 'success'); }
      else if (info.tier >= 2) haptic('impact', info.tier === 3 ? 'heavy' : 'medium');
      else haptic('impact', 'light');
    }

    pushLayer(node, { full: true, onClose: render });
    step();
  }

  /* ========================= Бонус ========================= */

  function waitText(ms) {
    const m = Math.ceil(ms / 60000);
    return m >= 60 ? `${Math.floor(m / 60)} ч ${m % 60} мин` : `${m} мин`;
  }
  function claimDaily() {
    const r = G.claimDaily(state);
    if (!r) return;
    save();
    render();
    toast(`Бонус: +${r.coins} монет`);
    haptic('notify', 'success');
  }
  function dailyStrip() {
    const st = G.dailyStatus(state);
    if (st.ready) {
      const p = G.dailyPreview(state);
      return h('div', { class: 'daily' },
        h('div', null, h('strong', { text: 'Ежедневный бонус' }), h('div', { class: 'sub', text: `+${p.coins} монет, ${p.streak}-й день подряд` })),
        h('button', { class: 'btn primary small', type: 'button', onClick: claimDaily }, 'Забрать'));
    }
    return h('div', { class: 'daily' },
      h('div', null, h('strong', { text: 'Бонус получен' }), h('div', { class: 'sub', text: `Следующий через ${waitText(st.waitMs)}` })));
  }

  /* ========================= Экраны ========================= */

  function segmented(opts, value, onPick, label) {
    return h('div', { class: 'seg', role: 'group', 'aria-label': label },
      opts.map(([v, t]) => h('button', { type: 'button', 'aria-pressed': String(v === value), onClick: () => onPick(v) }, t)));
  }

  function renderHeader() { $('#coins-val').textContent = fmt(state.coins); }

  function pullButton(count) {
    const price = G.PRICES[count], can = state.coins >= price;
    const label = count === 1 ? (kind === 'plate' ? 'Выбить автономер' : 'Выбить телефон') : 'Пак из 10';
    return h('button', { class: 'btn ' + (count === 1 ? 'primary' : ''), type: 'button', 'aria-disabled': can ? null : 'true', onClick: () => doPull(count) },
      h('span', { text: label }), h('span', { class: 'btn-price' }, coinIcon(), fmt(price)));
  }

  function pityLine(label, have, need) {
    const left = need - have;
    const text = left <= 1 ? `${label} выпадет со следующей крутки` : `${label} гарантирован через ${left} ${plural(left, ['крутку', 'крутки', 'круток'])}`;
    return h('div', null, h('p', { text }), h('div', { class: 'track', 'aria-hidden': 'true' }, h('i', { style: `--w:${Math.round((have / need) * 100)}%` })));
  }

  function renderPull() {
    fill($('#view-pull'),
      segmented([['plate', 'Автономер'], ['phone', 'Телефон']], kind, (v) => {
        kind = v;
        try { localStorage.setItem('ltg_kind', v); } catch (e) { /* ignore */ }
        renderPull();
      }, 'Что выбивать'),
      h('div', { class: 'hero' },
        lastFound
          ? [objectNode(lastFound, 'lg'), h('div', { class: 'r' + lastFound.tier }, rarLine(lastFound.tier))]
          : h('div', { class: 'blank' }, h('span', { text: 'Здесь появится номер' }))),
      h('div', { class: 'pull-actions' }, pullButton(1), pullButton(10)),
      h('div', { class: 'pity' },
        pityLine('Эпический или лучше', state.pity.epic, G.EPIC_PITY),
        pityLine('Легендарный или лучше', state.pity.leg, G.LEGENDARY_PITY)),
      dailyStrip());
  }

  function sortedItems() {
    return Object.values(state.items)
      .filter((it) => (filters.kind === 'all' || it.kind === filters.kind) && (filters.tier === 'all' || it.tier === filters.tier))
      .sort((a, b) => b.tier - a.tier || b.score - a.score || b.ts - a.ts);
  }

  function renderCollection() {
    const el = $('#view-collection');
    const all = Object.values(state.items);
    const byKind = all.filter((it) => filters.kind === 'all' || it.kind === filters.kind);
    const counts = R.map((_, t) => byKind.filter((it) => it.tier === t).length);
    const list = sortedItems();
    const cheap = all.filter((it) => it.tier <= 1);
    const cheapSum = cheap.reduce((s, it) => s + R[it.tier].sell, 0);

    fill(el,
      segmented([['all', 'Все'], ['plate', 'Автономера'], ['phone', 'Телефоны']], filters.kind, (v) => { filters.kind = v; filters.limit = 60; renderCollection(); }, 'Тип'),
      h('div', { class: 'chips' },
        h('button', { class: 'chip', type: 'button', 'aria-pressed': String(filters.tier === 'all'), onClick: () => { filters.tier = 'all'; filters.limit = 60; renderCollection(); } }, `Все ${byKind.length}`),
        R.map((_, t) => h('button', { class: `chip r${t}`, type: 'button', 'aria-pressed': String(filters.tier === t), onClick: () => { filters.tier = t; filters.limit = 60; renderCollection(); } },
          h('i'), `${PLURAL[t]} ${counts[t]}`))),
      cheap.length ? h('div', { class: 'list-tools' },
        h('span', { class: 'sub', text: `Обычных и необычных: ${cheap.length}` }),
        h('button', { class: 'link-btn', type: 'button', onClick: () => sellCheap(cheap.length, cheapSum) }, `Продать за ${fmt(cheapSum)}`)) : null,
      all.length === 0
        ? h('p', { class: 'list-empty', text: 'Пока пусто. Выбейте первый номер на вкладке «Выбить».' })
        : list.length === 0
          ? h('p', { class: 'list-empty', text: 'Нет номеров с такими фильтрами.' })
          : h('div', null, list.slice(0, filters.limit).map((it) => row(it, { onClick: () => openDetail(it.key) }))),
      list.length > filters.limit ? h('button', { class: 'btn small more-btn', type: 'button', onClick: () => { filters.limit += 60; renderCollection(); } }, `Показать ещё ${Math.min(60, list.length - filters.limit)}`) : null);
  }

  function sellCheap(n, sum) {
    askConfirm(`Продать ${n} ${plural(n, ['номер', 'номера', 'номеров'])} за ${fmt(sum)} монет?`, (ok) => {
      if (!ok) return;
      const r = G.sellAll(state, 1);
      save();
      render();
      toast(`Продано: ${r.count}, получено ${fmt(r.coins)} монет`);
    });
  }

  function share(it) {
    const text = `Выбил ${KIND_NAME[it.kind]} ${display(it)}: ${R[it.tier].name.toLowerCase()}!`;
    if (CFG.shareUrl && tg && tg.openTelegramLink) {
      tg.openTelegramLink(`https://t.me/share/url?url=${encodeURIComponent(CFG.shareUrl)}&text=${encodeURIComponent(text)}`);
      return;
    }
    const done = () => toast('Текст скопирован');
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, () => toast(text));
    else toast(text);
  }

  function openDetail(key) {
    const it = state.items[key];
    if (!it) return;
    const sell = R[it.tier].sell;
    const node = h('div', { class: `sheet detail r${it.tier}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Номер из коллекции' },
      h('div', { class: 'detail-stage' }, objectNode(it, 'lg')),
      rarLine(it.tier, 'big'),
      h('p', { class: 'tags', text: tagsText(it) }),
      h('div', { class: 'sheet-actions' },
        h('button', { class: 'btn', type: 'button', onClick: () => share(it) }, 'Поделиться'),
        h('button', { class: 'btn danger', type: 'button', onClick: () => {
          askConfirm(`Продать ${display(it)} за ${fmt(sell)} монет?`, (ok) => {
            if (!ok) return;
            G.sellItem(state, key);
            save();
            popLayer();
            render();
            toast(`Продано: +${fmt(sell)} монет`);
          });
        } }, `Продать за ${fmt(sell)}`)),
      h('button', { class: 'link-btn close', type: 'button', onClick: () => popLayer() }, 'Закрыть'));
    pushLayer(node);
  }

  const EXAMPLES = [
    ['plate', 'KKM512', 'Двойная буква'],
    ['phone', '61253777', 'Три семёрки в конце номера'],
    ['plate', 'VIP001', 'Слово на буквах и номер один'],
    ['phone', '65300000', 'Пять нулей в конце'],
    ['plate', 'AAA777', 'Три одинаковые буквы и 777'],
    ['phone', '61234567', 'Цифры от 1 до 7 по порядку'],
  ];

  function openRates() {
    const node = h('div', { class: 'sheet left', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Шансы и гарантии' },
      h('h2', { text: 'Шансы и гарантии' }),
      h('div', null, R.map((r, t) => h('div', { class: `rate-row r${t}` },
        h('div', { class: 'rar-line' }, pips(t), h('span', { class: 'rar-name', text: r.name })),
        h('span', { class: 'chance', text: String(r.weight).replace('.', ',') + '%' }),
        h('span', { class: 'price' }, coinIcon(), fmt(r.sell))))),
      h('ul', { class: 'rules' },
        h('li', { text: `Эпический или лучше выпадет не позже чем на ${G.EPIC_PITY}-й крутке, легендарный или лучше — на ${G.LEGENDARY_PITY}-й.` }),
        h('li', { text: 'В паке из 10 всегда есть редкий номер или лучше.' }),
        h('li', { text: 'Если номер уже есть в коллекции, он сразу продаётся за цену из таблицы справа.' }),
        h('li', { text: 'Редкость зависит от рисунка номера: повторы, цифры и буквы по порядку, зеркальные сочетания, слова.' })),
      h('h3', { text: 'Примеры' }),
      h('div', null, EXAMPLES.map(([k, v, why]) => {
        const info = k === 'plate' ? G.classifyPlate(v) : G.classifyPhone(v);
        return h('div', { class: `row r${info.tier}` }, objectNode(info, 'sm'),
          h('div', { class: 'row-meta' }, rarLine(info.tier), h('div', { class: 'row-tags', text: why })));
      })),
      h('button', { class: 'link-btn close', type: 'button', onClick: () => popLayer() }, 'Закрыть'));
    pushLayer(node);
  }

  function resetAll() {
    askConfirm('Удалить всю коллекцию и монеты и начать заново?', (ok) => {
      if (!ok) return;
      state = G.newState();
      lastFound = null;
      save();
      render();
      toast('Прогресс сброшен');
    });
  }

  function renderMore() {
    const sum = G.summarize(state);
    let plates = 0, phones = 0;
    sum.forEach((s) => { plates += s.plate; phones += s.phone; });
    const user = tg && tg.initDataUnsafe && tg.initDataUnsafe.user;
    const stat = (name, val) => h('div', null, h('dt', { text: name }), h('dd', { text: fmt(val) }));
    fill($('#view-more'),
      h('h1', { class: 'page-title', text: (user && user.first_name) || 'Профиль' }),
      h('dl', { class: 'stats' }, stat('Круток', state.pulls), stat('Автономеров в коллекции', plates), stat('Телефонов в коллекции', phones)),
      state.best ? h('div', { class: 'best' }, h('p', { class: 'sub', text: 'Лучшая находка' }), objectNode(state.best, 'md'), h('div', { class: 'r' + state.best.tier }, rarLine(state.best.tier))) : null,
      h('div', { class: 'more-actions' },
        h('button', { class: 'link-btn', type: 'button', onClick: openRates }, 'Шансы и гарантии'),
        h('button', { class: 'link-btn danger-text', type: 'button', onClick: resetAll }, 'Начать заново')),
      h('p', { class: 'fine', text: 'Номера генерируются случайно ради игры. Они не связаны с настоящими автомобилями и абонентами, а совпадения случайны.' }));
  }

  function render() {
    renderHeader();
    renderPull();
    renderCollection();
    renderMore();
  }

  function setTab(t) {
    tab = t;
    for (const b of document.querySelectorAll('.tabbar button')) b.setAttribute('aria-selected', String(b.dataset.tab === t));
    for (const name of ['pull', 'collection', 'more']) $('#view-' + name).hidden = name !== t;
    window.scrollTo(0, 0);
  }

  /* ========================= Запуск ========================= */

  async function init() {
    initTelegram();
    try { const k = localStorage.getItem('ltg_kind'); if (k === 'plate' || k === 'phone') kind = k; } catch (e) { /* ignore */ }

    const loaded = await Store.load();
    if (loaded.state) state = loaded.state;
    if (loaded.needsSync) save();

    for (const b of document.querySelectorAll('.tabbar button')) b.addEventListener('click', () => setTab(b.dataset.tab));
    $('#btn-rates').addEventListener('click', openRates);
    document.addEventListener('visibilitychange', () => { if (document.hidden) Store.flush(); });
    window.addEventListener('pagehide', () => Store.flush());
    setInterval(() => { if (!layers.length && tab === 'pull') renderPull(); }, 60000);

    render();
  }

  init();
})();
