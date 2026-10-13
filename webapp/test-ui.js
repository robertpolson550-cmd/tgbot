// Дымовой тест интерфейса без зависимостей: запуск `node webapp/test-ui.js`.
// Вместо браузера используется маленькая заглушка DOM, поэтому проверяется логика и отсутствие
// исключений, а не внешний вид. Внешний вид нужно смотреть прямо в Telegram.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const G = require('./game.js');
const APP = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');

/* ---------- заглушка DOM ---------- */
class Text { constructor(t) { this.nodeType = 3; this.textContent = String(t); } }
class El {
  constructor(tag) { this.nodeType = 1; this.tag = tag.toLowerCase(); this.attrs = {}; this.children = []; this.listeners = {}; this.parent = null; this.dataset = {}; this.hidden = false; this.style = {}; this.className = ''; }
  get classList() { const self = this; return { add: (c) => { if (!self.className.split(' ').includes(c)) self.className = (self.className + ' ' + c).trim(); }, remove: (c) => { self.className = self.className.split(' ').filter((x) => x && x !== c).join(' '); } }; }
  get textContent() { return this.children.map((c) => c.textContent).join(''); }
  set textContent(v) { this.children = [new Text(v)]; }
  set innerHTML(v) { this.children = [new Text('')]; this.html = v; }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'id') this.id = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  removeAttribute(k) { delete this.attrs[k]; }
  // как в настоящем DOM: всё, что не узел (в том числе null), превращается в текст
  append(...kids) { for (let k of kids) { if (!(k && k.nodeType)) k = new Text(String(k)); if (k.parent) k.parent.children = k.parent.children.filter((c) => c !== k); k.parent = this; this.children.push(k); } }
  replaceChildren(...kids) { this.children = []; this.append(...kids); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); this.parent = null; }
  addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); }
  click() { assert(!this.attrs.disabled, 'кнопка отключена'); (this.listeners.click || []).forEach((f) => f({ target: this })); }
  focus() {}
  matches(sel) {
    const m = /^([a-z]*)(#[\w-]+)?((?:\.[\w-]+)*)$/.exec(sel);
    if (!m) return false;
    if (m[1] && m[1] !== this.tag) return false;
    if (m[2] && this.attrs.id !== m[2].slice(1)) return false;
    const cls = this.className.split(' ');
    return m[3].split('.').filter(Boolean).every((c) => cls.includes(c));
  }
  all(sel) {
    const parts = sel.trim().split(/\s+/);
    const out = [];
    const walk = (node, ancestors) => {
      for (const c of node.children) {
        if (c.nodeType !== 1) continue;
        const chain = ancestors.concat(c);
        if (c.matches(parts[parts.length - 1])) {
          let i = parts.length - 2, ok = true;
          for (let j = chain.length - 2; i >= 0 && j >= 0; j--) if (chain[j].matches(parts[i])) i--;
          if (i >= 0) ok = false;
          if (ok) out.push(c);
        }
        walk(c, chain);
      }
    };
    walk(this, []);
    return out;
  }
  querySelector(sel) { return this.all(sel)[0] || null; }
  querySelectorAll(sel) { return this.all(sel); }
}
const text = (el) => el.textContent.replace(/\s+/g, ' ').trim();
const byText = (root, sel, re) => root.all(sel).find((e) => re.test(text(e)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const digits = (s) => Number(String(s).replace(/\D/g, ''));

/* ---------- запуск приложения в песочнице ---------- */
function boot({ tg, localStore }) {
  const root = new El('div');
  const mk = (tag, id, cls) => { const e = new El(tag); if (id) e.setAttribute('id', id); if (cls) e.className = cls; root.append(e); return e; };
  const app = mk('div', 'app');
  const coins = new El('span'); coins.setAttribute('id', 'coins-val'); app.append(coins);
  const rates = new El('button'); rates.setAttribute('id', 'btn-rates'); app.append(rates);
  const views = {};
  for (const n of ['pull', 'collection', 'more']) { views[n] = new El('section'); views[n].setAttribute('id', 'view-' + n); app.append(views[n]); }
  const nav = new El('nav'); nav.className = 'tabbar'; app.append(nav);
  const tabs = {};
  for (const n of ['pull', 'collection', 'more']) { const b = new El('button'); b.dataset.tab = n; b.setAttribute('aria-selected', 'false'); nav.append(b); tabs[n] = b; }
  const layers = mk('div', 'layers');
  const toast = mk('div', 'toast');

  const winListeners = {}, docListeners = {};
  const errors = [];
  const sandbox = {
    Game: G, Telegram: tg ? { WebApp: tg } : undefined, APP_CONFIG: {},
    console: { log() {}, warn() {}, error: (...a) => errors.push(a.join(' ')) },
    setTimeout, clearTimeout, setInterval: () => 0, Promise, Date, Math, Number, Array, Object, String, JSON,
    localStorage: { getItem: (k) => (k in localStore ? localStore[k] : null), setItem: (k, v) => { localStore[k] = String(v); } },
    navigator: { clipboard: { writeText: (t) => { sandbox._copied = t; return Promise.resolve(); } } },
    matchMedia: () => ({ matches: false }),
    getComputedStyle: () => ({ getPropertyValue: () => '#e5e8eb' }),
    confirm: () => true,
    scrollTo() {},
    addEventListener: (t, f) => { (winListeners[t] = winListeners[t] || []).push(f); },
    document: {
      documentElement: { dataset: {} },
      hidden: false, activeElement: null,
      createElement: (t) => new El(t), createTextNode: (t) => new Text(t),
      querySelector: (s) => root.querySelector(s),
      querySelectorAll: (s) => root.querySelectorAll(s),
      addEventListener: (t, f) => { (docListeners[t] = docListeners[t] || []).push(f); },
    },
  };
  sandbox.window = sandbox;
  vm.runInNewContext(APP, sandbox, { filename: 'app.js' });
  return {
    root, app, coins, rates, views, tabs, layers, toast, errors, sandbox,
    fire: (t) => (winListeners[t] || []).forEach((f) => f({})),
    docFire: (t, e) => (docListeners[t] || []).forEach((f) => f(e || {})),
  };
}

function makeTelegram(cloud) {
  const ok = (cb, v) => setTimeout(() => cb(null, v), 0);
  return {
    colorScheme: 'dark', isVersionAtLeast: () => true, ready() {}, expand() {}, disableVerticalSwipes() {}, onEvent() {},
    setHeaderColor() {}, setBackgroundColor() {}, showConfirm: (m, cb) => cb(true),
    HapticFeedback: { impactOccurred() {}, notificationOccurred() {} },
    BackButton: { onClick(f) { this.f = f; }, show() { this.shown = true; }, hide() { this.shown = false; } },
    initDataUnsafe: { user: { first_name: 'Тест' } },
    openTelegramLink(u) { this.lastLink = u; },
    CloudStorage: {
      getItem: (k, cb) => ok(cb, cloud[k] || ''),
      getItems: (ks, cb) => { const o = {}; ks.forEach((k) => (o[k] = cloud[k] || '')); ok(cb, o); },
      setItem: (k, v, cb) => { if (String(v).length > 4096) return setTimeout(() => cb('VALUE_INVALID'), 0); cloud[k] = v; ok(cb, true); },
      removeItems: (ks, cb) => { ks.forEach((k) => delete cloud[k]); ok(cb, true); },
    },
  };
}

let passed = 0;
const ok = (n, f) => Promise.resolve(f()).then(() => { passed++; console.log('  ✓', n); });

(async () => {
  const cloud = {}, local = {};
  const tg = makeTelegram(cloud);
  let a = boot({ tg, localStore: local });
  await sleep(40);

  console.log('Telegram-режим');
  await ok('старт: монеты и обе кнопки выбивания', () => {
    assert.strictEqual(digits(a.coins.textContent), 1000);
    assert(byText(a.views.pull, 'button', /Выбить автономер/));
    assert(byText(a.views.pull, 'button', /Пак из 10/));
    assert.strictEqual(a.root.querySelector('#view-pull').all('.pity .track').length, 2);
  });
  await ok('переключение на телефон меняет подпись кнопки', () => {
    byText(a.views.pull, '.seg button', /Телефон/).click();
    assert(byText(a.views.pull, 'button', /Выбить телефон/));
    byText(a.views.pull, '.seg button', /Автономер/).click();
  });
  await ok('одиночная крутка: открывается результат, закрывается кнопкой', () => {
    byText(a.views.pull, 'button', /Выбить автономер/).click();
    assert.strictEqual(a.layers.children.length, 1);
    assert(a.layers.querySelector('.obj.plate'), 'нет номера в результате');
    assert(G.RARITIES.some((r) => text(a.layers).includes(r.name)), 'нет названия редкости');
    assert.strictEqual(tg.BackButton.shown, true);
    byText(a.layers, 'button', /Готово/).click();
    assert.strictEqual(a.layers.children.length, 0);
    assert.strictEqual(tg.BackButton.shown, false);
    assert(a.views.pull.querySelector('.hero .obj'), 'последняя находка не показана');
  });
  await ok('бонус: забирается один раз', () => {
    const before = digits(a.coins.textContent);
    byText(a.views.pull, 'button', /Забрать/).click();
    assert.strictEqual(digits(a.coins.textContent), before + 300);
    assert(!byText(a.views.pull, 'button', /Забрать/));
    assert(/Бонус получен/.test(text(a.views.pull)));
  });
  await ok('пак из 10: пошагово и через «Пропустить» до итогов', () => {
    a.sandbox.__dummy = 0;
    // даём монет через бонус нельзя, поэтому крутим пак, пока хватает денег
    const before = digits(a.coins.textContent);
    assert(before >= 900, 'для пака не хватает монет: ' + before);
    byText(a.views.pull, 'button', /Пак из 10/).click();
    assert(/1 из 10/.test(text(a.layers)));
    byText(a.layers, 'button', /Дальше/).click();
    assert(/2 из 10/.test(text(a.layers)));
    byText(a.layers, 'button', /Пропустить/).click();
    assert(/Итоги пака/.test(text(a.layers)));
    assert.strictEqual(a.layers.all('.sum-list .row').length, 10);
    byText(a.layers, 'button', /Готово/).click();
    assert.strictEqual(a.layers.children.length, 0);
  });
  await ok('нехватка монет: тост, монеты не списаны', () => {
    let guard = 0;
    while (digits(a.coins.textContent) >= 100 && guard++ < 50) {
      byText(a.views.pull, 'button', /Выбить автономер/).click();
      byText(a.layers, 'button', /Готово/).click();
    }
    const coinsLeft = digits(a.coins.textContent);
    assert(coinsLeft < 100);
    byText(a.views.pull, 'button', /Выбить автономер/).click();
    assert(/Не хватает монет/.test(text(a.toast)));
    assert.strictEqual(a.layers.children.length, 0);
    assert.strictEqual(digits(a.coins.textContent), coinsLeft);
  });
  await ok('коллекция: строки, фильтры, подробности и продажа', () => {
    a.tabs.collection.click();
    assert.strictEqual(a.views.collection.hidden, false);
    assert.strictEqual(a.views.pull.hidden, true);
    const rows = a.views.collection.all('.row');
    assert(rows.length > 5, 'в коллекции мало строк: ' + rows.length);
    byText(a.views.collection, '.seg button', /Телефоны/).click();
    byText(a.views.collection, '.seg button', /Все/).click();
    byText(a.views.collection, '.chip', /Редкие/).click();
    byText(a.views.collection, '.chip', /^Все/).click();
    const first = a.views.collection.all('.row')[0];
    const coinsBefore = digits(a.coins.textContent);
    first.click();
    assert.strictEqual(a.layers.children.length, 1);
    byText(a.layers, 'button', /Продать за/).click();
    assert.strictEqual(a.layers.children.length, 0, 'шторка не закрылась после продажи');
    assert(digits(a.coins.textContent) > coinsBefore);
    assert(/Продано/.test(text(a.toast)));
  });
  await ok('поделиться: без ссылки копирует текст', () => {
    a.views.collection.all('.row')[0].click();
    byText(a.layers, 'button', /Поделиться/).click();
    byText(a.layers, 'button', /Закрыть/).click();
  });
  await ok('массовая продажа дешёвых', () => {
    const btn = byText(a.views.collection, '.list-tools .link-btn', /Продать за/);
    if (btn) { btn.click(); assert(/Продано/.test(text(a.toast))); }
  });
  await ok('окно «Шансы»: 6 редкостей и 6 примеров', () => {
    a.rates.click();
    assert.strictEqual(a.layers.all('.rate-row').length, 6);
    assert.strictEqual(a.layers.all('.row').length, 6);
    a.docFire('keydown', { key: 'Escape' });
    assert.strictEqual(a.layers.children.length, 0);
  });
  await ok('вкладка «Ещё»: имя из Telegram и статистика', () => {
    a.tabs.more.click();
    assert(/Тест/.test(text(a.views.more)));
    assert(/Круток/.test(text(a.views.more)));
  });
  await ok('кнопка «Назад» Telegram закрывает слой', () => {
    a.rates.click();
    assert.strictEqual(a.layers.children.length, 1);
    tg.BackButton.f();
    assert.strictEqual(a.layers.children.length, 0);
  });

  console.log('Сохранение');
  const snapshot = { coins: digits(a.coins.textContent), items: Object.keys(G.deserialize(G.serialize(G.newState())).items).length };
  a.fire('pagehide');
  await sleep(60);
  await ok('в облаке есть куски не длиннее 4096', () => {
    const n = Number(cloud.n);
    assert(n >= 1, 'нет счётчика n');
    for (let i = 0; i < n; i++) assert(cloud['s' + i] && cloud['s' + i].length <= 3500, 'кусок ' + i);
    console.log('      кусков в облаке:', n);
  });
  a.tabs.collection.click();
  const itemsBefore = a.views.collection.all('.row').length;
  const coinsBefore = digits(a.coins.textContent);
  const b = boot({ tg, localStore: {} }); // пустой localStorage: данные должны прийти из облака
  await sleep(60);
  await ok('новое устройство подтягивает прогресс из облака', () => {
    assert.strictEqual(digits(b.coins.textContent), coinsBefore);
    b.tabs.collection.click();
    assert.strictEqual(b.views.collection.all('.row').length, itemsBefore);
  });
  await ok('сброс прогресса возвращает 1000 монет', () => {
    b.tabs.more.click();
    byText(b.views.more, 'button', /Начать заново/).click();
    assert.strictEqual(digits(b.coins.textContent), 1000);
    assert.strictEqual(b.views.collection.all('.row').length, 0);
    assert(/Пока пусто/.test(text(b.views.collection)));
  });

  console.log('Большое сохранение');
  {
    const st = G.newState();
    st.coins = 5e6;
    for (let i = 0; i < 500; i++) G.pullMany(st, i % 2 ? 'plate' : 'phone', 1, Math.random, 1700000000000 + i * 1000);
    const bigCloud = {}, bigLocal = { ltg_state_v1: Date.now() + '|' + G.serialize(st) };
    const d = boot({ tg: makeTelegram(bigCloud), localStore: bigLocal }); // локальная копия новее облака
    await sleep(60);
    d.fire('pagehide');
    await sleep(80);
    let n1 = 0;
    await ok('большая коллекция делится на несколько кусков не длиннее 3500', () => {
      n1 = Number(bigCloud.n);
      assert(n1 >= 3, 'кусков: ' + n1);
      for (let i = 0; i < n1; i++) assert(bigCloud['s' + i].length <= 3500, 'кусок ' + i);
      console.log('      предметов:', Object.keys(st.items).length, 'кусков:', n1);
    });
    const e = boot({ tg: makeTelegram(bigCloud), localStore: {} });
    await sleep(60);
    await ok('второе устройство собирает все куски обратно', () => {
      assert.strictEqual(digits(e.coins.textContent), st.coins);
      e.tabs.collection.click();
      assert(e.views.collection.all('.row').length > 0);
    });
    e.tabs.collection.click();
    const sell = byText(e.views.collection, '.list-tools .link-btn', /Продать за/);
    sell.click();
    e.fire('pagehide');
    await sleep(80);
    await ok('после продажи кусков становится меньше, старые удалены из облака', () => {
      const n2 = Number(bigCloud.n);
      assert(n2 < n1, `было ${n1}, стало ${n2}`);
      for (let i = n2; i < n1; i++) assert(!(('s' + i) in bigCloud), 'остался кусок s' + i);
      console.log('      кусков после продажи:', n2);
    });
  }

  console.log('Режим без Telegram (обычный браузер)');
  const c = boot({ tg: null, localStore: {} });
  await sleep(40);
  await ok('работает на localStorage без ошибок', () => {
    byText(c.views.pull, 'button', /Выбить автономер/).click();
    byText(c.layers, 'button', /Готово/).click();
    c.fire('pagehide');
    assert(c.sandbox.localStorage.getItem('ltg_state_v1'), 'состояние не записано');
  });
  await ok('нет ошибок в консоли во всех сценариях', () => {
    assert.deepStrictEqual([...a.errors, ...b.errors, ...c.errors], []);
  });
  await ok('в интерфейсе нет «null», «undefined» и «NaN»', () => {
    for (const app of [a, b, c]) {
      for (const tabName of ['pull', 'collection', 'more']) {
        app.tabs[tabName].click();
        const t = text(app.views[tabName]);
        assert(!/\b(null|undefined|NaN)\b/.test(t), `в «${tabName}» найден мусор: ${t.slice(0, 120)}`);
      }
    }
    c.rates.click();
    assert(!/\b(null|undefined|NaN)\b/.test(text(c.layers)));
    c.docFire('keydown', { key: 'Escape' });
  });

  console.log(`\nВсе проверки интерфейса пройдены: ${passed}`);
  process.exit(0);
})().catch((e) => { console.error('\nОШИБКА:', e && e.stack || e); process.exit(1); });
