import { describe, it, assert } from './harness';
import { lyricParser, parseLyric } from '@/utils/lyrics';

describe('lyrics', () => {
  it('parses [mm:ss.xx] timestamps into seconds', () => {
    const parsed = parseLyric('[00:00.10] Test\n[00:12.34] Twelve');
    assert.equal(parsed.length, 2);
    assert.equal(parsed[0].time, 0.1);
    assert.equal(parsed[1].time, 12.34);
    assert.equal(parsed[1].content, 'Twelve');
    // rawTime is normalised to a 2-digit fraction, which is what the
    // translation-merging code keys on.
    assert.equal(parsed[1].rawTime, '[00:12.34]');
  });

  it('expands a line carrying several timestamps into one entry each', () => {
    const parsed = parseLyric('[00:01.00][00:03.00] chorus');
    assert.deepEqual(
      parsed.map(line => line.time),
      [1, 3]
    );
    assert.deepEqual(
      parsed.map(line => line.content),
      ['chorus', 'chorus']
    );
  });

  it('drops lines with no trailing text and keeps the rest', () => {
    const parsed = parseLyric('[00:01.00] a\n[00:02.00]\n[00:03.00] c');
    assert.deepEqual(
      parsed.map(line => line.time),
      [1, 3]
    );
  });

  it('sorts by time regardless of input order', () => {
    const parsed = parseLyric('[00:03.00] c\n[00:01.00] a\n[00:02.00] b');
    assert.deepEqual(
      parsed.map(line => line.content),
      ['a', 'b', 'c']
    );
  });

  it('does not throw on malformed input', () => {
    assert.deepEqual(parseLyric(''), []);
    assert.deepEqual(parseLyric('   '), []);
    assert.deepEqual(parseLyric('no timestamps at all'), []);
    // Non-numeric timestamp: matched by the line regex, rejected by the
    // timestamp regex, so the line is silently skipped.
    assert.deepEqual(parseLyric('[00:xx] broken'), []);
  });

  it('pairs a translation line with its original via identical rawTime', () => {
    const main = parseLyric('[00:12.34] 你好');
    const trans = parseLyric('[00:12.34] Hello');
    assert.equal(main.length, 1);
    assert.equal(trans.length, 1);
    assert.equal(main[0].rawTime, trans[0].rawTime);
    assert.equal(main[0].content, '你好');
    assert.equal(trans[0].content, 'Hello');
  });

  it('lyricParser tolerates a missing payload', () => {
    const empty = lyricParser({});
    assert.deepEqual(empty.lyric, []);
    assert.deepEqual(empty.tlyric, []);
    assert.deepEqual(empty.romalyric, []);
    assert.equal(empty.lyricuser, undefined);
    assert.equal(empty.transuser, undefined);

    // No argument at all must not throw either.
    assert.deepEqual(lyricParser().lyric, []);
  });
});
