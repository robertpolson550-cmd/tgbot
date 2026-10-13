// Запуск: node webapp/test.js
const assert = require('assert');
const G = require('./game.js');

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const names = G.RARITIES.map((r) => r.id);
let passed = 0;
const ok = (name, fn) => { fn(); passed++; console.log('  ✓', name); };

console.log('Классификация автономеров');
ok('обычный KFT482', () => assert.strictEqual(names[G.classifyPlate('KFT482').tier], 'common'));
ok('необычный KKM512 (двойная буква)', () => assert.strictEqual(names[G.classifyPlate('KKM512').tier], 'uncommon'));
ok('эпический VIP001', () => assert.strictEqual(names[G.classifyPlate('VIP001').tier], 'epic'));
ok('легендарный ABC123', () => assert.strictEqual(names[G.classifyPlate('ABC123').tier], 'legendary'));
ok('легендарный DOG555', () => assert.strictEqual(names[G.classifyPlate('DOG555').tier], 'legendary'));
ok('мифический AAA777', () => assert.strictEqual(names[G.classifyPlate('AAA777').tier], 'mythic'));
ok('слова используют только допустимые буквы', () =>
  G.WORDS.forEach((w) => [...w].forEach((c) => assert(G.ALPHA.includes(c), w))));

console.log('Классификация телефонов');
ok('обычный 61254873', () => assert.strictEqual(names[G.classifyPhone('61254873').tier], 'common'));
ok('редкий 61253777', () => assert.strictEqual(names[G.classifyPhone('61253777').tier], 'rare'));
ok('две пары 61200777 даёт эпический', () => assert.strictEqual(names[G.classifyPhone('61200777').tier], 'epic'));
ok('легендарный 65300000', () => assert.strictEqual(names[G.classifyPhone('65300000').tier], 'legendary'));
ok('мифический 61234567', () => assert.strictEqual(names[G.classifyPhone('61234567').tier], 'mythic'));
ok('форматирование', () => {
  assert.strictEqual(G.formatPhone('61234567'), '+370 612 34567');
  assert.strictEqual(G.formatPlate('ABC123'), 'ABC 123');
});

console.log('Выпадение (100 000 круток, seed=1)');
{
  const st = G.newState();
  st.coins = 1e12;
  const rand = mulberry32(1);
  const N = 100000;
  const cnt = names.map(() => 0);
  const byKind = { plate: 0, phone: 0 };
  for (let i = 0; i < N; i++) {
    const kind = i % 2 ? 'plate' : 'phone';
    const res = G.pullMany(st, kind, 1, rand, 1000 + i);
    cnt[res.results[0].info.tier]++;
    byKind[kind]++;
  }
  const pct = cnt.map((c) => (c / N) * 100);
  names.forEach((n, i) => console.log('   ', n.padEnd(10), pct[i].toFixed(2).padStart(6) + '%', '(цель', G.RARITIES[i].weight + '%)'));
  const tol = [1.2, 1.0, 0.8, 1.2, 0.8, 0.25];
  pct.forEach((p, i) => {
    assert(Math.abs(p - G.RARITIES[i].weight) <= tol[i], `${names[i]}: ${p.toFixed(2)}% вне допуска`);
  });
  ok('доли редкостей близки к заявленным (с учётом гарантий)', () => {});
  ok('показанная редкость всегда совпала с запрошенной (fallback = 0)', () => assert.strictEqual(G._debug.fallbacks, 0));
}

console.log('Пак из 10');
ok('в каждом паке есть Редкий+ (2000 паков)', () => {
  const rand = mulberry32(7);
  for (let i = 0; i < 2000; i++) {
    const st = G.newState();
    st.coins = 900;
    const res = G.pullMany(st, i % 2 ? 'plate' : 'phone', 10, rand, 5000);
    assert.strictEqual(res.results.length, 10);
    assert(res.results.some((x) => x.info.tier >= 2), 'нет Редкого+ в паке ' + i);
  }
});
ok('не хватает монет → null и монеты не списаны', () => {
  const st = G.newState();
  st.coins = 99;
  assert.strictEqual(G.pullMany(st, 'plate', 1), null);
  assert.strictEqual(st.coins, 99);
});

console.log('Гарантии (pity)');
ok('Эпический+ не позже чем на 30-й крутке', () => {
  const st = G.newState();
  st.coins = 1e12;
  const rand = mulberry32(99);
  let sinceEpic = 0, maxGap = 0;
  for (let i = 0; i < 20000; i++) {
    const t = G.pullMany(st, 'plate', 1, rand, 1).results[0].info.tier;
    sinceEpic = t >= 3 ? 0 : sinceEpic + 1;
    maxGap = Math.max(maxGap, sinceEpic);
  }
  assert(maxGap < G.EPIC_PITY, 'максимальный разрыв ' + maxGap);
});

console.log('Дубликаты, продажа, бонус');
ok('дубликат не попадает в коллекцию, а возвращает монеты', () => {
  const st = G.newState();
  st.items['p:AAA111'] = Object.assign(G.classifyPlate('AAA111'), { ts: 1 });
  // подменяем ГСЧ так, чтобы всегда генерировался один и тот же номер невозможно напрямую,
  // поэтому проверяем через много круток: суммарно coins = старт - затраты + возвраты дублей
  st.coins = 1e6;
  const before = st.coins;
  const rand = mulberry32(5);
  let refunds = 0, spent = 0, dups = 0;
  for (let i = 0; i < 3000; i++) {
    const r = G.pullMany(st, 'plate', 1, rand, 1);
    spent += r.cost; refunds += r.results[0].refund; dups += r.results[0].isDup ? 1 : 0;
  }
  assert.strictEqual(st.coins, before - spent + refunds);
  assert(dups > 0, 'за 3000 круток ожидались дубликаты редких номеров');
});
ok('продажа и массовая продажа', () => {
  const st = G.newState();
  st.coins = 0;
  st.items['p:KFT482'] = Object.assign(G.classifyPlate('KFT482'), { ts: 1 });
  st.items['p:KKM512'] = Object.assign(G.classifyPlate('KKM512'), { ts: 1 });
  st.items['p:AAA777'] = Object.assign(G.classifyPlate('AAA777'), { ts: 1 });
  assert.strictEqual(G.sellItem(st, 'p:KFT482'), 10);
  const all = G.sellAll(st, 1);
  assert.deepStrictEqual([all.count, all.coins], [1, 25]);
  assert(st.items['p:AAA777'], 'мифический не должен продаться');
  assert.strictEqual(st.coins, 35);
});
ok('ежедневный бонус: серия и кулдаун', () => {
  const st = G.newState();
  st.coins = 0;
  const h = 3600 * 1000, t0 = 1e12;
  assert.deepStrictEqual(G.claimDaily(st, t0), { coins: 300, streak: 1 });
  assert.strictEqual(G.claimDaily(st, t0 + 5 * h), null);
  assert.deepStrictEqual(G.claimDaily(st, t0 + 24 * h), { coins: 350, streak: 2 });
  assert.deepStrictEqual(G.claimDaily(st, t0 + 24 * h + 100 * h), { coins: 300, streak: 1 }); // серия прервана
});

console.log('Сохранение');
ok('сериализация туда-обратно', () => {
  const st = G.newState();
  st.coins = 1e9;
  const rand = mulberry32(3);
  for (let i = 0; i < 400; i++) G.pullMany(st, i % 2 ? 'plate' : 'phone', 1, rand, 1700000000000 + i * 1000);
  const back = G.deserialize(G.serialize(st));
  assert.deepStrictEqual(Object.keys(back.items).sort(), Object.keys(st.items).sort());
  assert.strictEqual(back.coins, st.coins);
  assert.strictEqual(back.pulls, st.pulls);
  assert.deepStrictEqual(back.pity, st.pity);
  assert.strictEqual(back.best.key, st.best.key);
  const k = Object.keys(st.items)[0];
  assert.strictEqual(back.items[k].tier, st.items[k].tier);
  assert.strictEqual(back.items[k].ts, st.items[k].ts);
  console.log('      размер сохранения для', Object.keys(st.items).length, 'предметов:', G.serialize(st).length, 'символов');
});
ok('мусор и подделка отбрасываются', () => {
  assert.strictEqual(G.deserialize('не json'), null);
  assert.strictEqual(G.deserialize('{"v":2}'), null);
  const bad = G.deserialize(JSON.stringify({
    v: 1, c: -5, i: { 'p:abc123': 'a', 't:12345678': 'a', 'p:QQQ123': 'a', 'p:ABC000': 'a', 'p:ABC123': 'zz', '__proto__': 'x' },
  }));
  assert.strictEqual(bad.coins, 0);
  assert.deepStrictEqual(Object.keys(bad.items), ['p:ABC123']);
});

console.log('\nСправка: шансы у полностью случайных номеров (200 000 образцов)');
{
  const rand = mulberry32(11);
  const rl = () => G.ALPHA[Math.floor(rand() * G.ALPHA.length)];
  const plate = names.map(() => 0), phone = names.map(() => 0);
  const N = 200000;
  for (let i = 0; i < N; i++) {
    let d;
    do { d = String(Math.floor(rand() * 1000)).padStart(3, '0'); } while (d === '000');
    plate[G.classifyPlate(rl() + rl() + rl() + d).tier]++;
    let n = '6';
    for (let j = 0; j < 7; j++) n += Math.floor(rand() * 10);
    phone[G.classifyPhone(n).tier]++;
  }
  names.forEach((nm, i) => console.log('   ', nm.padEnd(10), 'номер:', ((plate[i] / N) * 100).toFixed(3).padStart(8) + '%', ' телефон:', ((phone[i] / N) * 100).toFixed(3).padStart(8) + '%'));
}

console.log(`\nВсе проверки пройдены: ${passed}`);
