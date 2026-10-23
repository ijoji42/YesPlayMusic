<template>
  <div class="track-list">
    <ContextMenu ref="menu">
      <div v-show="type !== 'cloudDisk'" class="item-info">
        <img
          :src="rightClickedTrackComputed.al.picUrl | resizeImage(224)"
          loading="lazy"
        />
        <div class="info">
          <div class="title">{{ rightClickedTrackComputed.name }}</div>
          <div class="subtitle">{{ rightClickedTrackComputed.ar[0].name }}</div>
        </div>
      </div>
      <hr v-show="type !== 'cloudDisk'" />
      <div class="item" @click="play">{{ $t('contextMenu.play') }}</div>
      <div class="item" @click="addToQueue">{{
        $t('contextMenu.addToQueue')
      }}</div>
      <div
        v-if="extraContextMenuItem.includes('removeTrackFromQueue')"
        class="item"
        @click="removeTrackFromQueue"
        >从队列删除</div
      >
      <hr v-show="type !== 'cloudDisk'" />
      <div
        v-show="!isRightClickedTrackLiked && type !== 'cloudDisk'"
        class="item"
        @click="like"
      >
        {{ $t('contextMenu.saveToMyLikedSongs') }}
      </div>
      <div
        v-show="isRightClickedTrackLiked && type !== 'cloudDisk'"
        class="item"
        @click="like"
      >
        {{ $t('contextMenu.removeFromMyLikedSongs') }}
      </div>
      <div
        v-if="extraContextMenuItem.includes('removeTrackFromPlaylist')"
        class="item"
        @click="removeTrackFromPlaylist"
        >从歌单中删除</div
      >
      <div
        v-show="type !== 'cloudDisk'"
        class="item"
        @click="addTrackToPlaylist"
        >{{ $t('contextMenu.addToPlaylist') }}</div
      >
      <div v-show="type !== 'cloudDisk'" class="item" @click="copyLink">{{
        $t('contextMenu.copyUrl')
      }}</div>
      <div
        v-if="extraContextMenuItem.includes('removeTrackFromCloudDisk')"
        class="item"
        @click="removeTrackFromCloudDisk"
        >从云盘中删除</div
      >
    </ContextMenu>

    <div ref="list" :style="listStyles">
      <template v-if="!isWindowed">
        <TrackListItem
          v-for="(track, index) in tracks"
          :key="itemKeyFor(track, index)"
          :track-prop="track"
          :track-no="index + 1"
          :highlight-playing-track="highlightPlayingTrack"
          :liked-song-id-set="likedSongIdSet"
          @dblclick.native="playThisList(track.id || track.songId)"
          @click.right.native="openMenu($event, track, index)"
        />
      </template>
      <template v-else>
        <div :style="{ height: topSpacerHeight }" aria-hidden="true"></div>
        <TrackListItem
          v-for="item in windowedTracks"
          :key="itemKeyFor(item.track, item.index)"
          :track-prop="item.track"
          :track-no="item.index + 1"
          :highlight-playing-track="highlightPlayingTrack"
          :liked-song-id-set="likedSongIdSet"
          @dblclick.native="playThisList(item.track.id || item.track.songId)"
          @click.right.native="openMenu($event, item.track, item.index)"
        />
        <div :style="{ height: bottomSpacerHeight }" aria-hidden="true"></div>
      </template>
    </div>
  </div>
</template>

<script>
import { mapActions, mapMutations, mapState } from 'vuex';
import { addOrRemoveTrackFromPlaylist } from '@/api/playlist';
import { cloudDiskTrackDelete } from '@/api/user';
import { isAccountLoggedIn } from '@/utils/auth';

import TrackListItem from '@/components/TrackListItem.vue';
import ContextMenu from '@/components/ContextMenu.vue';
import locale from '@/locale';

// 超过这个长度才启用窗口化渲染。短列表直接全量渲染，
// 既避免窗口化的固定开销，也保证常见场景的行为与改造前完全一致。
const WINDOW_THRESHOLD = 200;
// 视口上下各多渲染的行数，减少快速滚动时露出的空白。
const WINDOW_OVERSCAN = 10;
// 首帧在拿到真实行高之前先渲染的行数，够铺满一屏即可。
const WINDOW_INITIAL_SIZE = 40;
// 行高兜底值。只在还没量到真实 DOM 时临时使用，量到后立即被替换。
// 数值来自用 Electron 加载 TrackListItem 的真实 CSS 实测：
//   playlist / cloudDisk = 64px（46px 封面 + 上下各 1px 边框 + 上下各 8px 内边距）
//   album                = 48px（.track.album 写死 32px 内容高 + 16px 内边距）
const FALLBACK_ROW_HEIGHT_DEFAULT = 64;
const FALLBACK_ROW_HEIGHT_ALBUM = 48;
// 行高取整精度，避免 getBoundingClientRect 的亚像素抖动反复触发重算。
const HEIGHT_PRECISION = 100;

export default {
  name: 'TrackList',
  components: {
    TrackListItem,
    ContextMenu,
  },
  props: {
    tracks: {
      type: Array,
      default: () => {
        return [];
      },
    },
    type: {
      type: String,
      default: 'tracklist',
    }, // tracklist | album | playlist | cloudDisk
    id: {
      type: Number,
      default: 0,
    },
    dbclickTrackFunc: {
      type: String,
      default: 'default',
    },
    albumObject: {
      type: Object,
      default: () => {
        return {
          artist: {
            name: '',
          },
        };
      },
    },
    extraContextMenuItem: {
      type: Array,
      default: () => {
        return [
          // 'removeTrackFromPlaylist'
          // 'removeTrackFromQueue'
          // 'removeTrackFromCloudDisk'
        ];
      },
    },
    columnNumber: {
      type: Number,
      default: 4,
    },
    highlightPlayingTrack: {
      type: Boolean,
      default: true,
    },
    itemKey: {
      type: String,
      default: 'id',
    },
  },
  data() {
    return {
      rightClickedTrack: {
        id: 0,
        name: '',
        ar: [{ name: '' }],
        al: { picUrl: '' },
      },
      rightClickedTrackIndex: -1,
      listStyles: {},
      // 窗口化状态。windowStart / windowEnd 是相对 tracks 的绝对下标，
      // windowEnd 为开区间。
      windowStart: 0,
      windowEnd: 0,
      // 0 表示还没量到真实行高，此时用 fallbackRowHeight 兜底。
      rowHeight: 0,
      // 找不到滚动祖先时置 true，强制退回全量渲染。
      windowingDisabled: false,
    };
  },
  computed: {
    ...mapState(['liked', 'player']),
    // 把 liked.songs（可能上万条的 id 数组）索引成 Set，只在这里算一次。
    // 行组件拿 Set 做 has() 是 O(1)，而原来每行对数组做 includes() 是 O(N)，
    // 整张列表因此退化成 O(行数 × N)。
    // 依赖收集：new Set(arr) 会遍历数组下标，Vue 2 的数组 observer 在
    // push/splice 时会对 ob.dep 做 notify，所以点赞、取消点赞都会让这里
    // 失效重算，收藏态能实时刷新。
    likedSongIdSet() {
      return new Set(this.liked.songs);
    },
    // 只有「单列、线性排布」的类型才能安全窗口化。
    // tracklist 走 CSS grid 多列布局，一行的位置和线性滚动偏移不是 1:1
    // 对应关系，窗口化会静默打乱显示顺序，因此保持全量 v-for。
    isWindowed() {
      return (
        !this.windowingDisabled &&
        this.type !== 'tracklist' &&
        this.tracks.length > WINDOW_THRESHOLD
      );
    },
    windowedTracks() {
      const result = [];
      for (let i = this.windowStart; i < this.windowEnd; i++) {
        const track = this.tracks[i];
        if (track === undefined) continue;
        result.push({ track, index: i });
      }
      return result;
    },
    // 还没量到真实行高时用的估算值，只影响首帧的 spacer 高度。
    fallbackRowHeight() {
      return this.type === 'album'
        ? FALLBACK_ROW_HEIGHT_ALBUM
        : FALLBACK_ROW_HEIGHT_DEFAULT;
    },
    effectiveRowHeight() {
      return this.rowHeight > 0 ? this.rowHeight : this.fallbackRowHeight;
    },
    topSpacerHeight() {
      return `${Math.round(this.windowStart * this.effectiveRowHeight)}px`;
    },
    bottomSpacerHeight() {
      const rest = this.tracks.length - this.windowEnd;
      return `${Math.round((rest > 0 ? rest : 0) * this.effectiveRowHeight)}px`;
    },
    isRightClickedTrackLiked() {
      return this.likedSongIdSet.has(this.rightClickedTrack?.id);
    },
    rightClickedTrackComputed() {
      return this.type === 'cloudDisk'
        ? {
            id: 0,
            name: '',
            ar: [{ name: '' }],
            al: { picUrl: '' },
          }
        : this.rightClickedTrack;
    },
  },
  watch: {
    isWindowed(now) {
      if (now) {
        this.windowStart = 0;
        this.windowEnd = Math.min(this.tracks.length, WINDOW_INITIAL_SIZE);
        this.$nextTick(() => this.attachScrollContainer());
      } else {
        this.detachScrollContainer();
        this.windowStart = 0;
        this.windowEnd = 0;
      }
    },
    // tracks 换了新数组（切歌单、改筛选条件）时，滚动位置语义已经变了，
    // 必须重新量行高并重算窗口，否则会渲染出错误的切片。
    tracks() {
      if (!this.isWindowed) return;
      this.$nextTick(() => {
        this.measureRowHeight();
        this.updateWindow();
      });
    },
    // 原地 push / splice 不会改变数组引用，只能靠 length 兜住。
    'tracks.length'() {
      if (!this.isWindowed) return;
      this.$nextTick(() => this.updateWindow());
    },
  },
  created() {
    if (this.type === 'tracklist') {
      this.listStyles = {
        display: 'grid',
        gap: '4px',
        gridTemplateColumns: `repeat(${this.columnNumber}, 1fr)`,
      };
    }
    // 首帧就渲染一段，避免挂载前只有两个 spacer、页面高度看起来是空的。
    if (this.isWindowed) {
      this.windowEnd = Math.min(this.tracks.length, WINDOW_INITIAL_SIZE);
    }
    // 以下都是非响应式的实例属性，故意不放进 data()，
    // 否则 Vue 会去深度观测 DOM 节点 / ResizeObserver。
    this.scrollContainer = null;
    this.resizeObserver = null;
    this.scrollRafId = 0;
  },
  mounted() {
    if (!this.isWindowed) return;
    this.$nextTick(() => this.attachScrollContainer());
  },
  // keep-alive 页面（/next、/library）被切回来时 DOM 是重新插入的，
  // 需要重新绑一次监听；切走时容器引用已经失效，要解绑。
  activated() {
    if (!this.isWindowed) return;
    this.$nextTick(() => this.attachScrollContainer());
  },
  deactivated() {
    this.detachScrollContainer();
  },
  beforeDestroy() {
    this.detachScrollContainer();
  },
  methods: {
    ...mapMutations(['updateModal']),
    ...mapActions(['nextTrack', 'showToast', 'likeATrack']),
    // 保持改造前的 key 语义（itemKey === 'id' 用 id，否则 id+下标），
    // 保证窗口滑动不会让同一行被判定成不同的行而重建。
    itemKeyFor(track, index) {
      const key = this.itemKey === 'id' ? track?.id : `${track?.id}${index}`;
      // 云盘条目只有 songId 没有 id，旧实现在这里会产出重复的 undefined key。
      // 退化成绝对下标：同样唯一，而且窗口滑动不会改变某首歌的绝对下标。
      if (key === undefined || key === null || key === '') {
        return `index-${index}`;
      }
      return key;
    },
    // 真正的滚动容器不在本组件里：App.vue 的 <main> 是
    // position: fixed + overflow: auto，页面滚动发生在它身上。
    resolveScrollContainer() {
      const el = this.$el;
      if (!el || typeof el.closest !== 'function') return null;
      return el.closest('main');
    },
    attachScrollContainer() {
      if (!this.isWindowed) return;
      const container = this.resolveScrollContainer();
      if (!container) {
        // 找不到滚动祖先（例如组件被单独挂载）时放弃窗口化，
        // 退回全量渲染：宁可慢，也不要渲染出一片空白。
        this.windowingDisabled = true;
        return;
      }
      this.detachScrollContainer();
      this.scrollContainer = container;
      container.addEventListener('scroll', this.handleScroll, {
        passive: true,
      });
      window.addEventListener('resize', this.handleResize);
      if (typeof ResizeObserver !== 'undefined') {
        this.resizeObserver = new ResizeObserver(this.handleResize);
        this.resizeObserver.observe(container);
      }
      this.measureRowHeight();
      this.updateWindow();
    },
    detachScrollContainer() {
      if (this.scrollContainer) {
        this.scrollContainer.removeEventListener('scroll', this.handleScroll);
        this.scrollContainer = null;
      }
      window.removeEventListener('resize', this.handleResize);
      if (this.resizeObserver) {
        this.resizeObserver.disconnect();
        this.resizeObserver = null;
      }
      if (this.scrollRafId) {
        cancelAnimationFrame(this.scrollRafId);
        this.scrollRafId = 0;
      }
    },
    handleScroll() {
      // 滚动每帧可能触发多次，而 updateWindow 要读多个 rect（强制 reflow）。
      // 合并到一帧一次，和 App.vue 的 handleScroll 保持同一套写法。
      if (this.scrollRafId) return;
      this.scrollRafId = requestAnimationFrame(() => {
        this.scrollRafId = 0;
        this.updateWindow();
      });
    },
    handleResize() {
      // 容器尺寸变化后行高可能也变了（响应式字号、换行），重新量一次。
      this.$nextTick(() => {
        this.measureRowHeight();
        this.handleScroll();
      });
    },
    measureRowHeight() {
      if (!this.isWindowed) return;
      // 从真实渲染出来的行上量，不硬编码猜测值。
      // 只在列表容器内找，避免把 ContextMenu 里的节点误当成行。
      const list = this.$refs.list;
      if (!list) return;
      const row = list.querySelector('.track');
      if (!row) return;
      const height = row.getBoundingClientRect().height;
      if (!height) return;
      const rounded = Math.round(height * HEIGHT_PRECISION) / HEIGHT_PRECISION;
      if (rounded > 0 && rounded !== this.rowHeight) this.rowHeight = rounded;
    },
    updateWindow() {
      if (!this.isWindowed) return;
      const container = this.scrollContainer;
      const root = this.$el;
      if (!container || !root) return;
      // keep-alive 切走后元素会脱离文档，此时 rect 全是 0，算出来的窗口没有意义。
      if (container.isConnected === false) return;
      const containerRect = container.getBoundingClientRect();
      const rootRect = root.getBoundingClientRect();
      const rowHeight = this.effectiveRowHeight;
      const total = this.tracks.length;
      // 列表在容器内滚动，所以 root 的 rect 会跟着动；
      // 可视区相对列表顶部的偏移量就是「第一个可见行」的位置。
      const visibleTop = containerRect.top - rootRect.top;
      const visibleBottom = containerRect.bottom - rootRect.top;
      let start = Math.floor(visibleTop / rowHeight) - WINDOW_OVERSCAN;
      let end = Math.ceil(visibleBottom / rowHeight) + WINDOW_OVERSCAN;
      if (start < 0) start = 0;
      if (start > total) start = total;
      // end 必须 >= start，否则两个 spacer 会重叠，总高度会被算多。
      if (end < start) end = start;
      if (end > total) end = total;
      if (start === this.windowStart && end === this.windowEnd) return;
      this.windowStart = start;
      this.windowEnd = end;
    },
    openMenu(e, track, index = -1) {
      this.rightClickedTrack = track;
      this.rightClickedTrackIndex = index;
      this.$refs.menu.openMenu(e);
    },
    closeMenu() {
      this.rightClickedTrack = {
        id: 0,
        name: '',
        ar: [{ name: '' }],
        al: { picUrl: '' },
      };
      this.rightClickedTrackIndex = -1;
    },
    playThisList(trackID) {
      if (this.dbclickTrackFunc === 'default') {
        this.playThisListDefault(trackID);
      } else if (this.dbclickTrackFunc === 'none') {
        // do nothing
      } else if (this.dbclickTrackFunc === 'playTrackOnListByID') {
        this.player.playTrackOnListByID(trackID);
      } else if (this.dbclickTrackFunc === 'playPlaylistByID') {
        this.player.playPlaylistByID(this.id, trackID);
      } else if (this.dbclickTrackFunc === 'playAList') {
        let trackIDs = this.tracks.map(t => t.id || t.songId);
        this.player.replacePlaylist(trackIDs, this.id, 'artist', trackID);
      } else if (this.dbclickTrackFunc === 'dailyTracks') {
        let trackIDs = this.tracks.map(t => t.id);
        this.player.replacePlaylist(trackIDs, '/daily/songs', 'url', trackID);
      } else if (this.dbclickTrackFunc === 'playCloudDisk') {
        let trackIDs = this.tracks.map(t => t.id || t.songId);
        this.player.replacePlaylist(trackIDs, this.id, 'cloudDisk', trackID);
      }
    },
    playThisListDefault(trackID) {
      if (this.type === 'playlist') {
        this.player.playPlaylistByID(this.id, trackID);
      } else if (this.type === 'album') {
        this.player.playAlbumByID(this.id, trackID);
      } else if (this.type === 'tracklist') {
        let trackIDs = this.tracks.map(t => t.id);
        this.player.replacePlaylist(trackIDs, this.id, 'artist', trackID);
      }
    },
    play() {
      const id = this.rightClickedTrack.id;
      // 原实现一律走 addTrackToPlayNext(id, true)：先把歌塞进「下一首播放」队列
      // 再立刻消费掉。副作用是队列指针停在原来的位置，与当前实际播放的曲目脱节，
      // 之后点「下一首」会跳到错误的歌。
      // 如果这首歌本来就在当前播放列表里，直接在列表内定位播放；
      // 不在列表里（比如从搜索结果右键）才退回「插入队列并立即播放」。
      if (this.player.list.includes(id)) {
        this.player.playTrackOnListByID(id);
      } else {
        this.player.addTrackToPlayNext(id, true);
      }
    },
    addToQueue() {
      this.player.addTrackToPlayNext(this.rightClickedTrack.id);
    },
    like() {
      this.likeATrack(this.rightClickedTrack.id);
    },
    addTrackToPlaylist() {
      if (!isAccountLoggedIn()) {
        this.showToast(locale.t('toast.needToLogin'));
        return;
      }
      this.updateModal({
        modalName: 'addTrackToPlaylistModal',
        key: 'show',
        value: true,
      });
      this.updateModal({
        modalName: 'addTrackToPlaylistModal',
        key: 'selectedTrackID',
        value: this.rightClickedTrack.id,
      });
    },
    removeTrackFromPlaylist() {
      if (!isAccountLoggedIn()) {
        this.showToast(locale.t('toast.needToLogin'));
        return;
      }
      if (confirm(`确定要从歌单删除 ${this.rightClickedTrack.name}？`)) {
        let trackID = this.rightClickedTrack.id;
        addOrRemoveTrackFromPlaylist({
          op: 'del',
          pid: this.id,
          tracks: trackID,
        }).then(data => {
          this.showToast(
            data.body.code === 200
              ? locale.t('toast.removedFromPlaylist')
              : data.body.message
          );
          this.$parent.removeTrack(trackID);
        });
      }
    },
    copyLink() {
      this.$copyText(
        `https://music.163.com/song?id=${this.rightClickedTrack.id}`
      )
        .then(() => {
          this.showToast(locale.t('toast.copied'));
        })
        .catch(err => {
          this.showToast(`${locale.t('toast.copyFailed')}${err}`);
        });
    },
    removeTrackFromQueue() {
      this.$store.state.player.removeTrackFromQueue(
        this.rightClickedTrackIndex
      );
    },
    removeTrackFromCloudDisk() {
      if (confirm(`确定要从云盘删除 ${this.rightClickedTrack.songName}？`)) {
        let trackID = this.rightClickedTrack.songId;
        cloudDiskTrackDelete(trackID).then(data => {
          this.showToast(
            data.code === 200 ? '已将此歌曲从云盘删除' : data.message
          );
          let newCloudDisk = this.liked.cloudDisk.filter(
            t => t.songId !== trackID
          );
          this.$store.commit('updateLikedXXX', {
            name: 'cloudDisk',
            data: newCloudDisk,
          });
        });
      }
    },
  },
};
</script>

<style lang="scss" scoped></style>
