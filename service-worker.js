// 避難所案内マップ Service Worker v2.1
// UIは変更せず、アプリ本体のオフライン起動と外部ライブラリの再利用を担当する。
// 地図のオフライン本体（国土地理院PMTiles Range）は index.html 側の専用Cache Storageで管理する。

const CACHE_VERSION = 'v2.1';
const CORE_CACHE = `hinanjo-core-${CACHE_VERSION}`;
const RUNTIME_CACHE = `hinanjo-runtime-${CACHE_VERSION}`;
const CURRENT_PMTILES_CACHE = 'hinanjo-pmtiles-gsi-optbv-2026-04-v2';

// アプリの起動に最低限必要な同一オリジン資産
const CORE_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icons/favicon-16.png',
  './icons/favicon-32.png',
  './icons/apple-touch-icon.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-192.png',
  './icons/icon-maskable-512.png'
];

// 完全オフライン起動に必要な外部ライブラリ。
// install自体は、CDNの一時障害でPWA全体が登録不能にならないよう allSettled で扱う。
const EXTERNAL_APP_ASSETS = [
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  'https://cdn.tailwindcss.com/',
  'https://gsi-cyberjapan.github.io/optimal_bvmap/lib/maplibre-gl@2.4.0/maplibre-gl.css',
  'https://gsi-cyberjapan.github.io/optimal_bvmap/lib/maplibre-gl@2.4.0/maplibre-gl.js',
  'https://gsi-cyberjapan.github.io/optimal_bvmap/lib/pmtiles@2.10.0/index.js',
  'https://unpkg.com/@maplibre/maplibre-gl-leaflet@0.0.20/leaflet-maplibre-gl.js',
  'https://gsi-cyberjapan.github.io/optimal_bvmap/style/std.json',
  'https://gsi-cyberjapan.github.io/optimal_bvmap/sprite/std.json',
  'https://gsi-cyberjapan.github.io/optimal_bvmap/sprite/std.png',
  'https://gsi-cyberjapan.github.io/optimal_bvmap/sprite/std@2x.json',
  'https://gsi-cyberjapan.github.io/optimal_bvmap/sprite/std@2x.png'
];

async function cacheExternalAsset(cache, url) {
  try {
    const response = await fetch(url, { cache: 'no-store' });
    if (response.ok || response.type === 'opaque') {
      await cache.put(url, response.clone());
    }
  } catch (e) {
    console.warn('[SW] external precache skipped:', url, e);
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const core = await caches.open(CORE_CACHE);
    await core.addAll(CORE_ASSETS);

    const runtime = await caches.open(RUNTIME_CACHE);
    await Promise.allSettled(EXTERNAL_APP_ASSETS.map((url) => cacheExternalAsset(runtime, url)));

    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.map((name) => {
      const keep = name === CORE_CACHE ||
                   name === RUNTIME_CACHE ||
                   name === CURRENT_PMTILES_CACHE;
      return keep ? Promise.resolve(false) : caches.delete(name);
    }));
    await self.clients.claim();
  })());
});

function isOpenStreetMapTile(url) {
  return /^https:\/\/tile\.openstreetmap\.org\//.test(url);
}

function isRuntimeAsset(url) {
  return /unpkg\.com|cdn\.tailwindcss\.com|fonts\.googleapis\.com|fonts\.gstatic\.com|gsi-cyberjapan\.github\.io/.test(url);
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(RUNTIME_CACHE);
  // index.html側が同名ランタイムキャッシュへ保存したstyle/glyphもここで拾える。
  const cached = await cache.match(request);
  const network = fetch(request)
    .then(async (response) => {
      if (response && (response.ok || response.type === 'opaque')) {
        await cache.put(request, response.clone());
      }
      return response;
    })
    .catch(() => cached);
  return cached || network;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = request.url;

  // 重要: OSM公式タイルは永続キャッシュ/一括保存しない。
  // 通常閲覧時はネットワークへそのまま流し、HTTPキャッシュ規則はブラウザに任せる。
  if (isOpenStreetMapTile(url)) {
    return;
  }

  // ページ遷移：ネットワーク優先。圏外なら保存済みindex.htmlで起動する。
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        if (response.ok) {
          const core = await caches.open(CORE_CACHE);
          await core.put('./index.html', response.clone());
        }
        return response;
      } catch (e) {
        return (await caches.match('./index.html')) || (await caches.match('./'));
      }
    })());
    return;
  }

  // CDN / 国土地理院の表示補助資産：キャッシュを即時表示しつつオンライン時に更新。
  // PMTiles本体(cyberjapandata.gsi.go.jp)はindex.htmlのRange専用キャッシュで扱うためここには含めない。
  if (isRuntimeAsset(url)) {
    event.respondWith(staleWhileRevalidate(request));
    return;
  }

  // 同一オリジンのその他資産：キャッシュ優先。
  if (new URL(url).origin === self.location.origin) {
    event.respondWith((async () => {
      const cached = await caches.match(request);
      if (cached) return cached;
      try {
        const response = await fetch(request);
        if (response.ok) {
          const core = await caches.open(CORE_CACHE);
          await core.put(request, response.clone());
        }
        return response;
      } catch (e) {
        // 画像等でindex.htmlを返すと壊れたレスポンスになるため、ここではフォールバックしない。
        throw e;
      }
    })());
  }
});
