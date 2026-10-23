import { describe, it, assert } from './harness';
// `isSafeCacheUrl` is not exported by the module (it is an internal guard), so
// `tests/run.js` appends it as a named export at bundle time via the
// `expose-internals` esbuild plugin. The assertions below therefore run against
// the real shipped implementation.
import { isSafeCacheUrl } from '@/utils/db';

describe('db.isSafeCacheUrl', () => {
  it('rejects non-http(s) schemes', () => {
    assert.equal(isSafeCacheUrl('javascript:alert(1)'), false);
    assert.equal(isSafeCacheUrl('file:///etc/passwd'), false);
    assert.equal(isSafeCacheUrl('ftp://example.com/a.mp3'), false);
    assert.equal(isSafeCacheUrl('blob:https://example.com/uuid'), false);
  });

  it('rejects loopback and RFC1918 / link-local hosts', () => {
    const blocked = [
      'http://localhost/a.mp3',
      'http://localhost:10754/api',
      'http://0.0.0.0/a.mp3',
      'http://127.0.0.1/a.mp3',
      'http://127.0.0.1:8080/a.mp3',
      'http://10.1.2.3/a.mp3',
      'http://192.168.1.5/a.mp3',
      'http://169.254.169.254/latest/meta-data',
      'http://172.16.0.1/a.mp3',
      'http://172.31.255.255/a.mp3',
      'http://[::1]/a.mp3',
    ];
    for (const url of blocked) {
      assert.equal(isSafeCacheUrl(url), false, `should reject ${url}`);
    }
  });

  it('accepts public https, base64 data URLs and 172.32+ (outside the private range)', () => {
    assert.equal(isSafeCacheUrl('https://m701.music.126.net/x.mp3'), true);
    assert.equal(isSafeCacheUrl('http://m701.music.126.net/x.mp3'), true);
    assert.equal(isSafeCacheUrl('data:audio/mp3;base64,AAAA'), true);
    // 172.16.0.0/12 ends at 172.31.255.255 — 172.32.x.x is public.
    assert.equal(isSafeCacheUrl('http://172.32.0.1/a.mp3'), true);
  });

  it('rejects values that are not parseable URLs', () => {
    assert.equal(isSafeCacheUrl(''), false);
    assert.equal(isSafeCacheUrl('not a url'), false);
    assert.equal(isSafeCacheUrl(null), false);
    assert.equal(isSafeCacheUrl(undefined), false);
  });
});
