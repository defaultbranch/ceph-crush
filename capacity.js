'use strict';

/// <reference path="./types.js" />

/**
 * @fileoverview Worst-case usable capacity analysis for a CRUSH cluster.
 *
 * Depends on {@link CRUSH} (crush.js) for {@link CRUSH.hostWeight}.
 * Load order in HTML: types.js → crush.js → capacity.js.
 */

// Browser: CRUSH is already a global defined by crush.js (loaded first).
// Node.js: require crush.js explicitly.
/* global CRUSH */
const _CRUSH = typeof CRUSH !== 'undefined' ? CRUSH : require('./crush.js');

const CAPACITY = (() => {

  /**
   * Computes worst-case usable capacity scenarios for 0, 1, and 2 host failures.
   *
   * "Worst case" means the heaviest hosts fail first, maximising capacity loss.
   *
   * Capacity model:
   * - **hosts > RF**  — CRUSH distributes proportionally; all remaining hosts
   *   fill at the same rate. `usableTB = sum(remaining weights) / RF`.
   * - **hosts == RF** — every PG lands on every host; the smallest host is the
   *   bottleneck. `usableTB = min(remaining weights)`.
   * - **hosts < RF**  — failure-domain constraint cannot be satisfied; the
   *   cluster is degraded (existing data readable, full replication lost).
   *
   * Hosts whose effective weight is zero (all OSDs out, or host itself out)
   * are excluded from the analysis because CRUSH already ignores them.
   *
   * @param {ClusterMap} map - Current cluster topology.
   * @param {number}     rf  - Replication factor (pool.replicationFactor).
   * @returns {CapacityScenario[]} One entry per failure count (0 … min(2, hosts)).
   */
  function worstCaseCapacity(map, rf) {
    const weights = map.hosts
      .map(h => _CRUSH.hostWeight(h))
      .filter(w => w > 0)
      .sort((a, b) => b - a); // descending → heaviest fails first

    const scenarios = [];
    for (let f = 0; f <= Math.min(2, weights.length); f++) {
      const rem = weights.slice(f);
      const n   = rem.length;
      let status, usableTB;
      if (n === 0)       { status = 'unavailable'; usableTB = null; }
      else if (n < rf)   { status = 'degraded';    usableTB = null; }
      else if (n === rf) { status = 'ok';          usableTB = Math.min(...rem); }
      else               { status = 'ok';          usableTB = rem.reduce((s, w) => s + w, 0) / rf; }
      scenarios.push({ failures: f, hostsRemaining: n, status, usableTB });
    }
    return scenarios;
  }

  // ── Public API ──────────────────────────────────────────────────────────────
  return { worstCaseCapacity };

})();

// Allow loading with require() in Node.js without breaking browser <script> usage.
if (typeof module !== 'undefined') module.exports = CAPACITY;
