'use strict';

/**
 * @fileoverview Shared JSDoc type definitions for the CRUSH visualisation.
 *
 * This file contains no executable code. Load it before any module that
 * references these types so that editors and documentation tools can resolve
 * the @typedef references across files.
 */

/**
 * A single Object Storage Daemon.
 *
 * @typedef {Object} OSD
 * @property {number}  id   - Stable numeric OSD id; never reused after removal.
 * @property {number}  size - Declared capacity in TB; used directly as weight.
 * @property {boolean} out  - true = temporarily excluded from placement.
 */

/**
 * A host (failure domain). No two replicas of the same PG may land on OSDs
 * belonging to the same host.
 *
 * @typedef {Object} Host
 * @property {string}  id   - Stable string id; never reused after removal.
 * @property {number}  hid  - Stable numeric id used by the CRUSH hash.
 * @property {string}  name - Display name.
 * @property {boolean} out  - true = treat all OSDs on this host as out.
 * @property {OSD[]}   osds - OSDs attached to this host.
 */

/**
 * The cluster topology fed to the CRUSH engine.
 *
 * @typedef {Object} ClusterMap
 * @property {string} name  - Display name for the root bucket.
 * @property {Host[]} hosts - All hosts in the cluster.
 */

/**
 * Pool configuration that controls PG placement.
 *
 * @typedef {Object} Pool
 * @property {number} pgCount           - Total number of placement groups.
 * @property {number} replicationFactor - Number of replicas per PG.
 * @property {number} seed              - Integer mixed into every hash; changing
 *                                        it produces a different but equally
 *                                        valid mapping without altering the
 *                                        algorithm.
 */

/**
 * Complete PG → OSD mapping for a pool.
 * Each entry maps a PG id (0-based integer) to an array of OSD ids.
 * The array length equals replicationFactor when enough hosts are available,
 * and is shorter in degraded mode.
 *
 * @typedef {Map<number, number[]>} Mapping
 */

/**
 * One scenario in the worst-case capacity analysis.
 *
 * @typedef {Object} CapacityScenario
 * @property {number}              failures       - Number of hosts assumed lost.
 * @property {number}              hostsRemaining - Hosts still available.
 * @property {'ok'|'degraded'|'unavailable'} status
 *   - ok: full replication maintainable.
 *   - degraded: fewer hosts than RF; existing data readable, full replication lost.
 *   - unavailable: no hosts remaining.
 * @property {number|null} usableTB
 *   - Estimated usable (net) capacity in TB, or null when degraded/unavailable.
 */
