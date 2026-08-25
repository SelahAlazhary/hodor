/* ===== واجهة الموظف ===== */
import {
  $, $$, esc, toast, fullDateAr, dateKey, monthKey, dateAr, dayAr,
  timeAr, minToHuman, minToHours, toDate, deviceId, hhmmToMin, now, nowMs, clockParts, clockOffset,
  initials, LS
} from "./utils.js";
import { getPublicIP, ipMatches } from "./network.js";
import { DB_URL } from "./firebase.js";
import {
  checkIn, checkOut, markAbsent, watchRecord, getMonth, summarize,
  requiredMinOf, overtimeOf
} from "./store.js";
import { notify, askPermission, buzz } from "./notify.js";

let ST = null, EMP = null;
let unsubRec = null, clockTimer = null;
let today = null, kioskTarget = null;
let autoTimer = null, autoBusy = false;

export function disposeEmployee() {
  unsubRec?.(); clearInterval(clockTimer); clearInterval(autoTimer);
  unsubRec = clockTimer = autoTimer = null;
  window.removeEventListener("online", onBackOnline);
  document.removeEventListener("visibilitychange", onVisible);
  ST = EMP = today = kioskTarget = null;
  document.removeEventListener("az:employees", onEmployeesChanged);
  document.removeEventListener("az:settings", onSettingsChanged);
}

export function initEmployee(state, emp) {
  disposeEmployee();
  ST = state; EMP = emp;

  $("#empHeadName").textContent = emp.name;
  $("#empHeadJob").textContent = emp.job || "موظف";
  $("#empAvatar").textContent = initials(emp.name);
  $("#empHeadDate").textContent = fullDateAr();
  paintGreeting();
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
  window.addEventListener("online", onBackOnline);
  document.addEventListener("visibilitychange", onVisible);
}

function onVisible() { if (document.visibilityState === "visible") tryAutoCheckin(); }

/** عند عودة الاتصال: فحص فوري + تسجيل مزامنة خلفية تعمل والتطبيق مغلق */
async function onBackOnline() {
  tryAutoCheckin();
  try {
    const reg = await navigator.serviceWorker?.ready;
    if (reg && "sync" in reg) await reg.sync.register("az-auto-checkin");
  } catch {}
}

function onSettingsChanged() { applyKiosk(); paintToday(); paintAutoBar("", "جارٍ الفحص…"); tryAutoCheckin(); }

function onEmployeesChanged(e) {
  const fresh = e.detail.find(x => x.id === EMP?.id);
  if (fresh) {
    EMP = fresh;
    $("#empHeadName").textContent = fresh.name;
    $("#empHeadJob").textContent = fresh.job || "موظف";
    $("#empAvatar").textContent = initials(fresh.name);
  }
  applyKiosk();
}

/** تحية حسب وقت اليوم بتوقيت القاهرة */
function paintGreeting() {
  const el = $("#empGreet"); if (!el) return;
  const h = now().getHours();
  el.textContent = h < 5 ? "ليلة هادئة"
    : h < 12 ? "صباح الخير"
    : h < 16 ? "طاب يومك"
    : h < 21 ? "مساء الخير" : "ليلة هادئة";
}

/* ---------- الساعة ---------- */
const RING_TODAY = 540.35, RING_MONTH = 207.35;

/** حلقة SVG توضّح نسبة إنجاز دوام اليوم */
function paintGauge() {
  const ring = $("#todayRing"), pct = $("#todayPct");
  if (!ring) return;
  const dailyMin = Math.max(30, requiredMinOf(today, ST?.settings || {}, EMP));
  let worked = 0;
  if (today?.checkIn) {
    const endMs = today.checkOut ? toDate(today.checkOut).getTime() : nowMs();
    worked = Math.max(0, (endMs - toDate(today.checkIn).getTime()) / 60000);
  }
  const ratio = worked / dailyMin;
  const p = Math.max(0, Math.min(1, ratio));
  ring.style.strokeDashoffset = RING_TODAY * (1 - p);
  const extra = Math.max(0, Math.round(worked - dailyMin));
  pct.className = "gauge-pct" + (extra > 0 ? " over" : "");
  pct.textContent = today?.status === "absent" ? "غياب اليوم"
    : !today?.checkIn ? "لم يبدأ الدوام"
    : extra > 0 ? `اكتمل الدوام + ${minToHuman(extra)} إضافي`
    : `${Math.round(ratio * 100)}% من دوام اليوم`;
}

function startClock() {
  const tick = () => {
    const c = clockParts();
    $("#bigClock").innerHTML = `${c.t}<span class="clk-ap">${c.ap}</span>`;
    $("#bigDate").textContent = fullDateAr();
    paintGreeting();
    paintGauge();
    checkoutReminder();
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

/** يعكس حالة اليوم في شريط التوب بار */
function paintTopStatus(text, kind) {
  const chip = $("#tbStatus");
  if (!chip) return;
  chip.className = "tb-chip " + (kind || "");
  chip.innerHTML = `<i></i> ${esc(text)}`;
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
    paintTopStatus("لم يتم تسجيل الحضور", "idle");
    inL.textContent = "—"; outL.textContent = "—";
    btnIn.disabled = blocked; btnOut.disabled = true; btnAbs.disabled = false;
    return;
  }
  if (today.status === "absent") {
    pill.className = "pill pill-abs"; pill.textContent = "مُسجَّل كغياب اليوم";
    paintTopStatus("غياب اليوم", "abs");
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
    paintTopStatus(`انصرف ${timeAr(today.checkOut)}`, "out");
  } else if (today.status === "late") {
    pill.className = "pill pill-late";
    pill.textContent = `حاضر (متأخر ${today.lateMin || 0} د) منذ ${timeAr(today.checkIn)}`;
    paintTopStatus(`حاضر متأخر منذ ${timeAr(today.checkIn)}`, "late");
  } else {
    pill.className = "pill pill-in";
    pill.textContent = `حاضر منذ ${timeAr(today.checkIn)}`;
    paintTopStatus(`حاضر منذ ${timeAr(today.checkIn)}`, "in");
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
    const ot = Number(r.record.overtimeMin || 0);
    const exc = Number(r.record.lateExcused || 0);
    const otLine = ot > 0 ? `\n⏱ وقت إضافي: ${minToHuman(ot)}` : "";
    const excLine = exc > 0 ? `\n✅ عُوِّض تأخيرك (${minToHuman(exc)}) بالوقت الإضافي` : "";
    toast(exc > 0
      ? `تم الانصراف — عُوِّض تأخيرك بالوقت الإضافي ✅`
      : `تم تسجيل الانصراف — ${minToHuman(r.record.workedMin)} ✅`, "ok");
    notify("🔴 تم تسجيل الانصراف",
      `${t.name}\nساعة الحضور: ${i}\nساعة الانصراف: ${o}\nإجمالي اليوم: ${minToHuman(r.record.workedMin)}${otLine}${excLine}`,
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

  const s = summarize(rows, ST?.settings || {}, EMP);
  $("#stMonthHours").textContent = s.hours;
  $("#stOvertime").textContent = s.overtimeHours;

  // حلقة SVG: نسبة الساعات المنجزة إلى المطلوبة عن أيام الحضور
  const dailyMin = requiredMinOf(null, ST?.settings || {}, EMP);
  const target = (dailyMin / 60) * Math.max(1, s.days);
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
      <td>${otCell(r)}</td>
      <td>${statusTag(r)}</td>
    </tr>`).join("");
  $("#empHistEmpty").hidden = rows.length > 0;
}

/** خلية الوقت الإضافي */
function otCell(r) {
  const ot = overtimeOf(r, ST?.settings || {}, EMP);
  return ot > 0 ? `<span class="ot">+${minToHuman(ot)}</span>` : "—";
}

export function statusTag(r) {
  if (r.status === "absent") return '<span class="tag t-absent">غياب</span>';
  if (r.status === "late")   return '<span class="tag t-late">متأخر</span>';
  if (Number(r.lateExcused) > 0)
    return '<span class="tag t-excused" title="عُوِّض التأخير بالوقت الإضافي">تأخير معوَّض</span>';
  if (r.checkOut)            return '<span class="tag t-out">انصرف</span>';
  if (r.checkIn)             return '<span class="tag t-present">حاضر</span>';
  return '<span class="tag t-off">—</span>';
}

/* ---------- تنبيه انتهاء وقت العمل ---------- */
/** موعد انتهاء دوام الموظف بالدقائق */
const shiftEndMin = () => hhmmToMin(EMP?.workEnd || ST?.settings?.workEnd || "17:00");

/** ينبّه الموظف عند انتهاء دوامه ليسجّل انصرافه بنفسه
 *  (لا يُسجَّل الانصراف تلقائياً حتى يُحتسب الوقت الإضافي بدقة) */
function checkoutReminder() {
  if (!EMP || !today || !today.checkIn || today.checkOut || today.status === "absent") return;
  const end = shiftEndMin();
  if (end == null) return;

  const t = now();
  const cur = t.getHours() * 60 + t.getMinutes();
  if (cur < end) return;

  const over = cur - end;
  const slot = Math.floor(over / 30);            // تذكير كل 30 دقيقة
  if (slot > 4) return;                          // نتوقف بعد ساعتين
  const key = `az_endnotif_${EMP.id}_${dateKey()}`;
  if (Number(LS.get(key, 0)) > slot) return;
  LS.set(key, slot + 1);

  const endLabel = EMP.workEnd || ST?.settings?.workEnd || "17:00";
  const extra = over >= 5 ? `\n⏱ أنت الآن في وقت إضافي: ${minToHuman(over)}` : "";
  buzz([160, 80, 160]);
  toast("انتهى وقت دوامك — سجّل انصرافك", "ok");
  notify("🔔 حان وقت الانصراف",
    `${EMP.name}\nانتهى دوامك الساعة ${endLabel}${extra}\nسجّل انصرافك الآن ليُحتسب وقتك بدقة.`,
    { tag: "checkout-due", sticky: true });
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
                workStart: EMP.workStart || "", workEnd: EMP.workEnd || "",
                clockOffset: clockOffset() }
    });
    // يفحص الشبكة فور عودة الاتصال حتى لو كان التطبيق مغلقاً
    if ("sync" in reg) {
      try { await reg.sync.register("az-auto-checkin"); } catch {}
    }
    if ("periodicSync" in reg) {
      const st = await navigator.permissions?.query({ name: "periodic-background-sync" }).catch(() => null);
      if (!st || st.state === "granted")
        await reg.periodicSync.register("az-auto-checkin", { minInterval: 15 * 60 * 1000 }).catch(() => {});
    }
  } catch {}
}
