'use strict';

/**
 * @fileoverview Application-wide event bus.
 *
 * Components emit and subscribe to named events here instead of calling each
 * other directly, keeping inter-component coupling to zero.
 *
 * Usage:
 *   CrushBus.emit('state-changed', { clusterMap, pool, counts, ideals });
 *   const unsub = CrushBus.on('state-changed', ({ clusterMap, pool }) => { … });
 *   unsub(); // unsubscribe
 */

const CrushBus = (() => {
  const target = new EventTarget();
  return {
    /**
     * Subscribe to a named event.
     * @param {string}   event
     * @param {function} cb    - receives event.detail as its sole argument
     * @returns {function}     - call to unsubscribe
     */
    on(event, cb) {
      const handler = e => cb(e.detail);
      target.addEventListener(event, handler);
      return () => target.removeEventListener(event, handler);
    },

    /**
     * Emit a named event with an optional detail payload.
     * @param {string} event
     * @param {*}      [detail]
     * @returns {void}
     */
    emit(event, detail) {
      target.dispatchEvent(new CustomEvent(event, { detail }));
    },
  };
})();
