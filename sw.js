/* ===== Service Worker — تشغيل بدون إنترنت + الإشعارات ===== */
const VERSION = "azhari-attendance-v2";
const SHELL = [
  "./", "./index.html", "./manifest.webmanifest",
  "./css/app.css",
  "./js/app.js", "./js/utils.js", "./js/store.js",
  "./js/firebase.js", "./js/notify.js", "./js/employee.js", "./js/admin.js",
  "./icons/icon-192.png", "./icons/icon-512.png"
];

self.addEventListener("install", e => {
  e.waitUntil((async () => {
    const c = await caches.open(VERSION);
    await Promise.all(SHELL.map(u => c.add(u).catch(() => {})));
    self.skipWaiting();
  })());
});

self.addEventListener("activate", e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // لا نتدخل في اتصالات قاعدة البيانات اللحظية
  if (/firebaseio\.com|firebasedatabase\.app|firestore\.googleapis\.com/.test(url.hostname)) return;

  // ملفات SDK والخطوط: من الكاش أولاً ثم تحديث بالخلفية
  if (/gstatic\.com|googleapis\.com/.test(url.hostname)) {
    e.respondWith(staleWhileRevalidate(req));
    return;
  }

  // ملفات التطبيق (نفس النطاق)
  if (url.origin === location.origin) {
    // الصور والأيقونات: من الكاش مباشرة
    if (/\.(png|jpg|jpeg|svg|webp|ico)$/i.test(url.pathname)) {
      e.respondWith(staleWhileRevalidate(req));
      return;
    }
    // الصفحات والأكواد: الشبكة أولاً حتى تصل التحديثات فوراً، والكاش عند انقطاع النت
    e.respondWith((async () => {
      try {
        const r = await fetch(req);
        if (r && r.ok) (await caches.open(VERSION)).put(req, r.clone());
        return r;
      } catch {
        const cached = await caches.match(req);
        if (cached) return cached;
        if (req.mode === "navigate") return (await caches.match("./index.html")) || Response.error();
        return Response.error();
      }
    })());
  }
});

async function staleWhileRevalidate(req) {
  const c = await caches.open(VERSION);
  const cached = await c.match(req);
  const net = fetch(req).then(r => { if (r.ok) c.put(req, r.clone()); return r; }).catch(() => null);
  return cached || (await net) || Response.error();
}

/* فتح التطبيق عند الضغط على الإشعار */
self.addEventListener("notificationclick", e => {
  e.notification.close();
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of all) if ("focus" in c) return c.focus();
    if (self.clients.openWindow) return self.clients.openWindow("./");
  })());
});

/* استقبال إشعارات الدفع (اختياري عند تفعيل FCM) */
self.addEventListener("push", e => {
  let d = { title: "سلاح الأزهري", body: "لديك إشعار جديد" };
  try { d = { ...d, ...e.data.json() }; } catch { if (e.data) d.body = e.data.text(); }
  e.waitUntil(self.registration.showNotification(d.title, {
    body: d.body, icon: "./icons/icon-192.png", badge: "./icons/icon-192.png",
    dir: "rtl", lang: "ar", vibrate: [120, 60, 120]
  }));
});

self.addEventListener("message", e => { if (e.data === "skipWaiting") self.skipWaiting(); });
