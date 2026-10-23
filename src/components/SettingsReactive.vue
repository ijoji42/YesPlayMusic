<template>
  <div class="reactive-settings">
    <div class="top-row">
      <reactive-preview :cover-url="coverUrl" :config="config" />
      <div class="presets">
        <div class="field-label">
          {{ $t('settings.lyricsReactive.preset') }}
        </div>
        <div class="preset-buttons">
          <button
            v-for="name in presetNames"
            :key="name"
            class="preset"
            :class="{ active: config.preset === name }"
            type="button"
            @click="applyPreset(name)"
          >
            {{ $t(`settings.lyricsReactive.presets.${name}`) }}
          </button>
        </div>
        <p class="hint">{{ $t('settings.lyricsReactive.desc') }}</p>
      </div>
    </div>

    <div class="slider-grid">
      <div v-for="item in sliders" :key="item.key" class="slider-row">
        <div class="field-label">
          {{ $t(`settings.lyricsReactive.${item.key}`) }}
          <span class="value">{{ config[item.key] }}</span>
        </div>
        <vue-slider
          :value="config[item.key]"
          :min="0"
          :max="100"
          :interval="1"
          :duration="0"
          :drag-on-click="true"
          :dot-size="12"
          tooltip="none"
          @change="value => patch({ [item.key]: value })"
        />
      </div>
    </div>

    <div class="bottom-row">
      <div class="band">
        <div class="field-label">
          {{ $t('settings.lyricsReactive.band') }}
        </div>
        <select
          :value="config.band"
          @change="patch({ band: $event.target.value })"
        >
          <option v-for="band in bands" :key="band" :value="band">
            {{ $t(`settings.lyricsReactive.bands.${band}`) }}
          </option>
        </select>
      </div>
      <div class="dimensions">
        <div class="field-label">
          {{ $t('settings.lyricsReactive.dimensions') }}
        </div>
        <div class="checks">
          <label
            v-for="key in dimensionKeys"
            :key="key"
            class="check"
            :class="{ on: config.dimensions[key] }"
          >
            <input
              type="checkbox"
              :checked="config.dimensions[key]"
              @change="
                patch({
                  dimensions: { [key]: $event.target.checked },
                })
              "
            />
            <span>{{
              $t(`settings.lyricsReactive.dimensionNames.${key}`)
            }}</span>
          </label>
        </div>
      </div>
    </div>

    <p v-if="reducedMotion" class="notice">
      {{ $t('settings.lyricsReactive.reducedMotion') }}
    </p>
  </div>
</template>

<script>
import { mapState } from 'vuex';
import VueSlider from 'vue-slider-component';
import ReactivePreview from '@/components/ReactivePreview.vue';
import {
  REACTIVE_PRESETS,
  DEFAULT_REACTIVE_CONFIG,
  normalizeReactiveConfig,
  detectPreset,
} from '@/utils/audioAnalyser';

const PRESET_NAMES = ['soft', 'punchy', 'beatOnly', 'breathe'];
const DIMENSION_KEYS = ['scale', 'blur', 'brightness', 'hue', 'saturate'];

export default {
  name: 'SettingsReactive',
  components: { VueSlider, ReactivePreview },
  data() {
    return {
      presetNames: PRESET_NAMES,
      dimensionKeys: DIMENSION_KEYS,
      bands: ['bass', 'mid', 'treble', 'all'],
      sliders: [
        { key: 'intensity' },
        { key: 'sensitivity' },
        { key: 'smoothing' },
      ],
      reducedMotion: false,
    };
  },
  computed: {
    ...mapState(['settings', 'player']),
    config() {
      return normalizeReactiveConfig(
        this.settings.lyricsReactive || DEFAULT_REACTIVE_CONFIG
      );
    },
    coverUrl() {
      return this.player.currentTrack?.al?.picUrl || '';
    },
  },
  created() {
    this.motionQuery =
      typeof window !== 'undefined' && window.matchMedia
        ? window.matchMedia('(prefers-reduced-motion: reduce)')
        : null;
    if (this.motionQuery) {
      this.reducedMotion = this.motionQuery.matches;
      this.onMotionChange = e => {
        this.reducedMotion = e.matches;
      };
      // Safari 13 / Chromium 91 都支持 addListener；addEventListener 在
      // 老版本上不存在，两个都兜一下
      if (this.motionQuery.addEventListener) {
        this.motionQuery.addEventListener('change', this.onMotionChange);
      } else if (this.motionQuery.addListener) {
        this.motionQuery.addListener(this.onMotionChange);
      }
    }
  },
  beforeDestroy() {
    if (!this.motionQuery || !this.onMotionChange) return;
    if (this.motionQuery.removeEventListener) {
      this.motionQuery.removeEventListener('change', this.onMotionChange);
    } else if (this.motionQuery.removeListener) {
      this.motionQuery.removeListener(this.onMotionChange);
    }
  },
  methods: {
    /**
     * 所有改动都走这里：合并 → 反查预设名 → 一次性提交。
     * 必须是不可变更新（换新对象），Vue 2 才能侦测到变化并触发持久化插件。
     */
    patch(patchObject) {
      const current = this.config;
      const next = Object.assign({}, current, patchObject);
      if (patchObject.dimensions) {
        next.dimensions = Object.assign(
          {},
          current.dimensions,
          patchObject.dimensions
        );
      }
      // 手动微调后，如果刚好又等于某个预设，就显示那个预设名；
      // 否则显示「自定义」。
      next.preset = detectPreset(next);
      this.$store.commit('updateSettings', {
        key: 'lyricsReactive',
        value: next,
      });
    },
    applyPreset(name) {
      const preset = REACTIVE_PRESETS[name];
      if (!preset) return;
      this.$store.commit('updateSettings', {
        key: 'lyricsReactive',
        value: Object.assign({ preset: name }, preset, {
          dimensions: Object.assign({}, preset.dimensions),
        }),
      });
    },
  },
};
</script>

<style lang="scss" scoped>
.reactive-settings {
  padding: 12px 0 4px;

  .field-label {
    font-size: 13px;
    color: var(--color-secondary);
    margin-bottom: 8px;
    display: flex;
    align-items: center;
    gap: 8px;

    .value {
      color: var(--color-text);
      font-variant-numeric: tabular-nums;
    }
  }

  .top-row {
    display: flex;
    gap: 20px;
    align-items: flex-start;
    margin-bottom: 20px;
  }

  .presets {
    flex: 1;
    min-width: 0;
  }

  .preset-buttons {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }

  .preset {
    padding: 6px 14px;
    border: none;
    border-radius: 999px;
    font-size: 13px;
    cursor: pointer;
    color: var(--color-text);
    background: var(--color-secondary-bg-for-transparent);
    transition: background-color 0.2s, color 0.2s;

    &:hover {
      background: var(--color-primary-bg-for-transparent);
    }

    &.active {
      background: var(--color-primary);
      color: #fff;
    }
  }

  .hint {
    margin: 10px 0 0;
    font-size: 12px;
    line-height: 18px;
    color: var(--color-secondary);
  }

  .slider-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 20px;
    margin-bottom: 20px;
  }

  .bottom-row {
    display: grid;
    grid-template-columns: 200px 1fr;
    gap: 20px;
    align-items: start;
  }

  select {
    width: 100%;
    padding: 6px 10px;
    border: none;
    border-radius: 8px;
    font-size: 13px;
    color: var(--color-text);
    background: var(--color-secondary-bg-for-transparent);
  }

  .checks {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }

  .check {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 5px 12px;
    border-radius: 999px;
    font-size: 13px;
    cursor: pointer;
    color: var(--color-secondary);
    background: var(--color-secondary-bg-for-transparent);
    transition: background-color 0.2s, color 0.2s;

    input {
      // 视觉上用胶囊的选中态表达，隐藏原生勾选框但保留可聚焦性
      position: absolute;
      opacity: 0;
      width: 0;
      height: 0;
    }

    &.on {
      color: var(--color-text);
      background: var(--color-primary-bg-for-transparent);
    }

    &:focus-within {
      outline: 2px solid var(--color-primary);
      outline-offset: 2px;
    }
  }

  .notice {
    margin: 16px 0 0;
    padding: 8px 12px;
    border-radius: 8px;
    font-size: 12px;
    line-height: 18px;
    color: var(--color-text);
    background: var(--color-primary-bg-for-transparent);
  }
}

@media (max-width: 900px) {
  .reactive-settings {
    .top-row,
    .bottom-row {
      flex-direction: column;
      grid-template-columns: 1fr;
    }

    .slider-grid {
      grid-template-columns: 1fr;
      gap: 12px;
    }
  }
}

@media (prefers-reduced-motion: reduce) {
  .reactive-settings .preset,
  .reactive-settings .check {
    transition: none;
  }
}
</style>
