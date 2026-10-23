import axios from 'axios';
import Dexie from 'dexie';
import store from '@/store';

const db = new Dexie('yesplaymusic');

db.version(5).stores({
  trackDetail: '&id, updateTime',
  lyric: '&id, updateTime',
  album: '&id, updateTime',
  trackSources: '&id, createTime, size',
});

db.version(4).stores({
  trackDetail: '&id, updateTime',
  lyric: '&id, updateTime',
  album: '&id, updateTime',
});

db.version(3)
  .stores({
    trackSources: '&id, createTime',
  })
  .upgrade(tx =>
    tx
      .table('trackSources')
      .toCollection()
      .modify(
        track => !track.createTime && (track.createTime = new Date().getTime())
      )
  );

db.version(1).stores({
  trackSources: '&id',
});

// trackDetail 表是纯元数据，体积小，给个上限防止无限增长
const MAX_TRACK_DETAIL_ROWS = 3000;
let trackDetailWriteCount = 0;

// 缓存总量持久化，避免启动时把全部音频读进内存求和
const CACHE_BYTES_KEY = 'trackCacheBytes';
let tracksCacheBytes = readCacheBytes();

function readCacheBytes() {
  try {
    const raw = localStorage.getItem(CACHE_BYTES_KEY);
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? value : 0;
  } catch (e) {
    return 0;
  }
}

function writeCacheBytes() {
  try {
    localStorage.setItem(CACHE_BYTES_KEY, String(tracksCacheBytes));
  } catch (e) {
    /* ignore quota errors */
  }
}

function getByteLength(record) {
  if (!record) return 0;
  if (typeof record.size === 'number') return record.size;
  return record.source?.byteLength || 0;
}

// 等待 settings 可用
async function waitForSettingsReady(timeoutMs = 5000) {
  const interval = 100;
  const maxTries = Math.ceil(timeoutMs / interval);
  let tries = 0;
  while (
    (store.state == null ||
      store.state.settings == null ||
      store.state.settings.cacheLimit === undefined) &&
    tries < maxTries
  ) {
    await new Promise(resolve => setTimeout(resolve, interval));
    tries++;
  }
  return store.state && store.state.settings;
}

// 单曲缓存上限。UNM（第三方音源解锁）返回的 URL 完全不受本应用控制，
// 不设上限时一个恶意响应就能把磁盘写满。
const MAX_CACHE_BYTES = 60 * 1024 * 1024;

/**
 * 校验是否允许把这个 URL 的内容下载进缓存。
 *
 * 原实现直接 axios.get(url)，而 url 来自 UnblockNeteaseMusic 的返回，
 * 可以是任意地址 —— 等于把渲染进程变成一个 SSRF 跳板（内网探测 / 本机端口扫描），
 * 配合默认 8GB 的缓存上限还能被用来填充磁盘。
 */
function isSafeCacheUrl(rawUrl) {
  const value = String(rawUrl ?? '');

  // bilibili 音源是 base64 data URL，不经过网络，直接放行
  if (value.startsWith('data:')) return true;

  let parsed;
  try {
    parsed = new URL(value);
  } catch (e) {
    return false;
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) return false;

  const host = parsed.hostname.toLowerCase();
  if (
    host === 'localhost' ||
    host === '0.0.0.0' ||
    host === '[::1]' ||
    host === '::1' ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  ) {
    return false;
  }

  return true;
}

/**
 * 首次启动（或旧版本升级）时估算一次缓存总量。
 * 原实现用 toArray() 把整张表的音频 Blob 全部读进内存再求和，
 * 缓存到几百 MB 时启动即出现明显的内存峰值。现在总量走 localStorage 记账，
 * 只有记账缺失时才扫表，且扫完立刻回填。
 */
async function initTracksCacheBytes() {
  if (!process.env.IS_ELECTRON) return;
  try {
    await waitForSettingsReady();
    if (tracksCacheBytes === 0) {
      let total = 0;
      await db.trackSources.each(track => {
        total += getByteLength(track);
      });
      tracksCacheBytes = total;
      writeCacheBytes();
    }
    console.debug(
      '[debug][db.js] tracksCacheBytes:',
      tracksCacheBytes,
      'cacheLimit:',
      store.state.settings.cacheLimit
    );
    deleteExcessCache();
  } catch (err) {
    console.debug('[debug][db.js] initTracksCacheBytes failed', err);
  }
}

initTracksCacheBytes();

/**
 * 超出限额时按创建时间回收旧缓存。
 * 原实现递归调用自身且不 await，容易并发删除、也看不出何时结束；
 * 这里改成循环，并一次清到限额的 90%，避免每播一首歌都要删一轮。
 */
async function deleteExcessCache() {
  const settings = store.state?.settings;
  if (!settings || settings.cacheLimit === false) return;
  const limitBytes = Number(settings.cacheLimit) * Math.pow(1024, 2);
  if (!Number.isFinite(limitBytes) || limitBytes <= 0) return;
  if (tracksCacheBytes <= limitBytes) return;

  const targetBytes = limitBytes * 0.9;
  try {
    while (tracksCacheBytes > targetBytes) {
      const oldest = await db.trackSources.orderBy('createTime').first();
      if (!oldest) {
        tracksCacheBytes = 0;
        writeCacheBytes();
        break;
      }
      tracksCacheBytes = Math.max(0, tracksCacheBytes - getByteLength(oldest));
      await db.trackSources.delete(oldest.id);
    }
    writeCacheBytes();
    console.debug(
      '[debug][db.js] deleteExcessCache done, cacheSize:',
      tracksCacheBytes
    );
  } catch (error) {
    console.debug('[debug][db.js] deleteExcessCacheFailed', error);
  }
}

export async function cacheTrackSource(
  trackInfo,
  url,
  bitRate,
  from = 'netease'
) {
  if (!process.env.IS_ELECTRON) return null;
  try {
    const name = trackInfo.name;
    const artist =
      (trackInfo.ar && trackInfo.ar[0]?.name) ||
      (trackInfo.artists && trackInfo.artists[0]?.name) ||
      'Unknown';

    // 原实现这里还额外发了 3 个封面请求（没有 await、没有 catch），
    // 既不会用到返回值，还会产生未处理的 Promise rejection，直接去掉。
    if (!isSafeCacheUrl(url)) {
      console.warn('[db.js] refused to cache an unsafe url');
      return null;
    }

    const response = await axios.get(url, {
      responseType: 'arraybuffer',
      maxContentLength: MAX_CACHE_BYTES,
      maxBodyLength: MAX_CACHE_BYTES,
    });
    const byteLength = response.data.byteLength;
    if (byteLength > MAX_CACHE_BYTES) {
      console.warn('[db.js] track too large to cache, skipped');
      return null;
    }

    // 同一首歌重复缓存时先扣掉旧体积，避免记账重复累加
    const existing = await db.trackSources.get(trackInfo.id);
    if (existing) {
      tracksCacheBytes = Math.max(
        0,
        tracksCacheBytes - getByteLength(existing)
      );
    }

    await db.trackSources.put({
      id: trackInfo.id,
      source: response.data,
      size: byteLength,
      bitRate,
      from,
      name,
      artist,
      createTime: Date.now(),
    });

    tracksCacheBytes += byteLength;
    writeCacheBytes();
    console.debug(`[debug][db.js] cached track 👉 ${name} by ${artist}`);
    deleteExcessCache();
    return { trackID: trackInfo.id, source: response.data, bitRate };
  } catch (error) {
    console.debug('[debug][db.js] cacheTrackSource failed', error);
    return null;
  }
}

export function getTrackSource(id) {
  return db.trackSources
    .get(Number(id))
    .then(track => {
      if (!track) return null;
      console.debug(
        `[debug][db.js] get track from cache 👉 ${track.name} by ${track.artist}`
      );
      return track;
    })
    .catch(error => {
      console.debug('[debug][db.js] getTrackSource failed', error);
      return null;
    });
}

export function cacheTrackDetail(track, privileges) {
  db.trackDetail
    .put({
      id: track.id,
      detail: track,
      privileges: privileges,
      updateTime: Date.now(),
    })
    .then(() => {
      // 每 200 次写入裁剪一次，避免每次播放都做一次 count
      if (++trackDetailWriteCount % 200 !== 0) return;
      return db.trackDetail.count().then(count => {
        if (count <= MAX_TRACK_DETAIL_ROWS) return;
        return db.trackDetail
          .orderBy('updateTime')
          .limit(count - MAX_TRACK_DETAIL_ROWS)
          .primaryKeys()
          .then(keys => db.trackDetail.bulkDelete(keys));
      });
    })
    .catch(error => {
      console.debug('[debug][db.js] cacheTrackDetail failed', error);
    });
}

/**
 * 批量读取歌曲详情。
 *
 * 原实现用 `db.trackDetail.filter(...)` —— Dexie 的 filter 会对全表逐条执行
 * 回调，表越大越慢，是切歌时最明显的一次卡顿来源。
 * 现在直接按主键 bulkGet，复杂度 O(n)。
 */
export function getTrackDetailFromCache(ids) {
  const numericIds = ids
    .map(id => Number(id))
    .filter(id => Number.isFinite(id) && id > 0);

  if (numericIds.length === 0) return Promise.resolve(undefined);

  return db.trackDetail
    .bulkGet(numericIds)
    .then(tracks => {
      const result = { songs: [], privileges: [] };
      for (const id of numericIds) {
        const one = tracks.find(t => t && t.id === id);
        // 任意一首缺失就整体回退到网络请求，保证调用方拿到完整数据
        if (!one) return undefined;
        result.songs.push(one.detail);
        result.privileges.push(one.privileges);
      }
      return result.songs.length > 0 ? result : undefined;
    })
    .catch(error => {
      console.debug('[debug][db.js] getTrackDetailFromCache failed', error);
      return undefined;
    });
}

export function cacheLyric(id, lyrics) {
  return db.lyric
    .put({
      id: Number(id),
      lyrics,
      updateTime: Date.now(),
    })
    .catch(error => {
      console.debug('[debug][db.js] cacheLyric failed', error);
    });
}

export function getLyricFromCache(id) {
  return db.lyric
    .get(Number(id))
    .then(result => {
      if (!result) return undefined;
      return result.lyrics;
    })
    .catch(() => undefined);
}

export function cacheAlbum(id, album) {
  return db.album
    .put({
      id: Number(id),
      album,
      updateTime: Date.now(),
    })
    .catch(error => {
      console.debug('[debug][db.js] cacheAlbum failed', error);
    });
}

export function getAlbumFromCache(id) {
  return db.album
    .get(Number(id))
    .then(result => {
      if (!result) return undefined;
      return result.album;
    })
    .catch(() => undefined);
}

export function countDBSize() {
  const trackSizes = [];
  return db.trackSources
    .each(track => {
      trackSizes.push(getByteLength(track));
    })
    .then(() => {
      const res = {
        bytes: trackSizes.reduce((s1, s2) => s1 + s2, 0),
        length: trackSizes.length,
      };
      tracksCacheBytes = res.bytes;
      writeCacheBytes();
      console.debug(
        `[debug][db.js] load tracksCacheBytes: ${tracksCacheBytes}`
      );
      return res;
    });
}

export function clearDB() {
  tracksCacheBytes = 0;
  writeCacheBytes();
  return Promise.all(db.tables.map(table => table.clear())).then(() => true);
}
