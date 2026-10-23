<template>
  <div v-show="show" class="search-page">
    <div v-show="artists.length > 0 || albums.length > 0" class="row">
      <div v-show="artists.length > 0" class="artists">
        <div v-show="artists.length > 0" class="section-title"
          >{{ $t('search.artist')
          }}<router-link :to="`/search/${keywords}/artists`">{{
            $t('home.seeMore')
          }}</router-link></div
        >
        <CoverRow
          type="artist"
          :column-number="3"
          :items="artists.slice(0, 3)"
          gap="34px 24px"
        />
      </div>

      <div class="albums">
        <div v-show="albums.length > 0" class="section-title"
          >{{ $t('search.album')
          }}<router-link :to="`/search/${keywords}/albums`">{{
            $t('home.seeMore')
          }}</router-link></div
        >
        <CoverRow
          type="album"
          :items="albums.slice(0, 3)"
          sub-text="artist"
          :column-number="3"
          sub-text-font-size="14px"
          gap="34px 24px"
          :play-button-size="26"
        />
      </div>
    </div>

    <div v-show="tracks.length > 0" class="tracks">
      <div class="section-title"
        >{{ $t('search.song')
        }}<router-link :to="`/search/${keywords}/tracks`">{{
          $t('home.seeMore')
        }}</router-link></div
      >
      <TrackList :tracks="tracks" type="tracklist" />
    </div>

    <div v-show="musicVideos.length > 0" class="music-videos">
      <div class="section-title"
        >{{ $t('search.mv')
        }}<router-link :to="`/search/${keywords}/music-videos`">{{
          $t('home.seeMore')
        }}</router-link></div
      >
      <MvRow :mvs="musicVideos.slice(0, 5)" />
    </div>

    <div v-show="playlists.length > 0" class="playlists">
      <div class="section-title"
        >{{ $t('search.playlist')
        }}<router-link :to="`/search/${keywords}/playlists`">{{
          $t('home.seeMore')
        }}</router-link></div
      >
      <CoverRow
        type="playlist"
        :items="playlists.slice(0, 12)"
        sub-text="title"
        :column-number="6"
        sub-text-font-size="14px"
        gap="34px 24px"
        :play-button-size="26"
      />
    </div>

    <!-- 原实现是一行 24px 灰字（opacity 0.38，实测对比度 2.68:1，不达 WCAG AA），
         而且只说「没有结果」，不告诉用户能做什么。 -->
    <EmptyState
      v-show="!haveResult"
      class="no-results"
      icon="search"
      :title="keywords.length === 0 ? '输入关键字搜索' : $t('search.noResult')"
      :description="
        keywords.length === 0
          ? '可以搜索歌曲、歌手、专辑或歌单'
          : '换个关键词试试，或者检查一下有没有打错字'
      "
    />
  </div>
</template>

<script>
import { mapActions } from 'vuex';
import { getTrackDetail } from '@/api/track';
import { search } from '@/api/others';
import NProgress from 'nprogress';

import TrackList from '@/components/TrackList.vue';
import MvRow from '@/components/MvRow.vue';
import CoverRow from '@/components/CoverRow.vue';
import EmptyState from '@/components/EmptyState.vue';

export default {
  name: 'Search',
  components: {
    TrackList,
    MvRow,
    CoverRow,
    EmptyState,
  },
  data() {
    return {
      show: false,
      tracks: [],
      artists: [],
      albums: [],
      playlists: [],
      musicVideos: [],
    };
  },
  computed: {
    keywords() {
      return this.$route.params.keywords ?? '';
    },
    haveResult() {
      return (
        this.tracks.length +
          this.artists.length +
          this.albums.length +
          this.playlists.length +
          this.musicVideos.length >
        0
      );
    },
  },
  watch: {
    keywords: function (newKeywords) {
      if (newKeywords.length === 0) return;
      this.getData();
    },
  },
  created() {
    this.getData();
  },
  methods: {
    ...mapActions(['showToast']),
    playTrackInSearchResult(id) {
      let track = this.tracks.find(t => t.id === id);
      this.$store.state.player.appendTrackToPlayerList(track, true);
    },
    search(type = 'all') {
      const typeTable = {
        all: 1018,
        musicVideos: 1004,
        tracks: 1,
        albums: 10,
        artists: 100,
        playlists: 1000,
      };
      return search({
        keywords: this.keywords,
        type: typeTable[type],
        limit: 16,
      })
        .then(result => {
          return { result: result.result, type };
        })
        .catch(err => {
          // 原实现直接读 err.response.data，网络错误（无 response）时会二次抛错，
          // 且 catch 返回 undefined，让 Promise.all 的结果里出现 undefined
          const message =
            err?.response?.data?.msg ||
            err?.response?.data?.message ||
            '搜索请求失败';
          this.showToast(message);
          return { result: undefined, type };
        });
    },
    getData() {
      setTimeout(() => {
        if (!this.show) NProgress.start();
      }, 1000);
      this.show = false;

      const requestAll = requests => {
        const keywords = this.keywords;
        Promise.all(requests)
          .then(results => {
            if (keywords != this.keywords) return;
            results.forEach(item => {
              // search() 失败时会返回 { result: undefined, type }，
              // 原实现没有判空，直接读 item.type / item.result 会抛 TypeError 白屏
              if (!item || item.result === undefined) return;
              const searchType = item.type;
              const result = item.result;
              switch (searchType) {
                case 'all':
                  this.result = result;
                  break;
                case 'musicVideos':
                  this.musicVideos = result.mvs ?? [];
                  break;
                case 'artists':
                  this.artists = result.artists ?? [];
                  break;
                case 'albums':
                  this.albums = result.albums ?? [];
                  break;
                case 'tracks':
                  this.tracks = result.songs ?? [];
                  this.getTracksDetail();
                  break;
                case 'playlists':
                  this.playlists = result.playlists ?? [];
                  break;
              }
            });
          })
          .catch(error => {
            console.warn('[search] request failed', error);
          })
          .finally(() => {
            // 无论成功失败都必须复位：否则 NProgress 会一直转、页面永远空白
            NProgress.done();
            this.show = true;
          });
      };

      const requests = [
        this.search('artists'),
        this.search('albums'),
        this.search('tracks'),
      ];
      const requests2 = [this.search('musicVideos'), this.search('playlists')];

      requestAll(requests);
      requestAll(requests2);
    },
    getTracksDetail() {
      const trackIDs = this.tracks.map(t => t.id);
      if (trackIDs.length === 0) return;
      getTrackDetail(trackIDs.join(',')).then(result => {
        this.tracks = result.songs;
      });
    },
  },
};
</script>

<style lang="scss" scoped>
.section-title {
  font-weight: 600;
  font-size: 22px;
  opacity: 0.88;
  color: var(--color-text);
  margin-bottom: 16px;

  display: flex;
  justify-content: space-between;
  align-items: center;
  a {
    font-size: 13px;
    font-weight: 600;
    opacity: 0.68;
  }
}

.row {
  display: flex;
  flex-wrap: wrap;
  margin-top: 32px;

  .artists {
    flex: 1;
    margin-right: 8rem;
  }
  .albums {
    flex: 1;
  }
}

.tracks,
.music-videos,
.playlists {
  margin-top: 46px;
}

.no-results {
  position: absolute;
  top: 64px;
  right: 0;
  left: 0;
  bottom: 64px;
  font-size: 24px;
  color: var(--color-text);
  opacity: 0.38;
  display: flex;
  justify-content: center;
  align-items: center;
  div {
    display: flex;
    align-items: center;
  }
  .svg-icon {
    height: 24px;
    width: 24px;
    margin-right: 16px;
  }
}
</style>
