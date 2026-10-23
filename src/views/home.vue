<template>
  <div>
    <!-- 「继续收听」完全来自 localStorage，零网络请求，
         所以放在骨架屏之外：冷启动第一帧就有内容可看。
         高度固定，下面的骨架屏 / 真实内容加载完成时不会引起跳动。 -->
    <ContinueListening ref="continueListening" />
    <!-- 首屏骨架：show 为 false 时原来是一片纯白（最长约 1 秒），
         用户无法判断应用是活着还是卡死了。骨架屏让等待可见，
         同时避免内容突然出现时的布局跳动。 -->
    <div v-if="!show" class="home-skeleton" aria-hidden="true">
      <div v-for="row in 2" :key="row" class="sk-row">
        <Skeleton width="180px" height="22px" class="sk-title" />
        <div class="sk-grid">
          <div v-for="n in 5" :key="n" class="sk-item">
            <Skeleton height="0" radius="12px" style="padding-top: 100%" />
            <Skeleton width="80%" height="14px" style="margin-top: 8px" />
            <Skeleton width="50%" height="11px" style="margin-top: 6px" />
          </div>
        </div>
      </div>
    </div>
    <div v-show="show" class="home">
      <div
        v-if="settings.showPlaylistsByAppleMusic !== false"
        class="index-row first-row"
      >
        <div class="title"> by Apple Music </div>
        <CoverRow
          :type="'playlist'"
          :items="byAppleMusic"
          sub-text="appleMusic"
          :image-size="1024"
        />
      </div>
      <div class="index-row">
        <div class="title">
          {{ $t('home.recommendPlaylist') }}
          <router-link to="/explore?category=推荐歌单">{{
            $t('home.seeMore')
          }}</router-link>
        </div>
        <CoverRow
          :type="'playlist'"
          :items="recommendPlaylist.items"
          sub-text="copywriter"
        />
      </div>
      <div class="index-row">
        <div class="title"> For You </div>
        <div class="for-you-row">
          <DailyTracksCard ref="DailyTracksCard" />
          <FMCard />
        </div>
      </div>
      <div class="index-row">
        <div class="title">{{ $t('home.recommendArtist') }}</div>
        <CoverRow
          type="artist"
          :column-number="6"
          :items="recommendArtists.items"
        />
      </div>
      <div class="index-row">
        <div class="title">
          {{ $t('home.newAlbum') }}
          <router-link to="/new-album">{{ $t('home.seeMore') }}</router-link>
        </div>
        <CoverRow
          type="album"
          :items="newReleasesAlbum.items"
          sub-text="artist"
        />
      </div>
      <div class="index-row">
        <div class="title">
          {{ $t('home.charts') }}
          <router-link to="/explore?category=排行榜">{{
            $t('home.seeMore')
          }}</router-link>
        </div>
        <CoverRow
          type="playlist"
          :items="topList.items"
          sub-text="updateFrequency"
          :image-size="1024"
        />
      </div>
    </div>
  </div>
</template>

<script>
import { toplists } from '@/api/playlist';
import { toplistOfArtists } from '@/api/artist';
import { newAlbums } from '@/api/album';
import { byAppleMusic } from '@/utils/staticData';
import { getRecommendPlayList } from '@/utils/playList';
import NProgress from 'nprogress';
import { mapState } from 'vuex';
import CoverRow from '@/components/CoverRow.vue';
import ContinueListening from '@/components/ContinueListening.vue';
import FMCard from '@/components/FMCard.vue';
import DailyTracksCard from '@/components/DailyTracksCard.vue';
import Skeleton from '@/components/Skeleton.vue';

export default {
  name: 'Home',
  components: {
    CoverRow,
    ContinueListening,
    FMCard,
    DailyTracksCard,
    Skeleton,
  },
  data() {
    return {
      show: false,
      recommendPlaylist: { items: [] },
      newReleasesAlbum: { items: [] },
      topList: {
        items: [],
        ids: [19723756, 180106, 60198, 3812895, 60131],
      },
      recommendArtists: {
        items: [],
        indexs: [],
      },
    };
  },
  computed: {
    ...mapState(['settings']),
    byAppleMusic() {
      return byAppleMusic;
    },
  },
  activated() {
    this.loadData();
    // keep-alive 返回首页时刷新「继续收听」：离开期间可能又听了别的歌
    if (this.$refs.continueListening) {
      this.$refs.continueListening.refresh();
    }
    this.$parent.$refs.scrollbar.restorePosition();
  },
  methods: {
    loadData() {
      setTimeout(() => {
        if (!this.show) NProgress.start();
      }, 1000);

      // 原实现只在成功回调里 NProgress.done() + show = true，
      // 任一请求失败（弱网、接口 5xx、登录态过期）就会永久白屏，
      // 而且顶部进度条一直转。这里把「收起进度条 + 显示内容」放进 finally。
      getRecommendPlayList(10, false)
        .then(items => {
          this.recommendPlaylist.items = items;
        })
        .catch(error => {
          console.warn('[home] failed to load recommend playlist', error);
        })
        .finally(() => {
          NProgress.done();
          this.show = true;
        });

      newAlbums({
        area: this.settings.musicLanguage ?? 'ALL',
        limit: 10,
      })
        .then(data => {
          this.newReleasesAlbum.items = data.albums;
        })
        .catch(error => {
          console.warn('[home] failed to load new albums', error);
        });

      const toplistOfArtistsAreaTable = {
        all: null,
        zh: 1,
        ea: 2,
        jp: 4,
        kr: 3,
      };
      toplistOfArtists(
        toplistOfArtistsAreaTable[this.settings.musicLanguage ?? 'all']
      )
        .then(data => {
          let indexs = [];
          while (indexs.length < 6) {
            let tmp = ~~(Math.random() * 100);
            if (!indexs.includes(tmp)) indexs.push(tmp);
          }
          this.recommendArtists.indexs = indexs;
          this.recommendArtists.items = data.list.artists.filter((l, index) =>
            indexs.includes(index)
          );
        })
        .catch(error => {
          console.warn('[home] failed to load toplist artists', error);
        });

      toplists()
        .then(data => {
          this.topList.items = data.list.filter(l =>
            this.topList.ids.includes(l.id)
          );
        })
        .catch(error => {
          console.warn('[home] failed to load toplists', error);
        });

      try {
        this.$refs.DailyTracksCard.loadDailyTracks();
      } catch (error) {
        console.warn('[home] failed to load daily tracks', error);
      }
    },
  },
};
</script>

<style lang="scss" scoped>
.index-row {
  margin-top: 54px;
}

/* 骨架屏与真实内容使用同一套栅格，避免内容出现时布局跳动 */
.home-skeleton {
  .sk-row {
    margin-top: 54px;
    &:first-child {
      margin-top: 32px;
    }
  }
  .sk-title {
    display: block;
    margin-bottom: 20px;
  }
  .sk-grid {
    display: grid;
    grid-template-columns: repeat(5, 1fr);
    gap: 44px 24px;
  }
  .sk-item {
    min-width: 0;
  }
}
.index-row.first-row {
  margin-top: 32px;
}
.playlists {
  display: flex;
  flex-wrap: wrap;
  margin: {
    right: -12px;
    left: -12px;
  }
  .index-playlist {
    margin: 12px 12px 24px 12px;
  }
}

.title {
  display: flex;
  justify-content: space-between;
  align-items: flex-end;
  margin-bottom: 20px;
  font-size: 28px;
  font-weight: 700;
  color: var(--color-text);
  a {
    font-size: 13px;
    font-weight: 600;
    opacity: 0.68;
  }
}

footer {
  display: flex;
  justify-content: center;
  margin-top: 48px;
}

.for-you-row {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 24px;
  margin-bottom: 78px;
}
</style>
