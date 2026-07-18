'use strict';

/// <reference path="./types.js" />
const CRUSH    = require('./crush.js');
const CAPACITY = require('./capacity.js');

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
/** @returns {ClusterMap} 3-host cluster with uneven weights (8 / 20 / 12 TB). */
function make3Host() {
  return {
    name: 'cluster',
    hosts: [
      { id: 'h0', hid: 0, name: 'h0', out: false,
        osds: [{ id: 0, size: 4, out: false }, { id: 1, size: 4, out: false }] },   // 8 TB
      { id: 'h1', hid: 1, name: 'h1', out: false,
        osds: [{ id: 2, size: 8, out: false }, { id: 3, size: 4, out: false },
               { id: 4, size: 8, out: false }] },                                   // 20 TB
      { id: 'h2', hid: 2, name: 'h2', out: false,
        osds: [{ id: 5, size: 4, out: false }, { id: 6, size: 8, out: false }] },   // 12 TB
    ],
  };
}

/** @returns {ClusterMap} 4-host cluster (4 / 8 / 12 / 20 TB). */
function make4Host() {
  return {
    name: 'cluster',
    hosts: [
      { id: 'h0', hid: 0, name: 'h0', out: false,
        osds: [{ id: 0, size: 4, out: false }] },   // 4 TB
      { id: 'h1', hid: 1, name: 'h1', out: false,
        osds: [{ id: 1, size: 8, out: false }] },   // 8 TB
      { id: 'h2', hid: 2, name: 'h2', out: false,
        osds: [{ id: 2, size: 12, out: false }] },  // 12 TB
      { id: 'h3', hid: 3, name: 'h3', out: false,
        osds: [{ id: 3, size: 20, out: false }] },  // 20 TB
    ],
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test('scenario count: 3 hosts → 3 scenarios (0, 1, 2 failures)', () => {
  const s = CAPACITY.worstCaseCapacity(make3Host(), 3);
  assert(s.length === 3, `expected 3 scenarios, got ${s.length}`);
  for (let i = 0; i < 3; i++)
    assert(s[i].failures === i, `s[${i}].failures should be ${i}, got ${s[i].failures}`);
});

test('scenario count: 1 host → 2 scenarios (0, 1 failure)', () => {
  const map = { name: 'c', hosts: [
    { id: 'h0', hid: 0, name: 'h0', out: false, osds: [{ id: 0, size: 4, out: false }] },
  ]};
  const s = CAPACITY.worstCaseCapacity(map, 3);
  assert(s.length === 2, `expected 2 scenarios, got ${s.length}`);
});

test('hosts == RF (3 hosts, RF=3): bottleneck = smallest host', () => {
  // h0=8 TB, h1=20 TB, h2=12 TB → smallest is h0=8 TB
  const s = CAPACITY.worstCaseCapacity(make3Host(), 3);
  assert(s[0].status === 'ok', `status should be ok, got ${s[0].status}`);
  assert(s[0].usableTB === 8, `usable should be 8 TB, got ${s[0].usableTB}`);
});

test('hosts > RF (3 hosts, RF=2): usable = sum / RF', () => {
  // total = 8+20+12 = 40 TB, RF=2 → usable = 20 TB
  const s = CAPACITY.worstCaseCapacity(make3Host(), 2);
  assert(s[0].status === 'ok', `status should be ok`);
  assert(Math.abs(s[0].usableTB - 20) < 0.001,
    `usable should be 20 TB, got ${s[0].usableTB}`);
});

test('1 failure worst-case (3 hosts, RF=3): biggest host (20 TB) fails → degraded', () => {
  // Remaining after losing h1 (20 TB): h0=8, h2=12 → 2 hosts < RF=3 → degraded
  const s = CAPACITY.worstCaseCapacity(make3Host(), 3);
  assert(s[1].status === 'degraded', `status should be degraded, got ${s[1].status}`);
  assert(s[1].usableTB === null, 'usableTB should be null when degraded');
  assert(s[1].hostsRemaining === 2, `hostsRemaining should be 2, got ${s[1].hostsRemaining}`);
});

test('1 failure worst-case (4 hosts, RF=3): biggest host (20 TB) fails → ok, bottleneck', () => {
  // Remaining after losing h3 (20 TB): h0=4, h1=8, h2=12 → 3 hosts == RF → min=4 TB
  const s = CAPACITY.worstCaseCapacity(make4Host(), 3);
  assert(s[1].status === 'ok', `status should be ok, got ${s[1].status}`);
  assert(s[1].usableTB === 4, `usable should be 4 TB, got ${s[1].usableTB}`);
});

test('2 failures worst-case (4 hosts, RF=3): two biggest fail → degraded', () => {
  // Remove h3 (20 TB) and h2 (12 TB): remaining h0=4, h1=8 → 2 < RF=3 → degraded
  const s = CAPACITY.worstCaseCapacity(make4Host(), 3);
  assert(s[2].status === 'degraded', `status should be degraded, got ${s[2].status}`);
  assert(s[2].hostsRemaining === 2, `hostsRemaining should be 2, got ${s[2].hostsRemaining}`);
});

test('0 hosts remaining (1 host, RF=1, 1 failure): unavailable', () => {
  const map = { name: 'c', hosts: [
    { id: 'h0', hid: 0, name: 'h0', out: false, osds: [{ id: 0, size: 4, out: false }] },
  ]};
  const s = CAPACITY.worstCaseCapacity(map, 1);
  assert(s[1].status === 'unavailable', `status should be unavailable, got ${s[1].status}`);
  assert(s[1].hostsRemaining === 0, `hostsRemaining should be 0, got ${s[1].hostsRemaining}`);
});

test('out hosts are excluded from weight (treated as non-existent)', () => {
  const map = make3Host();
  map.hosts[1].out = true; // h1 (20 TB) is out → only h0=8, h2=12 are active
  // RF=3, 2 active hosts < RF → degraded even at 0 failures
  const s = CAPACITY.worstCaseCapacity(map, 3);
  assert(s[0].status === 'degraded',
    `out host should be excluded; expected degraded, got ${s[0].status}`);
});

test('worst-case ordering: heavier hosts fail first', () => {
  // 4 hosts RF=2: lose biggest (20 TB) first.
  // 0 failures: sum=44/2=22. 1 failure: (4+8+12)/2=12. 2 failures: (4+8)/2=6.
  const s = CAPACITY.worstCaseCapacity(make4Host(), 2);
  assert(s[0].usableTB > s[1].usableTB,
    `usable should decrease with each failure: ${s[0].usableTB} > ${s[1].usableTB}`);
  assert(s[1].usableTB > s[2].usableTB,
    `usable should decrease with each failure: ${s[1].usableTB} > ${s[2].usableTB}`);
});

// ── Report ────────────────────────────────────────────────────────────────────
console.log('');
for (const r of results) {
  const badge = r.pass ? G('PASS') : R('FAIL');
  console.log(`  ${badge}  ${r.name}`);
  if (!r.pass) console.log(`         ${R(r.detail)}`);
}
const passed = results.filter(r => r.pass).length;
console.log(`\n  ${B(`${passed}/${results.length} tests passed`)}\n`);
if (passed < results.length) process.exit(1);
