/* game.js — вся игровая логика (без DOM). Работает и в браузере, и в Node (для тестов). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Game = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ========================= Константы ========================= */

  // sell — сколько монет дают за продажу (и за дубликат). Подобрано так, что
  // если продавать всё подряд, то в среднем возвращается ~80% цены крутки.
  const RARITIES = [
    { id: 'common',    name: 'Обычный',     weight: 55,  sell: 10,   color: '#9aa4b2' },
    { id: 'uncommon',  name: 'Необычный',   weight: 25,  sell: 25,   color: '#4ade80' },
    { id: 'rare',      name: 'Редкий',      weight: 12,  sell: 80,   color: '#38bdf8' },
    { id: 'epic',      name: 'Эпический',   weight: 5.5, sell: 250,  color: '#c084fc' },
    { id: 'legendary', name: 'Легендарный', weight: 2,   sell: 1000, color: '#fbbf24' },
    { id: 'mythic',    name: 'Мифический',  weight: 0.5, sell: 5000, color: '#fb7185' },
  ];

  const PRICES = { 1: 100, 10: 900 };
  const START_COINS = 1000;
  const EPIC_PITY = 30;        // гарантированный Эпический+ не позже чем на 30-й крутке
  const LEGENDARY_PITY = 120;  // гарантированный Легендарный+ не позже чем на 120-й
  const DAILY_COOLDOWN = 20 * 3600 * 1000;
  const STREAK_WINDOW = 48 * 3600 * 1000;

  // Латинские буквы литовского алфавита (без диакритики): нет Q, W, X.
  const ALPHA = 'ABCDEFGHIJKLMNOPRSTUVYZ';
  const DIGITS = '0123456789';
  const WORDS = ['VIP', 'TOP', 'BOS', 'LTU', 'VLN', 'KNS', 'KLP', 'UAB', 'ONE', 'CAT', 'DOG', 'SUN', 'CAR', 'BIG'];

  // Минимальные очки для Необычный / Редкий / Эпический / Легендарный / Мифический
  const PLATE_THRESHOLDS = [1, 3, 5, 8, 11];
  const PHONE_THRESHOLDS = [2, 4, 6, 9, 12];

  const debug = { fallbacks: 0 };

  /* ========================= Утилиты ========================= */

  function defaultRandom() {
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
      const a = new Uint32Array(1);
      crypto.getRandomValues(a);
      return a[0] / 4294967296;
    }
    return Math.random();
  }
  const int = (r, n) => Math.floor(r() * n);
  const pick = (r, arr) => arr[int(r, arr.length)];
  const rd = (r) => String(int(r, 10));
  const rds = (r, k) => { let s = ''; for (let i = 0; i < k; i++) s += rd(r); return s; };
  const rl = (r) => ALPHA[int(r, ALPHA.length)];

  function tierOf(score, thresholds) {
    let t = 0;
    for (const th of thresholds) if (score >= th) t++;
    return t;
  }

  // строка — монотонная последовательность соседних символов алфавита (ABC, CBA, 123, 987)
  function isSeq(str, alphabet) {
    const idx = [...str].map((c) => alphabet.indexOf(c));
    if (idx.some((i) => i < 0)) return false;
    const d = idx[1] - idx[0];
    if (Math.abs(d) !== 1) return false;
    for (let i = 1; i < idx.length; i++) if (idx[i] - idx[i - 1] !== d) return false;
    return true;
  }

  /* ========================= Автономера ========================= */
  // Формат: 3 буквы + 3 цифры, например ABC123 (показывается как «ABC 123»).

  function classifyPlate(plate) {
    const L = plate.slice(0, 3), D = plate.slice(3);
    const tags = [];
    let s = 0;

    if (L[0] === L[1] && L[1] === L[2]) { s += 5; tags.push('Три одинаковые буквы'); }
    else if (WORDS.includes(L)) { s += 4; tags.push('Слово «' + L + '»'); }
    else if (isSeq(L, ALPHA)) { s += 4; tags.push('Буквы по порядку'); }
    else if (L[0] === L[2]) { s += 3; tags.push('Зеркальные буквы'); }
    else if (L[0] === L[1] || L[1] === L[2]) { s += 1; tags.push('Двойная буква'); }

    if (D === '777') { s += 7; tags.push('Счастливая семёрка'); }
    else if (D === '007') { s += 5; tags.push('Агент 007'); }
    else if (D === '001') { s += 3; tags.push('Номер один'); }
    else if (D[0] === D[1] && D[1] === D[2]) { s += 6; tags.push('Три одинаковые цифры'); }
    else if (isSeq(D, DIGITS)) { s += 4; tags.push('Цифры по порядку'); }
    else if (D[1] === '0' && D[2] === '0') { s += 3; tags.push('Круглое число'); }
    else if (D[0] === D[2]) { s += 2; tags.push('Зеркальные цифры'); }
    else if (D[0] === D[1] || D[1] === D[2]) { s += 1; tags.push('Двойная цифра'); }

    return { kind: 'plate', value: plate, key: 'p:' + plate, score: s, tier: tierOf(s, PLATE_THRESHOLDS), tags };
  }

  function plateCandidate(r) {
    const letters = pick(r, [
      () => rl(r) + rl(r) + rl(r),
      () => { const a = rl(r), b = rl(r); return r() < 0.5 ? a + a + b : b + a + a; },
      () => { const a = rl(r), b = rl(r); return a + b + a; },
      () => {
        const dir = r() < 0.5 ? 1 : -1;
        const start = dir === 1 ? int(r, ALPHA.length - 2) : 2 + int(r, ALPHA.length - 2);
        return ALPHA[start] + ALPHA[start + dir] + ALPHA[start + 2 * dir];
      },
      () => pick(r, WORDS),
      () => { const a = rl(r); return a + a + a; },
    ])();

    const digits = pick(r, [
      () => String(1 + int(r, 999)).padStart(3, '0'),
      () => { const a = rd(r), b = rd(r); return r() < 0.5 ? a + a + b : b + a + a; },
      () => { const a = rd(r), b = rd(r); return a + b + a; },
      () => String(1 + int(r, 9)) + '00',
      () => {
        const dir = r() < 0.5 ? 1 : -1;
        const start = dir === 1 ? int(r, 8) : 2 + int(r, 8);
        return DIGITS[start] + DIGITS[start + dir] + DIGITS[start + 2 * dir];
      },
      () => { const a = String(1 + int(r, 9)); return a + a + a; },
      () => '777',
      () => '007',
      () => '001',
    ])();

    return letters + digits;
  }

  function formatPlate(p) { return p.slice(0, 3) + ' ' + p.slice(3); }

  /* ========================= Телефоны ========================= */
  // Мобильные номера Литвы: +370 6XX XXXXX. Хранится как 8 цифр национального номера: «6XXXXXXX».

  const RUN_PTS = { 3: 2, 4: 4, 5: 6, 6: 9, 7: 12, 8: 15 };

  function classifyPhone(n) {
    if (!/^6\d{7}$/.test(n)) throw new Error('bad phone ' + n);
    const tags = [];
    let s = 0;

    // 1) самая длинная серия одинаковых цифр
    let best = null;
    for (let i = 0; i < n.length;) {
      let j = i;
      while (j + 1 < n.length && n[j + 1] === n[i]) j++;
      const len = j - i + 1, atEnd = j === n.length - 1;
      if (!best || len > best.len || (len === best.len && atEnd && !best.atEnd)) best = { d: n[i], len, atEnd };
      i = j + 1;
    }
    if (best.len >= 3) {
      s += RUN_PTS[best.len];
      tags.push(best.len + (best.len < 5 ? ' одинаковые цифры подряд' : ' одинаковых цифр подряд'));
      if (best.atEnd) { s += 2; tags.push('Повтор в конце номера'); }
      if (best.d === '7') { s += 1; tags.push('Счастливая семёрка'); }
    }

    // 2) последовательность цифр по порядку (1234, 8765…)
    let asc = 1, desc = 1, L = 1;
    for (let i = 1; i < n.length; i++) {
      const d = +n[i] - +n[i - 1];
      asc = d === 1 ? asc + 1 : 1;
      desc = d === -1 ? desc + 1 : 1;
      L = Math.max(L, asc, desc);
    }
    const seqPts = L >= 7 ? 12 : L === 6 ? 8 : L === 5 ? 5 : L === 4 ? 3 : 0;
    if (seqPts) { s += seqPts; tags.push('Цифры по порядку (' + L + ')'); }

    // 3) пары: 112233 / 1122
    let pairs = 0;
    for (let i = 0; i + 6 <= n.length && !pairs; i++) {
      if (n[i] === n[i + 1] && n[i + 2] === n[i + 3] && n[i + 4] === n[i + 5] && n[i] !== n[i + 2] && n[i + 2] !== n[i + 4]) pairs = 6;
    }
    for (let i = 0; i + 4 <= n.length && !pairs; i++) {
      if (n[i] === n[i + 1] && n[i + 2] === n[i + 3] && n[i] !== n[i + 2]) pairs = 4;
    }
    if (pairs === 6) { s += 4; tags.push('Три пары подряд'); }
    else if (pairs === 4) { s += 2; tags.push('Две пары подряд'); }

    // 4) узоры на конце номера (берётся самый сильный)
    const u = n.slice(-6), t = n.slice(-4);
    const rev = (x) => [...x].reverse().join('');
    if (u === rev(u) && new Set(u).size > 1) { s += 4; tags.push('Зеркальный хвост'); }
    else if (u[0] === u[2] && u[2] === u[4] && u[1] === u[3] && u[3] === u[5] && u[0] !== u[1]) { s += 4; tags.push('Повтор пары ×3'); }
    else if (u.slice(0, 3) === u.slice(3) && new Set(u.slice(0, 3)).size > 1) { s += 3; tags.push('Повтор тройки'); }
    else if (t === rev(t) && t[0] !== t[1]) { s += 2; tags.push('Зеркало на конце'); }
    else if (t[0] === t[2] && t[1] === t[3] && t[0] !== t[1]) { s += 2; tags.push('Повтор пары'); }

    // 5) целиком зеркальный номер (6XXYYXX6)
    if (n === rev(n) && new Set(n).size > 1) { s += 5; tags.push('Зеркальный номер'); }

    // 6) круглое окончание
    if (n.endsWith('00')) { s += 2; tags.push('Круглое окончание'); }

    return { kind: 'phone', value: n, key: 't:' + n, score: s, tier: tierOf(s, PHONE_THRESHOLDS), tags };
  }

  function phoneCandidate(r) {
    const base = () => '6' + rds(r, 7);
    const overlay = (b, pos, str) => b.slice(0, pos) + str + b.slice(pos + str.length);
    const place = (b, str) => overlay(b, 1 + int(r, 8 - str.length), str); // позиции 1..(8-len)

    return pick(r, [
      () => base(),
      () => { const k = 3 + int(r, 5); return overlay(base(), 8 - k, rd(r).repeat(k)); },        // серия на конце (3–7)
      () => { const k = 3 + int(r, 3); return place(base(), rd(r).repeat(k)); },                  // серия где угодно (3–5)
      () => {                                                                                      // последовательность внутри
        const k = 4 + int(r, 4), dir = r() < 0.5 ? 1 : -1;
        const a = dir === 1 ? int(r, 11 - k) : (k - 1) + int(r, 11 - k);
        let seq = '';
        for (let j = 0; j < k; j++) seq += DIGITS[a + dir * j];
        return place(base(), seq);
      },
      () => { const pre = pick(r, ['6789', '65432', '654321', '6543210']); return pre + rds(r, 8 - pre.length); },
      () => { const a = rd(r), b = rd(r); return place(base(), a + a + b + b); },
      () => { const a = rd(r), b = rd(r), c = rd(r); return place(base(), a + a + b + b + c + c); },
      () => { const a = rd(r), b = rd(r), c = rd(r); return overlay(base(), 2, a + b + c + c + b + a); },
      () => { const a = rd(r), b = rd(r); return overlay(base(), 4, a + b + b + a); },
      () => { const a = rd(r), b = rd(r); return overlay(base(), 4, a + b + a + b); },
      () => { const a = rd(r), b = rd(r); return overlay(base(), 2, a + b + a + b + a + b); },
      () => { const a = rd(r), b = rd(r), c = rd(r); return overlay(base(), 2, a + b + c + a + b + c); },
      () => { const k = 2 + int(r, 5); return overlay(base(), 8 - k, '0'.repeat(k)); },           // круглые окончания
      () => { const a = rd(r), b = rd(r), c = rd(r); return '6' + a + b + c + c + b + a + '6'; },
    ])();
  }

  function formatPhone(n) { return '+370 ' + n.slice(0, 3) + ' ' + n.slice(3); }

  /* ========================= Генерация ========================= */

  function rollTier(r, minTier) {
    minTier = minTier || 0;
    let total = 0;
    for (let i = minTier; i < RARITIES.length; i++) total += RARITIES[i].weight;
    let x = r() * total;
    for (let i = minTier; i < RARITIES.length; i++) {
      x -= RARITIES[i].weight;
      if (x < 0) return i;
    }
    return RARITIES.length - 1;
  }

  // Генерируем кандидатов, пока классификатор не подтвердит нужную редкость —
  // так показанная редкость всегда совпадает с реальной.
  function generate(kind, tier, r) {
    const gen = kind === 'plate' ? plateCandidate : phoneCandidate;
    const cls = kind === 'plate' ? classifyPlate : classifyPhone;
    let last = null;
    for (let i = 0; i < 5000; i++) {
      const v = gen(r);
      if (kind === 'plate' && v.slice(3) === '000') continue; // 000 на настоящих номерах не бывает
      const info = cls(v);
      last = info;
      if (info.tier === tier) return info;
    }
    debug.fallbacks++;
    return last;
  }

  /* ========================= Состояние и экономика ========================= */

  function newState() {
    return { v: 1, coins: START_COINS, pulls: 0, pity: { epic: 0, leg: 0 }, items: {}, lastDaily: 0, streak: 0, best: null };
  }

  function pullMany(state, kind, count, r, now) {
    r = r || defaultRandom;
    now = now || Date.now();
    if (kind !== 'plate' && kind !== 'phone') throw new Error('bad kind');
    const cost = PRICES[count];
    if (cost === undefined) throw new Error('bad count');
    if (state.coins < cost) return null;
    state.coins -= cost;

    const results = [];
    let gotRare = false;
    for (let i = 0; i < count; i++) {
      let minTier = 0, guaranteed = false;
      if (count === 10 && i === 9 && !gotRare) { minTier = 2; guaranteed = true; } // в паке из 10 всегда есть Редкий+

      let tier = rollTier(r, minTier), pity = null;
      if (state.pity.leg + 1 >= LEGENDARY_PITY && tier < 4) { tier = rollTier(r, 4); pity = 'legendary'; }
      else if (state.pity.epic + 1 >= EPIC_PITY && tier < 3) { tier = rollTier(r, 3); pity = 'epic'; }
      state.pity.epic = tier >= 3 ? 0 : state.pity.epic + 1;
      state.pity.leg = tier >= 4 ? 0 : state.pity.leg + 1;
      if (tier >= 2) gotRare = true;

      const info = generate(kind, tier, r);
      let isDup = false, refund = 0;
      if (state.items[info.key]) {
        isDup = true;
        refund = RARITIES[info.tier].sell;
        state.coins += refund;
      } else {
        state.items[info.key] = Object.assign({}, info, { ts: now });
      }
      state.pulls++;
      if (!state.best || info.tier > state.best.tier || (info.tier === state.best.tier && info.score > state.best.score)) state.best = info;
      results.push({ info, isDup, refund, pity, guaranteed });
    }
    return { results, cost };
  }

  function sellItem(state, key) {
    const it = state.items[key];
    if (!it) return 0;
    delete state.items[key];
    const c = RARITIES[it.tier].sell;
    state.coins += c;
    return c;
  }

  function sellAll(state, maxTier) {
    let count = 0, coins = 0;
    for (const key of Object.keys(state.items)) {
      if (state.items[key].tier <= maxTier) { coins += sellItem(state, key); count++; }
    }
    return { count, coins };
  }

  function dailyStatus(state, now) {
    now = now || Date.now();
    const wait = Math.min(state.lastDaily + DAILY_COOLDOWN - now, DAILY_COOLDOWN);
    return { ready: wait <= 0, waitMs: Math.max(0, wait) };
  }

  function claimDaily(state, now) {
    now = now || Date.now();
    if (!dailyStatus(state, now).ready) return null;
    state.streak = state.lastDaily && now - state.lastDaily <= STREAK_WINDOW ? state.streak + 1 : 1;
    const coins = 300 + Math.min(state.streak - 1, 6) * 50;
    state.coins += coins;
    state.lastDaily = now;
    return { coins, streak: state.streak };
  }

  // что получит игрок, если заберёт бонус сейчас (для подписи на кнопке)
  function dailyPreview(state, now) {
    now = now || Date.now();
    const streak = state.lastDaily && now - state.lastDaily <= STREAK_WINDOW ? state.streak + 1 : 1;
    return { coins: 300 + Math.min(streak - 1, 6) * 50, streak };
  }

  function summarize(state) {
    const byTier = RARITIES.map(() => ({ plate: 0, phone: 0 }));
    for (const it of Object.values(state.items)) byTier[it.tier][it.kind]++;
    return byTier;
  }

  /* ========================= Сохранение ========================= */

  function makeItem(key, ts) {
    let m = /^p:([A-Z]{3})(\d{3})$/.exec(key);
    if (m) {
      if ([...m[1]].some((c) => !ALPHA.includes(c)) || m[2] === '000') return null;
      return Object.assign(classifyPlate(m[1] + m[2]), { ts });
    }
    m = /^t:(6\d{7})$/.exec(key);
    if (m) return Object.assign(classifyPhone(m[1]), { ts });
    return null;
  }

  function serialize(state) {
    const items = {};
    for (const [k, it] of Object.entries(state.items)) items[k] = Math.floor(it.ts / 1000).toString(36);
    return JSON.stringify({
      v: 1, c: state.coins, p: state.pulls, y: [state.pity.epic, state.pity.leg],
      i: items, d: state.lastDaily, s: state.streak, b: state.best ? state.best.key : null,
    });
  }

  const clampInt = (x, lo, hi, dflt) => (Number.isFinite(x) ? Math.min(hi, Math.max(lo, Math.floor(x))) : dflt);

  // Данные из хранилища считаем недоверенными: всё проверяем.
  function deserialize(str) {
    let o;
    try { o = JSON.parse(str); } catch (e) { return null; }
    if (!o || typeof o !== 'object' || o.v !== 1) return null;
    const st = newState();
    st.coins = clampInt(o.c, 0, 1e12, st.coins);
    st.pulls = clampInt(o.p, 0, 1e9, 0);
    if (Array.isArray(o.y)) {
      st.pity.epic = clampInt(o.y[0], 0, EPIC_PITY, 0);
      st.pity.leg = clampInt(o.y[1], 0, LEGENDARY_PITY, 0);
    }
    st.lastDaily = clampInt(o.d, 0, 1e15, 0);
    st.streak = clampInt(o.s, 0, 1e6, 0);
    if (o.i && typeof o.i === 'object') {
      for (const [k, t] of Object.entries(o.i)) {
        const ts = parseInt(t, 36) * 1000;
        const it = makeItem(k, Number.isFinite(ts) ? ts : 0);
        if (it) st.items[k] = it;
      }
    }
    if (typeof o.b === 'string') st.best = makeItem(o.b, 0);
    return st;
  }

  return {
    RARITIES, PRICES, START_COINS, EPIC_PITY, LEGENDARY_PITY, ALPHA, WORDS, DAILY_COOLDOWN,
    classifyPlate, classifyPhone, formatPlate, formatPhone,
    rollTier, generate, newState, pullMany, sellItem, sellAll,
    dailyStatus, claimDaily, dailyPreview, summarize, serialize, deserialize, defaultRandom,
    _debug: debug,
  };
});
