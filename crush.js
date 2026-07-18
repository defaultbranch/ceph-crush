'use strict';

/**
 * CRUSH — simplified straw2 placement engine.
 *
 * ── Data structure contracts ─────────────────────────────────────────────────
 *
 *   OSD:
 *     { id: number,          -- stable numeric OSD id (never reused)
 *       size: number,        -- declared capacity in TB; used as base weight
 *       out: boolean }       -- true = temporarily excluded from placement
 *
 *   Host:
 *     { id: string,          -- stable string id (never reused)
 *       hid: number,         -- stable numeric id for hashing (never reused)
 *       name: string,        -- display name
 *       out: boolean,        -- true = all OSDs on this host are excluded
 *       osds: OSD[] }
 *
 *   ClusterMap:
 *     { name: string,
 *       hosts: Host[] }
 *
 *   Pool:
 *     { pgCount: number,          -- total placement groups
 *       replicationFactor: number,-- replicas per PG
 *       seed: number }            -- integer; changes the mapping without
 *                                 -- altering the algorithm
 *
 *   Mapping:  Map<pgId: number, osdIds: number[]>
 *             osdIds.length === replicationFactor when enough hosts exist,
 *             otherwise shorter (degraded).
 *
 * ── Algorithm note ───────────────────────────────────────────────────────────
 * Uses weighted reservoir sampling (Efraimidis-Spirakis) as the bucket
 * selection strategy — this is what Ceph calls "straw2".
 * For failure-domain enforcement (one replica per host) we zero-weight
 * already-chosen hosts rather than using CRUSH's retry/attempt mechanism.
 * The result is semantically identical for educational purposes.
 */
const CRUSH = (() => {

  // ── Hash ───────────────────────────────────────────────────────────────────
  // Jenkins lookup3 finalise — same family as Ceph's crush_hash32_rjenkins1.
  // Takes three non-negative integers, returns an unsigned 32-bit integer.
  function hash(a, b, c) {
    const u = x => x >>> 0;
    const rot = (x, n) => u((x << n) | (x >>> (32 - n)));
    a = u(a); b = u(b); c = u(c);
    c = u(c ^ b - rot(b, 14));
    a = u(a ^ c - rot(c, 11));
    b = u(b ^ a - rot(a, 25));
    c = u(c ^ b - rot(b, 16));
    a = u(a ^ c - rot(c,  4));
    b = u(b ^ a - rot(a, 14));
    c = u(c ^ b - rot(b, 24));
    return c;
  }

  // ── Effective weights ──────────────────────────────────────────────────────
  // An OSD is fully excluded when it is marked out OR its host is marked out.
  // The host-level flag is handled in hostWeight; callers use osdWeight only
  // for within-host OSD selection (host already confirmed to be in).

  function osdWeight(osd) {
    return osd.out ? 0 : osd.size;
  }

  function hostWeight(host) {
    if (host.out) return 0;
    return host.osds.reduce((sum, o) => sum + osdWeight(o), 0);
  }

  // ── Straw2: weighted selection from a list ─────────────────────────────────
  // items    — array of candidates
  // getW     — item → effective weight (items with w <= 0 are skipped)
  // getNumId — item → stable number used in the hash
  // pgId, r  — placement group id and replica index
  // seed     — pool seed, mixed into the hash
  // level    — hierarchy depth (0 = host, 1 = OSD …); prevents hash collisions
  //            between levels that share the same numeric ids (e.g. hid=0 and
  //            osd.id=0 would otherwise produce identical hash inputs).
  //
  // Returns the selected item, or null if every item has weight ≤ 0.
  function straw2Select(items, getW, getNumId, pgId, r, seed, level) {
    let best = null;
    let bestScore = -Infinity;
    for (const item of items) {
      const w = getW(item);
      if (w <= 0) continue;
      // Mix level into the first argument so host- and OSD-level hashes never
      // collide even when hids and osd ids share the same numeric values.
      const h = hash((pgId ^ seed) + level * 0x7FFF, r, getNumId(item));
      // map to open interval (0, 1) to avoid log(0)
      const u = (h + 0.5) / 0x100000000;
      // score = ln(u) / w  — maximise → higher weight wins proportionally
      const score = Math.log(u) / w;
      if (score > bestScore) { bestScore = score; best = item; }
    }
    return best;
  }

  // ── crushSelect: map one pgId → OSD id array ──────────────────────────────
  function crushSelect(pgId, clusterMap, pool) {
    const { replicationFactor, seed } = pool;
    const replicas  = [];
    const usedHosts = new Set();

    for (let r = 0; r < replicationFactor; r++) {
      // Level 0: select a host, excluding already-used ones via zero weight.
      const host = straw2Select(
        clusterMap.hosts,
        h => usedHosts.has(h.id) ? 0 : hostWeight(h),
        h => h.hid,
        pgId, r, seed, 0
      );
      if (!host) break; // not enough hosts

      // Level 1: select an OSD within that host.
      const osd = straw2Select(
        host.osds,
        osdWeight,
        o => o.id,
        pgId, r, seed, 1
      );
      if (!osd) break; // host has no active OSDs (shouldn't happen after hostWeight check)

      replicas.push(osd.id);
      usedHosts.add(host.id);
    }
    return replicas;
  }

  // ── computeMapping: map all PGs in a pool ─────────────────────────────────
  function computeMapping(clusterMap, pool) {
    const mapping = new Map();
    for (let pgId = 0; pgId < pool.pgCount; pgId++) {
      mapping.set(pgId, crushSelect(pgId, clusterMap, pool));
    }
    return mapping;
  }

  // ── Per-OSD statistics (used by the visualization) ────────────────────────

  // Returns Map<osdId, actualCount> for all OSDs in the cluster map.
  function pgCountsPerOsd(clusterMap, mapping) {
    const counts = new Map();
    for (const host of clusterMap.hosts)
      for (const osd of host.osds)
        counts.set(osd.id, 0);
    for (const osdIds of mapping.values())
      for (const id of osdIds)
        counts.set(id, (counts.get(id) ?? 0) + 1);
    return counts;
  }

  // Returns Map<osdId, idealCount> based on weight ratios.
  // idealCount = (osdWeight / totalWeight) * pgCount * replicationFactor
  function idealPgsPerOsd(clusterMap, pool) {
    const totalWeight = clusterMap.hosts
      .flatMap(h => h.osds)
      .reduce((sum, o) => sum + osdWeight(o), 0);
    const totalSlots = pool.pgCount * pool.replicationFactor;
    const ideal = new Map();
    for (const host of clusterMap.hosts)
      for (const osd of host.osds)
        ideal.set(osd.id, totalWeight > 0
          ? (osdWeight(osd) / totalWeight) * totalSlots
          : 0);
    return ideal;
  }

  // ── Public API ─────────────────────────────────────────────────────────────
  return {
    hash,
    osdWeight,
    hostWeight,
    straw2Select,
    crushSelect,
    computeMapping,
    pgCountsPerOsd,
    idealPgsPerOsd,
  };

})();

// Allow loading with require() in Node.js without breaking browser <script> usage.
if (typeof module !== 'undefined') module.exports = CRUSH;
