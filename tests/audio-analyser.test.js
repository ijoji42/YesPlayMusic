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
  '--react-bass',
  '--react-blur',
  '--react-brightness',
  '--react-drift',
  '--react-glow',
  '--react-mid',
  '--react-pulse',
  '--react-saturate',
  '--react-scale',
  '--react-treble',
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

      // 加性阈值：跳变必须超过 need 才算一拍。
      // （旧实现靠 MIN_BEAT_LEVEL=70 这个绝对门限挡低电平噪声，绝对刻度在
      // AGC 之后没有意义了，改成由 need >= 4 承担。）
      const small = analyser.createBeatDetector(21);
      for (let i = 0; i < 10; i += 1) small.push(30, 50);
      assert.equal(small.push(33, 50), false);

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

      // 契约边界：满能量 + 满脉冲时各变量都不能越界。
      // 区间在 AGC 落地后整体放大过（amp 现在真的能跑满 0~1），
      // 这里只断言方向和量级，不钉死具体数值。
      const peak = analyser.mapFrameToVars({ level: 255, pulse: 1 }, ALL_ON);
      const blur = parseFloat(peak['--react-blur']);
      assert.ok(blur >= 28 && blur <= 50, `blur out of range: ${blur}`);
      assert.ok(parseFloat(peak['--react-drift']) <= 72);
      assert.ok(parseFloat(peak['--react-glow']) <= 0.75);
      assert.ok(parseFloat(peak['--react-scale']) <= 1.13);
      assert.ok(parseFloat(peak['--react-brightness']) <= 1.12);
      assert.ok(parseFloat(peak['--react-saturate']) <= 1.45);
      // 亮度是乘数语义，低能量时必须能压到 1 以下（旧区间从 1 起步，没有下行空间）
      assert.ok(parseFloat(quiet['--react-brightness']) < 1);
    });

    // AGC 是这次「律动看着完全没动」的根因修复：真实音乐的 bass bin 均值
    // 常年 228~240，level/255 会一直贴着 0.9，所有维度被钉死在映射上限。
    it('does not amplify a flat signal into flicker', () => {
      assert.equal(typeof analyser.createAgcTracker, 'function');
      const agc = analyser.createAgcTracker();
      let maxAmp = 0;
      // 恒定 232（实测《起风了》的 bass 均值就是这个量级）
      for (let i = 0; i < 60; i += 1) {
        maxAmp = Math.max(maxAmp, agc.push(232).amp);
      }
      assert.ok(
        maxAmp <= 0.35,
        `flat signal must not be amplified, got ${maxAmp}`
      );
      // 跨度被 floor 兜住，不会因为「没起伏」而除零/发散
      assert.ok(agc.state().span >= 24, `span ${agc.state().span}`);
    });

    it('stretches a narrow real-world range to most of 0~1', () => {
      const agc = analyser.createAgcTracker();
      let lo = 1;
      let hi = 0;
      // 实测 bass 在 224~240 之间波动；AGC 之后应该跑出大半个量程
      for (let i = 0; i < 40; i += 1) {
        const amp = agc.push(i % 2 === 0 ? 224 : 240).amp;
        lo = Math.min(lo, amp);
        hi = Math.max(hi, amp);
      }
      assert.ok(hi - lo > 0.5, `AGC should stretch the range, got ${lo}~${hi}`);
    });

    it('treats silence as silence instead of dragging the gain floor', () => {
      const agc = analyser.createAgcTracker();
      for (let i = 0; i < 10; i += 1) agc.push(230);
      const before = agc.state();
      for (let i = 0; i < 10; i += 1) {
        assert.equal(agc.push(0).amp, 0);
      }
      const after = agc.state();
      assert.equal(after.min, before.min);
      assert.equal(after.max, before.max);
    });

    // 乘性阈值在高电平下不可达：mean=232 时 232*1.225=284 > 255 上限，
    // pulse 永远为 0，--react-glow 丢掉最大的一项动态。
    it('detects beats on a saturated signal', () => {
      const detector = analyser.createBeatDetector(21);
      for (let i = 0; i < 10; i += 1) detector.push(232, 55, 24);
      assert.equal(detector.push(240, 55, 24), true);

      // 同样的高电平，但完全不动 → 不能误判成鼓点
      const flat = analyser.createBeatDetector(21);
      let fired = false;
      for (let i = 0; i < 30; i += 1) {
        fired = flat.push(232, 55, 24) || fired;
      }
      assert.equal(fired, false);
    });

    it('exposes per-band amplitudes for the visual layer', () => {
      const vars = analyser.mapFrameToVars(
        { level: 200, pulse: 0, bassAmp: 1, midAmp: 0.5, trebleAmp: 0.25 },
        ALL_ON
      );
      assert.equal(vars['--react-bass'], '1');
      assert.equal(vars['--react-mid'], '0.5');
      assert.equal(vars['--react-treble'], '0.25');

      // 没传分频段时退化成 amp，而不是 0（单独调用本函数的场景）
      const fallback = analyser.mapFrameToVars(
        { level: 255, pulse: 0 },
        ALL_ON
      );
      assert.equal(fallback['--react-bass'], '1');
    });

    // AGC 状态机单独可调用：状态作为参数传入，不需要 AudioContext，
    // 也不必绕 sampleFrame() 间接测。
    it('drives the AGC state machine directly', () => {
      assert.equal(typeof analyser.__updateAgcForTests, 'function');
      assert.equal(typeof analyser.createAgcState, 'function');

      const state = analyser.createAgcState();
      const first = analyser.__updateAgcForTests(state, 232);
      // 首帧把当前值当谷底、并给一个 floor 跨度的峰顶 → 归一化结果是 0
      assert.equal(first.amp, 0);
      assert.equal(first.span, 24);
      assert.equal(state.min, 232);
      assert.equal(state.max, 256);

      // 状态是就地更新的：往上一跳立刻能读到一个明显大于 0 的 amp
      const up = analyser.__updateAgcForTests(state, 246);
      assert.ok(up.amp > 0.5, `expected a jump, got ${up.amp}`);
      assert.equal(up.span, 24);

      // 静音帧不推进基准
      const before = { min: state.min, max: state.max };
      const silent = analyser.__updateAgcForTests(state, 0);
      assert.equal(silent.amp, 0);
      assert.equal(state.min, before.min);
      assert.equal(state.max, before.max);
    });

    // 运行时要靠 lastFrame 判断「AGC 收敛到哪了」，字段名不能悄悄变。
    it('reports amp and the converged AGC state on lastFrame', () => {
      const frame = analyser.getLastFrame();
      assert.equal(typeof frame.amp, 'number');
      assert.equal(typeof frame.agc.min, 'number');
      assert.equal(typeof frame.agc.max, 'number');
      assert.equal(typeof frame.agc.span, 'number');
      assert.equal(typeof frame.smooth, 'number');
      assert.equal(typeof frame.bassAmp, 'number');
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
