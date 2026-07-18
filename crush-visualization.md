# CRUSH Algorithm Visualization

## Overview

A self-contained, interactive HTML page that teaches Ceph's CRUSH placement
algorithm through direct manipulation. The user builds a small cluster, configures
a pool, and observes how PGs are distributed — and how that distribution changes
when the topology or failure state changes. No server, no dependencies: one file,
open in a browser.

## What is CRUSH?

CRUSH (Controlled Replication Under Scalable Hashing) is the algorithm Ceph uses
to deterministically compute where every piece of data lives in the cluster. Given
a placement-group (PG) ID and a cluster map, CRUSH walks a hierarchy of buckets
and selects one OSD per required replica, without consulting any central authority
or lookup table.

Key properties:
- **Deterministic** — the same inputs always produce the same OSD selection.
- **Decentralised** — any client or OSD can compute the mapping independently.
- **Failure-domain aware** — replicas are placed across distinct failure domains
  (hosts, racks, datacenters) as configured.
- **Minimal data movement** — when the cluster map changes, only the PGs that
  *must* move do so; everything else stays put.

## Topology

The visualization uses the simplest meaningful hierarchy:

```
root
 └── host  (failure domain)
      └── OSD
           └── PGs
```

The failure domain is the **host**: no two replicas of the same PG are allowed on
OSDs that belong to the same host. This is the most common real-world configuration.

## Controls and Interactions

### Topology controls
| Action | Effect |
|--------|--------|
| Add host | Adds a new host to the cluster map; triggers a rebalance |
| Remove host | Permanently removes the host and all its OSDs; triggers a rebalance |
| Add OSD to host | Adds an OSD with a chosen size (weight); triggers a rebalance |
| Remove OSD | Permanently removes an OSD; triggers a rebalance |
| Mark OSD / host out | Sets effective weight to 0; triggers a restore |
| Mark OSD / host back in | Restores original weight; reverses the restore |

### Pool configuration
| Parameter | Notes |
|-----------|-------|
| PG count | Slider: 8 / 16 / 32 / 64. Low values make individual PG movements visible; higher values show the law-of-large-numbers smoothing |
| Replication factor | 2 or 3 replicas per PG |

### Algorithm parameters
| Parameter | Notes |
|-----------|-------|
| Bucket type | uniform, list, straw2 — affects how weight influences selection probability and how much data moves on topology changes |
| Hash seed | CRUSH is fully deterministic; changing the seed produces a different but equally valid mapping |

## Key Concepts Illustrated

### 1. Deterministic, decentralised placement
Given the same cluster map and PG ID, any node computes the identical OSD set.
The visualization lets the user pick a PG and trace the algorithm step by step
through the bucket hierarchy.

### 2. Failure-domain guarantees
Replicas always land on OSDs belonging to different hosts. The visualization
highlights when a topology change would make this guarantee impossible to satisfy
(e.g. fewer hosts than the replication factor).

### 3. Restore moves vs rebalance moves

**Restore** — triggered when an OSD or host is *marked out* (temporary failure):
- The affected PGs remap to other OSDs to maintain the replication factor.
- The remapped PGs are *displaced from their canonical home* — the cluster map
  still records where they belong.
- When the OSD is marked back in, those PGs and only those PGs move back.
- Data movement is bounded by the lost OSD's share of total capacity.

**Rebalance** — triggered when an OSD or host is *permanently added or removed*:
- The canonical mapping changes; there is no "home to return to".
- CRUSH minimises the number of PGs that change OSD (straw2 is specifically
  designed for this).
- Data movement is bounded by delta_weight / new_total_weight of stored data.

The UI distinguishes these by showing **PGs in transit** (displaced from canonical
location) vs **PGs settled**.

### 4. Distribution quality and PG count
The display shows, for each OSD, the *actual* PG count alongside the *ideal*
fractional count derived from its weight. At low PG counts the rounding error
(quantization noise) is large and visible; increasing PG count smooths it out.
This illustrates why production clusters use large PG counts.

### 5. Weight-proportional placement
OSDs with larger declared size receive proportionally more PGs. The visualization
makes this visible through the ideal PG line on each OSD.

## Implementation Notes

- Pure HTML/CSS/JavaScript, no external dependencies.
- SVG is used for all graphical output (cluster map, PG distribution).
- CRUSH is implemented as a simplified but faithful straw2-style algorithm in
  JavaScript (configurable bucket type).
- State is kept in a plain JavaScript object; every control change recomputes
  the full mapping from scratch and re-renders.
- A step-through panel animates the algorithm's traversal for a selected PG.

## Implementation Plan

The page is built in eight increments, each independently testable in a browser.

| # | Increment | Deliverable |
|---|-----------|-------------|
| 1 | **Static cluster map** | Render a hardcoded topology (3 hosts, a few OSDs each) as an SVG tree. No interactivity — establish the visual layout. |
| 2 | **CRUSH algorithm core** | Implement the JS mapping engine (straw2 bucket selection, failure-domain enforcement). Given a fixed map and pool config, compute OSD assignments for every PG. Verify in the browser console. |
| 3 | **PG distribution display** | Show actual vs ideal PG counts on each OSD in the SVG. The cluster map now reflects a real mapping. |
| 4 | **Topology controls** | Control panel: add/remove host, add/remove OSD with size picker. Every change recomputes and re-renders. |
| 5 | **Pool config controls** | PG count slider (8 / 16 / 32 / 64) and replication factor selector (2 / 3). Wired to the engine. |
| 6 | **Mark out / back in** | Per-OSD and per-host out/in toggle. Display PGs in transit (displaced from canonical location) vs PGs settled. Restore vs rebalance becomes visible. |
| 7 | **PG trace / step-through** | Click a PG to step through the algorithm's tree traversal, with the chosen path highlighted in the SVG. |
| 8 | **Algorithm parameters** | Bucket type selector (uniform / list / straw2) and hash seed input. |
