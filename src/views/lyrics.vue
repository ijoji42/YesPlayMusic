<template>
  <transition name="slide-up">
    <div
      class="lyrics-page"
      :class="{ 'no-lyric': noLyric }"
      :data-theme="theme"
    >
      <div
        v-if="
          settings.lyricsBackground === 'blur' ||
          settings.lyricsBackground === 'dynamic' ||
          settings.lyricsBackground === 'reactive'
        "
        ref="lyricsBackground"
        class="lyrics-background"
        :class="{
          'dynamic-background': settings.lyricsBackground === 'dynamic',
          'reactive-background': settings.lyricsBackground === 'reactive',
        }"
      >
        <div
          class="top-right"
          :style="{ backgroundImage: `url(${bgImageUrl})` }"
        />
        <div
          class="bottom-left"
          :style="{ backgroundImage: `url(${bgImageUrl})` }"
        />
      </div>
      <div
        v-if="settings.lyricsBackground === true"
        class="gradient-background"
        :style="{ background }"
      ></div>

      <!-- 律动的两层可见信号：整片暗幕（亮度呼吸）+ 三团大光斑（频段 + 节拍）。
           它们必须是 .lyrics-page 的直接子节点：任何带 z-index / filter /
           overflow 的包装层都会新建层叠上下文，光斑的 mix-blend-mode 就混不到
           下面的模糊封面上了。 -->
      <div
        v-if="settings.lyricsBackground === 'reactive'"
        class="react-veil"
        aria-hidden="true"
      ></div>
      <div
        v-if="settings.lyricsBackground === 'reactive'"
        class="react-orbs"
        :style="reactiveAccentStyle"
        aria-hidden="true"
      >
        <div class="react-orb a"></div>
        <div class="react-orb b"></div>
        <div class="react-orb c"></div>
      </div>

      <!-- 纯装饰的抖动噪点层，用来打散 8-bit 色深下的渐变台阶 -->
      <div class="lyrics-grain" aria-hidden="true"></div>

      <div class="left-side">
        <div>
          <div v-if="settings.showLyricsTime" class="date">
            {{ date }}
          </div>
          <div class="cover">
            <div class="cover-container">
              <img :src="imageUrl" loading="lazy" />
              <div
                class="shadow"
                :style="{ backgroundImage: `url(${imageUrl})` }"
              ></div>
            </div>
          </div>
          <div class="controls">
            <div class="top-part">
              <div class="track-info">
                <div class="title" :title="currentTrack.name">
                  <router-link
                    v-if="hasList()"
                    :to="`${getListPath()}`"
                    @click.native="toggleLyrics"
                    >{{ currentTrack.name }}
                  </router-link>
                  <span v-else>
                    {{ currentTrack.name }}
                  </span>
                </div>
                <div class="subtitle">
                  <router-link
                    v-if="artist.id !== 0"
                    :to="`/artist/${artist.id}`"
                    @click.native="toggleLyrics"
                    >{{ artist.name }}
                  </router-link>
                  <span v-else>
                    {{ artist.name }}
                  </span>
                  <span v-if="album.id !== 0">
                    -
                    <router-link
                      :to="`/album/${album.id}`"
                      :title="album.name"
                      @click.native="toggleLyrics"
                      >{{ album.name }}
                    </router-link>
                  </span>
                </div>
              </div>
              <div class="top-right">
                <div class="volume-control">
                  <button-icon :title="$t('player.mute')" @click.native="mute">
                    <svg-icon v-show="volume > 0.5" icon-class="volume" />
                    <svg-icon v-show="volume === 0" icon-class="volume-mute" />
                    <svg-icon
                      v-show="volume <= 0.5 && volume !== 0"
                      icon-class="volume-half"
                    />
                  </button-icon>
                  <div class="volume-bar">
                    <vue-slider
                      v-model="volume"
                      :min="0"
                      :max="1"
                      :interval="0.01"
                      :drag-on-click="true"
                      :duration="0"
                      tooltip="none"
                      :dot-size="12"
                    ></vue-slider>
                  </div>
                </div>
                <div class="buttons">
                  <button-icon
                    :title="$t('player.like')"
                    @click.native="likeATrack(player.currentTrack.id)"
                  >
                    <svg-icon
                      :icon-class="
                        player.isCurrentTrackLiked ? 'heart-solid' : 'heart'
                      "
                    />
                  </button-icon>
                  <button-icon
                    :title="$t('contextMenu.addToPlaylist')"
                    @click.native="addToPlaylist"
                  >
                    <svg-icon icon-class="plus" />
                  </button-icon>
                  <!-- <button-icon @click.native="openMenu" title="Menu"
                    ><svg-icon icon-class="more"
                  /></button-icon> -->
                </div>
              </div>
            </div>
            <div class="progress-bar">
              <PlayerProgress compact />
            </div>
            <div class="media-controls">
              <button-icon
                v-show="!player.isPersonalFM"
                :title="
                  player.repeatMode === 'one'
                    ? $t('player.repeatTrack')
                    : $t('player.repeat')
                "
                :class="{ active: player.repeatMode !== 'off' }"
                @click.native="switchRepeatMode"
              >
                <svg-icon
                  v-show="player.repeatMode !== 'one'"
                  icon-class="repeat"
                />
                <svg-icon
                  v-show="player.repeatMode === 'one'"
                  icon-class="repeat-1"
                />
              </button-icon>
              <div class="middle">
                <button-icon
                  v-show="!player.isPersonalFM"
                  :title="$t('player.previous')"
                  @click.native="playPrevTrack"
                >
                  <svg-icon icon-class="previous" />
                </button-icon>
                <button-icon
                  v-show="player.isPersonalFM"
                  title="不喜欢"
                  @click.native="moveToFMTrash"
                >
                  <svg-icon icon-class="thumbs-down" />
                </button-icon>
                <button-icon
                  id="play"
                  :title="$t(player.playing ? 'player.pause' : 'player.play')"
                  @click.native="playOrPause"
                >
                  <svg-icon :icon-class="player.playing ? 'pause' : 'play'" />
                </button-icon>
                <button-icon
                  :title="$t('player.next')"
                  @click.native="playNextTrack"
                >
                  <svg-icon icon-class="next" />
                </button-icon>
              </div>
              <button-icon
                v-show="!player.isPersonalFM"
                :title="$t('player.shuffle')"
                :class="{ active: player.shuffle }"
                @click.native="switchShuffle"
              >
                <svg-icon icon-class="shuffle" />
              </button-icon>
              <button-icon
                v-show="
                  isShowLyricTypeSwitch &&
                  $store.state.settings.showLyricsTranslation &&
                  lyricType === 'translation'
                "
                :title="$t('player.translationLyric')"
                @click.native="switchLyricType"
              >
                <span class="lyric-switch-icon">译</span>
              </button-icon>
              <button-icon
                v-show="
                  isShowLyricTypeSwitch &&
                  $store.state.settings.showLyricsTranslation &&
                  lyricType === 'romaPronunciation'
                "
                :title="$t('player.PronunciationLyric')"
                @click.native="switchLyricType"
              >
                <span class="lyric-switch-icon">音</span>
              </button-icon>
            </div>
          </div>
        </div>
      </div>
      <div class="right-side">
        <transition name="slide-fade">
          <div
            v-show="!noLyric"
            ref="lyricsContainer"
            class="lyrics-container"
            :style="lyricFontSize"
          >
            <div id="line-1" class="line"></div>
            <div
              v-for="(line, index) in lyricToShow"
              :id="`line${index}`"
              :key="index"
              class="line"
              :class="{
                highlight: highlightLyricIndex === index,
              }"
              @click="clickLyricLine(line.time)"
              @dblclick="clickLyricLine(line.time, true)"
            >
              <div class="content">
                <span
                  v-if="line.contents[0]"
                  @click.right="openLyricMenu($event, line, 0)"
                  >{{ line.contents[0] }}</span
                >
                <br />
                <span
                  v-if="
                    line.contents[1] &&
                    $store.state.settings.showLyricsTranslation
                  "
                  class="translation"
                  @click.right="openLyricMenu($event, line, 1)"
                  >{{ line.contents[1] }}</span
                >
              </div>
            </div>
            <div id="line-end" class="line"></div>
            <ContextMenu v-if="!noLyric" ref="lyricMenu">
              <div class="item" @click="copyLyric(false)">{{
                $t('contextMenu.copyLyric')
              }}</div>
              <div
                v-if="
                  rightClickLyric &&
                  rightClickLyric.contents[1] &&
                  $store.state.settings.showLyricsTranslation
                "
                class="item"
                @click="copyLyric(true)"
                >{{ $t('contextMenu.copyLyricWithTranslation') }}</div
              >
            </ContextMenu>
          </div>
        </transition>
      </div>
      <div class="close-button" @click="toggleLyrics">
        <button>
          <svg-icon icon-class="arrow-down" />
        </button>
      </div>
      <div class="close-button" style="left: 24px" @click="fullscreen">
        <button>
          <svg-icon v-if="isFullscreen" icon-class="fullscreen-exit" />
          <svg-icon v-else icon-class="fullscreen" />
        </button>
      </div>
    </div>
  </transition>
</template>

<script>
// The lyrics page of Apple Music is so gorgeous, so I copy the design.
// Some of the codes are from https://github.com/sl1673495/vue-netease-music

import { mapState, mapMutations, mapActions } from 'vuex';
import VueSlider from 'vue-slider-component';
import ContextMenu from '@/components/ContextMenu.vue';
import { formatTrackTime } from '@/utils/common';
import { getLyric, getCloudLyric } from '@/api/track';
import { lyricParser, copyLyric, parseLyric } from '@/utils/lyrics';
import ButtonIcon from '@/components/ButtonIcon.vue';
import PlayerProgress from '@/components/PlayerProgress.vue';
import * as Vibrant from 'node-vibrant/dist/vibrant.worker.min.js';
import Color from 'color';
import { isAccountLoggedIn } from '@/utils/auth';
import { hasListSource, getListSourcePath } from '@/utils/playList';
import {
  subscribe,
  setReactiveConfig,
  mapFrameToVars,
  supportsReactive,
  normalizeReactiveConfig,
  DEFAULT_REACTIVE_CONFIG,
} from '@/utils/audioAnalyser';
import locale from '@/locale';

const electron =
  process.env.IS_ELECTRON === true ? window.require('electron') : null;
const ipcRenderer = electron?.ipcRenderer || null;

// 系统级「减弱动态效果」。放在模块作用域而不是 data 里：它不需要触发重渲染，
// 而 shouldRunReactive 在播放/切歌/开关歌词页时本来就会被重新求值。
function prefersReducedMotion() {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// 每帧写入 .lyrics-page 的自定义属性全集。停循环时按这份清单逐个清掉，
// 保证回落到 CSS 里的静态值，而不是冻结在最后一帧。
const REACTIVE_VARS = [
  '--react-scale',
  '--react-blur',
  '--react-brightness',
  '--react-saturate',
  '--react-pulse',
  '--react-drift',
  '--react-glow',
  '--react-bass',
  '--react-mid',
  '--react-treble',
  '--react-power',
];

export default {
  name: 'Lyrics',
  components: {
    VueSlider,
    ButtonIcon,
    ContextMenu,
    PlayerProgress,
  },
  data() {
    return {
      lyricsInterval: null,
      lyric: [],
      tlyric: [],
      romalyric: [],
      lyricType: 'translation', // or 'romaPronunciation'
      highlightLyricIndex: -1,
      minimize: true,
      background: '',
      date: this.formatTime(new Date()),
      isFullscreen: !!document.fullscreenElement,
      rightClickLyric: null,
      // 律动背景的运行时状态：不进 Vuex，避免每帧触发整页重渲染
      reactiveUnsubscribe: null,
      reactiveConfig: normalizeReactiveConfig(
        this.$store.state.settings.lyricsReactive || DEFAULT_REACTIVE_CONFIG
      ),
      // 从封面取到的主色，"r, g, b" 形式。光斑用它染色，取不到时由 CSS
      // 里的 var() 回退值接管（深色主题白、浅色主题冷灰）。
      reactiveAccent: '',
      // 主色旋转 40° 后的互补色，给第二团光斑用，避免两团同色糊成一束追光。
      reactiveAccentAlt: '',
    };
  },
  computed: {
    ...mapState(['player', 'settings', 'showLyrics']),
    currentTrack() {
      return this.player.currentTrack;
    },
    volume: {
      get() {
        return this.player.volume;
      },
      set(value) {
        this.player.volume = value;
      },
    },
    imageUrl() {
      return this.player.currentTrack?.al?.picUrl + '?param=1024y1024';
    },
    bgImageUrl() {
      // 首启时 _currentTrack 还没有 al（曲目详情尚未拉回来），直接拼串会得到
      // "undefined?param=512y512"，浏览器会为这个无效地址发一次请求并把背景
      // 刷黑。默认效果改成「动态」后这条路径每次首启都会走到，所以必须挡住。
      const picUrl = this.player.currentTrack?.al?.picUrl;
      return picUrl ? `${picUrl}?param=512y512` : '';
    },
    isShowLyricTypeSwitch() {
      return this.romalyric.length > 0 && this.tlyric.length > 0;
    },
    lyricToShow() {
      return this.lyricType === 'translation'
        ? this.lyricWithTranslation
        : this.lyricWithRomaPronunciation;
    },
    lyricWithTranslation() {
      let ret = [];
      // 空内容的去除
      const lyricFiltered = this.lyric.filter(({ content }) =>
        Boolean(content)
      );
      // content统一转换数组形式
      if (lyricFiltered.length) {
        lyricFiltered.forEach(l => {
          const { rawTime, time, content } = l;
          const lyricItem = { time, content, contents: [content] };
          const sameTimeTLyric = this.tlyric.find(
            ({ rawTime: tLyricRawTime }) => tLyricRawTime === rawTime
          );
          if (sameTimeTLyric) {
            const { content: tLyricContent } = sameTimeTLyric;
            if (content) {
              lyricItem.contents.push(tLyricContent);
            }
          }
          ret.push(lyricItem);
        });
      } else {
        ret = lyricFiltered.map(({ time, content }) => ({
          time,
          content,
          contents: [content],
        }));
      }
      return ret;
    },
    lyricWithRomaPronunciation() {
      let ret = [];
      // 空内容的去除
      const lyricFiltered = this.lyric.filter(({ content }) =>
        Boolean(content)
      );
      // content统一转换数组形式
      if (lyricFiltered.length) {
        lyricFiltered.forEach(l => {
          const { rawTime, time, content } = l;
          const lyricItem = { time, content, contents: [content] };
          const sameTimeRomaLyric = this.romalyric.find(
            ({ rawTime: tLyricRawTime }) => tLyricRawTime === rawTime
          );
          if (sameTimeRomaLyric) {
            const { content: romaLyricContent } = sameTimeRomaLyric;
            if (content) {
              lyricItem.contents.push(romaLyricContent);
            }
          }
          ret.push(lyricItem);
        });
      } else {
        ret = lyricFiltered.map(({ time, content }) => ({
          time,
          content,
          contents: [content],
        }));
      }
      return ret;
    },
    lyricFontSize() {
      return {
        fontSize: `${this.$store.state.settings.lyricFontSize || 28}px`,
      };
    },
    noLyric() {
      return this.lyric.length == 0;
    },
    artist() {
      return this.currentTrack?.ar
        ? this.currentTrack.ar[0]
        : { id: 0, name: 'unknown' };
    },
    album() {
      return this.currentTrack?.al || { id: 0, name: 'unknown' };
    },
    theme() {
      return this.settings.lyricsBackground === true ? 'dark' : 'auto';
    },
    reactiveAccentStyle() {
      const style = {};
      if (this.reactiveAccent) style['--react-accent'] = this.reactiveAccent;
      if (this.reactiveAccentAlt) {
        style['--react-accent-alt'] = this.reactiveAccentAlt;
      }
      return style;
    },
    // 只有「律动模式 + 歌词页可见 + 正在播放 + 环境支持 Web Audio」
    // 四个条件同时成立时才跑 rAF 循环。关掉任何一个条件都会立刻停掉，
    // 这一点可以用 DevTools 的 Performance 面板验证。
    // 系统开了「减弱动态效果」时默认不跑，除非用户在设置里显式点过「仍然开启」。
    shouldRunReactive() {
      return (
        this.settings.lyricsBackground === 'reactive' &&
        this.showLyrics === true &&
        this.player.playing === true &&
        supportsReactive() &&
        (!prefersReducedMotion() ||
          Boolean(this.settings.lyricsReactiveOverride))
      );
    },
  },
  watch: {
    currentTrack() {
      this.getLyric();
      this.getCoverColor();
    },
    // 从「模糊 / 动态」切到「律动」时也要取一次主色，否则光斑只能用 CSS 的
    // 回退色，跟封面完全无关。
    'settings.lyricsBackground'() {
      this.getCoverColor();
    },
    shouldRunReactive(run) {
      if (run) {
        this.startReactiveLoop();
      } else {
        this.stopReactiveLoop();
      }
    },
    'settings.lyricsReactive': {
      deep: true,
      handler(value) {
        this.reactiveConfig = normalizeReactiveConfig(value);
        setReactiveConfig(this.reactiveConfig);
        // 让改动立刻体现在画面上，不必等下一帧
        this.applyReactiveFrame(null);
      },
    },
    showLyrics(show) {
      if (show) {
        this.setLyricsInterval();
        this.$store.commit('enableScrolling', false);
      } else {
        // 在 Electron 环境下，即使不显示歌词页面，也保持定时器运行以更新 Touch Bar
        if (process.env.IS_ELECTRON !== true) {
          clearInterval(this.lyricsInterval);
        }
        this.$store.commit('enableScrolling', true);
        // Fullscreen is requested on documentElement, so it makes the whole
        // window fullscreen. Since the only way to leave fullscreen from the
        // UI lives on this page, closing it would leave the window stuck in
        // fullscreen with no way out (minimize/restore stays fullscreen).
        this.exitFullscreen();
      }
    },
  },
  created() {
    this.getLyric();
    this.getCoverColor();
    this.initDate();
    // 在 Electron 环境下立即启动歌词定时器，以便 Touch Bar 可以显示歌词
    if (process.env.IS_ELECTRON === true) {
      this.setLyricsInterval();
    }
    document.addEventListener('keydown', e => {
      if (e.key === 'F11') {
        e.preventDefault();
        this.fullscreen();
      }
    });
    document.addEventListener('fullscreenchange', () => {
      this.isFullscreen = !!document.fullscreenElement;
    });
  },
  beforeDestroy: function () {
    if (this.timer) {
      clearInterval(this.timer);
    }
    this.stopReactiveLoop();
    this.exitFullscreen();
  },
  mounted() {
    // 如果挂载时就已经满足条件（比如从上次会话直接进歌词页），立刻接上
    if (this.shouldRunReactive) this.startReactiveLoop();
  },
  destroyed() {
    clearInterval(this.lyricsInterval);
    this.stopReactiveLoop();
  },
  methods: {
    ...mapMutations(['toggleLyrics', 'updateModal']),
    ...mapActions(['likeATrack']),
    /**
     * 启动律动循环。注意 rAF 循环本身由 audioAnalyser 统一管理：
     * 设置页的预览块和歌词页共用同一个循环，两边都退订后循环才真正停下。
     */
    startReactiveLoop() {
      this.stopReactiveLoop();
      // v-if 渲染的背景元素要等 DOM 更新后才拿得到
      this.$nextTick(() => {
        if (!this.shouldRunReactive) return;
        if (!this.$el) return;
        setReactiveConfig(this.reactiveConfig);
        this.reactiveUnsubscribe = subscribe(frame => {
          this.applyReactiveFrame(frame);
        });
      });
    },
    stopReactiveLoop() {
      if (this.reactiveUnsubscribe) {
        this.reactiveUnsubscribe();
        this.reactiveUnsubscribe = null;
      }
      // 自定义属性写在 .lyrics-page 根节点上，让 .lyrics-background、
      // .react-veil、.react-orbs 三个兄弟节点都能继承到同一份值。
      const stage = this.$el;
      if (!stage || !stage.style) return;
      // 清掉自定义属性，让 CSS 里的 var() 回退值（静态模糊 / 无暗幕）接管
      REACTIVE_VARS.forEach(key => stage.style.removeProperty(key));
    },
    applyReactiveFrame(frame) {
      const stage = this.$el;
      if (!stage || !stage.style) return;
      const vars = mapFrameToVars(
        frame || { level: 0, pulse: 0 },
        this.reactiveConfig
      );
      Object.keys(vars).forEach(key => {
        stage.style.setProperty(key, vars[key]);
      });
    },
    initDate() {
      var _this = this;
      clearInterval(this.timer);
      this.timer = setInterval(function () {
        _this.date = _this.formatTime(new Date());
      }, 1000);
    },
    formatTime(value) {
      let hour = value.getHours().toString();
      let minute = value.getMinutes().toString();
      let second = value.getSeconds().toString();
      return (
        hour.padStart(2, '0') +
        ':' +
        minute.padStart(2, '0') +
        ':' +
        second.padStart(2, '0')
      );
    },
    fullscreen() {
      if (document.fullscreenElement) {
        this.exitFullscreen();
      } else {
        document.documentElement.requestFullscreen();
      }
    },
    exitFullscreen() {
      if (document.fullscreenElement) {
        document.exitFullscreen();
      }
    },
    addToPlaylist() {
      if (!isAccountLoggedIn()) {
        this.showToast(locale.t('toast.needToLogin'));
        return;
      }
      this.$store.dispatch('fetchLikedPlaylist');
      this.updateModal({
        modalName: 'addTrackToPlaylistModal',
        key: 'show',
        value: true,
      });
      this.updateModal({
        modalName: 'addTrackToPlaylistModal',
        key: 'selectedTrackID',
        value: this.currentTrack?.id,
      });
    },
    playPrevTrack() {
      this.player.playPrevTrack();
    },
    playOrPause() {
      this.player.playOrPause();
    },
    playNextTrack() {
      if (this.player.isPersonalFM) {
        this.player.playNextFMTrack();
      } else {
        this.player.playNextTrack();
      }
    },
    getLyric() {
      if (!this.currentTrack.id) return;
      // 请求前先清空。原实现只在成功分支里重置，请求失败时上一首的歌词会
      // 一直留在屏幕上 —— 显示错误的歌词比显示空白恶劣得多。
      this.lyric = [];
      this.tlyric = [];
      this.romalyric = [];
      const clearLyric = () => {
        this.lyric = [];
        this.tlyric = [];
        this.romalyric = [];
        return false;
      };
      if (
        this.currentTrack.pc !== null &&
        this.currentTrack.cd === null &&
        this.$store.state.data.user?.userId
      ) {
        //云盘未设置关联的歌曲获取其内置歌词
        return getCloudLyric(
          this.currentTrack.id,
          this.$store.state.data.user?.userId
        )
          .then(data => {
            this.tlyric = [];
            this.romalyric = [];
            this.lyric = data?.lrc?.length > 0 ? parseLyric(data.lrc) : [];
            this.lyricType = 'translation';
            return true;
          })
          .catch(error => {
            console.warn('[lyrics] failed to load cloud lyric', error);
            return clearLyric();
          });
      }
      return getLyric(this.currentTrack.id)
        .then(data => {
          if (!data?.lrc?.lyric) {
            return clearLyric();
          } else {
            let { lyric, tlyric, romalyric } = lyricParser(data);
            lyric = lyric.filter(
              l => !/^作(词|曲)\s*(:|：)\s*无$/.exec(l.content)
            );
            let includeAM =
              lyric.length <= 10 &&
              lyric.map(l => l.content).includes('纯音乐，请欣赏');
            if (includeAM) {
              let reg = /^作(词|曲)\s*(:|：)\s*/;
              let author = this.currentTrack?.ar[0]?.name;
              lyric = lyric.filter(l => {
                let regExpArr = l.content.match(reg);
                return (
                  !regExpArr || l.content.replace(regExpArr[0], '') !== author
                );
              });
            }
            if (lyric.length === 1 && includeAM) {
              return clearLyric();
            } else {
              this.lyric = lyric;
              this.tlyric = tlyric;
              this.romalyric = romalyric;
              if (tlyric.length * romalyric.length > 0) {
                this.lyricType = 'translation';
              } else {
                this.lyricType =
                  lyric.length > 0 ? 'translation' : 'romaPronunciation';
              }
              return true;
            }
          }
        })
        .catch(error => {
          console.warn('[lyrics] failed to load lyric', error);
          return clearLyric();
        });
    },
    switchLyricType() {
      this.lyricType =
        this.lyricType === 'translation' ? 'romaPronunciation' : 'translation';
    },
    formatTrackTime(value) {
      return formatTrackTime(value);
    },
    clickLyricLine(value, startPlay = false) {
      // TODO: 双击选择还会选中文字，考虑搞个右键菜单复制歌词
      let jumpFlag = false;
      this.lyric.filter(function (item) {
        if (item.content == '纯音乐，请欣赏') {
          jumpFlag = true;
        }
      });
      if (window.getSelection().toString().length === 0 && !jumpFlag) {
        this.player.seek(value);
      }
      if (startPlay === true) {
        this.player.play();
      }
    },
    openLyricMenu(e, lyric, idx) {
      this.rightClickLyric = { ...lyric, idx };
      this.$refs.lyricMenu.openMenu(e);
      e.preventDefault();
    },
    copyLyric(withTranslation) {
      if (this.rightClickLyric) {
        const idx = this.rightClickLyric.idx;
        if (!withTranslation) {
          copyLyric(this.rightClickLyric.contents[idx]);
        } else {
          copyLyric(this.rightClickLyric.contents.join(' '));
        }
      }
    },
    setLyricsInterval() {
      this.lyricsInterval = setInterval(() => {
        const progress = this.player.seek(null, false) ?? 0;
        let oldHighlightLyricIndex = this.highlightLyricIndex;
        this.highlightLyricIndex = this.lyric.findIndex((l, index) => {
          const nextLyric = this.lyric[index + 1];
          return (
            progress >= l.time && (nextLyric ? progress < nextLyric.time : true)
          );
        });
        if (oldHighlightLyricIndex !== this.highlightLyricIndex) {
          // 只在显示歌词页面时才滚动
          if (this.showLyrics) {
            const el = document.getElementById(
              `line${this.highlightLyricIndex}`
            );
            if (el)
              el.scrollIntoView({
                behavior: 'smooth',
                block: 'center',
              });
          }

          // 发送当前歌词到主进程（用于 Touch Bar 显示）
          if (ipcRenderer && this.highlightLyricIndex >= 0) {
            const currentLyricLine = this.lyricToShow[this.highlightLyricIndex];
            if (currentLyricLine && currentLyricLine.contents) {
              // 只发送第一行歌词（原文），避免显示过长
              const lyricText = currentLyricLine.contents[0] || '';
              ipcRenderer.send('updateLyric', { lyric: lyricText });
            }
          }
        }
      }, 50);
    },
    moveToFMTrash() {
      this.player.moveToFMTrash();
    },
    switchRepeatMode() {
      this.player.switchRepeatMode();
    },
    switchShuffle() {
      this.player.switchShuffle();
    },
    getCoverColor() {
      const mode = this.settings.lyricsBackground;
      // 渐变背景和律动背景都需要主色：前者拿去拼渐变，后者拿去给光斑染色。
      if (mode !== true && mode !== 'reactive') return;
      const picUrl = this.currentTrack?.al?.picUrl;
      if (!picUrl) return;
      Vibrant.from(`${picUrl}?param=256y256`, { colorCount: 1 })
        .getPalette()
        .then(palette => {
          const swatch = palette.DarkMuted || palette.Muted || palette.Vibrant;
          if (!swatch || !swatch._rgb) return;
          const originColor = Color.rgb(swatch._rgb);
          if (mode === true) {
            const color = originColor.darken(0.1).rgb().string();
            const color2 = originColor.lighten(0.28).rotate(-30).rgb().string();
            this.background = `linear-gradient(to top left, ${color}, ${color2})`;
          }
          // 取整后再拼串：color 的 rgb().array() 带小数，虽然 rgba() 也吃，
          // 但插进自定义属性里会让每帧的字符串比较变复杂，没有必要。
          const rgbString = c =>
            c
              .rgb()
              .array()
              .slice(0, 3)
              .map(v => Math.round(v))
              .join(', ');
          this.reactiveAccent = rgbString(originColor);
          // 旋转 40° 再提亮一点：两套主题下都要能读出来（浅色靠 multiply
          // 压暗、深色靠 screen 加光，同一个中间调两边都够用）。
          this.reactiveAccentAlt = rgbString(
            originColor.rotate(40).lighten(0.18)
          );
        })
        .catch(() => {
          // 封面取色失败（跨域 / 无网络 / 调色板为空）时保持空串，
          // 由 CSS 的 var() 回退值接管，不影响律动本身。
        });
    },
    hasList() {
      return hasListSource();
    },
    getListPath() {
      return getListSourcePath();
    },
    mute() {
      this.player.mute();
    },
  },
};
</script>

<style lang="scss" scoped>
.lyrics-page {
  position: fixed;
  top: 0;
  right: 0;
  left: 0;
  bottom: 0;
  z-index: 200;
  background: var(--color-body-bg);
  display: flex;
  clip: rect(auto, auto, auto, auto);
}

.lyrics-background {
  // 收敛后的放大倍数。原来 75% / 150% 会把每一个 8-bit 色阶台阶拉宽到肉眼
  // 可辨的程度，断层就是这么被「放大」出来的；92% / 112% 保留原来的明暗
  // 观感，但相邻色阶的落差回到了噪声可以盖住的量级。
  //
  // 亮度从 132% 降到 112%：132% 会把模糊封面洗成近白，既吃掉了可感知对比度，
  // 也让后面「暗幕随能量变厚」的呼吸空间被压没 —— 亮到顶了就再也亮不起来。
  // 112% 的底子让 --react-brightness 的 0.82~1.12 乘上去落在 0.92~1.25，
  // 幅度够大，又不会洗白。
  --contrast-lyrics-background: 92%;
  --brightness-lyrics-background: 112%;
}

[data-theme='dark'] .lyrics-background {
  --contrast-lyrics-background: 112%;
  --brightness-lyrics-background: 72%;
}

.lyrics-background {
  filter: blur(50px) contrast(var(--contrast-lyrics-background))
    brightness(var(--brightness-lyrics-background));
  // 向外扩 6%：blur 的采样边界落在视口之外，四周不会出现一圈被滤镜
  // 稀释过的暗边；同时尺寸和 .gradient-background 保持一致，切模式不跳动。
  position: absolute;
  top: -6vh;
  left: -6vw;
  height: 112vh;
  width: 112vw;

  .top-right,
  .bottom-left {
    z-index: 0;
    width: 140vw;
    height: 140vw;
    opacity: 0.6;
    position: absolute;
    background-size: cover;
  }

  .top-right {
    right: 0;
    top: 0;
    mix-blend-mode: luminosity;
  }

  .bottom-left {
    left: 0;
    bottom: 0;
    animation-direction: reverse;
    animation-delay: 10s;
  }
}

.dynamic-background > div {
  animation: rotate 150s linear infinite;
}

// 律动背景。和 .lyrics-background 是同一个元素，靠更高优先级覆盖 filter。
// 只动 transform 与 filter 这两个合成层属性，不碰 width/margin/top，
// 避免每帧触发布局重排。
.lyrics-background.reactive-background {
  // 用纯数字而不是百分比，这样 calc() 里做乘法是安全的
  // 和 .lyrics-background 的 92% / 112% 同源，两套值必须一起改，
  // 否则律动模式仍然是断的。
  --react-base-brightness: 1.12;
  --react-base-contrast: 0.92;

  // 光斑是 ::after 的替代者，背景本身不再需要裁切边界；保留 overflow
  // 是为了让 blur 的采样不溢出到歌词文字上。
  overflow: hidden;

  // 去掉了 hue-rotate：整片背景跟着能量整体换色，是最强的「廉价」信号，
  // 也是用户说的「杀马特」感的来源。现在只保留清晰度 / 明度 / 饱和度三个维度。
  filter: blur(var(--react-blur, 50px)) contrast(var(--react-base-contrast))
    brightness(calc(var(--react-base-brightness) * var(--react-brightness, 1)))
    saturate(var(--react-saturate, 1));
  // 160ms + ease-out：原来 80ms linear 每帧都在「跳」，没有惯性。
  // 慢一倍并让曲线头快尾缓，变化才是被推出去的，而不是硬切。
  transition: filter 160ms cubic-bezier(0.2, 0, 0, 1);
  will-change: filter;
}

[data-theme='dark'] .lyrics-background.reactive-background {
  --react-base-brightness: 0.72;
  --react-base-contrast: 1.12;
}

// 两层景深：近层（右上，压在歌词前面）跟着缩放 + 大幅漂移，
// 远层（左下）只做反向的小幅漂移。两层位移方向和幅度都不同，
// 眼睛读到的是「镜头在轻微推拉」，而不是整块背景一起被拉伸。
// 近层才吃 --react-scale，远层不吃 —— 缩放差本身也构成景深。
.lyrics-background.reactive-background > .top-right {
  transform: translate3d(
      calc(var(--react-drift, 0px) * -1),
      calc(var(--react-drift, 0px) * -0.55),
      0
    )
    scale(var(--react-scale, 1));
  transition: transform 140ms cubic-bezier(0.22, 1, 0.36, 1);
  will-change: transform;
}

.lyrics-background.reactive-background > .bottom-left {
  transform: translate3d(
    calc(var(--react-drift, 0px) * 0.7),
    calc(var(--react-drift, 0px) * 0.45),
    0
  );
  transition: transform 160ms cubic-bezier(0.22, 1, 0.36, 1);
  will-change: transform;
}

// ---------------------------------------------------------------------------
// 律动的可见信号
//
// 上一版把「律动」整个压在形变上（blur / scale / drift），实测每帧幅度只有
// 0.4px / 0.08% —— 而且全作用在一个本身就被 blur(50px) 糊掉、又被
// brightness(132%) 洗白的面上，没有边缘可以追踪，人眼一个都读不出来。
//
// 现在换成两个幅度大、且有明确物理含义的信号：
//   1. 整片暗幕随 --react-brightness 变厚 / 变薄（全屏亮度呼吸，幅度 0 → 0.4）
//   2. 三团大光斑随低 / 中 / 高频位移、缩放、明灭（位移幅度是几十 vw）
// blur / drift / scale 降级成「质感」，不再是主信号。
// ---------------------------------------------------------------------------

.react-veil {
  position: absolute;
  inset: 0;
  z-index: 0;
  pointer-events: none;
  background: #000;
  // 亮度乘数越低 → 幕越厚。1.12（安静）时全透明，0.82（高潮）时约 0.41。
  // 深色主题底子本来就更暗，系数给到 1.9，高潮时约 0.57。
  opacity: calc((1.12 - var(--react-brightness, 1.12)) * 1.35);
  transition: opacity 120ms linear;
}

[data-theme='dark'] .react-veil {
  opacity: calc((1.12 - var(--react-brightness, 1.12)) * 1.9);
}

// 光斑容器必须是 .lyrics-page 的直接子节点，而且不能设 z-index / filter /
// transform / opacity —— 任何一条都会新建层叠上下文，光斑的 mix-blend-mode
// 就只能混到容器自己的空白背景上，看起来像三块贴纸。
.react-orbs {
  position: absolute;
  inset: 0;
  pointer-events: none;
}

.react-orb {
  // 主色由 JS 从封面取（node-vibrant 的 DarkMuted）。取不到时按主题回退：
  // 浅色主题用冷灰压暗，深色主题用白光提亮。
  --orb-accent: var(--react-accent, 60, 70, 90);
  position: absolute;
  border-radius: 50%;
  pointer-events: none;
  // 浅色主题：multiply 用暗色染色；深色主题：screen 加光。
  mix-blend-mode: multiply;
  will-change: transform, opacity;
  transition: transform 120ms cubic-bezier(0.2, 0, 0, 1), opacity 160ms linear;
  // 用 ellipse closest-side 而不是 circle：光斑元素的宽高比跟着视口走，
  // circle 的渐变半径会超出元素短边、在 border-radius 边界被硬切一刀，
  // 画面上就是一圈明显的「等高线」。closest-side 让渐变正好收在椭圆边上。
  //
  // 中心 alpha 0.95 + 多段 stop：环宽 ≈ 斜坡长度 / 可用 8-bit 色阶数。
  // 中心越亮，screen / multiply 之后的 luma 跨度越大、色阶越多、环越细；
  // 多段 stop 让每一段的局部斜率更均匀，台阶分布更散，更容易被抖动打散。
  // （实测：两段 0.72→0 时深色高潮态有 6~8 圈宽 40~80px 的同心环。）
  background: radial-gradient(
    ellipse closest-side at 50% 50%,
    #{'rgba(var(--orb-accent), 0.95)'} 0%,
    #{'rgba(var(--orb-accent), 0.88)'} 14%,
    #{'rgba(var(--orb-accent), 0.62)'} 30%,
    #{'rgba(var(--orb-accent), 0.34)'} 46%,
    #{'rgba(var(--orb-accent), 0.14)'} 60%,
    #{'rgba(var(--orb-accent), 0.04)'} 70%,
    #{'rgba(var(--orb-accent), 0)'} 78%
  );
}

// 第二团用封面主色旋转 40° 的互补色。两团不同色，读起来才是「房间里的光」，
// 而不是一束打在同一面墙上的追光。
.react-orb.b {
  --orb-accent: var(--react-accent-alt, 70, 110, 190);
}

[data-theme='dark'] .react-orb {
  --orb-accent: var(--react-accent, 255, 255, 255);
  mix-blend-mode: screen;
}

[data-theme='dark'] .react-orb.b {
  --orb-accent: var(--react-accent-alt, 120, 170, 255);
}

// 三团光斑各自咬住一个频段。位置刻意让大团从左上、中团从右下溢出屏幕：
// 可见区只截到 alpha 斜坡的上半段，光斑边界被推到屏外，既没有「贴上去的
// 椭圆轮廓」，也不会在画面正中间堆出一个聚光灯。
// 尺寸用 % 而不是 vw/vh：设置页 240×140 的预览块可以直接复用同一份比例。
// --react-bass/mid/treble 是纯能量，没有乘过强度系数，所以这里必须再乘
// --react-power，否则用户在设置里拖「强度」滑杆对光斑完全无效。
.react-orb.a {
  width: 130%;
  height: 130%;
  left: -45%;
  top: -52%;
  transform: translate3d(
      calc(var(--react-bass, 0) * var(--react-power, 1) * 26%),
      calc(var(--react-bass, 0) * var(--react-power, 1) * 18%),
      0
    )
    scale(calc(1 + var(--react-bass, 0) * var(--react-power, 1) * 0.3));
  opacity: calc((0.1 + var(--react-bass, 0) * 0.55) * var(--react-power, 1));
}

.react-orb.b {
  width: 95%;
  height: 95%;
  right: -28%;
  bottom: -34%;
  transform: translate3d(
      calc(var(--react-mid, 0) * var(--react-power, 1) * -22%),
      calc(var(--react-mid, 0) * var(--react-power, 1) * -15%),
      0
    )
    scale(calc(1 + var(--react-mid, 0) * var(--react-power, 1) * 0.28));
  opacity: calc((0.08 + var(--react-mid, 0) * 0.42) * var(--react-power, 1));
}

// 第三团是右边缘的「溢光」，一半在屏外 —— 做成画面中间一个圆点会像污渍
.react-orb.c {
  width: 60%;
  height: 60%;
  left: 66%;
  top: 10%;
  transform: translate3d(
      calc(var(--react-treble, 0) * var(--react-power, 1) * 12%),
      calc(var(--react-treble, 0) * var(--react-power, 1) * -9%),
      0
    )
    scale(calc(1 + var(--react-pulse, 0) * var(--react-power, 1) * 0.3));
  opacity: calc(
    (0.04 + var(--react-treble, 0) * 0.22 + var(--react-pulse, 0) * 0.16) *
      var(--react-power, 1)
  );
}

@media (prefers-reduced-motion: reduce) {
  .lyrics-background.reactive-background,
  .lyrics-background.reactive-background > .top-right,
  .lyrics-background.reactive-background > .bottom-left,
  .react-veil,
  .react-orb {
    transition: none;
  }
}

@keyframes rotate {
  0% {
    transform: rotate(0deg);
  }

  100% {
    transform: rotate(360deg);
  }
}

.gradient-background {
  position: absolute;
  top: -6vh;
  left: -6vw;
  height: 112vh;
  width: 112vw;
}

// 8-bit 色深下，blur 抹平细节后的大面积平滑渐变必然出现色阶台阶。
// 叠一层极淡的噪声把台阶打散（dither），这是 Spotify / Apple Music 处理
// 同一问题的标准做法：噪声幅度只要 1~2 个色阶，肉眼看不到颗粒，
// 但足以让相邻色带之间不再有硬边。
//
// 四个参数都是像素级实测出来的，缺一不可：
//
// 1. **必须是 `normal`，不能是 `overlay`**。overlay 的扰动幅度正比于
//    `2·min(base, 1−base)`，在近黑背景上退化成 0 —— 实测深色主题下
//    `overlay + 0.022` 与「完全不加噪声」的截图 md5 完全相同（σ = 0.000，
//    432px 同值段）。旧版就是这么写的，所以深色主题的断层一直没修掉。
//    `normal` 的扰动幅度是 `a·(noise − 0.5)`，与底色无关。
// 2. **SVG filter 必须声明 `color-interpolation-filters='sRGB'`**。默认是
//    linearRGB，feTurbulence 的均值 0.5 会被 gamma 抬到 sRGB 的 186（不是
//    128），整层噪声把画面往亮处拽，深色主题黑位多抬 1.7 个色阶。
// 3. **`background-size` 必须锁在 160px，不能放大**。σ 对尺寸几乎不敏感
//    （0.77~0.81），但 lag-1 自相关从 −0.05 涨到 +0.87 —— 噪声能量没减少，
//    只是从「逐像素抖动」搬到「肉眼可见的斑块」。用 1px 则纹素塌成一个
//    平均色，噪声彻底消失。160px = SVG 固有尺寸，1 纹素正好 1 设备像素。
// 4. **rect 用 100% 而不是写死 160**，DPR ≠ 1 时才不会被二次缩放。
//
// 层级：z-index 0 盖在 .lyrics-background / .gradient-background（同为 0，
// 但 DOM 顺序在前）之上，在 .left-side（z-index 1）和 .right-side
// （z-index 0，DOM 顺序在后）之下，所以任何文字都不会被噪声覆盖。
.lyrics-grain {
  position: absolute;
  inset: 0;
  z-index: 0;
  pointer-events: none;
  opacity: 0.08;
  mix-blend-mode: normal;
  background-image: url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n' color-interpolation-filters='sRGB'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.86' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
  background-repeat: repeat;
  background-size: 160px 160px;
}

// 深色主题单独降一档：`normal` 的均值偏移是 `a·(128 − base)`，深色背景
// base ≈ 18，同样 opacity 的黑位抬升是浅色的三倍。0.06 时黑位 18.2 → 21.4
// （+3.2 个色阶，均匀无结构），噪声 σ ≈ 1.1 个色阶，远低于可见颗粒的
// 门槛（实测 σ ≈ 2.1 才开始看得见）。
[data-theme='dark'] .lyrics-grain {
  opacity: 0.06;
}

.left-side {
  flex: 1;
  display: flex;
  justify-content: flex-end;
  margin-right: 32px;
  margin-top: 24px;
  align-items: center;
  transition: all 0.5s;

  z-index: 1;

  .date {
    max-width: 54vh;
    margin: 24px 0;
    color: var(--color-text);
    text-align: center;
    font-size: 4rem;
    font-weight: 600;
    opacity: 0.88;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 1;
    overflow: hidden;
  }

  .controls {
    max-width: 54vh;
    margin-top: 24px;
    color: var(--color-text);

    .title {
      margin-top: 8px;
      font-size: 1.4rem;
      font-weight: 600;
      opacity: 0.88;
      display: -webkit-box;
      -webkit-box-orient: vertical;
      -webkit-line-clamp: 1;
      overflow: hidden;
    }

    .subtitle {
      margin-top: 4px;
      font-size: 1rem;
      opacity: 0.58;
      display: -webkit-box;
      -webkit-box-orient: vertical;
      -webkit-line-clamp: 1;
      overflow: hidden;
    }

    .top-part {
      display: flex;
      justify-content: space-between;

      .top-right {
        display: flex;
        justify-content: space-between;

        .volume-control {
          margin: 0 10px;
          display: flex;
          align-items: center;

          .volume-bar {
            width: 84px;
          }
        }

        .buttons {
          display: flex;
          align-items: center;

          button {
            margin: 0 0 0 4px;
          }

          .svg-icon {
            height: 18px;
            width: 18px;
          }
        }
      }
    }

    .progress-bar {
      margin-top: 22px;
      width: 100%;
      // 进度条本体改用 PlayerProgress（本地 250ms 采样）。
      // 原来直接 v-model 到 player.progress，导致这一页每秒重渲染一次，
      // 连带 60 行歌词 DOM 一起重建。紧凑变体保持原有的留白与字号。
    }

    .media-controls {
      display: flex;
      justify-content: center;
      margin-top: 18px;
      align-items: center;

      button {
        margin: 0;
      }

      .svg-icon {
        opacity: 0.38;
        height: 14px;
        width: 14px;
      }

      .active .svg-icon {
        opacity: 0.88;
      }

      .middle {
        padding: 0 16px;
        display: flex;
        align-items: center;

        button {
          margin: 0 8px;
        }

        button#play .svg-icon {
          height: 28px;
          width: 28px;
          padding: 2px;
        }

        .svg-icon {
          opacity: 0.88;
          height: 22px;
          width: 22px;
        }
      }

      .lyric-switch-icon {
        color: var(--color-text);
        font-size: 14px;
        line-height: 14px;
        opacity: 0.88;
      }
    }
  }
}

.cover {
  position: relative;

  .cover-container {
    position: relative;
  }

  img {
    border-radius: 0.75em;
    width: 54vh;
    height: 54vh;
    user-select: none;
    object-fit: cover;
  }

  .shadow {
    position: absolute;
    top: 12px;
    height: 54vh;
    width: 54vh;
    filter: blur(16px) opacity(0.6);
    transform: scale(0.92, 0.96);
    z-index: -1;
    background-size: cover;
    border-radius: 0.75em;
  }
}

.right-side {
  flex: 1;
  font-weight: 600;
  color: var(--color-text);
  margin-right: 24px;
  z-index: 0;

  .lyrics-container {
    height: 100%;
    display: flex;
    flex-direction: column;
    padding-left: 78px;
    max-width: 460px;
    overflow-y: auto;
    transition: 0.5s;
    scrollbar-width: none; // firefox

    .line {
      margin: 2px 0;
      padding: 12px 18px;
      transition: 0.5s;
      border-radius: 12px;

      &:hover {
        background: var(--color-secondary-bg-for-transparent);
      }

      .content {
        transform-origin: center left;
        transform: scale(0.95);
        transition: all 0.35s cubic-bezier(0.25, 0.46, 0.45, 0.94);
        user-select: none;

        span {
          opacity: 0.28;
          cursor: default;
          font-size: 1em;
          transition: all 0.35s cubic-bezier(0.25, 0.46, 0.45, 0.94);
        }

        span.translation {
          opacity: 0.2;
          font-size: 0.925em;
        }
      }
    }

    .line#line-1:hover,
    .line#line-end:hover {
      background: unset;
    }

    // 底部留白，让最后几句歌词也能滚动到屏幕中间。
    // 不能用 .line:last-child，因为最后一个子元素是右键菜单 (ContextMenu)
    .line#line-end {
      flex-shrink: 0;
      height: 50vh;
      margin: 0;
      padding: 0;
    }

    .translation {
      margin-top: 0.1em;
    }

    .highlight div.content {
      transform: scale(1);

      span {
        opacity: 0.98;
        display: inline-block;
      }

      span.translation {
        opacity: 0.65;
      }
    }
  }

  ::-webkit-scrollbar {
    display: none;
  }

  .lyrics-container .line:first-child {
    margin-top: 50vh;
  }
}

.close-button {
  position: fixed;
  top: 24px;
  right: 24px;
  z-index: 300;
  border-radius: 0.75rem;
  height: 44px;
  width: 44px;
  display: flex;
  justify-content: center;
  align-items: center;
  opacity: 0.28;
  transition: 0.2s;
  -webkit-app-region: no-drag;

  .svg-icon {
    color: var(--color-text);
    padding-top: 5px;
    height: 22px;
    width: 22px;
  }

  &:hover {
    background: var(--color-secondary-bg-for-transparent);
    opacity: 0.88;
  }
}

.lyrics-page.no-lyric {
  .left-side {
    transition: all 0.5s;
    transform: translateX(27vh);
    margin-right: 0;
  }
}

@media (max-aspect-ratio: 10/9) {
  .left-side {
    display: none;
  }

  .right-side .lyrics-container {
    max-width: 100%;
  }
}

@media screen and (min-width: 1200px) {
  .right-side .lyrics-container {
    max-width: 600px;
  }
}

.slide-up-enter-active,
.slide-up-leave-active {
  transition: all 0.4s;
}

.slide-up-enter,
.slide-up-leave-to

/* .fade-leave-active below version 2.1.8 */ {
  transform: translateY(100%);
}

.slide-fade-enter-active {
  transition: all 0.5s ease;
}

.slide-fade-leave-active {
  transition: all 0.5s cubic-bezier(0.2, 0.2, 0, 1);
}

.slide-fade-enter,
.slide-fade-leave-to {
  transform: translateX(27vh);
  opacity: 0;
}
</style>
