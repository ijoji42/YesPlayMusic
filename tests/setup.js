'use strict';

/* global globalThis */
// eslint 6 ships an espree whose `env` list predates `globalThis`, so declare it
// explicitly instead of adding a `.eslintignore` entry that would stop linting
// the whole test suite.

/**
 * DOM / storage shims. Imported first from `tests/index.js` so that the
 * modules under test can touch these globals at import time without blowing up.
 *
 * Nothing here emulates real behaviour beyond storing strings — if a test ever
 * depends on the DOM actually doing something, it should not live in this
 * suite.
 */

function createStorage() {
  /** @type {Map<string, string>} */
  const store = new Map();
  return {
    getItem(key) {
      const value = store.get(String(key));
      return value === undefined ? null : value;
    },
    setItem(key, value) {
      store.set(String(key), String(value));
    },
    removeItem(key) {
      store.delete(String(key));
    },
    clear() {
      store.clear();
    },
    key(i) {
      return Array.from(store.keys())[i] ?? null;
    },
    get length() {
      return store.size;
    },
  };
}

if (typeof globalThis.localStorage === 'undefined') {
  globalThis.localStorage = createStorage();
}

if (typeof globalThis.sessionStorage === 'undefined') {
  globalThis.sessionStorage = createStorage();
}

if (typeof globalThis.window === 'undefined') {
  globalThis.window = globalThis;
}

if (typeof globalThis.navigator === 'undefined') {
  globalThis.navigator = { userAgent: 'node-test-harness', language: 'zh-CN' };
}

if (typeof globalThis.document === 'undefined') {
  const element = {
    style: { setProperty() {}, getPropertyValue: () => '' },
    setAttribute() {},
    getAttribute: () => null,
    removeAttribute() {},
    appendChild() {},
    removeChild() {},
    addEventListener() {},
    removeEventListener() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
  };
  globalThis.document = {
    body: element,
    documentElement: element,
    head: element,
    createElement: () => element,
    querySelector: () => element,
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
    execCommand: () => true,
  };
}

module.exports = {};
