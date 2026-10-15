// 설치형 앱용 서비스 워커
// 화면 파일을 저장해 두어 오프라인에서도 앱이 열리게 한다.
// 온라인이면 항상 최신 파일을 먼저 받고(새 버전 바로 반영), 실패할 때만 저장본을 쓴다.
// AI API 요청(다른 주소)은 건드리지 않는다.

const CACHE = "hsim-app-v2";
const SHELL = [
  "./", "./index.html", "./style.css", "./app.js", "./settings.js", "./local-api.js", "./store.js",
  "./prompt.js", "./game.js", "./providers.js",
  "./manifest.webmanifest", "./icon-192.png", "./icon-512.png",
];

self.addEventListener("install", (ev) => {
  ev.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (ev) => {
  ev.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (ev) => {
  const req = ev.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return;
  ev.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() =>
        caches.match(req, { ignoreSearch: true })
          .then((hit) => hit || (req.mode === "navigate" ? caches.match("./index.html") : undefined))
          .then((hit) => hit || new Response("오프라인이에요", { status: 503 })),
      ),
  );
});
