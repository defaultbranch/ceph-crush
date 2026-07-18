'use strict';

/**
 * CRUSH — simplified straw2 placement engine.
 *
 * Data-structure contracts: {@link OSD}, {@link Host}, {@link ClusterMap},
 * {@link Pool}, {@link Mapping} — see types.js.
 *
 * Algorithm: weighted reservoir sampling (Efraimidis-Spirakis), which is what
 * Ceph calls "straw2". Failure-domain enforcement (one replica per host) is
 * achieved by zero-weighting already-chosen hosts rather than using CRUSH's
 * retry/attempt mechanism; the result is semantically identical for educational
 * purposes.
 */
const CRUSH = (() => {

  // ── Hash ───────────────────────────────────────────────────────────────────
  // Jenkins lookup3 finalise — same family as Ceph's crush_hash32_rjenkins1.

  /**
   * Jenkins lookup3 finalise mix.
   * Same hash family as Ceph's crush_hash32_rjenkins1.
   * @param {number} a - First non-negative integer.
   * @param {number} b - Second non-negative integer.
   * @param {number} c - Third non-negative integer.
   * @returns {number} Unsigned 32-bit integer.
   */
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

  /**
   * Effective weight of an OSD: its declared size in TB, or 0 when marked out.
   * @param {OSD} osd
   * @returns {number}
   */
  function osdWeight(osd) {
    return osd.out ? 0 : osd.size;
  }

  /**
   * Effective weight of a host: sum of its OSDs' weights, or 0 when the host
   * itself is marked out.
   * @param {Host} host
   * @returns {number}
   */
  function hostWeight(host) {
    if (host.out) return 0;
    return host.osds.reduce((sum, o) => sum + osdWeight(o), 0);
  }

  // ── Straw2: weighted selection from a list ─────────────────────────────────

  /**
   * Weighted reservoir sampling (Efraimidis-Spirakis / straw2).
   * Selects one item from `items` with probability proportional to its weight.
   *
   * @template T
   * @param {T[]}              items    - Candidate items.
   * @param {function(T):number} getW   - Returns the effective weight of an item;
   *                                      items with weight ≤ 0 are skipped.
   * @param {function(T):number} getNumId - Returns a stable integer id used in
   *                                        the hash (must be unique within items).
   * @param {PgId}   pgId  - Placement-group id.
   * @param {number} r     - Replica index (0-based).
   * @param {number} seed  - Pool seed mixed into the hash.
   * @param {number} level - Hierarchy depth (0 = host, 1 = OSD); prevents hash
   *                         collisions between levels sharing the same numeric ids.
   * @returns {T|null} The selected item, or null if every item has weight ≤ 0.
   */
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

  /**
   * Runs the CRUSH algorithm for a single PG.
   * Selects `replicationFactor` OSDs across distinct hosts, proportional to
   * host and OSD weights. Returns fewer OSDs in degraded mode (not enough hosts).
   *
   * @param {PgId}       pgId       - Placement-group id.
   * @param {ClusterMap} clusterMap
   * @param {Pool}       pool
   * @returns {OsdId[]} Ordered list of selected OSD ids (length ≤ replicationFactor).
   */
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

  /**
   * Computes the full PG → OSD mapping for a pool.
   * @param {ClusterMap} clusterMap
   * @param {Pool}       pool
   * @returns {Mapping}
   */
  function computeMapping(clusterMap, pool) {
    const mapping = new Map();
    for (let pgId = 0; pgId < pool.pgCount; pgId++) {
      mapping.set(pgId, crushSelect(pgId, clusterMap, pool));
    }
    return mapping;
  }

  // ── Per-OSD statistics (used by the visualization) ────────────────────────

  /**
   * Returns the actual PG count per OSD across the full mapping.
   * Every OSD in the cluster map is present in the result, even if its count
   * is zero.
   * @param {ClusterMap} clusterMap
   * @param {Mapping}    mapping
   * @returns {Map<OsdId, number>}
   */
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

  /**
   * Returns the ideal (weight-proportional) PG count per OSD.
   * idealCount = (osdWeight / totalWeight) × pgCount × replicationFactor
   * @param {ClusterMap} clusterMap
   * @param {Pool}       pool
   * @returns {Map<OsdId, number>}
   */
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
