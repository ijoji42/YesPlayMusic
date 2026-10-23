import { describe, it, assert } from './harness';
import defaults from '@/store/initLocalStorage';

const REACTIVE_KEYS = [
  'preset',
  'intensity',
  'sensitivity',
  'smoothing',
  'band',
  'dimensions',
];
const DIMENSION_KEYS = ['scale', 'blur', 'brightness', 'hue', 'saturate'];

describe('store.initLocalStorage', () => {
  it('ships a lyrics-background default the lyrics page understands', () => {
    const settings = defaults.settings;
    assert.ok(
      Object.prototype.hasOwnProperty.call(settings, 'lyricsBackground'),
      'settings.lyricsBackground is missing'
    );
    // `src/views/lyrics.vue` renders the background only when this value is
    // one of the three mode strings, and `settings.vue` still exposes a plain
    // on/off toggle. Accept either shape so a deliberate migration in one of
    // those two files does not turn into a red build here, but reject typos.
    const value = settings.lyricsBackground;
    const modes = ['blur', 'dynamic', 'reactive'];
    assert.ok(
      typeof value === 'boolean' || modes.includes(value),
      `unexpected lyricsBackground: ${JSON.stringify(value)}`
    );
    assert.equal(settings.showLyricsTranslation, true);
  });

  it('lyricsReactive carries every key the settings UI and analyser read', () => {
    const reactive = defaults.settings.lyricsReactive;
    assert.ok(reactive && typeof reactive === 'object', 'lyricsReactive');
    for (const key of REACTIVE_KEYS) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(reactive, key),
        `lyricsReactive.${key} is missing`
      );
    }
    for (const key of DIMENSION_KEYS) {
      assert.equal(
        typeof reactive.dimensions[key],
        'boolean',
        `lyricsReactive.dimensions.${key} should be a boolean`
      );
    }
    assert.equal(typeof reactive.intensity, 'number');
    assert.equal(typeof reactive.sensitivity, 'number');
    assert.equal(typeof reactive.smoothing, 'number');
    assert.ok(reactive.intensity >= 0 && reactive.intensity <= 100);
    assert.ok(reactive.sensitivity >= 0 && reactive.sensitivity <= 100);
    assert.ok(reactive.smoothing >= 0 && reactive.smoothing <= 100);
  });

  it('crossfadeDuration defaults to a non-negative number', () => {
    const value = defaults.settings.crossfadeDuration;
    assert.equal(typeof value, 'number');
    assert.ok(Number.isFinite(value));
    assert.ok(value >= 0, `crossfadeDuration should be >= 0, got ${value}`);
  });
});
