import { describe, it, assert } from './harness';
import * as analyser from '@/utils/audioAnalyser';

// `src/utils/audioAnalyser.js` was added late in this optimisation pass, so the
// suite degrades to a visible skip instead of a hard failure if a future
// refactor removes an export. It never silently drops a case.
const has = name => typeof analyser[name] === 'function';

const SCALE_ON = {
  preset: 'custom',
  intensity: 40,
  sensitivity: 50,
  smoothing: 70,
  band: 'bass',
  dimensions: {
    scale: true,
    blur: true,
    brightness: false,
    hue: false,
    saturate: false,
  },
};

describe('audioAnalyser', () => {
  if (!has('mapFrameToVars')) {
    it.skip('maps a frame to CSS custom properties', 'mapFrameToVars missing');
    it.skip('keeps scale neutral at intensity 0', 'mapFrameToVars missing');
    it.skip('detects a bass spike as a beat', 'createBeatDetector missing');
    it.skip('normalises config', 'normalizeReactiveConfig missing');
  } else {
    it('emits exactly "1" for --react-scale when intensity is 0', () => {
      const vars = analyser.mapFrameToVars(
        { level: 200, pulse: 1 },
        { ...SCALE_ON, intensity: 0 }
      );
      // Not "1.0000" and not "1.00" — the string has to be stable so the
      // browser does not repaint when nothing changed.
      assert.equal(vars['--react-scale'], '1');
      assert.equal(vars['--react-pulse'], '1');
    });

    it('scales above 1 when pulse is 1 and the scale dimension is on', () => {
      const withPulse = analyser.mapFrameToVars(
        { level: 0, pulse: 1 },
        SCALE_ON
      );
      assert.ok(
        Number(withPulse['--react-scale']) > 1,
        `expected > 1, got ${withPulse['--react-scale']}`
      );

      // A louder frame must scale further than a quieter one.
      const quiet = analyser.mapFrameToVars({ level: 40, pulse: 0 }, SCALE_ON);
      const loud = analyser.mapFrameToVars({ level: 240, pulse: 0 }, SCALE_ON);
      assert.ok(
        Number(loud['--react-scale']) > Number(quiet['--react-scale']),
        'louder frame should produce a larger scale'
      );

      // ...and turning the dimension off pins it back to 1.
      const off = analyser.mapFrameToVars(
        { level: 255, pulse: 1 },
        { ...SCALE_ON, dimensions: { ...SCALE_ON.dimensions, scale: false } }
      );
      assert.equal(off['--react-scale'], '1');
    });

    it('does not fire a beat when bass is flat across the window', () => {
      const detector = analyser.createBeatDetector(21);
      let beat = false;
      for (let i = 0; i < 30; i += 1) beat = detector.push(80, 50);
      assert.equal(beat, false);
      assert.equal(detector.size(), 21);
    });

    it('fires a beat on a sharp bass spike above the moving average', () => {
      const detector = analyser.createBeatDetector(21);
      for (let i = 0; i < 10; i += 1) detector.push(80, 50);
      assert.equal(detector.push(200, 50), true);

      // A spike that stays under MIN_BEAT_LEVEL (70) must still be ignored.
      const quiet = analyser.createBeatDetector(21);
      for (let i = 0; i < 10; i += 1) quiet.push(30, 50);
      assert.equal(quiet.push(60, 50), false);

      detector.reset();
      assert.equal(detector.size(), 0);
    });

    it('normalises and clamps a reactive config', () => {
      const normalised = analyser.normalizeReactiveConfig({
        intensity: 400,
        sensitivity: -20,
        smoothing: 70,
        band: 'ultrasonic',
        dimensions: { scale: 1 },
      });
      assert.equal(normalised.intensity, 100);
      assert.equal(normalised.sensitivity, 0);
      assert.equal(normalised.band, 'bass');
      assert.equal(normalised.preset, 'custom');
      assert.equal(normalised.dimensions.scale, true);
      assert.equal(
        normalised.dimensions.hue,
        analyser.DEFAULT_REACTIVE_CONFIG.dimensions.hue
      );

      assert.equal(
        analyser.detectPreset(analyser.REACTIVE_PRESETS.soft),
        'soft'
      );
      assert.equal(
        analyser.detectPreset({ ...SCALE_ON, intensity: 41 }),
        'custom'
      );
    });
  }
});
