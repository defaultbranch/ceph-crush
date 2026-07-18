'use strict';

/**
 * @fileoverview <crush-map> custom element.
 *
 * Renders the CRUSH cluster topology as an SVG tree (root → hosts → OSDs)
 * with actual/ideal PG count labels and green→amber imbalance colouring.
 *
 * Subscribes to the 'state-changed' event on CrushBus.  The event detail must
 * carry { clusterMap, pool, counts, ideals } — pre-computed by the orchestrator
 * so this component is a pure renderer with no CRUSH computation of its own,
 * except for CRUSH.hostWeight() which is a trivial weight sum.
 *
 * Depends on globals: CrushBus (bus.js), CRUSH (crush.js).
 */

class CrushMap extends HTMLElement {

  // ── layout constants ───────────────────────────────────────────────────────
  static SVG_W    = 820;
  static SLOT_W   = 90;
  static MARGIN_X = 95;
  static Y_ROOT   = 60;
  static Y_HOST   = 210;
  static Y_OSD    = 360;
  static ROOT_W   = 120; static ROOT_H = 40; static ROOT_R = 6;
  static HOST_W   = 110; static HOST_H = 40; static HOST_R = 6;
  static OSD_R    = 38;
  static NS       = 'http://www.w3.org/2000/svg';

  constructor() {
    super();
    const shadow = this.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        :host { display: block; }
        .svg-wrap { overflow-x: auto; }
        svg {
          background: #fff;
          border: 1px solid #dde;
          border-radius: 6px;
          display: block;
        }
        .legend {
          display: flex;
          gap: 1.5rem;
          margin-top: 0.75rem;
          font-size: 0.82rem;
          color: #555;
          align-items: center;
          font-family: system-ui, sans-serif;
        }
        .legend-item { display: flex; align-items: center; gap: 0.35rem; }
        .legend-swatch {
          width: 14px; height: 14px; border-radius: 3px; display: inline-block;
        }
        .legend-swatch.root { background: #2c3e50; }
        .legend-swatch.host { background: #2980b9; }
        .legend-swatch.osd  { background: #27ae60; border-radius: 50%; }
      </style>
      <div class="svg-wrap"><svg width="820" height="460"></svg></div>
      <div class="legend">
        <span class="legend-item"><span class="legend-swatch root"></span>Root (cluster)</span>
        <span class="legend-item"><span class="legend-swatch host"></span>Host (failure domain)</span>
        <span class="legend-item"><span class="legend-swatch osd"></span>OSD (size in TB)</span>
      </div>`;
    this._svg    = shadow.querySelector('svg');
    this._unsubs = [];
  }

  connectedCallback() {
    this._unsubs = [
      CrushBus.on('state-changed', d => this._update(d)),
    ];
  }

  disconnectedCallback() {
    this._unsubs.forEach(u => u());
    this._unsubs = [];
  }

  // ── private ────────────────────────────────────────────────────────────────

  /**
   * @param {{ clusterMap: ClusterMap, counts: Map<OsdId,number>, ideals: Map<OsdId,number> }} detail
   */
  _update({ clusterMap, counts, ideals }) {
    this._render(clusterMap, { counts, ideals });
  }

  /**
   * @param {ClusterMap} map
   * @param {{ counts: Map<OsdId,number>, ideals: Map<OsdId,number> }} stats
   */
  _render(map, stats) {
    const svg = this._svg;
    while (svg.firstChild) svg.removeChild(svg.firstChild);

    const layout     = this._computeLayout(map);
    const totalSlots = map.hosts.reduce((s, h) => s + Math.max(h.osds.length, 1), 0);
    svg.setAttribute('width', Math.max(CrushMap.SVG_W,
      CrushMap.MARGIN_X * 2 + totalSlots * CrushMap.SLOT_W));

    // connectors (behind nodes)
    for (const hl of layout.hosts) {
      svg.appendChild(this._connector(
        layout.rootCx, layout.rootCy + CrushMap.ROOT_H / 2,
        hl.cx,         hl.cy        - CrushMap.HOST_H / 2));
      for (const ol of hl.osds) {
        svg.appendChild(this._connector(
          hl.cx, hl.cy + CrushMap.HOST_H / 2,
          ol.cx, ol.cy - CrushMap.OSD_R));
      }
    }

    // root node
    const totalWeight = map.hosts.reduce((s, h) => s + CRUSH.hostWeight(h), 0);
    svg.appendChild(this._roundedRect(layout.rootCx, layout.rootCy,
      CrushMap.ROOT_W, CrushMap.ROOT_H, CrushMap.ROOT_R, '#2c3e50'));
    svg.appendChild(this._label(layout.rootCx, layout.rootCy - 9, map.name, { bold: true }));
    svg.appendChild(this._label(layout.rootCx, layout.rootCy + 9,
      `${totalWeight} TB`, { size: 11, fill: '#a8bfd4' }));

    // host nodes
    for (const hl of layout.hosts) {
      const hw = CRUSH.hostWeight(hl.host);
      svg.appendChild(this._roundedRect(hl.cx, hl.cy,
        CrushMap.HOST_W, CrushMap.HOST_H, CrushMap.HOST_R, '#2980b9'));
      svg.appendChild(this._label(hl.cx, hl.cy - 9, hl.host.name, { size: 13 }));
      svg.appendChild(this._label(hl.cx, hl.cy + 9,
        `${hw} TB`, { size: 11, fill: '#a8d4f0' }));
    }

    // OSD nodes
    for (const hl of layout.hosts) {
      for (const ol of hl.osds) {
        const actual = stats.counts.get(ol.osd.id) ?? 0;
        const ideal  = stats.ideals.get(ol.osd.id) ?? 0;
        const fill   = this._osdColor(actual, ideal);
        svg.appendChild(this._el('circle', { cx: ol.cx, cy: ol.cy, r: CrushMap.OSD_R, fill }));
        svg.appendChild(this._label(ol.cx, ol.cy - 14, `osd.${ol.osd.id}`, { size: 12, bold: true }));
        svg.appendChild(this._label(ol.cx, ol.cy + 1,  `${ol.osd.size} TB`, { size: 11, fill: '#ddf0e8' }));
        svg.appendChild(this._label(ol.cx, ol.cy + 16,
          `${actual} / ${ideal.toFixed(1)}`, { size: 10 }));
      }
    }
  }

  /**
   * Assigns (cx, cy) to every host and OSD.
   * Empty hosts get one reserved slot so they remain visible.
   * @param {ClusterMap} map
   * @returns {{ rootCx: number, rootCy: number, hosts: Array }}
   */
  _computeLayout(map) {
    let slot = 0;
    const hosts = [];

    for (const host of map.hosts) {
      const osds = host.osds.map(osd => {
        const cx = CrushMap.MARGIN_X + slot * CrushMap.SLOT_W + CrushMap.SLOT_W / 2;
        slot++;
        return { osd, cx, cy: CrushMap.Y_OSD };
      });
      let cx;
      if (osds.length === 0) {
        cx = CrushMap.MARGIN_X + slot * CrushMap.SLOT_W + CrushMap.SLOT_W / 2;
        slot++;
      } else {
        cx = osds.reduce((s, o) => s + o.cx, 0) / osds.length;
      }
      hosts.push({ host, cx, cy: CrushMap.Y_HOST, osds });
    }

    const rootCx = hosts.reduce((s, h) => s + h.cx, 0) / hosts.length;
    return { rootCx, rootCy: CrushMap.Y_ROOT, hosts };
  }

  /**
   * Interpolate from green (#27ae60) toward amber (#e67e22) as the deviation
   * of actual from ideal exceeds the ±20 % threshold.
   * @param {number} actual
   * @param {number} ideal
   * @returns {string} CSS colour
   */
  _osdColor(actual, ideal) {
    if (ideal <= 0) return '#27ae60';
    const dev = Math.abs(actual - ideal) / ideal;
    if (dev <= 0.20) return '#27ae60';
    const t = Math.min((dev - 0.20) / 0.20, 1.0);
    const r = Math.round(39  + t * (230 - 39));
    const g = Math.round(174 + t * (126 - 174));
    const b = Math.round(96  + t * (34  - 96));
    return `rgb(${r},${g},${b})`;
  }

  // ── SVG helpers ────────────────────────────────────────────────────────────

  _el(tag, attrs, text) {
    const e = document.createElementNS(CrushMap.NS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    if (text !== undefined) e.textContent = text;
    return e;
  }

  _connector(x1, y1, x2, y2) {
    return this._el('line', { x1, y1, x2, y2, stroke: '#b0b8c8', 'stroke-width': 2 });
  }

  _roundedRect(cx, cy, w, h, r, fill) {
    return this._el('rect', {
      x: cx - w / 2, y: cy - h / 2, width: w, height: h, rx: r, ry: r, fill,
    });
  }

  _label(x, y, text, opts = {}) {
    return this._el('text', {
      x, y,
      'text-anchor':        'middle',
      'dominant-baseline':  'middle',
      fill:                 opts.fill || '#fff',
      'font-size':          opts.size || 13,
      'font-family':        'system-ui, sans-serif',
      'font-weight':        opts.bold ? 'bold' : 'normal',
    }, text);
  }
}

customElements.define('crush-map', CrushMap);
