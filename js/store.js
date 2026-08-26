/* ===== طبقة البيانات — Firebase Realtime Database =====
   كل عمليات الكتابة تمر عبر "طابور محلي" (Outbox) مخزَّن في الجهاز:
   - تظهر النتيجة فوراً في الواجهة (حتى بدون إنترنت)
   - تُرفع إلى القاعدة تلقائياً بالترتيب فور عودة الاتصال
   - تبقى محفوظة حتى لو أُغلق التطبيق أو أُعيد تشغيل الهاتف            */

import {
  db, PATH, ref, get, set, update, remove, push,
  onValue, query, orderByKey, startAt, endAt, limitToLast
} from "./firebase.js";
import { LS, dateKey, monthRange, hhmmToMin, toDate, normName, samePhone, deviceId,
         deviceLabel, deviceKind,
         now, nowMs, instant, setClockOffset } from "./utils.js";

/* ---------------- الإعدادات الافتراضية ---------------- */
export const DEFAULT_SETTINGS = {
  company: "Spot Light",
  workStart: "09:00",
  workEnd: "17:00",
  graceMin: 15,
  dailyHours: 8,
  checkinMode: "self",      // self | kiosk | both
  kioskDeviceId: "",
  kioskDeviceName: "",
  /* الحضور التلقائي عند الاتصال بشبكة الشركة */
  autoCheckin: false,
  networks: {},             // { "41_33_12_5": { ip, label, addedAt } }
  manualCheckin: false,
  earlyCheckinMin: 60,        // يُسمح بتسجيل الحضور قبل بدء الشفت بهذا العدد من الدقائق فقط
  screenMonitor: false,       // مراقبة شاشات الكمبيوتر بلقطات عشوائية      // زر «تسجيل حضور» مخفي عن الموظف افتراضياً
  forceInstall: true,
  autoWindowStart: "06:00",
  autoWindowEnd: "17:30"
};

/* ================= الطابور المحلي ================= */
const OUTBOX_KEY = "az_outbox";
let outbox = LS.get(OUTBOX_KEY, []) || [];
const refreshers = new Set();
let flushing = false;

const saveOutbox = () => { LS.set(OUTBOX_KEY, outbox); refreshers.forEach(f => { try { f(); } catch {} }); };
export const pendingCount = () => outbox.length;

function enqueue(path, data) {
  outbox.push({ id: nowMs() + "_" + Math.random().toString(36).slice(2, 7), path, data, tries: 0 });
  saveOutbox();
  flush();
}

async function runOp(op) {
  const r = ref(db, op.path);
  return op.data === null ? remove(r) : update(r, op.data);
}

/** يرفع العمليات المعلّقة بالترتيب.
 *  لا تُحذف أي عملية إلا بعد تأكيد الخادم — وعند الفشل تُعاد المحاولة تلقائياً
 *  بفواصل زمنية متزايدة، فلا تضيع أي بيانات مهما طال انقطاع الإنترنت.        */
let retryTimer = null;
export async function flush() {
  if (flushing || !outbox.length) return;
  flushing = true;
  try {
    while (outbox.length) {
      await runOp(outbox[0]);      // ينتظر تأكيد الخادم
      outbox.shift();
      saveOutbox();
    }
    clearTimeout(retryTimer);
  } catch (e) {
    const op = outbox[0];
    if (op) { op.tries = (op.tries || 0) + 1; saveOutbox(); }
    console.warn("تأجيل رفع العمليات:", e?.message || e);
    const wait = Math.min(60000, 3000 * Math.max(1, op?.tries || 1));
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => flush(), wait);
  } finally {
    flushing = false;
  }
}

/* دمج العمليات المعلّقة فوق البيانات القادمة من الخادم */
function pendingUnder(prefix) {
  return outbox.filter(o => o.path === prefix || o.path.startsWith(prefix + "/"));
}
function setDeep(obj, keys, val) {
  if (!keys.length) {
    if (val === null) return null;
    return Object.assign(obj && typeof obj === "object" ? obj : {}, val);
  }
  const o = obj && typeof obj === "object" ? obj : {};
  const [k, ...rest] = keys;
  if (!rest.length && val === null) { delete o[k]; return o; }
  o[k] = setDeep(o[k], rest, val);
  if (o[k] === null) delete o[k];
  return o;
}
function overlay(prefix, raw) {
  const ops = pendingUnder(prefix);
  if (!ops.length) return raw;
  let out = raw ? JSON.parse(JSON.stringify(raw)) : {};
  for (const op of ops) {
    const keys = op.path === prefix ? [] : op.path.slice(prefix.length + 1).split("/");
    out = setDeep(out, keys, op.data);
    if (out === null) out = {};
  }
  return out;
}

/* ================= أدوات المراقبة ================= */
const cacheKey = p => "az_cache_" + p;

function watchPath(path, mapFn, cb) {
  let raw = LS.get(cacheKey(path), null);
  const render = () => { try { cb(mapFn(overlay(path, raw))); } catch (e) { console.warn(path, e); } };
  refreshers.add(render);
  render();                                   // عرض فوري من الكاش المحلي
  const un = onValue(ref(db, path), snap => {
    raw = snap.val();
    LS.set(cacheKey(path), raw);
    render();
  }, err => console.warn("watch " + path, err.message));
  return () => { try { un(); } catch {} refreshers.delete(render); };
}

async function readPath(path) {
  try {
    const s = await get(ref(db, path));
    const v = s.val();
    LS.set(cacheKey(path), v);
    return overlay(path, v);
  } catch (e) {
    return overlay(path, LS.get(cacheKey(path), null));
  }
}

const notEmpty = o => o && typeof o === "object" && Object.keys(o).length > 0;
const entries = o => Object.entries(o || {});

/** مزامنة الساعة مع خادم Firebase (الساعة العالمية) */
export function watchServerClock(cb) {
  return onValue(ref(db, ".info/serverTimeOffset"), s => {
    const off = Number(s.val());
    if (isFinite(off)) { setClockOffset(off); cb?.(off); }
  }, () => {});
}

/** مراقبة حالة الاتصال بالقاعدة */
export function watchConnection(cb) {
  return onValue(ref(db, ".info/connected"), s => { const on = s.val() === true; if (on) flush(); cb(on); },
    () => cb(false));
}

/* ================= الإعدادات ================= */
export async function getSettings() {
  const v = await readPath(PATH.settings);
  if (notEmpty(v)) return { ...DEFAULT_SETTINGS, ...v };
  enqueue(PATH.settings, { ...DEFAULT_SETTINGS, createdAt: nowMs() });
  return { ...DEFAULT_SETTINGS };
}
export function watchSettings(cb) {
  return watchPath(PATH.settings, v => ({ ...DEFAULT_SETTINGS, ...(v || {}) }), cb);
}
export function saveSettings(patch) {
  enqueue(PATH.settings, { ...patch, updatedAt: nowMs() });
  return Promise.resolve();
}

/** شبكات الشركة المعتمدة للحضور التلقائي */
export function addNetwork(ip, label) {
  const key = String(ip).replace(/[.:#$/\[\]]/g, "_");
  enqueue(`${PATH.settings}/networks/${key}`, { ip: String(ip).trim(), label: label || "", addedAt: nowMs() });
}
export function removeNetwork(ip) {
  const key = String(ip).replace(/[.:#$/\[\]]/g, "_");
  enqueue(`${PATH.settings}/networks/${key}`, null);
}

/* ================= رموز ربط الأجهزة (QR) ================= */
const BIND_PATH = "bindTokens";
const TOKEN_TTL = 15 * 60 * 1000;                 // صلاحية 15 دقيقة

/** ينشئ رمز ربط لمرة واحدة ويعيد الرمز */
export async function createBindToken(empId, empName) {
  const token = (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2))
    .replace(/-/g, "").slice(0, 20);
  await set(ref(db, `${BIND_PATH}/${token}`), {
    empId, empName: empName || "", createdAt: nowMs(), expiresAt: nowMs() + TOKEN_TTL, used: false
  });
  return token;
}

/** يتحقق من الرمز ويستهلكه — يعيد { ok, empId, error } */
export async function consumeBindToken(token) {
  try {
    const snap = await get(ref(db, `${BIND_PATH}/${token}`));
    const t = snap.val();
    if (!t) return { ok: false, error: "رمز الربط غير صالح" };
    if (t.used) return { ok: false, error: "هذا الرمز استُخدم من قبل — اطلب رمزاً جديداً" };
    if (Number(t.expiresAt) && nowMs() > Number(t.expiresAt))
      return { ok: false, error: "انتهت صلاحية الرمز — اطلب رمزاً جديداً" };
    await update(ref(db, `${BIND_PATH}/${token}`), { used: true, usedAt: nowMs(), device: deviceId() });
    return { ok: true, empId: t.empId };
  } catch (e) {
    return { ok: false, error: "تعذّر التحقق من الرمز — تأكد من الاتصال" };
  }
}

/* ═══ ربط الكمبيوتر بمسح رمز من هاتف الموظف ═══
   يُخزَّن الطلب داخل سجل الجهاز نفسه، فيراه الهاتف عند مسح الرمز ويوافق عليه. */
const PC_TTL = 10 * 60 * 1000;

/** (الكمبيوتر) ينشئ طلب ربط ويعيد الرمز */
export async function createPcRequest(pcId = deviceId()) {
  const code = Math.random().toString(36).slice(2, 8).toUpperCase();
  await update(ref(db, `${PATH.devices}/${pcId}`), {
    name: deviceLabel(), kind: deviceKind(), lastSeen: nowMs(),
    pcLink: { code, status: "pending", at: nowMs(), exp: nowMs() + PC_TTL }
  });
  return code;
}

/** (الكمبيوتر) يراقب الموافقة */
export function watchPcRequest(pcId, cb) {
  return onValue(ref(db, `${PATH.devices}/${pcId}/pcLink`), s => cb(s.val() || null),
    e => console.warn("watchPcRequest", e.message));
}

/** (الهاتف) يوافق على ربط الكمبيوتر بحساب الموظف */
export async function approvePcRequest(pcId, code, emp) {
  const snap = await get(ref(db, `${PATH.devices}/${pcId}/pcLink`));
  const link = snap.val();
  if (!link) return { ok: false, error: "طلب الربط غير موجود — أعد فتح الصفحة على الكمبيوتر" };
  if (String(link.code) !== String(code)) return { ok: false, error: "رمز غير مطابق" };
  if (link.exp && nowMs() > Number(link.exp)) return { ok: false, error: "انتهت صلاحية الرمز — حدّث الصفحة على الكمبيوتر" };

  await update(ref(db, `${PATH.devices}/${pcId}/pcLink`), {
    status: "approved", empId: emp.id, empName: emp.name, approvedAt: nowMs()
  });
  await update(ref(db, `${PATH.employees}/${emp.id}`), { pcDevice: pcId, pcLinkedAt: nowMs() });
  return { ok: true };
}

/** يبحث عن جهاز كمبيوتر ينتظر الربط بهذا الرمز (للإدخال اليدوي) */
export async function findPcRequestByCode(code) {
  try {
    const snap = await get(ref(db, PATH.devices));
    const all = snap.val() || {};
    const want = String(code).trim().toUpperCase();
    for (const [id, d] of Object.entries(all)) {
      const l = d && d.pcLink;
      if (l && String(l.code).toUpperCase() === want && l.status === "pending"
          && (!l.exp || nowMs() <= Number(l.exp))) return { pcId: id, code: want };
    }
    return null;
  } catch { return null; }
}

/** (الكمبيوتر) ينهي الطلب بعد الدخول */
export async function clearPcRequest(pcId = deviceId()) {
  try { await remove(ref(db, `${PATH.devices}/${pcId}/pcLink`)); } catch {}
}

/** فصل الكمبيوتر عن حساب الموظف */
export async function releasePcDevice(empId) {
  enqueue(`${PATH.employees}/${empId}`, { pcDevice: null, pcLinkedAt: null });
}

/* ================= الموظفون ================= */
const empList = obj => entries(obj).map(([id, v]) => ({ id, ...v }))
  .sort((a, b) => String(a.name).localeCompare(String(b.name), "ar"));

export function watchEmployees(cb) { return watchPath(PATH.employees, empList, cb); }
export async function listEmployees() { return empList(await readPath(PATH.employees)); }

export async function addEmployee(data) {
  const id = push(ref(db, PATH.employees)).key;      // مفتاح يُولَّد محلياً (يعمل بدون إنترنت)
  enqueue(`${PATH.employees}/${id}`, {
    name: data.name.trim(),
    nameKey: normName(data.name),
    job: data.job || "",
    phone: data.phone || "",
    workStart: data.workStart || "",
    workEnd: data.workEnd || "",
    active: data.active !== false,
    createdAt: nowMs()
  });
  return id;
}
export async function updateEmployee(id, data) {
  const patch = { ...data, updatedAt: nowMs() };
  if (data.name) patch.nameKey = normName(data.name);
  enqueue(`${PATH.employees}/${id}`, patch);
}
export async function removeEmployee(id) { enqueue(`${PATH.employees}/${id}`, null); }

export function findEmployeeByName(list, typed) {
  const k = normName(typed);
  if (!k) return null;
  return list.find(e => normName(e.name) === k)
      || list.find(e => normName(e.name).startsWith(k))
      || list.find(e => normName(e.name).includes(k))
      || null;
}

/** يبحث عن الموظف بالاسم ورقم الهاتف معاً */
export function findEmployee(list, typedName, typedPhone) {
  const k = normName(typedName);
  if (!k) return { emp: null, reason: "name" };
  const byName = list.filter(e => normName(e.name) === k)
    .concat(list.filter(e => normName(e.name) !== k && normName(e.name).startsWith(k)))
    .concat(list.filter(e => normName(e.name) !== k && !normName(e.name).startsWith(k) && normName(e.name).includes(k)));
  if (!byName.length) return { emp: null, reason: "name" };
  const match = byName.find(e => samePhone(e.phone, typedPhone));
  return match ? { emp: match, reason: null } : { emp: null, reason: "phone" };
}

/* ---------------- ربط الحساب بجهاز واحد ---------------- */
/** يربط حساب الموظف بهذا الجهاز */
export async function bindDevice(empId, devId = deviceId()) {
  enqueue(`${PATH.employees}/${empId}`, {
    boundDevice: devId,
    boundAt: nowMs(),
    boundUA: String(navigator.userAgent || "").slice(0, 120)
  });
}
/** يحرّر الحساب ليتمكن الموظف من استخدام هاتف جديد */
export async function releaseDevice(empId) {
  enqueue(`${PATH.employees}/${empId}`, {
    boundDevice: null, boundAt: null, boundUA: null, releasedAt: nowMs()
  });
}

/* ================= الحضور ================= */
const dayPath = dk => `${PATH.attendance}/${dk}`;
const attPath = (dk, empId) => `${PATH.attendance}/${dk}/${empId}`;

export async function getRecord(dk, empId) {
  const v = await readPath(attPath(dk, empId));
  return notEmpty(v) ? { id: empId, empId, date: dk, ...v } : null;
}
export function watchRecord(dk, empId, cb) {
  return watchPath(attPath(dk, empId), v => (notEmpty(v) ? { id: empId, empId, date: dk, ...v } : null), cb);
}
export function watchDay(dk, cb) {
  return watchPath(dayPath(dk), obj => entries(obj).map(([empId, v]) => ({ id: empId, empId, date: dk, ...v })), cb);
}

/** سجلات شهر كامل — لكل الموظفين أو لموظف واحد */
export async function getMonth(mk, empId = null) {
  const { start, end } = monthRange(mk);
  let val = null;
  try {
    const snap = await get(query(ref(db, PATH.attendance), orderByKey(), startAt(start), endAt(end)));
    val = snap.val() || {};
    LS.set("az_cache_month_" + mk, val);
  } catch {
    val = LS.get("az_cache_month_" + mk, {}) || {};
  }
  const merged = overlay(PATH.attendance, val) || {};
  const rows = [];
  for (const [date, emps] of entries(merged)) {
    if (date < start || date > end) continue;
    for (const [eid, rec] of entries(emps)) {
      if (empId && eid !== empId) continue;
      rows.push({ id: eid, empId: eid, date, ...rec });
    }
  }
  rows.sort((a, b) => a.date.localeCompare(b.date));
  return rows;
}

function lateCheck(t, emp, settings) {
  const start = hhmmToMin(emp.workStart || settings.workStart);
  if (start == null) return { status: "present", lateMin: 0 };
  const cur = t.getHours() * 60 + t.getMinutes();
  const lateMin = cur - (start + Number(settings.graceMin || 0));
  return lateMin > 0 ? { status: "late", lateMin } : { status: "present", lateMin: 0 };
}

/** تسجيل حضور */
export async function checkIn(emp, settings, source = "self") {
  const t = now(), inst = instant(), dk = dateKey(t);
  const exist = await getRecord(dk, emp.id);
  if (exist && exist.checkIn) return { ok: false, error: "تم تسجيل حضورك اليوم بالفعل", record: exist };

  const { status, lateMin } = lateCheck(t, emp, settings);
  const rec = {
    empId: emp.id, empName: emp.name, date: dk,
    checkIn: inst.toISOString(), checkOut: null,
    workedMin: 0, status, lateMin,
    expectedStart: emp.workStart || settings.workStart,
    expectedEnd: emp.workEnd || settings.workEnd,
    source, deviceId: deviceId(),
    createdAt: nowMs(), updatedAt: nowMs()
  };
  // تسجيل الحضور يُكتب مباشرة إلى الخادم (لا طابور محلي) — فلا يُعتبر ناجحاً
  // إلا إذا حُفظ فعلياً. بهذا لا يُسجَّل حضور بلا اتصال حقيقي بالإنترنت.
  if (!navigator.onLine) return { ok: false, error: "لا يوجد اتصال بالإنترنت — تعذّر تسجيل الحضور" };
  try {
    await set(attRef(dk, emp.id), rec);
  } catch (e) {
    return { ok: false, error: "تعذّر حفظ الحضور — تأكد من اتصالك بالإنترنت وحاول مجدداً" };
  }
  logEvent({ type: "in", empId: emp.id, empName: emp.name, date: dk, at: inst.toISOString(), status });
  return { ok: true, record: rec };
}

/** ═══ تعويض التأخير بالوقت الإضافي ═══
 *  إذا عمل الموظف وقتاً إضافياً بعد نهاية دوامه فإنه يكون قد عوّض تأخيره،
 *  فيُسجَّل أنه **لم يتأخر** ويُحتسب له الفائض وقتاً إضافياً.
 *  مثال: دوامه 9→5، حضر 10 (متأخر ساعة) وانصرف 7 مساءً
 *        ⇒ عمل 9 ساعات بدل 8 ⇒ لا تأخير + ساعة إضافية.       */
export function compensateLate(rec, workedMin, requiredMin) {
  const overtimeMin = Math.max(0, workedMin - requiredMin);
  const lateMin = Math.max(0, Number(rec?.lateMin || 0));
  const patch = { workedMin, requiredMin, overtimeMin, completed: true };

  if (lateMin > 0 && overtimeMin > 0) {
    patch.status = "present";       // عُوِّض التأخير بالكامل
    patch.lateMin = 0;
    patch.lateExcused = lateMin;    // نحتفظ بالرقم للشفافية في التقارير
  } else {
    patch.status = rec?.status === "late" ? "late" : "present";
    patch.lateMin = lateMin;
    patch.lateExcused = 0;
  }
  return patch;
}

/** تسجيل انصراف — يحسب ساعات اليوم تلقائياً */
export async function checkOut(emp, settings) {
  const inst = instant(), dk = dateKey(now());
  const exist = await getRecord(dk, emp.id);
  if (!exist || !exist.checkIn) return { ok: false, error: "يجب تسجيل الحضور أولاً" };
  if (exist.checkOut) return { ok: false, error: "تم تسجيل انصرافك اليوم بالفعل", record: exist };

  const workedMin = Math.max(0, Math.round((nowMs() - toDate(exist.checkIn).getTime()) / 60000));
  const requiredMin = requiredMinOf(exist, settings, emp);
  const patch = {
    checkOut: inst.toISOString(),
    ...compensateLate(exist, workedMin, requiredMin),
    updatedAt: nowMs()
  };
  enqueue(attPath(dk, emp.id), patch);
  logEvent({ type: "out", empId: emp.id, empName: emp.name, date: dk, at: inst.toISOString(), workedMin });
  return { ok: true, record: { ...exist, ...patch } };
}

/** تسجيل غياب */
export async function markAbsent(emp, dk = dateKey(), note = "", by = "admin") {
  const rec = {
    empId: emp.id, empName: emp.name, date: dk,
    checkIn: null, checkOut: null, workedMin: 0,
    status: "absent", note, markedBy: by,
    createdAt: nowMs(), updatedAt: nowMs()
  };
  enqueue(attPath(dk, emp.id), rec);
  logEvent({ type: "abs", empId: emp.id, empName: emp.name, date: dk, at: instant().toISOString(), note });
  return rec;
}

/** كتابة/تعديل سجل من لوحة المدير */
export async function setRecord(dk, empId, data) {
  enqueue(attPath(dk, empId), { ...data, updatedAt: nowMs() });
}
export async function clearRecord(dk, empId) { enqueue(attPath(dk, empId), null); }

export async function editTimes(dk, empId, checkInISO, checkOutISO) {
  const patch = { checkIn: checkInISO || null, checkOut: checkOutISO || null, updatedAt: nowMs() };
  if (checkInISO && checkOutISO)
    patch.workedMin = Math.max(0, Math.round((new Date(checkOutISO) - new Date(checkInISO)) / 60000));
  enqueue(attPath(dk, empId), patch);
}

/* ================= ساعات الدوام والوقت الإضافي ================= */
/** الدقائق المطلوبة في اليوم لهذا الموظف (من مواعيده الخاصة أو الافتراضية) */
export function requiredMinOf(rec, settings = {}, emp = null) {
  const a = hhmmToMin(rec?.expectedStart || emp?.workStart || settings.workStart);
  const b = hhmmToMin(rec?.expectedEnd   || emp?.workEnd   || settings.workEnd);
  if (a != null && b != null) {
    let d = b - a;
    if (d < 0) d += 1440;          // دوام يمتد بعد منتصف الليل
    if (d > 0) return d;
  }
  return Math.round((Number(settings.dailyHours) || 8) * 60);
}
/** الدقائق الإضافية فوق الدوام المطلوب */
export function overtimeOf(rec, settings = {}, emp = null) {
  if (!rec || !rec.checkOut) return 0;
  if (Number.isFinite(rec.overtimeMin)) return Math.max(0, rec.overtimeMin);
  return Math.max(0, Number(rec.workedMin || 0) - requiredMinOf(rec, settings, emp));
}
/** الدقائق الناقصة عن الدوام المطلوب */
export function shortageOf(rec, settings = {}, emp = null) {
  if (!rec || !rec.checkOut) return 0;
  return Math.max(0, requiredMinOf(rec, settings, emp) - Number(rec.workedMin || 0));
}

/* ================= التجميع الشهري ================= */
export function summarize(rows, settings = {}, emp = null) {
  const s = { days: 0, absent: 0, late: 0, minutes: 0, open: 0, overtimeMin: 0, shortMin: 0 };
  for (const r of rows) {
    if (r.status === "absent") { s.absent++; continue; }
    if (r.checkIn) {
      s.days++;
      if (r.status === "late") s.late++;
      if (r.checkOut) {
        s.minutes += Number(r.workedMin || 0);
        s.overtimeMin += overtimeOf(r, settings, emp);
        s.shortMin += shortageOf(r, settings, emp);
      } else s.open++;
    }
  }
  s.hours = Math.round((s.minutes / 60) * 100) / 100;
  s.overtimeHours = Math.round((s.overtimeMin / 60) * 100) / 100;
  s.avgMin = s.days ? Math.round(s.minutes / s.days) : 0;
  return s;
}

/* ================= سجل الأحداث (إشعارات المدير) ================= */
export function logEvent(ev) {
  const id = push(ref(db, PATH.events)).key;
  enqueue(`${PATH.events}/${id}`, { ...ev, createdAt: nowMs() });
}
export function watchEvents(cb, n = 60) {
  let raw = LS.get(cacheKey(PATH.events), null);
  const render = () => {
    const merged = overlay(PATH.events, raw) || {};
    const list = entries(merged).map(([id, v]) => ({ id, ...v }))
      .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0))
      .slice(0, n);
    cb(list);
  };
  refreshers.add(render);
  render();
  const un = onValue(query(ref(db, PATH.events), orderByKey(), limitToLast(n)), snap => {
    raw = snap.val(); LS.set(cacheKey(PATH.events), raw); render();
  }, err => console.warn("watchEvents", err.message));
  return () => { try { un(); } catch {} refreshers.delete(render); };
}
export async function clearEvents() {
  enqueue(PATH.events, null);
  LS.set(cacheKey(PATH.events), null);
}

/* ================= إشعارات الإدارة ================= */
const NOTICE_PATH = "notices";

/** يرسل إشعاراً لموظف أو مجموعة أو الجميع
 *  @param to "all" أو مصفوفة معرّفات موظفين */
export async function sendNotice({ to, title, body }) {
  const id = push(ref(db, NOTICE_PATH)).key;
  const map = to === "all" ? "all"
    : (Array.isArray(to) ? to : [to]).reduce((o, k) => (o[k] = true, o), {});
  try {
    // كتابة مباشرة (لا طابور) حتى يظهر أي خطأ صلاحيات فوراً بدل نجاح وهمي
    await set(ref(db, `${NOTICE_PATH}/${id}`), {
      to: map, title: String(title || "").trim(), body: String(body || "").trim(),
      at: instant().toISOString(), createdAt: nowMs()
    });
    return { ok: true, id };
  } catch (e) {
    const denied = String(e?.code || e?.message || "").toLowerCase().includes("permission");
    return { ok: false, error: denied
      ? "قواعد قاعدة البيانات تمنع الإرسال — انشر ملف database.rules.json من Firebase"
      : "تعذّر الإرسال — تأكد من الاتصال بالإنترنت" };
  }
}
export function watchNotices(cb, n = 40) {
  return watchPath(NOTICE_PATH, obj => entries(obj).map(([id, v]) => ({ id, ...v }))
    .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0)).slice(0, n), cb);
}
export async function removeNotice(id) {
  try { await remove(ref(db, `${NOTICE_PATH}/${id}`)); } catch { enqueue(`${NOTICE_PATH}/${id}`, null); }
}
/** هل هذا الإشعار موجَّه لهذا الموظف؟ */
export const noticeFor = (notice, empId) =>
  notice?.to === "all" || (notice?.to && notice.to[empId] === true);

/* ================= الأجهزة ================= */
export async function registerDevice() {
  const id = deviceId();
  const ua = navigator.userAgent;
  enqueue(`${PATH.devices}/${id}`, {
    name: deviceLabel(), kind: deviceKind(), ua: ua.slice(0, 160), lastSeen: nowMs()
  });
  return id;
}
/** يحذف جهازاً من قائمة الأجهزة المسجّلة */
export async function removeDeviceEntry(id) {
  enqueue(`${PATH.devices}/${id}`, null);
}

export function watchDevices(cb) {
  return watchPath(PATH.devices, obj => entries(obj).map(([id, v]) => ({ id, ...v }))
    .sort((a, b) => Number(b.lastSeen || 0) - Number(a.lastSeen || 0)), cb);
}
