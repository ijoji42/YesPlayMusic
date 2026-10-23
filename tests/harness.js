'use strict';

/**
 * Tiny synchronous test registry. No nesting semantics beyond a name prefix,
 * no globals beyond the ones this file returns, no dependencies.
 */

const assert = require('node:assert/strict');

/** @type {{ name: string, fn: Function }[]} */
const queue = [];
/** @type {{ prefix: string, fn: Function }[]} */
const beforeHooks = [];
/** @type {{ prefix: string, fn: Function }[]} */
const afterHooks = [];
/** @type {{ name: string, reason: string }[]} */
const skipped = [];

let prefix = '';

function qualify(name) {
  return prefix ? `${prefix} > ${name}` : name;
}

function describe(name, fn) {
  const previous = prefix;
  prefix = qualify(name);
  try {
    fn();
  } finally {
    prefix = previous;
  }
}

function register(name, fn) {
  queue.push({ name: qualify(name), fn });
}

register.skip = function skip(name, reason) {
  skipped.push({ name: qualify(name), reason: reason || 'skipped' });
};

function beforeEach(fn) {
  beforeHooks.push({ prefix, fn });
}

function afterEach(fn) {
  afterHooks.push({ prefix, fn });
}

const applies = (hook, testName) =>
  hook.prefix === '' || testName.startsWith(hook.prefix);

/**
 * Run every registered test in registration order, awaiting async ones.
 *
 * @param {{ ok: Function, fail: Function, skip: Function }} report
 */
async function run(report) {
  let index = 0;
  let passed = 0;
  const failures = [];

  for (const item of queue) {
    index += 1;
    try {
      for (const hook of beforeHooks) {
        if (applies(hook, item.name)) await hook.fn();
      }
      await item.fn();
      for (const hook of afterHooks) {
        if (applies(hook, item.name)) await hook.fn();
      }
      passed += 1;
      report.ok(index, item.name);
    } catch (error) {
      failures.push({ name: item.name, error });
      report.fail(index, item.name, error);
    }
  }

  // Skips are reported after the real cases so the numbering stays stable
  // regardless of whether the module under test exists yet.
  for (const item of skipped) {
    index += 1;
    report.skip(index, item.name, item.reason);
  }

  return { passed, failures, skipped: skipped.length, total: index };
}

module.exports = {
  assert,
  describe,
  it: register,
  test: register,
  beforeEach,
  afterEach,
  run,
  queue,
};
