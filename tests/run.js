'use strict';

/**
 * Zero-dependency test runner.
 *
 * `node_modules` is not installable in this environment (see
 * `docs/smoke-test.md`), so there is no Vitest/Jest here. Instead we bundle
 * `tests/index.js` with the esbuild that is already a runtime dependency and
 * require the resulting CommonJS file in this very process.
 *
 * Usage: node tests/run.js
 */

const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const STUB = path.join(__dirname, 'stubs', 'empty.js');
const BUILD_DIR = path.join(__dirname, '.build');
const ENTRY = path.join(__dirname, 'index.js');
const OUT_FILE = path.join(BUILD_DIR, 'bundle.cjs');

/**
 * Bare specifiers that cannot run in plain Node: browser-only APIs, Electron
 * IPC, IndexedDB, or modules that build a Vuex store at import time.
 */
const STUB_EXACT = [
  'axios',
  'change-case',
  'color',
  'core-js',
  'crypto-js',
  'dayjs',
  'dexie',
  'electron',
  'electron-log',
  'electron-store',
  'howler',
  'js-cookie',
  'jsbi',
  'lodash',
  'md5',
  'node-vibrant',
  'nprogress',
  'plyr',
  'qrcode',
  'register-service-worker',
  'vue',
  'vue-clipboard2',
  'vue-gtag',
  'vue-i18n',
  'vue-router',
  'vue-slider-component',
  'vuex',
];

/**
 * Resolved `src/` paths that must be replaced by the stub. Matching on the
 * *resolved* path (rather than on the `@/` prefix) keeps `@/store` stubbed while
 * `@/store/initLocalStorage` still resolves to the real module.
 */
const STUB_SRC_FILES = [
  path.join(SRC, 'store', 'index.js'),
  path.join(SRC, 'utils', 'request.js'),
];
const STUB_SRC_DIRS = [
  path.join(SRC, 'api'),
  path.join(SRC, 'store', 'plugins'),
];

/**
 * Files whose non-exported helpers the suite needs to reach. esbuild appends
 * the listed names as named exports at load time, so the assertions run against
 * the real shipped implementation instead of a copy.
 */
const EXPOSE_INTERNALS = {
  [path.join('utils', 'db.js')]: ['isSafeCacheUrl'],
};

// esbuild treats a path returned from onResolve as final and does not apply
// `resolveExtensions` to it, so the extension is probed here.
const RESOLVE_SUFFIXES = ['', '.js', '.json', '.mjs', '.cjs'];

function resolveUnderSrc(base) {
  for (const suffix of RESOLVE_SUFFIXES) {
    const candidate = `${base}${suffix}`;
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch (error) {
      /* keep probing */
    }
  }
  for (const suffix of RESOLVE_SUFFIXES) {
    const candidate = path.join(base, `index${suffix}`);
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch (error) {
      /* keep probing */
    }
  }
  return base;
}

function isStubbedSrcPath(resolved) {
  if (STUB_SRC_FILES.includes(resolved)) return true;
  return STUB_SRC_DIRS.some(
    dir => resolved === dir || resolved.startsWith(`${dir}${path.sep}`)
  );
}

/**
 * Single resolver: bare browser-only specifiers and `@/` app singletons go to
 * the stub, every other `@/` specifier is expanded to `src/`.
 */
const resolvePlugin = {
  name: 'stub-and-alias',
  setup(build) {
    build.onResolve({ filter: /.*/ }, args => {
      if (STUB_EXACT.includes(args.path)) return { path: STUB };
      if (!args.path.startsWith('@/')) return null;
      const resolved = resolveUnderSrc(path.join(SRC, args.path.slice(2)));
      if (isStubbedSrcPath(resolved)) return { path: STUB };
      return { path: resolved };
    });
  },
};

const exposePlugin = {
  name: 'expose-internals',
  setup(build) {
    for (const [relative, names] of Object.entries(EXPOSE_INTERNALS)) {
      const absolute = path.join(SRC, relative);
      const escaped = absolute
        .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        .replace(/\\\\/g, '[\\\\/]');
      build.onLoad({ filter: new RegExp(`^${escaped}$`) }, args => {
        const contents = fs.readFileSync(args.path, 'utf8');
        return {
          contents: `${contents}\nexport { ${names.join(', ')} };\n`,
          loader: 'js',
        };
      });
    }
  },
};

// esbuild throws "Cannot use plugins in synchronous API calls" for buildSync,
// so the async build() is used instead. It is awaited in main().
function bundle() {
  fs.mkdirSync(BUILD_DIR, { recursive: true });
  return esbuild.build({
    entryPoints: [ENTRY],
    outfile: OUT_FILE,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    logLevel: 'silent',
    resolveExtensions: ['.js', '.json', '.mjs', '.cjs'],
    mainFields: ['module', 'main'],
    // The resolve plugin must win over esbuild's default resolution so that
    // browser-only bare specifiers and `@/` singletons never hit the real file.
    plugins: [resolvePlugin, exposePlugin],
  });
}

function createReporter() {
  return {
    ok(index, name) {
      process.stdout.write(`ok ${index} - ${name}\n`);
    },
    fail(index, name, error) {
      process.stdout.write(`not ok ${index} - ${name}\n`);
      const message = (error && (error.message || String(error))) || '';
      for (const line of String(message).split('\n')) {
        process.stdout.write(`  # ${line}\n`);
      }
      if (error && error.stack) {
        const frame = String(error.stack)
          .split('\n')
          .slice(1, 4)
          .map(line => `  # ${line.trim()}`)
          .join('\n');
        process.stdout.write(`${frame}\n`);
      }
    },
    skip(index, name, reason) {
      process.stdout.write(`ok ${index} - ${name} # SKIP ${reason}\n`);
    },
  };
}

async function main() {
  const startedAt = Date.now();

  try {
    await bundle();
  } catch (error) {
    process.stderr.write('failed to bundle the test entry\n');
    process.stderr.write(`${(error && error.message) || error}\n`);
    process.exit(1);
  }

  // eslint-disable-next-line global-require
  const harness = require(OUT_FILE);
  const reporter = createReporter();
  const result = await harness.run(reporter);
  const elapsed = Date.now() - startedAt;

  const parts = [
    `${result.passed} passed`,
    `${result.failures.length} failed`,
    `${result.skipped} skipped`,
  ];
  process.stdout.write(`\n1..${result.total}\n`);
  process.stdout.write(`${parts.join(', ')} (${elapsed}ms)\n`);

  if (result.failures.length > 0) {
    process.stdout.write('\nfailures:\n');
    for (const failure of result.failures) {
      process.stdout.write(`  - ${failure.name}\n`);
    }
    process.exit(1);
  }

  if (result.total === 0) {
    process.stdout.write('no tests were registered\n');
    process.exit(1);
  }
}

main().catch(error => {
  process.stderr.write(`${(error && error.stack) || error}\n`);
  process.exit(1);
});
