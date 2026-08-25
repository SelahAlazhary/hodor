/* ===== طبقة البيانات — Firebase Realtime Database =====
   كل عمليات الكتابة تمر عبر "طابور محلي" (Outbox) مخزَّن في الجهاز:
   - تظهر النتيجة فوراً في الواجهة (حتى بدون إنترنت)
   - تُرفع إلى القاعدة تلقائياً بالترتيب فور عودة الاتصال
   - تبقى محفوظة حتى لو أُغلق التطبيق أو أُعيد تشغيل الهاتف            */

import {
  db, PATH, ref, get, set, update, remove, push,
  onValue, query, orderByKey, startAt, endAt, limitToLast
} from "./firebase.js";
import { LS, dateKey, monthRange, hhmmToMin, toDate, normName, deviceId } from "./utils.js";

/* ---------------- الإعدادات الافتراضية ---------------- */
export const DEFAULT_SETTINGS = {
  company: "سلاح الأزهري",
  workStart: "09:00",
  workEnd: "17:00",
  graceMin: 15,
  dailyHours: 8,
  adminPass: "azhari2026",
  checkinMode: "self",      // self | kiosk | both
  kioskDeviceId: "",
  kioskDeviceName: "",
  /* الحضور التلقائي عند الاتصال بشبكة الشركة */
  autoCheckin: false,
  networks: {},             // { "41_33_12_5": { ip, label, addedAt } }
  autoWindowStart: "05:00",
  autoWindowEnd: "23:59"
};

/* ================= الطابور المحلي ================= */
const OUTBOX_KEY = "az_outbox";
let outbox = LS.get(OUTBOX_KEY, []) || [];
const refreshers = new Set();
let flushing = false;

const saveOutbox = () => { LS.set(OUTBOX_KEY, outbox); refreshers.forEach(f => { try { f(); } catch {} }); };
export const pendingCount = () => outbox.length;

function enqueue(path, data) {
  outbox.push({ id: Date.now() + "_" + Math.random().toString(36).slice(2, 7), path, data, tries: 0 });
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

/** مراقبة حالة الاتصال بالقاعدة */
export function watchConnection(cb) {
  return onValue(ref(db, ".info/connected"), s => { const on = s.val() === true; if (on) flush(); cb(on); },
    () => cb(false));
}

/* ================= الإعدادات ================= */
export async function getSettings() {
  const v = await readPath(PATH.settings);
  if (notEmpty(v)) return { ...DEFAULT_SETTINGS, ...v };
  enqueue(PATH.settings, { ...DEFAULT_SETTINGS, createdAt: Date.now() });
  return { ...DEFAULT_SETTINGS };
}
export function watchSettings(cb) {
  return watchPath(PATH.settings, v => ({ ...DEFAULT_SETTINGS, ...(v || {}) }), cb);
}
export function saveSettings(patch) {
  enqueue(PATH.settings, { ...patch, updatedAt: Date.now() });
  return Promise.resolve();
}

/** شبكات الشركة المعتمدة للحضور التلقائي */
export function addNetwork(ip, label) {
  const key = String(ip).replace(/[.:#$/\[\]]/g, "_");
  enqueue(`${PATH.settings}/networks/${key}`, { ip: String(ip).trim(), label: label || "", addedAt: Date.now() });
}
export function removeNetwork(ip) {
  const key = String(ip).replace(/[.:#$/\[\]]/g, "_");
  enqueue(`${PATH.settings}/networks/${key}`, null);
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
    createdAt: Date.now()
  });
  return id;
}
export async function updateEmployee(id, data) {
  const patch = { ...data, updatedAt: Date.now() };
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

function lateCheck(now, emp, settings) {
  const start = hhmmToMin(emp.workStart || settings.workStart);
  if (start == null) return { status: "present", lateMin: 0 };
  const cur = now.getHours() * 60 + now.getMinutes();
  const lateMin = cur - (start + Number(settings.graceMin || 0));
  return lateMin > 0 ? { status: "late", lateMin } : { status: "present", lateMin: 0 };
}

/** تسجيل حضور */
export async function checkIn(emp, settings, source = "self") {
  const now = new Date(), dk = dateKey(now);
  const exist = await getRecord(dk, emp.id);
  if (exist && exist.checkIn) return { ok: false, error: "تم تسجيل حضورك اليوم بالفعل", record: exist };

  const { status, lateMin } = lateCheck(now, emp, settings);
  const rec = {
    empId: emp.id, empName: emp.name, date: dk,
    checkIn: now.toISOString(), checkOut: null,
    workedMin: 0, status, lateMin,
    expectedStart: emp.workStart || settings.workStart,
    expectedEnd: emp.workEnd || settings.workEnd,
    source, deviceId: deviceId(),
    createdAt: Date.now(), updatedAt: Date.now()
  };
  enqueue(attPath(dk, emp.id), rec);
  logEvent({ type: "in", empId: emp.id, empName: emp.name, date: dk, at: now.toISOString(), status });
  return { ok: true, record: rec };
}

/** تسجيل انصراف — يحسب ساعات اليوم تلقائياً */
export async function checkOut(emp, settings) {
  const now = new Date(), dk = dateKey(now);
  const exist = await getRecord(dk, emp.id);
  if (!exist || !exist.checkIn) return { ok: false, error: "يجب تسجيل الحضور أولاً" };
  if (exist.checkOut) return { ok: false, error: "تم تسجيل انصرافك اليوم بالفعل", record: exist };

  const workedMin = Math.max(0, Math.round((now - toDate(exist.checkIn)) / 60000));
  const patch = {
    checkOut: now.toISOString(), workedMin,
    status: exist.status === "late" ? "late" : "present",
    completed: true, updatedAt: Date.now()
  };
  enqueue(attPath(dk, emp.id), patch);
  logEvent({ type: "out", empId: emp.id, empName: emp.name, date: dk, at: now.toISOString(), workedMin });
  return { ok: true, record: { ...exist, ...patch } };
}

/** تسجيل غياب */
export async function markAbsent(emp, dk = dateKey(), note = "", by = "admin") {
  const rec = {
    empId: emp.id, empName: emp.name, date: dk,
    checkIn: null, checkOut: null, workedMin: 0,
    status: "absent", note, markedBy: by,
    createdAt: Date.now(), updatedAt: Date.now()
  };
  enqueue(attPath(dk, emp.id), rec);
  logEvent({ type: "abs", empId: emp.id, empName: emp.name, date: dk, at: new Date().toISOString(), note });
  return rec;
}

/** كتابة/تعديل سجل من لوحة المدير */
export async function setRecord(dk, empId, data) {
  enqueue(attPath(dk, empId), { ...data, updatedAt: Date.now() });
}
export async function clearRecord(dk, empId) { enqueue(attPath(dk, empId), null); }

export async function editTimes(dk, empId, checkInISO, checkOutISO) {
  const patch = { checkIn: checkInISO || null, checkOut: checkOutISO || null, updatedAt: Date.now() };
  if (checkInISO && checkOutISO)
    patch.workedMin = Math.max(0, Math.round((new Date(checkOutISO) - new Date(checkInISO)) / 60000));
  enqueue(attPath(dk, empId), patch);
}

/* ================= التجميع الشهري ================= */
export function summarize(rows) {
  const s = { days: 0, absent: 0, late: 0, minutes: 0, open: 0 };
  for (const r of rows) {
    if (r.status === "absent") { s.absent++; continue; }
    if (r.checkIn) {
      s.days++;
      if (r.status === "late") s.late++;
      if (r.checkOut) s.minutes += Number(r.workedMin || 0); else s.open++;
    }
  }
  s.hours = Math.round((s.minutes / 60) * 100) / 100;
  s.avgMin = s.days ? Math.round(s.minutes / s.days) : 0;
  return s;
}

/* ================= الرسائل ================= */
export async function sendMessage(empId, empName, from, text) {
  const id = push(ref(db, `${PATH.messages}/${empId}`)).key;
  enqueue(`${PATH.messages}/${empId}/${id}`, {
    empId, empName, from, text: String(text).trim(),
    ts: new Date().toISOString(),
    readByAdmin: from === "admin", readByEmp: from === "employee",
    createdAt: Date.now()
  });
  if (from === "employee")
    logEvent({ type: "msg", empId, empName, at: new Date().toISOString(), text: String(text).slice(0, 60) });
}
const threadList = (obj, empId) => entries(obj).map(([id, v]) => ({ id, empId, ...v }))
  .sort((a, b) => String(a.ts).localeCompare(String(b.ts)));

export function watchThread(empId, cb) {
  return watchPath(`${PATH.messages}/${empId}`, o => threadList(o, empId), cb);
}
export function watchAllMessages(cb) {
  return watchPath(PATH.messages, obj => {
    const all = [];
    for (const [empId, thread] of entries(obj)) all.push(...threadList(thread, empId));
    all.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
    return all;
  }, cb);
}
export async function markThreadRead(msgs, side) {
  const field = side === "admin" ? "readByAdmin" : "readByEmp";
  const other = side === "admin" ? "employee" : "admin";
  msgs.filter(m => m.from === other && !m[field])
      .forEach(m => enqueue(`${PATH.messages}/${m.empId}/${m.id}`, { [field]: true }));
}

/* ================= سجل الأحداث (إشعارات المدير) ================= */
export function logEvent(ev) {
  const id = push(ref(db, PATH.events)).key;
  enqueue(`${PATH.events}/${id}`, { ...ev, createdAt: Date.now() });
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

/* ================= الأجهزة ================= */
export async function registerDevice() {
  const id = deviceId();
  const ua = navigator.userAgent;
  const name = /Android/i.test(ua) ? "هاتف أندرويد"
             : /iPhone|iPad/i.test(ua) ? "جهاز آيفون/آيباد"
             : /Windows/i.test(ua) ? "كمبيوتر ويندوز"
             : /Mac/i.test(ua) ? "جهاز ماك" : "جهاز";
  enqueue(`${PATH.devices}/${id}`, { name, ua: ua.slice(0, 160), lastSeen: Date.now() });
  return id;
}
export function watchDevices(cb) {
  return watchPath(PATH.devices, obj => entries(obj).map(([id, v]) => ({ id, ...v }))
    .sort((a, b) => Number(b.lastSeen || 0) - Number(a.lastSeen || 0)), cb);
}
