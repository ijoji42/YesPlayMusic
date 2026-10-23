const path = require('path');
function resolve(dir) {
  return path.join(__dirname, dir);
}

module.exports = {
  // 生产环境打包不输出 map
  productionSourceMap: false,
  devServer: {
    disableHostCheck: true,
    port: process.env.DEV_SERVER_PORT || 8080,
    proxy: {
      '^/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        pathRewrite: {
          '^/api': '/',
        },
      },
    },
  },
  pwa: {
    name: 'YesPlayMusic',
    iconPaths: {
      favicon32: 'img/icons/favicon-32x32.png',
    },
    themeColor: '#ffffff00',
    manifestOptions: {
      background_color: '#335eea',
    },
    // workboxOptions: {
    //   swSrc: "dev/sw.js",
    // },
  },
  pages: {
    index: {
      entry: 'src/main.js',
      template: 'public/index.html',
      filename: 'index.html',
      title: 'YesPlayMusic',
      chunks: ['main', 'chunk-vendors', 'chunk-common', 'index'],
    },
  },
  chainWebpack(config) {
    config.module.rules.delete('svg');
    config.module.rule('svg').exclude.add(resolve('src/assets/icons')).end();
    config.module
      .rule('icons')
      .test(/\.svg$/)
      .include.add(resolve('src/assets/icons'))
      .end()
      .use('svg-sprite-loader')
      .loader('svg-sprite-loader')
      .options({
        symbolId: 'icon-[name]',
      })
      .end();
    config.module
      .rule('napi')
      .test(/\.node$/)
      .use('node-loader')
      .loader('node-loader')
      .end();

    config.module
      .rule('webpack4_es_fallback')
      .test(/\.js$/)
      .include.add(/node_modules/)
      .end()
      .use('esbuild-loader')
      .loader('esbuild-loader')
      .options({ target: 'es2015', format: 'cjs' })
      .end();

    // 原来这里用 LimitChunkCountPlugin({ maxChunks: 3 }) 把所有异步 chunk
    // 强行合并成 3 个包。副作用是路由级代码分割被彻底废掉：
    // 首屏必须下载完设置页 / 歌词页 / MV 页 / LastFM 回调页等全部 19 个视图
    // （实测 1.09 MiB JS，其中 382 KiB 是用户可能永远不打开的页面）。
    //
    // 这个插件当初是为了「chunk 包太多」加的，但 webpack 4 默认的分包策略
    // 对 19 个路由本来就是合理的，而且桌面端走本地协议、Web 端走 HTTP/2，
    // 多几个 chunk 的请求开销远小于首屏多下 700 KiB。
    // 已移除，恢复按路由懒加载。

    // 关掉 prefetch。vue-cli 默认会把全部 19 个路由的 js/css 以
    // <link rel="prefetch"> 塞进 index.html（实测 38 个），空闲时一次性
    // 下载所有页面。桌面端是本地协议无所谓，Web 端在慢网下会和首屏抢带宽。
    // 注意插件名带 page 后缀（prefetch-index），只删 'prefetch' 不生效。
    config.plugins.delete('prefetch-index');
    config.plugins.delete('prefetch');
  },
  // 添加插件的配置
  pluginOptions: {
    // electron-builder的配置文件
    electronBuilder: {
      nodeIntegration: true,
      externals: ['@unblockneteasemusic/rust-napi'],
      builderOptions: {
        productName: 'YesPlayMusic',
        copyright: 'Copyright © YesPlayMusic',
        // compression: "maximum", // 机器好的可以打开，配置压缩，开启后会让 .AppImage 格式的客户端启动缓慢
        asar: true,
        // 解灰用的 native 模块（.node）无法从 asar 内 dlopen，
        // 必须解包到 app.asar.unpacked，否则打包版会「开发能播、发布不能播」
        asarUnpack: ['**/node_modules/@unblockneteasemusic/**'],
        // 这里原本配置了 publish 指向 qier222/YesPlayMusic（上游作者仓库）。
        // 后果是：electron-builder 会生成 app-update.yml，electron-updater 启动时
        // 检查上游仓库，发现新版本就提示下载并安装 —— 装完之后本地这份 fork 的代码
        // 会被上游版本直接覆盖。
        //
        // 这是个人维护的 fork，没有自己的发布服务器、也没有代码签名，
        // 因此默认不生成更新配置（打包产物不含 app-update.yml，updater 会直接跳过）。
        // 以后要启用自动更新时，在这里补上自己的 provider 与 owner/repo，
        // 并同时设置环境变量 YPM_ENABLE_AUTO_UPDATE=1（见 background.js 的 checkForUpdates）。
        // publish: [
        //   {
        //     provider: 'github',
        //     owner: '<your-account>',
        //     repo: '<your-repo>',
        //     vPrefixedTagName: true,
        //     releaseType: 'draft',
        //   },
        // ],
        directories: {
          // 旧的 dist_electron 被一个残留句柄占着（app.asar 无法删除），
          // 本次输出到独立目录避免冲突；旧目录释放后可改回 'dist_electron'。
          output: 'dist_electron_v0412',
        },
        mac: {
          target: [
            {
              target: 'dmg',
              arch: ['x64', 'arm64', 'universal'],
            },
          ],
          artifactName: '${productName}-${os}-${version}-${arch}.${ext}',
          category: 'public.app-category.music',
          darkModeSupport: true,
        },
        win: {
          target: [
            {
              target: 'portable',
              arch: ['x64'],
            },
            {
              target: 'nsis',
              arch: ['x64'],
            },
          ],
          publisherName: 'YesPlayMusic',
          icon: 'build/icons/icon.ico',
          // 原来这里是 publish: ['github']，会覆盖上面的 publish 配置，
          // 同样指向上游仓库。已移除，见 builderOptions.publish 处的说明。
        },
        linux: {
          target: [
            {
              target: 'AppImage',
              arch: ['x64'],
            },
            {
              target: 'tar.gz',
              arch: ['x64', 'arm64'],
            },
            {
              target: 'deb',
              arch: ['x64', 'armv7l', 'arm64'],
            },
            {
              target: 'rpm',
              arch: ['x64'],
            },
            {
              target: 'snap',
              arch: ['x64'],
            },
            {
              target: 'pacman',
              arch: ['x64'],
            },
          ],
          category: 'Music',
          // 原值 './build/icon.icns' 指向的文件并不存在（实际在 build/icons/），
          // 而且 Linux 需要 png 而不是 icns。传目录让 electron-builder 自动挑选。
          icon: 'build/icons',
        },
        dmg: {
          icon: 'build/icons/icon.icns',
        },
        nsis: {
          // 原配置 oneClick + perMachine 会静默安装到 Program Files（需要 UAC 提权，
          // 无管理员权限时直接失败），并且 deleteAppDataOnUninstall: true
          // 会让用户卸载重装后丢失全部设置、收藏、缓存与登录态。
          oneClick: false,
          perMachine: false,
          allowToChangeInstallationDirectory: true,
          deleteAppDataOnUninstall: false,
        },
      },
      // 主线程的配置文件
      chainWebpackMainProcess: config => {
        config.plugin('define').tap(args => {
          args[0]['IS_ELECTRON'] = true;
          return args;
        });
        config.resolve.alias.set(
          'jsbi',
          path.join(__dirname, 'node_modules/jsbi/dist/jsbi-cjs.js')
        );

        config.module
          .rule('webpack4_es_fallback')
          .test(/\.js$/)
          .include.add(/node_modules/)
          .end()
          .use('esbuild-loader')
          .loader('esbuild-loader')
          .options({ target: 'es2015', format: 'cjs' })
          .end();
      },
      // 渲染线程的配置文件
      chainWebpackRendererProcess: config => {
        // 渲染线程的一些其他配置
        // Chain webpack config for electron renderer process only
        // The following example will set IS_ELECTRON to true in your app
        config.plugin('define').tap(args => {
          args[0]['IS_ELECTRON'] = true;
          return args;
        });
      },
      // 主入口文件
      // mainProcessFile: 'src/main.js',
      // mainProcessArgs: []
    },
  },
};
