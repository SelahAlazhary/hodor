/* ===== أدوات مساعدة ===== */

export const $  = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];

/* ---------- التاريخ والوقت ---------- */
export const AR_DAYS = ["الأحد","الإثنين","الثلاثاء","الأربعاء","الخميس","الجمعة","السبت"];
export const AR_MONTHS = ["يناير","فبراير","مارس","أبريل","مايو","يونيو","يوليو","أغسطس","سبتمبر","أكتوبر","نوفمبر","ديسمبر"];

const p2 = n => String(n).padStart(2, "0");

/** yyyy-mm-dd بالتوقيت المحلي */
export function dateKey(d = new Date()) {
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}
/** yyyy-mm */
export function monthKey(d = new Date()) {
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}`;
}
export function monthRange(mk) {
  const [y, m] = mk.split("-").map(Number);
  const start = `${y}-${p2(m)}-01`;
  const last = new Date(y, m, 0).getDate();
  return { start, end: `${y}-${p2(m)}-${p2(last)}`, days: last, y, m };
}
export function clockStr(d = new Date()) {
  return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
}
/** 03:45 م */
export function timeAr(v) {
  if (!v) return "—";
  const d = v instanceof Date ? v : new Date(v);
  if (isNaN(d)) return "—";
  let h = d.getHours(); const m = p2(d.getMinutes());
  const s = h < 12 ? "ص" : "م";
  h = h % 12 || 12;
  return `${p2(h)}:${m} ${s}`;
}
export function dateAr(dk) {
  const d = new Date(dk + "T00:00:00");
  return `${d.getDate()} ${AR_MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}
export function dayAr(dk) {
  return AR_DAYS[new Date(dk + "T00:00:00").getDay()];
}
export function fullDateAr(d = new Date()) {
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
  const s = Math.floor((Date.now() - d.getTime()) / 1000);
  if (s < 60) return "الآن";
  if (s < 3600) return `منذ ${Math.floor(s / 60)} د`;
  if (s < 86400) return `منذ ${Math.floor(s / 3600)} س`;
  return `${dateAr(dateKey(d))} • ${timeAr(d)}`;
}

/* ---------- تخزين محلي ---------- */
export const LS = {
  get(k, d = null) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} }
};

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
