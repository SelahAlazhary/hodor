/* ===== واجهة الموظف ===== */
import {
  $, $$, esc, toast, clockStr, fullDateAr, dateKey, monthKey, dateAr, dayAr,
  timeAr, minToHuman, minToHours, toDate, deviceId, hhmmToMin, now, nowMs, clockSynced, clockOffset, LS
} from "./utils.js";
import { getPublicIP, ipMatches } from "./network.js";
import { DB_URL } from "./firebase.js";
import {
  checkIn, checkOut, markAbsent, watchRecord, getMonth, summarize
} from "./store.js";
import { notify, askPermission, buzz } from "./notify.js";

let ST = null, EMP = null;
let unsubRec = null, clockTimer = null;
let today = null, kioskTarget = null;
let autoTimer = null, autoBusy = false;

export function disposeEmployee() {
  unsubRec?.(); clearInterval(clockTimer); clearInterval(autoTimer);
  unsubRec = clockTimer = autoTimer = null;
  window.removeEventListener("online", tryAutoCheckin);
  document.removeEventListener("visibilitychange", onVisible);
  ST = EMP = today = kioskTarget = null;
  document.removeEventListener("az:employees", onEmployeesChanged);
  document.removeEventListener("az:settings", onSettingsChanged);
}

export function initEmployee(state, emp) {
  disposeEmployee();
  ST = state; EMP = emp;

  $("#empHeadName").textContent = emp.name;
  $("#empHeadDate").textContent = fullDateAr();
  $("#empMonth").value = monthKey();

  startClock();
  bindActions();
  applyKiosk();
  watchToday();
  loadHistory();

  document.addEventListener("az:employees", onEmployeesChanged);
  document.addEventListener("az:settings", onSettingsChanged);

  // الحضور التلقائي عند الاتصال بشبكة الشركة
  paintAutoBar("", "جارٍ الفحص…");
  tryAutoCheckin();
  armBackgroundAuto();
  autoTimer = setInterval(tryAutoCheckin, 4 * 60 * 1000);
  window.addEventListener("online", tryAutoCheckin);
  document.addEventListener("visibilitychange", onVisible);
}

function onVisible() { if (document.visibilityState === "visible") tryAutoCheckin(); }

function onSettingsChanged() { applyKiosk(); paintToday(); paintAutoBar("", "جارٍ الفحص…"); tryAutoCheckin(); }

function onEmployeesChanged(e) {
  const fresh = e.detail.find(x => x.id === EMP?.id);
  if (fresh) { EMP = fresh; $("#empHeadName").textContent = fresh.name; }
  applyKiosk();
}

/* ---------- الساعة ---------- */
const RING_TODAY = 540.35, RING_MONTH = 207.35;

/** حلقة SVG توضّح نسبة إنجاز دوام اليوم */
function paintGauge() {
  const ring = $("#todayRing"), pct = $("#todayPct");
  if (!ring) return;
  const dailyMin = Math.max(30, (Number(ST?.settings?.dailyHours) || 8) * 60);
  let worked = 0;
  if (today?.checkIn) {
    const endMs = today.checkOut ? toDate(today.checkOut).getTime() : nowMs();
    worked = Math.max(0, (endMs - toDate(today.checkIn).getTime()) / 60000);
  }
  const p = Math.max(0, Math.min(1, worked / dailyMin));
  ring.style.strokeDashoffset = RING_TODAY * (1 - p);
  pct.textContent = today?.status === "absent" ? "غياب اليوم"
    : today?.checkIn ? `${Math.round(p * 100)}% من دوام اليوم` : "لم يبدأ الدوام";
}

function startClock() {
  const tick = () => {
    $("#bigClock").textContent = clockStr();
    $("#bigDate").textContent = fullDateAr();
    const src = $("#clockSrc");
    if (src) {
      src.textContent = clockSynced() ? "بتوقيت الخادم العالمي" : "بتوقيت الجهاز";
      src.className = "clock-src" + (clockSynced() ? " synced" : "");
    }
    paintGauge();
  };
  tick();
  clockTimer = setInterval(tick, 1000);
}

/* ---------- وضع الكشك ---------- */
function currentTarget() { return kioskTarget || EMP; }

function applyKiosk() {
  const s = ST?.settings || {};
  const isKiosk = (s.checkinMode === "kiosk" || s.checkinMode === "both")
                  && s.kioskDeviceId && s.kioskDeviceId === deviceId();
  const bar = $("#empKioskBar");
  bar.hidden = !isKiosk;

  if (isKiosk) {
    const sel = $("#kioskEmpSelect");
    const prev = sel.value;
    sel.innerHTML = (ST.employees || []).filter(e => e.active !== false)
      .map(e => `<option value="${e.id}">${esc(e.name)}</option>`).join("");
    sel.value = prev && [...sel.options].some(o => o.value === prev) ? prev : EMP.id;
    kioskTarget = (ST.employees || []).find(e => e.id === sel.value) || EMP;
    sel.onchange = () => {
      kioskTarget = ST.employees.find(e => e.id === sel.value) || EMP;
      watchToday(); loadHistory();
    };
  } else {
    kioskTarget = null;
  }

  // منع التسجيل إن كان الوضع "جهاز محدد فقط" وهذا ليس الجهاز المعتمد
  const blocked = s.checkinMode === "kiosk" && !isKiosk;
  $("#btnCheckIn").disabled = blocked;
  $("#btnCheckOut").disabled = blocked;
  if (blocked) $("#statusPill").textContent = "التسجيل متاح فقط من جهاز الاستقبال المعتمد";
}

/* ---------- سجل اليوم ---------- */
function watchToday() {
  unsubRec?.();
  const t = currentTarget();
  unsubRec = watchRecord(dateKey(), t.id, rec => { today = rec; paintToday(); paintGauge(); });
}

function paintToday() {
  const pill = $("#statusPill");
  const inL = $("#inTimeLbl"), outL = $("#outTimeLbl");
  const btnIn = $("#btnCheckIn"), btnOut = $("#btnCheckOut"), btnAbs = $("#btnAbsence");
  const s = ST?.settings || {};
  const blocked = s.checkinMode === "kiosk" && s.kioskDeviceId !== deviceId();

  if (!today) {
    pill.className = "pill pill-idle";
    pill.textContent = blocked ? "التسجيل متاح فقط من جهاز الاستقبال المعتمد" : "لم يتم تسجيل الحضور بعد";
    inL.textContent = "—"; outL.textContent = "—";
    btnIn.disabled = blocked; btnOut.disabled = true; btnAbs.disabled = false;
    return;
  }
  if (today.status === "absent") {
    pill.className = "pill pill-abs"; pill.textContent = "مُسجَّل كغياب اليوم";
    inL.textContent = "—"; outL.textContent = "—";
    btnIn.disabled = blocked; btnOut.disabled = true; btnAbs.disabled = true;
    return;
  }
  inL.textContent = today.checkIn ? timeAr(today.checkIn) : "—";
  outL.textContent = today.checkOut ? timeAr(today.checkOut) : "—";
  btnIn.disabled = true; btnAbs.disabled = true;
  btnOut.disabled = !!today.checkOut || blocked;

  if (today.checkOut) {
    pill.className = "pill pill-out";
    pill.textContent = `انتهى دوام اليوم — ${minToHuman(today.workedMin)}`;
  } else if (today.status === "late") {
    pill.className = "pill pill-late";
    pill.textContent = `حاضر (متأخر ${today.lateMin || 0} د) منذ ${timeAr(today.checkIn)}`;
  } else {
    pill.className = "pill pill-in";
    pill.textContent = `حاضر منذ ${timeAr(today.checkIn)}`;
  }
}

/* ---------- الأزرار ---------- */
function bindActions() {
  $("#btnCheckIn").onclick = async () => {
    const t = currentTarget();
    await askPermission(true);
    const src = kioskTarget ? "kiosk" : "self";
    const r = await checkIn(t, ST.settings, src);
    if (!r.ok) { toast(r.error, "err"); return; }
    buzz();
    const tm = timeAr(r.record.checkIn);
    toast(`تم تسجيل حضور ${t.name} الساعة ${tm} ✅`, "ok");
    notify("✅ تم تسجيل الحضور",
      `${t.name}\nوقت الحضور: ${tm}\n${r.record.status === "late" ? "⚠ تأخير " + r.record.lateMin + " دقيقة" : "في الموعد المحدد"}`,
      { tag: "att-in" });
    loadHistory();
  };

  $("#btnCheckOut").onclick = async () => {
    const t = currentTarget();
    if (!confirm(`تأكيد تسجيل انصراف ${t.name}؟`)) return;
    const r = await checkOut(t, ST.settings);
    if (!r.ok) { toast(r.error, "err"); return; }
    buzz([100, 50, 100, 50, 160]);
    const i = timeAr(r.record.checkIn), o = timeAr(r.record.checkOut);
    toast(`تم تسجيل الانصراف — ${minToHuman(r.record.workedMin)} ✅`, "ok");
    notify("🔴 تم تسجيل الانصراف",
      `${t.name}\nساعة الحضور: ${i}\nساعة الانصراف: ${o}\nإجمالي اليوم: ${minToHuman(r.record.workedMin)}`,
      { tag: "att-out", sticky: true });
    loadHistory();
  };

  $("#btnAbsence").onclick = async () => {
    const t = currentTarget();
    const note = prompt(`تسجيل غياب لـ ${t.name} — سبب الغياب (اختياري):`, "");
    if (note === null) return;
    await markAbsent(t, dateKey(), note || "", kioskTarget ? "kiosk" : "employee");
    buzz();
    toast("تم تسجيل الغياب وإبلاغ الإدارة", "ok");
    notify("🚫 تم تسجيل غياب", `${t.name}\nاليوم: ${dateAr(dateKey())}${note ? "\nالسبب: " + note : ""}`, { tag: "att-abs" });
    loadHistory();
  };

  $("#empMonth").onchange = loadHistory;
}

/* ---------- سجل الشهر ---------- */
async function loadHistory() {
  const t = currentTarget(); if (!t) return;
  const mk = $("#empMonth").value || monthKey();
  let rows = [];
  try { rows = await getMonth(mk, t.id); } catch (e) { console.warn(e); }

  const s = summarize(rows);
  $("#stMonthHours").textContent = s.hours;

  // حلقة SVG: نسبة الساعات المنجزة إلى المطلوبة عن أيام الحضور
  const daily = Number(ST?.settings?.dailyHours) || 8;
  const target = daily * Math.max(1, s.days);
  const ring = $("#monthRing");
  if (ring) ring.style.strokeDashoffset = RING_MONTH * (1 - Math.max(0, Math.min(1, s.hours / target)));

  $("#stDays").textContent = s.days;
  $("#stLate").textContent = s.late;
  $("#stAbsent").textContent = s.absent;

  const tb = $("#empHistTable tbody");
  tb.innerHTML = rows.slice().reverse().map(r => `
    <tr>
      <td>${dayAr(r.date)}</td>
      <td>${dateAr(r.date)}</td>
      <td>${r.checkIn ? timeAr(r.checkIn) : "—"}</td>
      <td>${r.checkOut ? timeAr(r.checkOut) : "—"}</td>
      <td>${r.checkOut ? minToHuman(r.workedMin) : (r.checkIn ? "جارٍ" : "—")}</td>
      <td>${statusTag(r)}</td>
    </tr>`).join("");
  $("#empHistEmpty").hidden = rows.length > 0;
}

export function statusTag(r) {
  if (r.status === "absent") return '<span class="tag t-absent">غياب</span>';
  if (r.status === "late")   return '<span class="tag t-late">متأخر</span>';
  if (r.checkOut)            return '<span class="tag t-out">انصرف</span>';
  if (r.checkIn)             return '<span class="tag t-present">حاضر</span>';
  return '<span class="tag t-off">—</span>';
}

/* ---------- الحضور التلقائي عبر شبكة الشركة ---------- */
const autoNets = () => Object.values(ST?.settings?.networks || {});

function autoEnabled() {
  const s = ST?.settings || {};
  return !!s.autoCheckin && autoNets().length > 0 && !kioskTarget
      && (s.checkinMode === "self" || s.checkinMode === "both");
}

function paintAutoBar(state, msg) {
  const bar = $("#autoBar"); if (!bar) return;
  bar.hidden = !autoEnabled();
  if (bar.hidden) return;
  const el = $("#autoState");
  el.className = "auto-state" + (state ? " " + state : "");
  el.textContent = msg;
}

/** يفحص شبكة الجهاز ويسجّل الحضور تلقائياً إن كانت شبكة الشركة */
async function tryAutoCheckin() {
  if (!autoEnabled() || autoBusy) { paintAutoBar("", "جارٍ الفحص…"); return; }
  if (!navigator.onLine) { paintAutoBar("off", "لا يوجد اتصال"); return; }
  if (today && (today.checkIn || today.status === "absent")) { paintAutoBar("on", "تم تسجيل حضورك اليوم"); return; }

  const s = ST.settings;
  const t = now(), cur = t.getHours() * 60 + t.getMinutes();
  const from = hhmmToMin(s.autoWindowStart || "05:00"), to = hhmmToMin(s.autoWindowEnd || "23:59");
  if (cur < from || cur > to) { paintAutoBar("off", "خارج وقت الفحص التلقائي"); return; }

  autoBusy = true;
  paintAutoBar("", "جارٍ فحص الشبكة…");
  try {
    const ip = await getPublicIP();
    if (!ip) { paintAutoBar("off", "تعذّر تحديد الشبكة"); return; }
    if (!ipMatches(ip, autoNets())) { paintAutoBar("off", "لست على شبكة الشركة"); return; }

    const r = await checkIn(EMP, s, "auto-wifi");
    if (!r.ok) { paintAutoBar("on", r.error || "تم التسجيل مسبقاً"); return; }
    buzz();
    const tm = timeAr(r.record.checkIn);
    toast(`تم تسجيل حضورك تلقائياً الساعة ${tm} ✅`, "ok");
    notify("✅ تم تسجيل الحضور تلقائياً",
      `${EMP.name}
عند اتصالك بشبكة الشركة
وقت الحضور: ${tm}` +
      (r.record.status === "late" ? `
⚠ تأخير ${r.record.lateMin} دقيقة` : ""),
      { tag: "auto-in", sticky: true });
    paintAutoBar("on", "تم تسجيل الحضور تلقائياً");
    loadHistory();
  } finally { autoBusy = false; }
}

/** يزوّد الـ Service Worker بما يلزم ليسجّل الحضور والتطبيق مغلق (أندرويد/كروم) */
async function armBackgroundAuto() {
  try {
    const reg = await navigator.serviceWorker?.ready;
    if (!reg || !EMP) return;
    (reg.active || reg.waiting)?.postMessage({
      type: "az-auto-config",
      config: { dbUrl: DB_URL, empId: EMP.id, empName: EMP.name,
                workStart: EMP.workStart || "", clockOffset: clockOffset() }
    });
    if ("periodicSync" in reg) {
      const st = await navigator.permissions?.query({ name: "periodic-background-sync" }).catch(() => null);
      if (!st || st.state === "granted")
        await reg.periodicSync.register("az-auto-checkin", { minInterval: 15 * 60 * 1000 }).catch(() => {});
    }
  } catch {}
}
