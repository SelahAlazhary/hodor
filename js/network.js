/* ===== التعرّف على شبكة الشركة =====
   المتصفحات لا تسمح بقراءة اسم شبكة الواي فاي (SSID) لأسباب أمنية،
   لذلك نتعرّف على شبكة الشركة عن طريق "عنوان IP العام" الذي يخرج منه الإنترنت.
   كل جهاز متصل بواي فاي الشركة يظهر بنفس هذا العنوان — فيُسجَّل الحضور تلقائياً. */

let cache = { ip: null, at: 0 };
const TTL = 60_000;

const SERVICES = [
  { url: "https://api.ipify.org?format=json", pick: async r => (await r.json()).ip },
  { url: "https://ipapi.co/json/",            pick: async r => (await r.json()).ip },
  { url: "https://www.cloudflare.com/cdn-cgi/trace",
    pick: async r => ((await r.text()).match(/^ip=(.+)$/m) || [])[1] }
];

/** يجلب عنوان IP العام للجهاز (مع تخزين مؤقت دقيقة واحدة) */
export async function getPublicIP(force = false) {
  if (!navigator.onLine) return null;
  if (!force && cache.ip && Date.now() - cache.at < TTL) return cache.ip;

  for (const s of SERVICES) {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 6000);
      const res = await fetch(s.url, { signal: ctl.signal, cache: "no-store" });
      clearTimeout(t);
      if (!res.ok) continue;
      const ip = (await s.pick(res) || "").trim();
      if (ip) { cache = { ip, at: Date.now() }; return ip; }
    } catch { /* نجرّب الخدمة التالية */ }
  }
  return null;
}

/** مفتاح صالح للتخزين في Realtime Database (لا يقبل النقاط) */
export const ipKey = ip => String(ip).replace(/[.:#$/\[\]]/g, "_");

/** هل ينتمي العنوان لإحدى شبكات الشركة؟
 *  يقبل عنواناً كاملاً (41.33.12.5) أو بداية نطاق تنتهي بنقطة (41.33.) */
export function ipMatches(ip, networks) {
  if (!ip) return false;
  return (networks || []).some(n => {
    const v = String(n?.ip || n || "").trim();
    if (!v) return false;
    return v.endsWith(".") ? ip.startsWith(v) : ip === v;
  });
}

/** نوع الاتصال إن كان المتصفح يوفّره (لا يكشف اسم الشبكة) */
export function connectionType() {
  const c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  return c?.type || c?.effectiveType || "unknown";
}
