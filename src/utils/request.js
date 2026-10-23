import router from '@/router';
import { doLogout, getCookie } from '@/utils/auth';
import axios from 'axios';

let baseURL = '';
// Web 和 Electron 跑在不同端口避免同时启动时冲突
if (process.env.IS_ELECTRON) {
  if (process.env.NODE_ENV === 'production') {
    baseURL = process.env.VUE_APP_ELECTRON_API_URL;
  } else {
    baseURL = process.env.VUE_APP_ELECTRON_API_URL_DEV;
  }
} else {
  baseURL = process.env.VUE_APP_NETEASE_API_URL;
}

/**
 * settings 缓存。
 *
 * 原实现每个请求都 JSON.parse 三次 localStorage，且 settings 缺失或损坏时
 * 会直接抛错，导致请求根本发不出去。这里做两件事：短 TTL 缓存 + 容错。
 */
const SETTINGS_CACHE_TTL = 1000;
let settingsCache = null;
let settingsCacheAt = 0;

function getSettings() {
  const now = Date.now();
  if (settingsCache !== null && now - settingsCacheAt < SETTINGS_CACHE_TTL) {
    return settingsCache;
  }
  try {
    settingsCache = JSON.parse(localStorage.getItem('settings')) || {};
  } catch (e) {
    settingsCache = {};
  }
  settingsCacheAt = now;
  return settingsCache;
}

/** 外部修改 settings 后可以主动失效缓存 */
export function invalidateSettingsCache() {
  settingsCache = null;
  settingsCacheAt = 0;
}

const service = axios.create({
  baseURL,
  withCredentials: true,
  timeout: 15000,
});

service.interceptors.request.use(function (config) {
  if (!config.params) config.params = {};
  if (baseURL && baseURL.length) {
    if (
      baseURL[0] !== '/' &&
      !process.env.IS_ELECTRON &&
      getCookie('MUSIC_U') !== null
    ) {
      config.params.cookie = `MUSIC_U=${getCookie('MUSIC_U')};`;
    }
  } else {
    console.error("You must set up the baseURL in the service's config");
  }

  if (!process.env.IS_ELECTRON && !config.url.includes('/login')) {
    config.params.realIP = '211.161.244.70';
  }

  const settings = getSettings();

  // Force real_ip
  if (process.env.VUE_APP_REAL_IP) {
    config.params.realIP = process.env.VUE_APP_REAL_IP;
  } else if (settings.enableRealIP && settings.realIP) {
    config.params.realIP = settings.realIP;
  }

  const proxy = settings.proxyConfig;
  if (proxy && ['HTTP', 'HTTPS'].includes(proxy.protocol) && proxy.server) {
    config.params.proxy = `${proxy.protocol}://${proxy.server}:${proxy.port}`;
  }

  return config;
});

service.interceptors.response.use(
  response => {
    const res = response.data;
    return res;
  },
  async error => {
    /** @type {import('axios').AxiosResponse | null} */
    let response;
    let data;
    if (error === 'TypeError: baseURL is undefined') {
      response = error;
      data = error;
      console.error("You must set up the baseURL in the service's config");
    } else if (error.response) {
      response = error.response;
      data = response.data;
    }

    if (
      response &&
      typeof data === 'object' &&
      data.code === 301 &&
      data.msg === '需要登录'
    ) {
      console.warn('Token has expired. Logout now!');

      // 登出帳戶
      doLogout();

      // 導向登入頁面
      if (process.env.IS_ELECTRON === true) {
        router.push({ name: 'loginAccount' });
      } else {
        router.push({ name: 'login' });
      }
    }

    // 关键修复：原实现没有 reject，错误被静默吞掉，
    // 调用方的 .then 会拿到 undefined，随后在 data.songs[0] 这类地方崩溃。
    return Promise.reject(error);
  }
);

export default service;
