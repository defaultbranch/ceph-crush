# CRUSH Algorithm Visualisation

An interactive, self-contained browser page that teaches Ceph's
[CRUSH](https://ceph.io/assets/pdfs/weil-crush-sc06.pdf) placement algorithm
through direct manipulation — no server, no build step, no dependencies.

![increment 5 screenshot placeholder](crush-visualization.md)

## What is CRUSH?

CRUSH (Controlled Replication Under Scalable Hashing) deterministically maps
every placement group (PG) to a set of OSDs using only the cluster map and a
hash — no central lookup table required. It is failure-domain aware (replicas
land on different hosts) and minimises data movement when the topology changes.

## Getting started

```bash
git clone <repo-url>
cd crush
# open in any modern browser — no web server needed
open crush-visualization.html          # macOS
xdg-open crush-visualization.html     # Linux
```

## What you can do

| Panel | Actions |
|-------|---------|
| **Cluster map** (SVG) | Visualises root → hosts → OSDs; OSD circles show actual / ideal PG count and shift green → amber as imbalance grows |
| **Pool configuration** | Adjust PG count (8 – 1024, powers of 2) and replication factor (2 / 3) |
| **Worst-case capacity** | Usable capacity for 0 / 1 / 2 host failures, always assuming the heaviest hosts fail first |
| **Topology controls** | Add / remove hosts and OSDs (with size picker); stable ids are never reused |

## Running the tests

The CRUSH engine and capacity analyser each have a Node.js smoke-test suite:

```bash
node crush-test.js      # 11 tests
node capacity-test.js   # 10 tests
```

Browser equivalents: open `crush-test.html` and `capacity-test.html`.

## File map

| File | Role |
|------|------|
| `crush-visualization.html` | Main page — orchestrator, state, non-extracted panels |
| `crush-map.js` | `<crush-map>` Web Component — SVG rendering (shadow DOM) |
| `bus.js` | `CrushBus` — tiny `EventTarget` event bus used by all components |
| `crush.js` | CRUSH engine: straw2 selection, failure-domain enforcement, stats |
| `capacity.js` | Worst-case usable capacity analysis |
| `types.js` | JSDoc `@typedef` declarations — no executable code |
| `test-style.css` | Shared stylesheet for test runners |

## Design notes

[crush-visualization.md](crush-visualization.md) is the authoritative design
document — full spec, key concepts, implementation notes, and per-increment
history. This README is a lightweight entry point that summarises and links to
it; detail always lives in the design doc.

## Implementation status

| # | Increment | Status |
|---|-----------|--------|
| 1 | Static cluster map | ✅ |
| 2 | CRUSH engine + tests | ✅ |
| 3 | PG distribution display | ✅ |
| 4 | Topology controls | ✅ |
| 5 | Pool config controls + component extraction | ✅ |
| 6 | Mark out / back in (restore vs rebalance) | planned |
| 7 | PG trace / step-through | planned |
| 8 | Algorithm parameters (bucket type, seed) | planned |
