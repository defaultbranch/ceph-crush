'use strict';

const CRUSH = require('./crush.js');

// ── ANSI helpers ──────────────────────────────────────────────────────────────
const G = s => `\x1b[32m${s}\x1b[0m`;  // green
const R = s => `\x1b[31m${s}\x1b[0m`;  // red
const B = s => `\x1b[1m${s}\x1b[0m`;   // bold

// ── Mini test runner ──────────────────────────────────────────────────────────
const results = [];

function test(name, fn) {
  try {
    fn();
    results.push({ name, pass: true });
  } catch (e) {
    results.push({ name, pass: false, detail: e.message });
  }
}

function assert(condition, msg = 'assertion failed') {
  if (!condition) throw new Error(msg);
}

// ── Fixtures ──────────────────────────────────────────────────────────────────
function makeMap() {
  return {
    name: 'cluster',
    hosts: [
      { id: 'host-1', hid: 0, name: 'host-1', out: false,
        osds: [{ id: 0, size: 4, out: false },
               { id: 1, size: 4, out: false }] },
      { id: 'host-2', hid: 1, name: 'host-2', out: false,
        osds: [{ id: 2, size: 8, out: false },
               { id: 3, size: 4, out: false },
               { id: 4, size: 8, out: false }] },
      { id: 'host-3', hid: 2, name: 'host-3', out: false,
        osds: [{ id: 5, size: 4, out: false },
               { id: 6, size: 8, out: false }] },
    ]
  };
}

const defaultPool = { pgCount: 64, replicationFactor: 3, seed: 0 };

function hostOfOsd(map, osdId) {
  for (const h of map.hosts)
    for (const o of h.osds)
      if (o.id === osdId) return h;
  return null;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test('determinism: identical inputs produce identical mapping', () => {
  const cm = makeMap();
  const m1 = CRUSH.computeMapping(cm, defaultPool);
  const m2 = CRUSH.computeMapping(cm, defaultPool);
  for (let i = 0; i < defaultPool.pgCount; i++)
    assert(JSON.stringify(m1.get(i)) === JSON.stringify(m2.get(i)),
      `pg ${i} differs between two runs`);
});

test('replica count: every PG has exactly replicationFactor OSDs', () => {
  const m = CRUSH.computeMapping(makeMap(), defaultPool);
  for (let i = 0; i < defaultPool.pgCount; i++) {
    const n = m.get(i).length;
    assert(n === defaultPool.replicationFactor,
      `pg ${i}: expected ${defaultPool.replicationFactor} replicas, got ${n}`);
  }
});

test('failure domain: no two replicas of a PG share a host', () => {
  const cm = makeMap();
  const m = CRUSH.computeMapping(cm, defaultPool);
  for (let i = 0; i < defaultPool.pgCount; i++) {
    const hostIds = m.get(i).map(id => hostOfOsd(cm, id).id);
    assert(new Set(hostIds).size === hostIds.length,
      `pg ${i} has replicas on the same host: [${hostIds}]`);
  }
});

test('no duplicate OSDs within a PG', () => {
  const m = CRUSH.computeMapping(makeMap(), defaultPool);
  for (let i = 0; i < defaultPool.pgCount; i++) {
    const osds = m.get(i);
    assert(new Set(osds).size === osds.length,
      `pg ${i} has duplicate OSD: [${osds}]`);
  }
});

test('weight proportionality: 8 TB OSD beats 4 TB sibling on same host', () => {
  // host-2: osd.2 (8TB), osd.3 (4TB), osd.4 (8TB)
  const m = CRUSH.computeMapping(makeMap(), defaultPool);
  const counts = new Map([2, 3, 4].map(id => [id, 0]));
  for (const osds of m.values())
    for (const id of osds)
      if (counts.has(id)) counts.set(id, counts.get(id) + 1);
  assert(counts.get(2) > counts.get(3),
    `osd.2 (8 TB, ${counts.get(2)} PGs) should exceed osd.3 (4 TB, ${counts.get(3)} PGs)`);
  assert(counts.get(4) > counts.get(3),
    `osd.4 (8 TB, ${counts.get(4)} PGs) should exceed osd.3 (4 TB, ${counts.get(3)} PGs)`);
});

test('out OSD: marked-out OSD receives no assignments', () => {
  const cm = makeMap();
  cm.hosts[1].osds[1].out = true; // osd.3
  const m = CRUSH.computeMapping(cm, defaultPool);
  for (const osds of m.values())
    assert(!osds.includes(3), 'osd.3 (out) appears in a mapping');
});

test('out host: all OSDs on a marked-out host receive no assignments', () => {
  const cm = makeMap();
  cm.hosts[0].out = true; // host-1 → osd.0, osd.1
  const m = CRUSH.computeMapping(cm, defaultPool);
  for (const osds of m.values()) {
    assert(!osds.includes(0), 'osd.0 on out host-1 appears in a mapping');
    assert(!osds.includes(1), 'osd.1 on out host-1 appears in a mapping');
  }
});

test('seed: different seeds produce different mappings', () => {
  const cm = makeMap();
  const m0 = CRUSH.computeMapping(cm, { ...defaultPool, seed: 0  });
  const m1 = CRUSH.computeMapping(cm, { ...defaultPool, seed: 42 });
  let diffs = 0;
  for (let i = 0; i < defaultPool.pgCount; i++)
    if (JSON.stringify(m0.get(i)) !== JSON.stringify(m1.get(i))) diffs++;
  assert(diffs > 0, 'different seeds produced identical mappings');
});

test('degraded: fewer hosts than replicationFactor → shorter replica lists', () => {
  const cm = {
    name: 'tiny',
    hosts: [
      { id: 'h0', hid: 0, name: 'h0', out: false, osds: [{ id: 0, size: 4, out: false }] },
      { id: 'h1', hid: 1, name: 'h1', out: false, osds: [{ id: 1, size: 4, out: false }] },
    ]
  };
  const pool = { pgCount: 8, replicationFactor: 3, seed: 0 };
  const m = CRUSH.computeMapping(cm, pool);
  for (let i = 0; i < pool.pgCount; i++)
    assert(m.get(i).length === 2,
      `pg ${i}: expected 2 replicas (only 2 hosts), got ${m.get(i).length}`);
});

test('pgCountsPerOsd: counts sum to pgCount × replicationFactor', () => {
  const cm = makeMap();
  const m = CRUSH.computeMapping(cm, defaultPool);
  const counts = CRUSH.pgCountsPerOsd(cm, m);
  const total = [...counts.values()].reduce((s, n) => s + n, 0);
  const expected = defaultPool.pgCount * defaultPool.replicationFactor;
  assert(total === expected, `sum is ${total}, expected ${expected}`);
});

test('idealPgsPerOsd: ideal counts sum to pgCount × replicationFactor', () => {
  const cm = makeMap();
  const ideal = CRUSH.idealPgsPerOsd(cm, defaultPool);
  const total = [...ideal.values()].reduce((s, n) => s + n, 0);
  const expected = defaultPool.pgCount * defaultPool.replicationFactor;
  assert(Math.abs(total - expected) < 0.001, `ideal sum is ${total}, expected ${expected}`);
});

// ── Report ────────────────────────────────────────────────────────────────────
console.log('');
for (const r of results) {
  const badge = r.pass ? G('PASS') : R('FAIL');
  console.log(`  ${badge}  ${r.name}`);
  if (r.detail) console.log(`         ${R(r.detail)}`);
}

const passed = results.filter(r => r.pass).length;
const total  = results.length;
const summary = `\n  ${passed}/${total} tests passed`;
console.log(passed === total ? G(B(summary)) : R(B(summary)));
console.log('');

process.exit(passed === total ? 0 : 1);
