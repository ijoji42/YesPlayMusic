'use strict';

/**
 * Inert stand-in for browser/Electron-only or stateful modules.
 *
 * The test runner maps heavy bare specifiers (`howler`, `dexie`, `axios`,
 * `@/store`, ...) onto this file so that a module under test can be imported
 * in plain Node without a DOM, a network, or a Vuex instance.
 *
 * Every property access, call and `new` returns the same proxy, so chains such
 * as `new Dexie('x').version(5).stores({})` or `store.state.settings.lang`
 * evaluate without throwing.
 */

const inert = new Proxy(function inert() {}, {
  get(target, prop) {
    // Never look like a thenable: `await inert` must not hang.
    if (prop === 'then') return undefined;
    if (prop === Symbol.toPrimitive) return () => '';
    if (prop === Symbol.iterator) return function* empty() {};
    if (prop === Symbol.toStringTag) return 'InertStub';
    if (prop === 'toString') return () => '';
    if (prop === 'valueOf') return () => '';
    if (prop === 'toJSON') return () => ({});
    // Keep `for (const k in inert)` and `Object.keys(inert)` empty so that
    // esbuild's CJS interop helper does not try to copy anything.
    if (prop === '__esModule') return false;
    return inert;
  },
  apply() {
    return inert;
  },
  construct() {
    return inert;
  },
  has() {
    return true;
  },
  // A function target always owns non-configurable `prototype`, so the trap has
  // to report the real own keys or Node throws an invariant violation.
  ownKeys(target) {
    return Reflect.ownKeys(target);
  },
  getOwnPropertyDescriptor(target, prop) {
    const own = Reflect.getOwnPropertyDescriptor(target, prop);
    if (own) return own;
    return {
      configurable: true,
      enumerable: true,
      writable: true,
      value: inert,
    };
  },
});

module.exports = inert;
module.exports.default = inert;
