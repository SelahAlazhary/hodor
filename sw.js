/* ===== Service Worker — تشغيل بدون إنترنت + الإشعارات ===== */
const VERSION = "azhari-attendance-v3";
const CFG_CACHE = "azhari-config";   // كاش دائم لإعدادات الحضور التلقائي
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
    await Promise.all(keys.filter(k => k !== VERSION && k !== CFG_CACHE).map(k => caches.delete(k)));
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

/* ═══════════ الحضور التلقائي عبر شبكة الشركة ═══════════
   يعمل والتطبيق مغلق على أندرويد/كروم بعد تثبيته كتطبيق،
   عبر Periodic Background Sync + واجهة REST لقاعدة البيانات اللحظية. */
const CFG_KEY = "/__az_auto_config";

self.addEventListener("message", e => {
  if (e.data === "skipWaiting") { self.skipWaiting(); return; }
  if (e.data?.type === "az-auto-config") {
    e.waitUntil(caches.open(CFG_CACHE).then(c => c.put(
      new Request(CFG_KEY),
      new Response(JSON.stringify(e.data.config), { headers: { "content-type": "application/json" } })
    )));
  }
});

self.addEventListener("periodicsync", e => {
  if (e.tag === "az-auto-checkin") e.waitUntil(autoCheckin());
});
self.addEventListener("sync", e => {
  if (e.tag === "az-auto-checkin") e.waitUntil(autoCheckin());
});

const p2 = n => String(n).padStart(2, "0");
const toMin = t => { const [h, m] = String(t || "").split(":").map(Number); return isNaN(h) ? null : h * 60 + m; };

async function publicIP() {
  const urls = [
    ["https://api.ipify.org?format=json", async r => (await r.json()).ip],
    ["https://www.cloudflare.com/cdn-cgi/trace", async r => ((await r.text()).match(/^ip=(.+)$/m) || [])[1]]
  ];
  for (const [u, pick] of urls) {
    try { const r = await fetch(u, { cache: "no-store" }); if (r.ok) { const ip = (await pick(r) || "").trim(); if (ip) return ip; } }
    catch {}
  }
  return null;
}
const ipHit = (ip, nets) => nets.some(n => {
  const v = String(n?.ip || "").trim();
  return v && (v.endsWith(".") ? ip.startsWith(v) : ip === v);
});

async function autoCheckin() {
  try {
    const c = await caches.open(CFG_CACHE);
    const res = await c.match(new Request(CFG_KEY));
    if (!res) return;
    const cfg = await res.json();
    if (!cfg?.dbUrl || !cfg?.empId) return;

    const S = await (await fetch(`${cfg.dbUrl}/settings/global.json`, { cache: "no-store" })).json();
    if (!S || !S.autoCheckin) return;
    const nets = Object.values(S.networks || {});
    if (!nets.length) return;

    const now = new Date();
    const cur = now.getHours() * 60 + now.getMinutes();
    if (cur < (toMin(S.autoWindowStart) ?? 300) || cur > (toMin(S.autoWindowEnd) ?? 1439)) return;

    const dk = `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}`;
    const url = `${cfg.dbUrl}/attendance/${dk}/${cfg.empId}.json`;
    const exist = await (await fetch(url, { cache: "no-store" })).json();
    if (exist && (exist.checkIn || exist.status === "absent")) return;

    const ip = await publicIP();
    if (!ip || !ipHit(ip, nets)) return;

    const startMin = toMin(cfg.workStart || S.workStart) ?? 540;
    const late = cur - (startMin + Number(S.graceMin || 0));
    const rec = {
      empId: cfg.empId, empName: cfg.empName, date: dk,
      checkIn: now.toISOString(), checkOut: null, workedMin: 0,
      status: late > 0 ? "late" : "present", lateMin: late > 0 ? late : 0,
      source: "auto-wifi-bg", createdAt: Date.now(), updatedAt: Date.now()
    };
    await fetch(url, { method: "PATCH", body: JSON.stringify(rec) });
    await fetch(`${cfg.dbUrl}/events.json`, {
      method: "POST",
      body: JSON.stringify({ type: "in", empId: cfg.empId, empName: cfg.empName, date: dk, at: rec.checkIn, status: rec.status, createdAt: Date.now() })
    });

    let h = now.getHours(); const mm = p2(now.getMinutes());
    const ap = h < 12 ? "ص" : "م"; h = h % 12 || 12;
    await self.registration.showNotification("✅ تم تسجيل الحضور تلقائياً", {
      body: `${cfg.empName}
عند اتصالك بشبكة الشركة
وقت الحضور: ${p2(h)}:${mm} ${ap}`,
      icon: "./icons/icon-192.png", badge: "./icons/icon-192.png",
      dir: "rtl", lang: "ar", tag: "auto-in", vibrate: [120, 60, 120]
    });
  } catch (e) { /* نتجاهل الأخطاء في الخلفية */ }
}
