/* ═══════════ التحقق من كلمة مرور المدير ═══════════
   كلمة المرور لا تُخزَّن أبداً كنص مقروء:
   • تُحفظ بصيغة مشفَّرة (SHA-256) في المسار settings/auth
   • قواعد قاعدة البيانات تمنع قراءة هذا المسار نهائياً
   • التحقق يتم بمحاولة كتابة البصمة في adminAuth — تقبلها القاعدة
     فقط إذا طابقت البصمة المخزَّنة، فلا يحتاج التطبيق لقراءتها إطلاقاً. */

import { db, ref, get, set } from "./firebase.js";
import { deviceId, LS } from "./utils.js";

const SALT = "azhari-attendance::v1::";
const AUTH_PATH = "settings/auth";
const LEGACY_PATH = "settings/global/adminPass";
const BOOTSTRAP = "azhari2026";          // تُستخدم مرة واحدة عند أول تشغيل فقط
const CACHE_KEY = "az_admin_hash";       // للدخول بدون إنترنت

/** بصمة SHA-256 للنص (تحتاج HTTPS أو localhost) */
export async function hashOf(text) {
  const data = new TextEncoder().encode(SALT + String(text));
  const buf = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

const withTimeout = (p, ms = 7000) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);

async function readStoredHash() {
  try {
    const s = await withTimeout(get(ref(db, AUTH_PATH + "/hash")));
    return s.val();          // نص = القواعد لم تُحدَّث بعد | null = غير موجودة
  } catch {
    return undefined;        // undefined = القراءة ممنوعة (الوضع الآمن) أو لا اتصال
  }
}

/** يكتب البصمة الجديدة — القاعدة تشترط إرسال البصمة القديمة عند التغيير */
async function writeHash(hash, prev) {
  await withTimeout(set(ref(db, AUTH_PATH), prev ? { hash, prev, at: Date.now() } : { hash, at: Date.now() }));
  LS.set(CACHE_KEY, hash);
  set(ref(db, LEGACY_PATH), null).catch(() => {});   // إزالة أي نسخة نصية قديمة
}

/**
 * يتحقق من كلمة المرور دون كشف البصمة المخزَّنة.
 * @returns {Promise<{ok:boolean, hash:string}>}
 */
export async function verifyAdmin(pw, legacyPlain = null) {
  const h = await hashOf(pw);

  // بدون إنترنت: نقارن بالبصمة المحفوظة على الجهاز من آخر دخول ناجح
  if (!navigator.onLine) {
    const cached = LS.get(CACHE_KEY);
    return { ok: !!cached && cached === h, hash: h };
  }

  // 1) الطريقة الآمنة: القاعدة نفسها تقبل الكتابة فقط إذا طابقت البصمة
  try {
    await withTimeout(set(ref(db, `adminAuth/${deviceId()}`), { h, at: Date.now() }));
    LS.set(CACHE_KEY, h);
    return { ok: true, hash: h };
  } catch { /* القواعد قد تكون غير محدَّثة، أو كلمة المرور خاطئة — نتابع الفحص */ }

  // 2) قبل تحديث القواعد: مقارنة مباشرة بالبصمة المخزَّنة
  const stored = await readStoredHash();
  if (typeof stored === "string" && stored) {
    if (stored === h) LS.set(CACHE_KEY, h);
    return { ok: stored === h, hash: h };
  }

  // 3) ترقية تلقائية من كلمة المرور النصية القديمة
  if (legacyPlain) {
    const ok = pw === legacyPlain;
    if (ok) await writeHash(h, null).catch(() => {});
    return { ok, hash: h };
  }

  // 4) أول تشغيل على الإطلاق: لا توجد بصمة محفوظة بعد.
  //    محاولة الكتابة آمنة لأن القواعد ترفضها إذا كانت هناك بصمة موجودة أصلاً.
  if (pw === BOOTSTRAP) {
    try { await writeHash(h, null); return { ok: true, hash: h }; } catch {}
  }

  return { ok: false, hash: h };
}

/* ═══ كلمة مرور الحضور الخاصة بالموظف ═══
   يعيّنها الموظف بنفسه وتُحفظ مشفَّرة في سجله، وتُطلب لتأكيد الحضور من الكمبيوتر. */
export async function empPinHash(pin) {
  return hashOf("emp::" + String(pin));
}

/** تصفير: هل تطابق كلمة المرور المحفوظة للموظف؟ */
export async function verifyEmpPin(emp, pin) {
  if (!emp?.pinHash) return { ok: false, error: "لم تُعيّن كلمة مرور الحضور بعد" };
  const h = await empPinHash(pin);
  return h === emp.pinHash ? { ok: true } : { ok: false, error: "كلمة المرور غير صحيحة" };
}

/** تغيير كلمة المرور — يتطلب معرفة الحالية */
export async function changeAdminPassword(current, next, legacyPlain = null) {
  if (!next || next.length < 4) return { ok: false, error: "كلمة المرور الجديدة قصيرة جداً (4 أحرف على الأقل)" };
  if (!navigator.onLine) return { ok: false, error: "تغيير كلمة المرور يحتاج اتصالاً بالإنترنت" };

  const cur = await verifyAdmin(current, legacyPlain);
  if (!cur.ok) return { ok: false, error: "كلمة المرور الحالية غير صحيحة" };

  try {
    await writeHash(await hashOf(next), cur.hash);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: "تعذّر حفظ كلمة المرور — تأكد من الاتصال" };
  }
}
