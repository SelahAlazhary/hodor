/* ===== أدوات مساعدة ===== */

export const $  = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];

/* ---------- التاريخ والوقت ---------- */
export const AR_DAYS = ["الأحد","الإثنين","الثلاثاء","الأربعاء","الخميس","الجمعة","السبت"];
export const AR_MONTHS = ["يناير","فبراير","مارس","أبريل","مايو","يونيو","يوليو","أغسطس","سبتمبر","أكتوبر","نوفمبر","ديسمبر"];

const p2 = n => String(n).padStart(2, "0");

/* ---------- الساعة العالمية وتوقيت مصر ----------
   • الوقت مأخوذ من خادم Firebase لا من ساعة الجهاز
     فلا يمكن التلاعب بالحضور بتغيير ساعة الهاتف.
   • كل العرض والحسابات بتوقيت القاهرة مهما كانت إعدادات المنطقة الزمنية
     في هاتف الموظف أو حاسوب الإدارة. */
export const TZ = "Africa/Cairo";

let _offset = 0, _synced = false;
try { _offset = Number(JSON.parse(localStorage.getItem("az_clock_offset") || "0")) || 0; } catch {}

export function setClockOffset(ms) {
  const v = Number(ms);
  if (!isFinite(v)) return;
  _offset = v; _synced = true;
  try { localStorage.setItem("az_clock_offset", JSON.stringify(v)); } catch {}
}
export const clockOffset = () => _offset;
export const clockSynced = () => _synced;

/** اللحظة الحقيقية الآن (ميلي ثانية) — تُستخدم للتخزين وحساب المدد */
export const nowMs = () => Date.now() + _offset;
/** كائن التاريخ للحظة الحقيقية (للتخزين بصيغة ISO) */
export const instant = () => new Date(nowMs());

let _fmt;
function tzParts(ms) {
  _fmt = _fmt || new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit"
  });
  const o = {};
  for (const part of _fmt.formatToParts(new Date(ms)))
    if (part.type !== "literal") o[part.type] = Number(part.value);
  if (o.hour === 24) o.hour = 0;
  return o;
}

/** يحوّل لحظة إلى كائن تاريخ قيمُه (الساعة/اليوم) بتوقيت القاهرة */
export function zoned(v) {
  const ms = v instanceof Date ? v.getTime() : Number(v);
  const t = tzParts(ms);
  return new Date(t.year, t.month - 1, t.day, t.hour, t.minute, t.second);
}

/** الوقت الحالي بتوقيت القاهرة (للعرض واستخراج الساعة والتاريخ) */
export const now = () => zoned(nowMs());

/** يحوّل توقيت حائط القاهرة (YYYY-MM-DD + HH:MM) إلى لحظة حقيقية */
export function msFromCairo(dateStr, hhmm = "00:00") {
  const [Y, M, D] = String(dateStr).split("-").map(Number);
  const [h, m] = String(hhmm).split(":").map(Number);
  const target = Date.UTC(Y, M - 1, D, h || 0, m || 0);
  let guess = target;
  for (let i = 0; i < 3; i++) {
    const t = tzParts(guess);
    const asUTC = Date.UTC(t.year, t.month - 1, t.day, t.hour, t.minute);
    const diff = target - asUTC;
    if (!diff) break;
    guess += diff;
  }
  return guess;
}

/** yyyy-mm-dd بالتوقيت المحلي */
export function dateKey(d = now()) {
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}
/** yyyy-mm */
export function monthKey(d = now()) {
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}`;
}
export function monthRange(mk) {
  const [y, m] = mk.split("-").map(Number);
  const start = `${y}-${p2(m)}-01`;
  const last = new Date(y, m, 0).getDate();
  return { start, end: `${y}-${p2(m)}-${p2(last)}`, days: last, y, m };
}
/** المؤقت بنظام 12 ساعة — يعيد { t: "01:42:15", ap: "م" } */
export function clockParts(d = now()) {
  const h24 = d.getHours();
  const h = h24 % 12 || 12;
  return {
    t: `${p2(h)}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`,
    ap: h24 < 12 ? "ص" : "م"
  };
}
export function clockStr(d = now()) {
  const c = clockParts(d);
  return `${c.t} ${c.ap}`;
}
/** عرض الوقت بنظام 12 ساعة بتوقيت القاهرة — مثل 05:05 م */
export function timeAr(v) {
  if (!v) return "—";
  const raw = v instanceof Date ? v : new Date(v);
  if (isNaN(raw)) return "—";
  const d = zoned(raw);
  const h24 = d.getHours();
  return `${p2(h24 % 12 || 12)}:${p2(d.getMinutes())} ${h24 < 12 ? "ص" : "م"}`;
}
export function dateAr(dk) {
  const d = new Date(dk + "T00:00:00");
  return `${d.getDate()} ${AR_MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}
export function dayAr(dk) {
  return AR_DAYS[new Date(dk + "T00:00:00").getDay()];
}
export function fullDateAr(d = now()) {
  return `${AR_DAYS[d.getDay()]} ${d.getDate()} ${AR_MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}
/** "HH:MM" → دقائق */
export function hhmmToMin(t) {
  if (!t) return null;
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}
/** دقائق → "7 س 30 د" */
export function minToHuman(min) {
  if (!min || min < 0) return "0";
  const h = Math.floor(min / 60), m = min % 60;
  return m ? `${h} س ${m} د` : `${h} س`;
}
export const minToHours = min => Math.round(((min || 0) / 60) * 100) / 100;

export function isoOf(v) {
  if (!v) return null;
  if (typeof v === "number") return new Date(v).toISOString();
  if (typeof v === "string") return v;
  if (v.toDate) return v.toDate().toISOString();
  if (v instanceof Date) return v.toISOString();
  return null;
}
export function toDate(v) {
  const i = isoOf(v);
  return i ? new Date(i) : null;
}
export function relAr(v) {
  const d = toDate(v); if (!d) return "";
  const s = Math.floor((nowMs() - d.getTime()) / 1000);
  if (s < 60) return "الآن";
  if (s < 3600) return `منذ ${Math.floor(s / 60)} د`;
  if (s < 86400) return `منذ ${Math.floor(s / 3600)} س`;
  return `${dateAr(dateKey(zoned(d)))} • ${timeAr(d)}`;
}

/* ---------- تخزين محلي ---------- */
export const LS = {
  get(k, d = null) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} }
};

/* ---------- التعرّف على نوع الجهاز ----------
   نجمع أكثر من إشارة موثوقة بدل الاعتماد على نص المتصفح وحده:
   userAgentData (الأدق في المتصفحات الحديثة) ثم اللمس ثم المؤشر ثم المقاس. */
export function deviceKind() {
  const ua = navigator.userAgent || "";
  const uaData = navigator.userAgentData;

  // 1) الإشارة الرسمية من المتصفح
  if (uaData && typeof uaData.mobile === "boolean") {
    if (uaData.mobile) return /iPad|Tablet/i.test(ua) ? "tablet" : "phone";
    if (!/Android|iPhone|iPad|iPod/i.test(ua)) return "desktop";
  }

  // 2) آيباد الحديث يتنكّر كماك — نكشفه باللمس
  const touch = (navigator.maxTouchPoints || 0) > 1;
  if (/iPad/i.test(ua) || (/Macintosh/i.test(ua) && touch)) return "tablet";
  if (/iPhone|iPod/i.test(ua)) return "phone";
  if (/Android/i.test(ua)) return /Mobile/i.test(ua) ? "phone" : "tablet";
  if (/Windows Phone|IEMobile|BlackBerry|Opera Mini/i.test(ua)) return "phone";

  // 3) بلا لمس ومؤشر دقيق ⇒ كمبيوتر
  const finePointer = window.matchMedia?.("(pointer: fine)")?.matches;
  if (!touch && finePointer !== false) return "desktop";

  // 4) الحكم بالمقاس كملاذ أخير
  const w = Math.min(screen.width || 0, screen.height || 0);
  if (touch && w && w <= 500) return "phone";
  if (touch && w && w <= 900) return "tablet";
  return "desktop";
}

export const isPhoneDevice   = () => deviceKind() === "phone";
export const isTabletDevice  = () => deviceKind() === "tablet";
export const isDesktopDevice = () => deviceKind() === "desktop";
/** أجهزة محمولة (هاتف أو لوحي) */
export const isHandheld = () => deviceKind() !== "desktop";

/** اسم عربي واضح للجهاز يظهر في لوحة المدير */
export function deviceLabel() {
  const ua = navigator.userAgent || "";
  const kind = deviceKind();
  const os = /Android/i.test(ua) ? "أندرويد"
    : /iPhone|iPad|iPod/i.test(ua) ? "آيفون/آيباد"
    : /Windows/i.test(ua) ? "ويندوز"
    : /Mac/i.test(ua) ? "ماك"
    : /Linux/i.test(ua) ? "لينكس" : "";
  const base = kind === "phone" ? "هاتف" : kind === "tablet" ? "جهاز لوحي" : "كمبيوتر";
  return os ? `${base} ${os}` : base;
}

export function deviceId() {
  let id = LS.get("az_device_id");
  if (!id) { id = "dev_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4); LS.set("az_device_id", id); }
  return id;
}

/* ---------- واجهة ---------- */
let toastTimer;
export function toast(msg, type = "") {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = msg;
  el.className = "toast " + type;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
}

export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/** تطبيع الاسم العربي للمقارنة (همزات/تشكيل/مسافات) */
export function normName(s) {
  return String(s || "")
    .replace(/[ً-ْٰ]/g, "")
    .replace(/[أإآٱ]/g, "ا").replace(/ى/g, "ي").replace(/ؤ/g, "و").replace(/ئ/g, "ي").replace(/ة/g, "ه")
    .replace(/\s+/g, " ").trim().toLowerCase();
}

/** تطبيع رقم الهاتف: يحوّل الأرقام العربية ويحذف كل ما عدا الأرقام */
export function normPhone(v) {
  return String(v || "")
    .replace(/[٠-٩]/g, d => "٠١٢٣٤٥٦٧٨٩".indexOf(d))
    .replace(/[۰-۹]/g, d => "۰۱۲۳۴۵۶۷۸۹".indexOf(d))
    .replace(/\D/g, "");
}
/** يقارن رقمين مع تجاهل مفتاح الدولة وأصفار البداية */
export function samePhone(a, b) {
  const x = normPhone(a), y = normPhone(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const tail = n => n.slice(-9);          // آخر 9 أرقام تكفي للمطابقة
  return tail(x) === tail(y);
}

/** أول حرفين من الاسم لصورة الحساب */
export function initials(name) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "؟";
  return parts.length === 1 ? parts[0].slice(0, 1) : parts[0][0] + parts[1][0];
}

/* ---------- تصدير CSV ---------- */
export function downloadCSV(filename, rows) {
  const csv = rows.map(r => r.map(c => {
    const v = String(c ?? "");
    return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  }).join(",")).join("\r\n");
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1500);
}
