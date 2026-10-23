<template>
  <transition name="cp-fade">
    <div v-if="visible" class="command-palette">
      <div class="cp-backdrop" @click="close"></div>
      <div
        class="cp-panel"
        role="dialog"
        aria-modal="true"
        :aria-label="$t('commandPalette.open')"
        @keydown.esc.stop.prevent="close"
      >
        <div class="cp-search">
          <svg-icon icon-class="search" class="cp-search-icon" />
          <input
            ref="input"
            v-model="query"
            class="cp-input"
            type="text"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded="true"
            aria-controls="cp-listbox"
            :aria-activedescendant="activeDescendant"
            :placeholder="$t('commandPalette.placeholder')"
            autocomplete="off"
            spellcheck="false"
            @keydown="handleInputKeydown"
          />
        </div>
        <div
          id="cp-listbox"
          ref="list"
          class="cp-list"
          role="listbox"
          @mousedown.prevent
        >
          <div
            v-for="group in groups"
            :key="group.id"
            class="cp-group"
            role="group"
            :aria-labelledby="`cp-group-${group.id}`"
          >
            <div :id="`cp-group-${group.id}`" class="cp-group-title">{{
              $t(group.title)
            }}</div>
            <div
              v-for="item in group.items"
              :id="item.id"
              :key="item.id"
              class="cp-item"
              :class="{
                'is-active': item.id === activeId,
                'is-disabled': item.disabled,
              }"
              role="option"
              :aria-selected="item.id === activeId ? 'true' : 'false'"
              :aria-disabled="item.disabled ? 'true' : 'false'"
              @click="activate(item)"
              @mouseenter="setActiveById(item.id)"
            >
              <svg-icon :icon-class="item.icon" class="cp-item-icon" />
              <span class="cp-item-label">{{ item.label }}</span>
              <span v-if="item.hint" class="cp-item-hint">{{ item.hint }}</span>
            </div>
          </div>
          <div v-if="items.length === 0" class="cp-empty">{{
            $t('commandPalette.noResults')
          }}</div>
        </div>
        <div class="cp-footer">{{ $t('commandPalette.hint') }}</div>
      </div>
    </div>
  </transition>
</template>

<script>
import { mapState } from 'vuex';
import { isEditableTarget } from '@/utils/common';

const GROUP_ACTION = 'action';
const GROUP_NAVIGATE = 'navigate';
const GROUP_SEARCH = 'search';

// 命令面板最多同时展示多少条本地命令；超过这个数就不再插入「搜索」行，
// 避免用户已经能用本地命令表达意图时，被一条会跳走的搜索结果抢走回车。
const LOCAL_RESULTS_ENOUGH = 3;

export default {
  name: 'CommandPalette',
  data() {
    return {
      visible: false,
      query: '',
      activeIndex: 0,
      previouslyFocused: null,
    };
  },
  computed: {
    ...mapState(['player']),
    normalizedQuery() {
      return this.query.trim().toLowerCase();
    },
    hasCurrentTrack() {
      return this.player.enabled && (this.player.currentTrack?.id ?? 0) !== 0;
    },
    actionItems() {
      const items = [
        {
          key: 'playPause',
          icon: this.player.playing ? 'pause' : 'play',
          label: this.$t('commandPalette.actions.playPause'),
          keywords: ['play', 'pause', 'toggle'],
          disabled: !this.player.enabled,
          run: () => this.player.playOrPause(),
        },
        {
          key: 'next',
          icon: 'next',
          label: this.$t('commandPalette.actions.next'),
          keywords: ['next', 'skip', 'forward'],
          disabled: !this.hasCurrentTrack,
          run: () => this.playNextTrack(),
        },
        {
          key: 'prev',
          icon: 'previous',
          label: this.$t('commandPalette.actions.prev'),
          keywords: ['previous', 'prev', 'back', 'backward'],
          disabled: !this.hasCurrentTrack,
          run: () => this.player.playPrevTrack(),
        },
        {
          key: 'mute',
          icon: this.player.volume === 0 ? 'volume' : 'volume-mute',
          label: this.$t('commandPalette.actions.mute'),
          keywords: ['mute', 'unmute', 'volume', 'silence'],
          disabled: !this.player.enabled,
          run: () => this.player.mute(),
        },
        {
          key: 'like',
          icon: this.player.isCurrentTrackLiked ? 'heart-solid' : 'heart',
          label: this.$t('commandPalette.actions.like'),
          keywords: ['like', 'heart', 'favorite', 'collect'],
          disabled: !this.hasCurrentTrack,
          run: () => this.likeCurrentTrack(),
        },
        {
          key: 'lyrics',
          icon: 'list',
          label: this.$t('commandPalette.actions.lyrics'),
          keywords: ['lyrics', 'lyric', 'words'],
          disabled: !this.hasCurrentTrack,
          run: () => this.$store.commit('toggleLyrics'),
        },
        {
          key: 'settings',
          icon: 'settings',
          label: this.$t('commandPalette.actions.settings'),
          keywords: ['settings', 'preferences', 'options', 'config'],
          disabled: false,
          run: () => this.go({ name: 'settings' }),
        },
      ];
      return items
        .filter(item => this.matches(item))
        .map(item => this.decorate(item, GROUP_ACTION));
    },
    navigateItems() {
      const items = [
        {
          key: 'home',
          icon: 'arrow-right',
          label: this.$t('commandPalette.actions.home'),
          keywords: ['home', 'index', 'start'],
          disabled: false,
          run: () => this.go({ name: 'home' }),
        },
        {
          key: 'explore',
          icon: 'arrow-right',
          label: this.$t('commandPalette.actions.explore'),
          keywords: ['explore', 'discover', 'browse'],
          disabled: false,
          run: () => this.go({ name: 'explore' }),
        },
        {
          key: 'library',
          icon: 'arrow-right',
          label: this.$t('commandPalette.actions.library'),
          keywords: ['library', 'collection', 'mine'],
          disabled: false,
          run: () => this.go({ name: 'library' }),
        },
        {
          key: 'daily',
          icon: 'arrow-right',
          label: this.$t('commandPalette.actions.daily'),
          keywords: ['daily', 'recommend', 'today', '每日', '推荐'],
          disabled: false,
          run: () => this.go({ name: 'dailySongs' }),
        },
        {
          key: 'search',
          icon: 'arrow-right',
          label: this.$t('commandPalette.actions.search'),
          keywords: ['search', 'find', 'query'],
          disabled: false,
          run: () => this.go({ name: 'search' }),
        },
      ];
      return items
        .filter(item => this.matches(item))
        .map(item => this.decorate(item, GROUP_NAVIGATE));
    },
    searchItem() {
      const keywords = this.query.trim();
      if (keywords.length === 0) return null;
      // 本地命令已经给出足够多的候选时，不再插一条「跳去搜索页」，
      // 否则回车很容易落到搜索上而不是用户真正想执行的那条命令。
      if (
        this.actionItems.length + this.navigateItems.length >=
        LOCAL_RESULTS_ENOUGH
      )
        return null;
      return this.decorate(
        {
          key: 'searchKeywords',
          icon: 'search',
          label: this.$t('commandPalette.actions.search'),
          hint: keywords,
          keywords: [],
          disabled: false,
          run: () => this.go({ name: 'search', params: { keywords } }),
        },
        GROUP_SEARCH
      );
    },
    groups() {
      return [
        {
          id: GROUP_ACTION,
          title: 'commandPalette.groups.action',
          items: this.actionItems,
        },
        {
          id: GROUP_NAVIGATE,
          title: 'commandPalette.groups.navigate',
          items: this.navigateItems,
        },
        {
          id: GROUP_SEARCH,
          title: 'commandPalette.groups.search',
          items: this.searchItem ? [this.searchItem] : [],
        },
      ].filter(group => group.items.length > 0);
    },
    items() {
      return this.groups.reduce((all, group) => all.concat(group.items), []);
    },
    activeItem() {
      return this.items[this.activeIndex] || null;
    },
    activeId() {
      return this.activeItem ? this.activeItem.id : null;
    },
    activeDescendant() {
      return this.activeId;
    },
  },
  watch: {
    query() {
      this.resetActive();
    },
  },
  created() {
    window.addEventListener('keydown', this.handleGlobalKeydown);
  },
  beforeDestroy() {
    window.removeEventListener('keydown', this.handleGlobalKeydown);
  },
  methods: {
    /** 公开 API：打开面板（可通过 ref 调用） */
    open() {
      if (this.visible) return;
      this.previouslyFocused = document.activeElement;
      this.query = '';
      this.visible = true;
      this.resetActive();
      this.$nextTick(() => {
        this.$refs.input?.focus();
      });
    },
    /** 公开 API：关闭面板，焦点回到打开前的元素 */
    close() {
      if (!this.visible) return;
      this.visible = false;
      const target = this.previouslyFocused;
      this.previouslyFocused = null;
      this.$nextTick(() => {
        if (
          target &&
          typeof target.focus === 'function' &&
          document.contains(target)
        )
          target.focus();
      });
    },
    /** 公开 API：切换开关 */
    toggle() {
      this.visible ? this.close() : this.open();
    },
    decorate(item, group) {
      return { ...item, group, id: `cp-item-${group}-${item.key}` };
    },
    matches(item) {
      const query = this.normalizedQuery;
      if (query.length === 0) return true;
      if (item.label.toLowerCase().includes(query)) return true;
      return item.keywords.some(keyword => keyword.includes(query));
    },
    resetActive() {
      const index = this.items.findIndex(item => !item.disabled);
      this.activeIndex = index < 0 ? 0 : index;
    },
    setActiveById(id) {
      const index = this.items.findIndex(item => item.id === id);
      if (index >= 0 && !this.items[index].disabled) this.activeIndex = index;
    },
    moveActive(step) {
      const items = this.items;
      if (items.length === 0) return;
      let index = this.activeIndex;
      for (let i = 0; i < items.length; i++) {
        index = (index + step + items.length) % items.length;
        if (!items[index].disabled) break;
      }
      this.activeIndex = index;
      this.$nextTick(() => {
        const active = this.$refs.list?.querySelector('.cp-item.is-active');
        active?.scrollIntoView({ block: 'nearest' });
      });
    },
    activate(item) {
      if (!item || item.disabled) return;
      this.close();
      item.run();
    },
    playNextTrack() {
      // 私人 FM 下「下一首」走的是 FM 拉取逻辑，直接调 playNextTrack 会拿到
      // 旧的播放列表项。与 Player.vue 的分支保持一致。
      if (this.player.isPersonalFM) {
        this.player.playNextFMTrack();
      } else {
        this.player.playNextTrack();
      }
    },
    likeCurrentTrack() {
      const id = this.player.currentTrack?.id ?? 0;
      if (id === 0) return;
      this.$store.dispatch('likeATrack', id);
    },
    go(location) {
      if (this.$route.name === location.name && !location.params) return;
      this.$router.push(location);
    },
    handleInputKeydown(e) {
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          this.moveActive(1);
          break;
        case 'ArrowUp':
          e.preventDefault();
          this.moveActive(-1);
          break;
        case 'PageDown':
          e.preventDefault();
          this.moveActive(5);
          break;
        case 'PageUp':
          e.preventDefault();
          this.moveActive(-5);
          break;
        case 'Enter':
          e.preventDefault();
          this.activate(this.activeItem);
          break;
        case 'Tab':
          // 面板里只有输入框可聚焦，Tab 出去会让键盘用户迷失在背后的页面上
          e.preventDefault();
          break;
        default:
          break;
      }
    },
    handleGlobalKeydown(e) {
      if (this.visible && (e.key === 'Escape' || e.key === 'Esc')) {
        e.preventDefault();
        this.close();
        return;
      }
      // 别的处理器已经认领了这次按键（例如设置页正在录制快捷键），不要抢。
      if (e.defaultPrevented || e.repeat) return;
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      if (typeof e.key !== 'string' || e.key.toLowerCase() !== 'k') return;
      // 面板打开时焦点在自己的输入框里，这时 Cmd/Ctrl+K 应该能把它关掉；
      // 页面上的其它输入框（搜索框、设置里的 textarea / select）里则让位给打字。
      if (!this.visible && isEditableTarget(e.target)) return;
      e.preventDefault();
      this.toggle();
    },
  },
};
</script>

<style lang="scss" scoped>
.command-palette {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  // 高于歌词页（200/300）与弹窗（1000），低于 Toast（1010）：
  // 面板打开时提示条仍然可见。
  z-index: 1005;
  display: flex;
  justify-content: center;
  align-items: flex-start;
  padding-top: 14vh;
  box-sizing: border-box;
}

.cp-backdrop {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  background: rgba(255, 255, 255, 0.5);
  backdrop-filter: blur(2px);
}

.cp-panel {
  position: relative;
  z-index: 1;
  display: flex;
  flex-direction: column;
  width: 560px;
  max-width: calc(100vw - 32px);
  max-height: min(420px, calc(100vh - 14vh - 32px));
  background: rgba(255, 255, 255, 0.88);
  border: 1px solid rgba(0, 0, 0, 0.06);
  border-radius: 12px;
  box-shadow: 0 12px 32px -8px rgba(0, 0, 0, 0.18);
  backdrop-filter: blur(16px);
  overflow: hidden;
  -webkit-app-region: no-drag;
}

.cp-search {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  padding: 14px 16px;
  border-bottom: 1px solid rgba(128, 128, 128, 0.18);
}

.cp-search-icon {
  flex: 0 0 auto;
  width: 16px;
  height: 16px;
  margin-right: 10px;
  color: var(--color-secondary);
}

.cp-input {
  flex: 1 1 auto;
  min-width: 0;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--color-text);
  font-size: 15px;
  outline: none;

  &::placeholder {
    color: var(--color-secondary);
  }
}

.cp-list {
  flex: 1 1 auto;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 6px 6px 8px 6px;
  scrollbar-width: thin;

  &::-webkit-scrollbar {
    width: 6px;
  }
  &::-webkit-scrollbar-track {
    background: transparent;
  }
  &::-webkit-scrollbar-thumb {
    background: var(--color-secondary-bg-for-transparent);
    border-radius: 3px;
  }
}

.cp-group-title {
  position: sticky;
  top: 0;
  z-index: 1;
  padding: 8px 10px 6px 10px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--color-secondary);
  background: rgba(255, 255, 255, 0.94);
  backdrop-filter: blur(8px);
}

.cp-item {
  display: flex;
  align-items: center;
  padding: 9px 10px 9px 7px;
  border-left: 3px solid transparent;
  border-radius: 8px;
  color: var(--color-text);
  font-size: 14px;
  cursor: default;
  transition: background 0.12s ease;

  &.is-active {
    background: var(--color-primary-bg-for-transparent);
    // 左侧强调条 + 背景色：不单靠颜色区分当前项
    border-left-color: var(--color-primary);
  }

  &.is-disabled {
    opacity: 0.38;
  }
}

.cp-item-icon {
  flex: 0 0 auto;
  width: 16px;
  height: 16px;
  margin-right: 10px;
  color: var(--color-secondary);
}

.cp-item.is-active .cp-item-icon {
  color: var(--color-primary);
}

.cp-item-label {
  flex: 1 1 auto;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.cp-item-hint {
  flex: 0 1 auto;
  max-width: 45%;
  margin-left: 12px;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: 12px;
  color: var(--color-secondary);
}

.cp-empty {
  padding: 28px 16px;
  font-size: 14px;
  text-align: center;
  color: var(--color-secondary);
}

.cp-footer {
  flex: 0 0 auto;
  padding: 8px 16px;
  border-top: 1px solid rgba(128, 128, 128, 0.18);
  font-size: 12px;
  color: var(--color-secondary);
}

[data-theme='dark'] {
  .cp-backdrop {
    background: rgba(0, 0, 0, 0.45);
  }
  .cp-panel {
    background: rgba(36, 36, 36, 0.88);
    border: 1px solid rgba(255, 255, 255, 0.08);
  }
  .cp-group-title {
    background: rgba(36, 36, 36, 0.94);
  }
}

.cp-fade-enter-active,
.cp-fade-leave-active {
  transition: opacity 0.16s ease;
}
.cp-fade-enter,
.cp-fade-leave-to {
  opacity: 0;
}
.cp-fade-enter-active .cp-panel {
  animation: cp-pop 0.16s ease;
}

@keyframes cp-pop {
  from {
    opacity: 0;
    transform: translateY(-6px) scale(0.98);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

@media (prefers-reduced-motion: reduce) {
  .cp-fade-enter-active,
  .cp-fade-leave-active {
    transition: none;
  }
  .cp-fade-enter-active .cp-panel {
    animation: none;
  }
  .cp-item {
    transition: none;
  }
}
</style>
