// MindCare Tasks Service Worker
// 전략: 네트워크 우선, 실패 시 캐시 폴백 (오프라인 지원)
// HTML은 항상 새로 받아옴 (옛 코드 캐시 방지)

const CACHE_NAME = 'mindcare-v3';
const PRECACHE_URLS = [
  '/icon-192.png',
  '/icon-512.png',
  '/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  // 새 SW 즉시 활성화
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS))
      .catch(() => {})
  );
});

self.addEventListener('activate', (event) => {
  // 기존 캐시 모두 정리 (옛 버전 강제 제거)
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // POST, PUT, DELETE 등은 캐시하지 않음 (Supabase API 호출)
  if (req.method !== 'GET') return;

  // Supabase, Telegram API 호출은 그냥 통과
  if (url.hostname.includes('supabase.co') || url.hostname.includes('telegram.org')) {
    return;
  }

  // HTML, JS 파일은 네트워크 우선 (옛 코드 보일까봐)
  const isHtml = req.headers.get('accept')?.includes('text/html');
  if (isHtml || url.pathname.endsWith('.html') || url.pathname.endsWith('.js')) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          // 성공 응답은 캐시에 복사
          if (res && res.status === 200) {
            const resClone = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, resClone));
          }
          return res;
        })
        .catch(() => caches.match(req)) // 오프라인이면 캐시
    );
    return;
  }

  // 이미지, 폰트 등은 캐시 우선
  event.respondWith(
    caches.match(req).then((cached) =>
      cached || fetch(req).then((res) => {
        if (res && res.status === 200) {
          const resClone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, resClone));
        }
        return res;
      })
    )
  );
});
