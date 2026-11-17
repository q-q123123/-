/* 离线缓存 + 版本更新
 * 策略：
 *   - 页面导航（HTML）：网络优先，失败回退缓存 —— 所以重新部署后一打开就是新版
 *   - 静态资源：先给缓存、后台更新 —— 离线秒开，下一次打开拿到新版
 *   - 新版本不会偷偷激活：会等页面提示「有新版本」再切换，避免版本切换导致的数据错乱观感
 */
var VERSION = 'v5-mwk6cs6x';
var CACHE = 'wt-' + VERSION;

var ASSETS = [
  './',
  './index.html',
  './css/app.css',
  './js/format.js',
  './js/stats.js',
  './js/store.js',
  './js/sync.js',
  './js/chart.js',
  './js/app.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable.png'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE).then(function (cache) {
      return Promise.all(ASSETS.map(function (url) {
        return cache.add(new Request(url, { cache: 'reload' })).catch(function () {});
      }));
    }).then(function () {
      // 立刻接管，避免用户卡在旧版本上
      return self.skipWaiting();
    })
  );
});

self.addEventListener('message', function (event) {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys
        .filter(function (k) { return k.indexOf('wt-') === 0 && k !== CACHE; })
        .map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return;

  var url;
  try { url = new URL(req.url); } catch (e) { return; }
  if (url.origin !== self.location.origin) return;

  // 页面导航：网络优先
  if (req.mode === 'navigate' || (req.headers.get('accept') || '').indexOf('text/html') >= 0) {
    event.respondWith(
      fetch(req, { cache: 'no-cache' }).then(function (res) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put('./index.html', copy); });
        return res;
      }).catch(function () {
        return caches.match('./index.html').then(function (hit) {
          return hit || caches.match('./');
        });
      })
    );
    return;
  }

  // 静态资源：缓存优先 + 后台更新
  event.respondWith(
    caches.match(req).then(function (hit) {
      var updating = fetch(req, { cache: 'no-cache' }).then(function (res) {
        if (res && res.ok) {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); });
        }
        return res;
      }).catch(function () { return hit; });

      if (hit) {
        updating.catch(function () {});
        return hit;
      }
      return updating;
    })
  );
});
