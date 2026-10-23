import { describe, it, assert } from './harness';
import { bytesToSize, formatTrackTime } from '@/utils/common';

describe('common.formatTrackTime', () => {
  it('returns an empty string for falsy input', () => {
    assert.equal(formatTrackTime(0), '');
    assert.equal(formatTrackTime(undefined), '');
    assert.equal(formatTrackTime(null), '');
  });

  it('pads the seconds to two digits', () => {
    assert.equal(formatTrackTime(5), '0:05');
    assert.equal(formatTrackTime(59), '0:59');
    assert.equal(formatTrackTime(65), '1:05');
    assert.equal(formatTrackTime(600), '10:00');
  });

  it('keeps counting minutes past the one-hour mark', () => {
    assert.equal(formatTrackTime(3600), '60:00');
    assert.equal(formatTrackTime(3661), '61:01');
  });

  it('never produces NaN for negative input', () => {
    const value = formatTrackTime(-5);
    assert.equal(typeof value, 'string');
    assert.ok(!value.includes('NaN'));
  });
});

describe('common.bytesToSize', () => {
  it('reports raw bytes below 1 KiB', () => {
    // The store stub has no `lang`, so the zh-CN branch is taken.
    assert.equal(bytesToSize(0), '0字节');
    assert.equal(bytesToSize(1), '1字节');
    assert.equal(bytesToSize(1023), '1023字节');
  });

  it('switches unit exactly at 1 KiB / 1 MiB / 1 GiB', () => {
    assert.equal(bytesToSize(1024), '1.00 KB');
    assert.equal(bytesToSize(1024 * 1024), '1.00 MB');
    assert.equal(bytesToSize(1024 * 1024 * 1024), '1.00 GB');
  });

  it('rounds to two decimals within a unit', () => {
    assert.equal(bytesToSize(1536), '1.50 KB');
    assert.equal(bytesToSize(1024 * 1024 * 1.5), '1.50 MB');
  });
});
