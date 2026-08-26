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

/** يجلب العنوان من خدمة محددة بالترتيب (لتنويع مصدر التحقق) */
async function ipFrom(idx) {
  const s = SERVICES[idx % SERVICES.length];
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 6000);
    const res = await fetch(s.url, { signal: ctl.signal, cache: "no-store" });
    clearTimeout(t);
    if (!res.ok) return null;
    const ip = (await s.pick(res) || "").trim();
    return ip || null;
  } catch { return null; }
}

/**
 * تحقّق صارم من وجود الجهاز على شبكة الشركة — يفشل مغلقاً (لا يسجّل عند الشك).
 * • يقرأ العنوان الفعلي عدة مرات من مصادر مختلفة (لا يكفي مصدر واحد).
 * • كل قراءة يجب أن تطابق إحدى شبكات الشركة وإلا يُرفض التسجيل.
 * • لا اتصال أو تعذّر تحديد العنوان ⇒ رفض (لا يُفترض الوجود أبداً).
 * @returns {Promise<{ok:boolean, ip:string|null, reason:string}>}
 */
export async function verifyCompanyNetwork(nets, rounds = 3, gapMs = 1500) {
  if (!navigator.onLine) return { ok: false, ip: null, reason: "offline" };
  if (!nets || !nets.length) return { ok: false, ip: null, reason: "nonets" };

  let confirmed = null;
  for (let i = 0; i < rounds; i++) {
    // نوّع المصدر بين الجولات حتى لا يمرّ عنوان مزيّف من مصدر واحد
    let ip = await ipFrom(i);
    if (!ip) ip = await ipFrom(i + 1);        // خدمة بديلة لنفس الجولة
    if (!ip) return { ok: false, ip: null, reason: "noip" };
    if (!ipMatches(ip, nets)) return { ok: false, ip, reason: "offnet" };
    if (confirmed && confirmed !== ip && !nets.some(n => {
      const v = String(n?.ip || n).trim(); return v.endsWith(".");
    })) {
      // العنوان تغيّر بين جولتين على شبكة بعنوان ثابت ⇒ اتصال غير مستقر، نرفض احتياطاً
      return { ok: false, ip, reason: "unstable" };
    }
    confirmed = ip;
    if (i < rounds - 1) await new Promise(r => setTimeout(r, gapMs));
  }
  return { ok: true, ip: confirmed, reason: "ok" };
}

/** رسالة عربية لسبب رفض التحقق */
export function netReasonAr(reason) {
  return ({
    offline: "لا يوجد اتصال بالإنترنت — لا يمكن تأكيد وجودك في الشركة",
    nonets:  "لم تُضَف شبكة الشركة بعد — راجع الإدارة",
    noip:    "تعذّر تحديد شبكتك — تأكد من الاتصال وحاول مجدداً",
    offnet:  "لست متصلاً بشبكة الشركة — لا يمكن تسجيل الحضور من خارج المقر",
    unstable:"اتصال غير مستقر — حاول مرة أخرى من داخل شبكة الشركة"
  })[reason] || "تعذّر التحقق من الشبكة";
}
