/* ===== Service Worker — تشغيل بدون إنترنت + الإشعارات ===== */
const VERSION = "spotlight-v17";
const CFG_CACHE = "azhari-config";   // كاش دائم لإعدادات الحضور التلقائي
const SHELL = [
  "./", "./index.html", "./manifest.webmanifest",
  "./css/app.css",
  "./js/app.js", "./js/utils.js", "./js/store.js",
  "./js/firebase.js", "./js/notify.js", "./js/employee.js", "./js/admin.js", "./js/sound.js", "./js/scanner.js", "./js/screen.js",
  "./icons/icon-192-sl.png", "./icons/icon-512-sl.png"
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
  let d = { title: "Spot Light", body: "لديك إشعار جديد" };
  try { d = { ...d, ...e.data.json() }; } catch { if (e.data) d.body = e.data.text(); }
  e.waitUntil(self.registration.showNotification(d.title, {
    body: d.body, icon: "./icons/icon-192-sl.png", badge: "./icons/icon-192-sl.png",
    dir: "rtl", lang: "ar", silent: false, vibrate: [120, 60, 120]
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
  if (e.tag === "az-auto-checkin")
    e.waitUntil(Promise.all([autoCheckin(), checkoutDue(), leftNetwork()]));
});
self.addEventListener("sync", e => {
  if (e.tag === "az-auto-checkin") e.waitUntil(autoCheckin());
});

const p2 = n => String(n).padStart(2, "0");

/** يحوّل لحظة إلى كائن تاريخ بقِيَم توقيت القاهرة */
function cairo(ms) {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: "Africa/Cairo", hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit"
  });
  const o = {};
  for (const part of f.formatToParts(new Date(ms))) if (part.type !== "literal") o[part.type] = +part.value;
  if (o.hour === 24) o.hour = 0;
  return new Date(o.year, o.month - 1, o.day, o.hour, o.minute, o.second);
}
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

/** ينبّه إذا غادر الموظف شبكة الشركة دون تسجيل انصراف (يعمل والتطبيق مغلق) */
async function leftNetwork() {
  try {
    const c = await caches.open(CFG_CACHE);
    const res = await c.match(new Request(CFG_KEY));
    if (!res) return;
    const cfg = await res.json();
    if (!cfg?.dbUrl || !cfg?.empId) return;

    const S = await (await fetch(`${cfg.dbUrl}/settings/global.json`, { cache: "no-store" })).json() || {};
    const nets = Object.values(S.networks || {});
    if (!nets.length) return;

    const ms = Date.now() + (Number(cfg.clockOffset) || 0);
    const now = cairo(ms);
    const dk = `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}`;
    const rec = await (await fetch(`${cfg.dbUrl}/attendance/${dk}/${cfg.empId}.json`, { cache: "no-store" })).json();
    if (!rec || !rec.checkIn || rec.checkOut || rec.status === "absent") return;

    const ip = await publicIP();
    if (!ip) return;

    const markReq = new Request("/__az_leftnet");
    const mark = await c.match(markReq);
    const prev = mark ? await mark.json() : null;

    if (ipHit(ip, nets)) {                       // ما زال داخل الشبكة
      if (prev) await c.delete(markReq);
      return;
    }
    // ═══ انصراف تلقائي بعد مغادرة الشبكة بساعة (وقت الانصراف = لحظة المغادرة) ═══
    const prevLeft = rec.leftNetAt ? new Date(rec.leftNetAt).getTime() : ms;
    const awayMin = Math.round((ms - prevLeft) / 60000);
    if (S.autoCheckout !== false && rec.leftNetAt && awayMin >= Number(S.autoCheckoutAfterLeaveMin ?? 60)) {
      const inMs = new Date(rec.checkIn).getTime();
      let outMs = prevLeft; if (outMs > ms) outMs = ms; if (outMs <= inMs) outMs = ms;
      const workedMin = Math.max(0, Math.round((outMs - inMs) / 60000));
      const a = toMin(rec.expectedStart), b = toMin(rec.expectedEnd);
      let reqMin = (a != null && b != null) ? b - a : Number(S.dailyHours || 8) * 60; if (reqMin < 0) reqMin += 1440; reqMin = reqMin || 480;
      const lateMin = Math.max(0, Number(rec.lateMin || 0)); const ot = Math.max(0, workedMin - reqMin);
      await fetch(`${cfg.dbUrl}/attendance/${dk}/${cfg.empId}.json`, { method: "PATCH", body: JSON.stringify({
        checkOut: new Date(outMs).toISOString(), workedMin, requiredMin: reqMin, overtimeMin: ot,
        completed: true, autoCheckout: true,
        status: (lateMin > 0 && ot > 0) ? "present" : (rec.status === "late" ? "late" : "present"),
        lateMin: (lateMin > 0 && ot > 0) ? 0 : lateMin, lateExcused: (lateMin > 0 && ot > 0) ? lateMin : 0,
        updatedAt: Date.now() }) });
      await fetch(`${cfg.dbUrl}/events.json`, { method: "POST", body: JSON.stringify({
        type: "out", empId: cfg.empId, empName: cfg.empName, date: dk,
        at: new Date(outMs).toISOString(), workedMin, auto: true, createdAt: Date.now() }) });
      const oh = cairo(outMs), H = Math.floor(workedMin/60), Mn = workedMin%60;
      const outLbl = `${p2(oh.getHours()%12||12)}:${p2(oh.getMinutes())} ${oh.getHours()<12?"ص":"م"}`;
      await self.registration.showNotification("🔴 تم تسجيل انصرافك", {
        body: `${cfg.empName}
مضت ساعة على مغادرتك شبكة الشركة
سُجّل انصرافك عند خروجك الساعة ${outLbl}
إجمالي اليوم: ${Mn? H+" س "+Mn+" د" : H+" س"}`,
        icon: "./icons/icon-192-sl.png", badge: "./icons/icon-192-sl.png",
        dir: "rtl", lang: "ar", silent: false, requireInteraction: true, tag: "auto-out", vibrate: [300,120,300,120,300] });
      return;
    }

    if (prev && prev.date === dk && prev.done) return;
    await c.put(markReq, new Response(JSON.stringify({ date: dk, done: true }),
      { headers: { "content-type": "application/json" } }));

    const endStr = cfg.workEnd || S.workEnd || "17:00";
    const endMin = toMin(endStr);
    const curMin = now.getHours() * 60 + now.getMinutes();
    const afterShift = endMin != null && curMin >= endMin;
    const leftAtISO = new Date(ms).toISOString();

    // نسجّل لحظة المغادرة ليستطيع المدير إنهاء اليوم عليها بدقة
    await fetch(`${cfg.dbUrl}/attendance/${dk}/${cfg.empId}.json`, {
      method: "PATCH",
      body: JSON.stringify({ leftNetAt: leftAtISO, leftAfterShift: afterShift })
    });

    await fetch(`${cfg.dbUrl}/events.json`, {
      method: "POST",
      body: JSON.stringify({ type: "leftnet", empId: cfg.empId, empName: cfg.empName,
                             date: dk, at: leftAtISO, checkIn: rec.checkIn,
                             afterShift, createdAt: ms })
    });

    await self.registration.showNotification(
      afterShift ? "🔔 غادرت بعد انتهاء دوامك" : "⚠️ خروج قبل انتهاء الدوام", {
      body: afterShift
        ? `${cfg.empName}\nانتهى دوامك الساعة ${endStr} وغادرت المقر دون تسجيل انصراف.\nسجّل انصرافك ليُحتسب وقتك ووقتك الإضافي بدقة.`
        : `${cfg.empName}\nخرجت من شبكة الشركة قبل انتهاء دوامك ولم تسجّل انصرافك.`,
      icon: "./icons/icon-192-sl.png", badge: "./icons/icon-192-sl.png",
      dir: "rtl", lang: "ar", silent: false, tag: "left-net", requireInteraction: true,
      vibrate: [200, 90, 200]
    });
  } catch (e) { /* تجاهل */ }
}

/** تنبيه الموظف بانتهاء دوامه ليسجّل انصرافه بنفسه (يعمل والتطبيق مغلق) */
async function checkoutDue() {
  try {
    const c = await caches.open(CFG_CACHE);
    const res = await c.match(new Request(CFG_KEY));
    if (!res) return;
    const cfg = await res.json();
    if (!cfg?.dbUrl || !cfg?.empId) return;

    const S = await (await fetch(`${cfg.dbUrl}/settings/global.json`, { cache: "no-store" })).json() || {};
    const endStr = cfg.workEnd || S.workEnd || "17:00";
    const end = toMin(endStr);
    if (end == null) return;

    const ms = Date.now() + (Number(cfg.clockOffset) || 0);
    const now = cairo(ms);
    const cur = now.getHours() * 60 + now.getMinutes();
    if (cur < end) return;

    const dk = `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}`;
    const rec = await (await fetch(`${cfg.dbUrl}/attendance/${dk}/${cfg.empId}.json`, { cache: "no-store" })).json();
    if (!rec || !rec.checkIn || rec.checkOut || rec.status === "absent") return;

    // ═══ انصراف تلقائي عند نهاية الشفت (لمن ما زال في المقر ولم يغادر الشبكة) ═══
    if (S.autoCheckout !== false && !rec.leftNetAt && cur >= end + Number(S.autoCheckoutAfterMin ?? 2)) {
      const inMs = new Date(rec.checkIn).getTime();
      // وقت الانصراف = نهاية الشفت اليوم (بتوقيت القاهرة)
      const endHH = end, endDate = new Date(now); endDate.setHours(Math.floor(endHH / 60), endHH % 60, 0, 0);
      let outMs = ms - (cur - endHH) * 60000;
      if (outMs <= inMs) outMs = ms;
      const workedMin = Math.max(0, Math.round((outMs - inMs) / 60000));
      const reqMin = (() => { const a = toMin(rec.expectedStart), b = toMin(rec.expectedEnd);
        let d = (a != null && b != null) ? b - a : (Number(S.dailyHours || 8) * 60); if (d < 0) d += 1440; return d || 480; })();
      const lateMin = Math.max(0, Number(rec.lateMin || 0));
      const ot = Math.max(0, workedMin - reqMin);
      const patch = { checkOut: new Date(outMs).toISOString(), workedMin, requiredMin: reqMin,
        overtimeMin: ot, completed: true, autoCheckout: true,
        status: (lateMin > 0 && ot > 0) ? "present" : (rec.status === "late" ? "late" : "present"),
        lateMin: (lateMin > 0 && ot > 0) ? 0 : lateMin, lateExcused: (lateMin > 0 && ot > 0) ? lateMin : 0,
        updatedAt: Date.now() };
      await fetch(`${cfg.dbUrl}/attendance/${dk}/${cfg.empId}.json`, { method: "PATCH", body: JSON.stringify(patch) });
      await fetch(`${cfg.dbUrl}/events.json`, { method: "POST", body: JSON.stringify({
        type: "out", empId: cfg.empId, empName: cfg.empName, date: dk,
        at: new Date(outMs).toISOString(), workedMin, auto: true, createdAt: Date.now() }) });
      const H = Math.floor(workedMin / 60), M = workedMin % 60;
      const dur = M ? `${H} س ${M} د` : `${H} س`;
      const oh = new Date(outMs), eh = oh.getHours(), em = p2(oh.getMinutes());
      const outLbl = `${p2(eh % 12 || 12)}:${em} ${eh < 12 ? "ص" : "م"}`;
      await self.registration.showNotification("🔴 انتهى شفتك — تم تسجيل انصرافك", {
        body: `${cfg.empName}\nخرجت من الشفت الساعة ${outLbl}\nإجمالي ساعات اليوم: ${dur}`,
        icon: "./icons/icon-192-sl.png", badge: "./icons/icon-192-sl.png",
        dir: "rtl", lang: "ar", silent: false, renotify: true, requireInteraction: true,
        tag: "auto-out", vibrate: [300, 120, 300, 120, 300] });
      return;
    }

    const slot = Math.floor((cur - end) / 30);
    if (slot > 4) return;
    const mark = await c.match(new Request("/__az_reminder"));
    const prev = mark ? await mark.json() : null;
    if (prev && prev.date === dk && prev.slot > slot) return;
    await c.put(new Request("/__az_reminder"),
      new Response(JSON.stringify({ date: dk, slot: slot + 1 }), { headers: { "content-type": "application/json" } }));

    const over = cur - end;
    const extra = over >= 5 ? `\n⏱ أنت الآن في وقت إضافي: ${Math.floor(over / 60)} س ${over % 60} د` : "";
    await self.registration.showNotification("🔔 حان وقت الانصراف", {
      body: `${cfg.empName}\nانتهى دوامك الساعة ${endStr}${extra}\nسجّل انصرافك الآن ليُحتسب وقتك بدقة.`,
      icon: "./icons/icon-192-sl.png", badge: "./icons/icon-192-sl.png",
      dir: "rtl", lang: "ar", silent: false, tag: "checkout-due", requireInteraction: true,
      vibrate: [160, 80, 160]
    });
  } catch (e) { /* تجاهل */ }
}

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

    // الوقت من الساعة العالمية وبتوقيت القاهرة — لا من ساعة الجهاز ولا منطقته الزمنية
    const ms = Date.now() + (Number(cfg.clockOffset) || 0);
    const now = cairo(ms);
    const cur = now.getHours() * 60 + now.getMinutes();
    if (cur < (toMin(S.autoWindowStart) ?? 300) || cur > (toMin(S.autoWindowEnd) ?? 1439)) return;

    const dk = `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}`;
    const url = `${cfg.dbUrl}/attendance/${dk}/${cfg.empId}.json`;
    const exist = await (await fetch(url, { cache: "no-store" })).json();
    if (exist && (exist.checkIn || exist.status === "absent")) return;

    const ip = await publicIP();
    if (!ip || !ipHit(ip, nets)) return;

    const startMin = toMin(cfg.workStart || S.workStart) ?? 540;
    // لا تسجيل قبل بدء الشفت بأكثر من المسموح
    if (cur < startMin - Number(S.earlyCheckinMin ?? 60)) return;

    // تحقّق صارم: قراءة ثانية للعنوان بعد فاصل قصير، كلاهما يجب أن يكون على الشبكة
    await new Promise(r => setTimeout(r, 1500));
    const ip2 = await publicIP();
    if (!ip2 || !ipHit(ip2, nets)) return;

    const late = cur - (startMin + Number(S.graceMin || 0));
    const rec = {
      empId: cfg.empId, empName: cfg.empName, date: dk,
      checkIn: new Date(ms).toISOString(), checkOut: null, workedMin: 0,
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
      icon: "./icons/icon-192-sl.png", badge: "./icons/icon-192-sl.png",
      dir: "rtl", lang: "ar", silent: false, tag: "auto-in", vibrate: [120, 60, 120]
    });
  } catch (e) { /* نتجاهل الأخطاء في الخلفية */ }
}
