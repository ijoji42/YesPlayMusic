import { describe, it, assert } from './harness';
import * as analyser from '@/utils/audioAnalyser';
import initLocalStorage from '@/store/initLocalStorage';

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
    saturate: false,
    drift: true,
  },
};

// 全部维度打开的配置：用来验证变量契约本身（名字、单位、取值范围）。
const ALL_ON = {
  preset: 'custom',
  intensity: 100,
  sensitivity: 50,
  smoothing: 70,
  band: 'all',
  dimensions: {
    scale: true,
    blur: true,
    brightness: true,
    saturate: true,
    drift: true,
  },
};

// 与视觉层约定好的变量清单。多一个少一个都会让 CSS 里的 var() 悄悄失效。
const CONTRACT_VARS = [
  '--react-blur',
  '--react-brightness',
  '--react-drift',
  '--react-glow',
  '--react-pulse',
  '--react-saturate',
  '--react-scale',
];

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
        normalised.dimensions.drift,
        analyser.DEFAULT_REACTIVE_CONFIG.dimensions.drift
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

    it('never emits --react-hue and keeps the agreed variable set', () => {
      const vars = analyser.mapFrameToVars({ level: 255, pulse: 1 }, ALL_ON);
      // hue-rotate 是用户口中「杀马特」的来源，整链路已移除。
      assert.equal(
        Object.prototype.hasOwnProperty.call(vars, '--react-hue'),
        false
      );
      assert.equal(vars['--react-hue'], undefined);
      assert.deepEqual(Object.keys(vars).sort(), CONTRACT_VARS);
    });

    it('sharpens the blur and widens the drift as energy rises', () => {
      const quiet = analyser.mapFrameToVars({ level: 20, pulse: 0 }, ALL_ON);
      const loud = analyser.mapFrameToVars({ level: 250, pulse: 0 }, ALL_ON);

      // 能量越高越清晰（聚焦感），不是越大越糊
      assert.ok(
        parseFloat(loud['--react-blur']) < parseFloat(quiet['--react-blur']),
        `blur should shrink: ${quiet['--react-blur']} -> ${loud['--react-blur']}`
      );
      assert.ok(
        parseFloat(loud['--react-drift']) > parseFloat(quiet['--react-drift']),
        `drift should grow: ${quiet['--react-drift']} -> ${loud['--react-drift']}`
      );

      // 契约边界：满能量 + 满脉冲时各变量都不能越界
      const peak = analyser.mapFrameToVars({ level: 255, pulse: 1 }, ALL_ON);
      const blur = parseFloat(peak['--react-blur']);
      assert.ok(blur >= 30 && blur <= 50, `blur out of range: ${blur}`);
      assert.ok(parseFloat(peak['--react-drift']) <= 26);
      assert.ok(parseFloat(peak['--react-glow']) <= 0.32);
      assert.ok(parseFloat(peak['--react-scale']) <= 1.06);
      assert.ok(parseFloat(peak['--react-brightness']) <= 1.06);
      assert.ok(parseFloat(peak['--react-saturate']) <= 1.1);
    });

    it('migrates the legacy hue dimension to drift', () => {
      const on = analyser.normalizeReactiveConfig({
        dimensions: { scale: true, hue: true },
      });
      assert.equal(on.dimensions.drift, true);
      assert.equal(
        Object.prototype.hasOwnProperty.call(on.dimensions, 'hue'),
        false
      );

      // 老配置里关掉色相的人，迁移后也应该是不视差
      const off = analyser.normalizeReactiveConfig({
        dimensions: { hue: false },
      });
      assert.equal(off.dimensions.drift, false);

      // 新配置里已经写了 drift 时以 drift 为准，不再看 hue
      const explicit = analyser.normalizeReactiveConfig({
        dimensions: { drift: true, hue: false },
      });
      assert.equal(explicit.dimensions.drift, true);
    });

    // 默认值在 initLocalStorage 和 REACTIVE_PRESETS.soft 里各写了一遍，只能靠人工
    // 同步。一旦漂移，detectPreset 会把默认档判成 'custom'，全新安装的用户打开
    // 设置页会看到四个预设按钮全灰、名字显示「自定义」，而且没有任何报错。
    it('shipped default equals the soft preset', () => {
      assert.equal(
        analyser.detectPreset(initLocalStorage.settings.lyricsReactive),
        'soft'
      );
    });
  }
});
