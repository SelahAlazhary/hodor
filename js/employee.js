/* ===== واجهة الموظف ===== */
import {
  $, $$, esc, toast, fullDateAr, dateKey, monthKey, dateAr, dayAr,
  timeAr, minToHuman, minToHours, toDate, deviceId, hhmmToMin, now, nowMs, clockParts, clockOffset,
  initials, instant, relAr, isDesktopDevice, LS
} from "./utils.js";
import { getPublicIP, ipMatches } from "./network.js";
import { empPinHash, verifyEmpPin } from "./auth.js";
import { startScan, parsePcCode, scannerSupported, cameraSupported } from "./scanner.js";
import { DB_URL } from "./firebase.js";
import {
  checkIn, checkOut, markAbsent, watchRecord, getMonth, summarize,
  requiredMinOf, overtimeOf, logEvent, setRecord, updateEmployee,
  watchNotices, noticeFor, approvePcRequest, findPcRequestByCode
} from "./store.js";
import { notify, askPermission, buzz } from "./notify.js";

let ST = null, EMP = null;
let unsubRec = null, unsubNotices = null, clockTimer = null;
let today = null, kioskTarget = null;
let autoTimer = null, autoBusy = false;
let netWasOn = null, netMisses = 0;

export function disposeEmployee() {
  try { stopScan?.(); } catch {}
  stopScan = null;
  unsubRec?.(); unsubNotices?.(); clearInterval(clockTimer); clearInterval(autoTimer);
  unsubRec = unsubNotices = clockTimer = autoTimer = null;
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
  bindPinForm();
  bindAutoStart();
  bindScanner();
  watchMyNotices();
  bindPcConfirm();
  paintPinState();
  paintPcConfirm();
  applyKiosk();
  watchToday();
  loadHistory();

  document.addEventListener("az:employees", onEmployeesChanged);
  document.addEventListener("az:settings", onSettingsChanged);

  // الحضور التلقائي عند الاتصال بشبكة الشركة
  paintAutoBar("", "جارٍ الفحص…");
  tryAutoCheckin();
  checkNetworkExit();
  armBackgroundAuto();
  autoTimer = setInterval(() => { tryAutoCheckin(); checkNetworkExit(); }, 4 * 60 * 1000);
  window.addEventListener("online", onBackOnline);
  document.addEventListener("visibilitychange", onVisible);
}

function onVisible() {
  if (document.visibilityState !== "visible") return;
  tryAutoCheckin(); checkNetworkExit();
}

/** عند عودة الاتصال: فحص فوري + تسجيل مزامنة خلفية تعمل والتطبيق مغلق */
async function onBackOnline() {
  tryAutoCheckin(); checkNetworkExit();
  try {
    const reg = await navigator.serviceWorker?.ready;
    if (reg && "sync" in reg) await reg.sync.register("az-auto-checkin");
  } catch {}
}

function onSettingsChanged() {
  applyKiosk(); paintToday(); paintAutoBar("", "جارٍ الفحص…"); tryAutoCheckin(); paintPcConfirm();
}

function onEmployeesChanged(e) {
  const fresh = e.detail.find(x => x.id === EMP?.id);
  if (fresh) {
    EMP = fresh;
    $("#empHeadName").textContent = fresh.name;
    $("#empHeadJob").textContent = fresh.job || "موظف";
    $("#empAvatar").textContent = initials(fresh.name);
    paintPinState();
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

  // زر تسجيل الحضور يظهر فقط لجهاز الكشك أو إن سمح المدير بالتسجيل اليدوي
  const manualAllowed = s.manualCheckin === true || isKiosk;
  const btnIn = $("#btnCheckIn");
  btnIn.hidden = !manualAllowed;
  document.querySelector(".action-grid")?.classList.toggle("no-in", !manualAllowed);

  const note = $("#autoOnlyNote");
  if (note) {
    note.hidden = manualAllowed;
    const msg = $("#autoOnlyMsg");
    if (msg) msg.textContent = s.autoCheckin
      ? "بمجرد اتصال هاتفك بشبكة الشركة — لا حاجة لأي ضغطة."
      : "يسجّله لك جهاز الاستقبال أو الإدارة — راجع الإدارة إن لم يظهر حضورك.";
  }

  // منع التسجيل إن كان الوضع "جهاز محدد فقط" وهذا ليس الجهاز المعتمد
  const blocked = s.checkinMode === "kiosk" && !isKiosk;
  btnIn.disabled = blocked;
  $("#btnCheckOut").disabled = blocked;
  if (blocked) $("#statusPill").textContent = "التسجيل متاح فقط من جهاز الاستقبال المعتمد";
}

/* ---------- سجل اليوم ---------- */
function watchToday() {
  unsubRec?.();
  const t = currentTarget();
  unsubRec = watchRecord(dateKey(), t.id, rec => { today = rec; paintToday(); paintGauge(); paintPcConfirm(); });
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
      { tag: "att-in", sound: "in" });
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
      { tag: "att-out", sticky: true, sound: "out" });
    loadHistory();
  };

  $("#btnAbsence").onclick = async () => {
    const t = currentTarget();
    const note = prompt(`تسجيل غياب لـ ${t.name} — سبب الغياب (اختياري):`, "");
    if (note === null) return;
    await markAbsent(t, dateKey(), note || "", kioskTarget ? "kiosk" : "employee");
    buzz();
    toast("تم تسجيل الغياب وإبلاغ الإدارة", "ok");
    notify("🚫 تم تسجيل غياب", `${t.name}\nاليوم: ${dateAr(dateKey())}${note ? "\nالسبب: " + note : ""}`, { tag: "att-abs", sound: "warn" });
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

/* ---------- ماسح رمز الكمبيوتر ---------- */
let stopScan = null;

function bindScanner() {
  const card = $("#scanCard"); if (!card) return;
  card.hidden = isDesktop();                 // الماسح للهاتف فقط
  const modal = $("#scanModal"), st = $("#scanState"), msg = $("#scanMsg");
  const show = (t, ok) => { msg.textContent = t; msg.className = "alert " + (ok ? "ok" : "error"); msg.hidden = false; };
  const close = () => { stopScan?.(); stopScan = null; modal.hidden = true; msg.hidden = true; };

  $("#scanClose").onclick = close;
  modal.onclick = e => { if (e.target === modal) close(); };

  $("#openScanner").onclick = async () => {
    modal.hidden = false; msg.hidden = true;
    st.className = "pill pill-idle"; st.textContent = "جارٍ تشغيل الكاميرا…";
    if (!cameraSupported()) { st.textContent = "الكاميرا غير متاحة — استخدم الرمز اليدوي"; return; }
    try {
      stopScan = await startScan($("#scanVideo"),
        v => { st.className = "pill pill-in"; st.textContent = "تم المسح — جارٍ الربط…"; linkPc(v); },
        e => { st.className = "pill pill-late"; st.textContent = e; });
      if (scannerSupported()) st.textContent = "وجّه الكاميرا نحو الرمز…";
    } catch (e) {
      st.className = "pill pill-abs";
      st.textContent = String(e && e.name) === "NotAllowedError"
        ? "لم يُسمح باستخدام الكاميرا — فعّل الإذن أو أدخل الرمز يدوياً"
        : "تعذّر تشغيل الكاميرا — أدخل الرمز يدوياً";
    }
  };

  $("#scanCodeForm").onsubmit = e => { e.preventDefault(); linkPc($("#scanCode").value); };

  async function linkPc(text) {
    const parsed = parsePcCode(text);
    if (!parsed) { show("رمز غير صالح", false); return; }
    let { pcId, code } = parsed;
    if (!pcId) {
      const found = await findPcRequestByCode(code);
      if (!found) { show("لا يوجد كمبيوتر ينتظر هذا الرمز — حدّث الصفحة على الكمبيوتر", false); return; }
      pcId = found.pcId;
    }
    const r = await approvePcRequest(pcId, code, EMP);
    if (!r.ok) { show(r.error, false); st.className = "pill pill-abs"; st.textContent = "لم يتم الربط"; return; }
    stopScan?.(); stopScan = null;
    show("تم ربط الكمبيوتر بحسابك ✅ افتح الشاشة عليه الآن", true);
    st.className = "pill pill-in"; st.textContent = "تم الربط بنجاح";
    buzz(); toast("تم ربط جهاز الكمبيوتر ✅", "ok");
    setTimeout(() => { modal.hidden = true; msg.hidden = true; }, 2600);
  }
}

/* ---------- إشعارات الإدارة ---------- */
function watchMyNotices() {
  unsubNotices?.();
  let primed = false;
  unsubNotices = watchNotices(list => {
    const mine = list.filter(n => noticeFor(n, EMP?.id));
    const card = $("#empNoticeCard"), ul = $("#empNoticeList");
    if (card && ul) {
      card.hidden = mine.length === 0;
      ul.innerHTML = mine.slice(0, 10).map(n => `
        <li><span class="fi fi-msg"><svg class="ico"><use href="#i-bell"/></svg></span>
          <span><b>${esc(n.title)}</b><br>${esc(n.body)}<small>${relAr(n.createdAt || n.at)}</small></span>
        </li>`).join("");
    }
    // إشعار على الهاتف لكل جديد لم يُعرض من قبل
    const seen = new Set(LS.get("az_notice_seen", []) || []);
    const fresh = mine.filter(n => !seen.has(n.id));
    fresh.forEach(n => seen.add(n.id));
    LS.set("az_notice_seen", [...seen].slice(-200));
    if (!primed) { primed = true; return; }
    fresh.slice(0, 3).forEach(n => {
      buzz();
      notify("📢 " + n.title, n.body, { tag: "notice-" + n.id, sticky: true, sound: "notice" });
      toast("📢 " + n.title, "ok");
    });
  });
}

/* ---------- كلمة مرور الحضور وتأكيد الكمبيوتر ---------- */
const isDesktop = () => isDesktopDevice();

function bindPinForm() {
  const form = $("#empPinForm"); if (!form) return;
  form.onsubmit = async e => {
    e.preventDefault();
    const box = $("#empPinMsg");
    const show = (t, ok) => { box.textContent = t; box.className = "alert " + (ok ? "ok" : "error"); box.hidden = false; };
    const oldPin = $("#empPinOld").value, np = $("#empPinNew").value, np2 = $("#empPinNew2").value;
    if (np.length < 4) { show("كلمة المرور قصيرة — 4 خانات على الأقل", false); return; }
    if (np !== np2) { show("كلمة المرور وتأكيدها غير متطابقين", false); return; }
    if (EMP.pinHash) {
      const v = await verifyEmpPin(EMP, oldPin);
      if (!v.ok) { show("كلمة المرور الحالية غير صحيحة", false); return; }
    }
    await updateEmployee(EMP.id, { pinHash: await empPinHash(np) });
    form.reset();
    show("تم حفظ كلمة مرور الحضور ✅", true);
    toast("تم حفظ كلمة مرور الحضور", "ok");
  };
}

/** ملف ويندوز ينشئ اختصاراً في مجلد بدء التشغيل ليفتح التطبيق بعد كل إقلاع */
function autoStartScript() {
  const url = location.origin + location.pathname;
  const raw = String.raw`@echo off
chcp 65001 >nul
title Spot Light - تشغيل تلقائي
set "URL=${url}"

rem  البحث عن متصفح مثبَّت
set "BR=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not exist "%BR%" set "BR=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if not exist "%BR%" set "BR=%LocalAppData%\Google\Chrome\Application\chrome.exe"
if not exist "%BR%" set "BR=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not exist "%BR%" set "BR=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
if not exist "%BR%" (
  echo لم يُعثر على متصفح Chrome أو Edge
  pause
  exit /b
)

rem  إنشاء اختصار في مجلد بدء التشغيل
set "VBS=%TEMP%\spotlight_autostart.vbs"
> "%VBS%" echo Set W = CreateObject("WScript.Shell")
>>"%VBS%" echo Set S = W.CreateShortcut(W.SpecialFolders("Startup") ^& "\Spot Light.lnk")
>>"%VBS%" echo S.TargetPath = "%BR%"
>>"%VBS%" echo S.Arguments = "--app=%URL%"
>>"%VBS%" echo S.Description = "Spot Light - نظام الحضور"
>>"%VBS%" echo S.Save
cscript //nologo "%VBS%"
del "%VBS%"

echo.
echo تم تفعيل التشغيل التلقائي بنجاح.
echo سيفتح التطبيق تلقائياً بعد كل إعادة تشغيل للجهاز.
echo.
pause
`;
  return raw.split("\n").join("\r\n");
}

function bindAutoStart() {
  const dl = $("#dlAutoStart"), show = $("#showAutoCmd"), box = $("#autoCmdBox");
  if (!dl) return;
  dl.onclick = () => {
    const blob = new Blob(["﻿" + autoStartScript()], { type: "application/octet-stream" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "SpotLight-AutoStart.bat";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    toast("نزّل الملف ثم افتحه بنقرة مزدوجة مرة واحدة", "ok");
  };
  show.onclick = () => {
    box.textContent = autoStartScript();
    box.hidden = !box.hidden;
    show.textContent = box.hidden ? "عرض محتوى الملف" : "إخفاء المحتوى";
  };
}

function paintPinState() {
  const tag = $("#pinState"); if (!tag) return;
  const has = !!EMP?.pinHash;
  tag.className = "tag " + (has ? "t-present" : "t-off");
  tag.textContent = has ? "مُعيَّنة" : "غير مُعيَّنة";
  const wrap = $("#oldPinWrap"); if (wrap) wrap.hidden = !has;
  // كلمة مرور الحضور والتشغيل التلقائي يخصّان الكمبيوتر فقط
  const pinCard = $("#empPinCard"); if (pinCard) pinCard.hidden = !isDesktop();
  const auto = $("#autoStartCard"); if (auto) auto.hidden = !isDesktop();
}

/** بطاقة تأكيد الحضور من الكمبيوتر — تظهر على الكمبيوتر فقط وداخل شبكة الشركة */
async function paintPcConfirm() {
  const card = $("#pcConfirmCard"); if (!card || !EMP) return;
  const s = ST?.settings || {};
  const needed = isDesktop() && !kioskTarget && (!today || (!today.checkIn && today.status !== "absent"));
  if (!needed) { card.hidden = true; return; }

  card.hidden = false;
  const msg = $("#pcConfirmMsg");
  if (!EMP.pinHash) {
    msg.textContent = "عيّن كلمة مرور الحضور من البطاقة بالأسفل أولاً.";
    $("#pcConfirmForm").hidden = true;
    return;
  }
  $("#pcConfirmForm").hidden = false;
  const nets = autoNets();
  if (!nets.length) { msg.textContent = "لم تُضف شبكة الشركة بعد — راجع الإدارة."; return; }
  const ip = navigator.onLine ? await getPublicIP() : null;
  const onNet = ip && ipMatches(ip, nets);
  msg.textContent = onNet
    ? "أنت داخل شبكة الشركة — أدخل كلمة مرور الحضور لتأكيد وجودك."
    : "⚠ لست على شبكة الشركة — لا يمكن تأكيد الحضور من خارج المقر.";
  $("#pcPin").disabled = !onNet;
  $("#pcConfirmForm").querySelector("button[type=submit]").disabled = !onNet;
}

function bindPcConfirm() {
  const form = $("#pcConfirmForm"); if (!form) return;
  form.onsubmit = async e => {
    e.preventDefault();
    const box = $("#pcConfirmMsgBox");
    const show = (t, ok) => { box.textContent = t; box.className = "alert " + (ok ? "ok" : "error"); box.hidden = false; };
    const nets = autoNets();
    const ip = navigator.onLine ? await getPublicIP(true) : null;
    if (!ip || !ipMatches(ip, nets)) { show("لا يمكن تأكيد الحضور من خارج شبكة الشركة", false); return; }
    const v = await verifyEmpPin(EMP, $("#pcPin").value);
    if (!v.ok) { show(v.error, false); return; }
    const r = await checkIn(EMP, ST.settings, "pc-pin");
    if (!r.ok) { show(r.error, false); return; }
    $("#pcPin").value = "";
    show("تم تأكيد حضورك ✅", true);
    buzz();
    toast(`تم تسجيل حضورك ${timeAr(r.record.checkIn)} ✅`, "ok");
    notify("✅ تم تأكيد الحضور", `${EMP.name}\nمن جهاز الكمبيوتر داخل الشركة\nالوقت: ${timeAr(r.record.checkIn)}`,
      { tag: "att-in", sound: "in" });
    loadHistory();
  };
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
    { tag: "checkout-due", sticky: true, sound: "warn" });
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

/** ═══ رصد خروج الموظف من شبكة الشركة قبل تسجيل الانصراف ═══
 *  عند مغادرته المقر يتغيّر عنوان الشبكة، فيصله تنبيه ويصل المدير إشعار.
 *  نشترط قراءتين متتاليتين خارج الشبكة حتى لا ينبّه لانقطاع لحظي.  */
async function checkNetworkExit() {
  const s = ST?.settings || {};
  const nets = autoNets();
  if (!nets.length || kioskTarget) return;
  if (!EMP || !today || !today.checkIn || today.checkOut || today.status === "absent") return;
  if (!navigator.onLine) return;                  // لا اتصال ⇒ لا نستطيع الحكم

  // إن سُجّل حضوره عبر الشبكة فهو كان عليها بالتأكيد
  if (netWasOn === null && String(today.source || "").startsWith("auto-wifi")) netWasOn = true;

  const ip = await getPublicIP();
  if (!ip) return;

  const key = `az_leftnet_${EMP.id}_${dateKey()}`;
  if (ipMatches(ip, nets)) {                      // ما زال داخل الشبكة
    netWasOn = true; netMisses = 0;
    LS.del(key);                                  // نعيد التسليح لو خرج لاحقاً
    return;
  }
  if (netWasOn !== true) return;                  // لم نتأكد أصلاً أنه كان عليها
  if (++netMisses < 2) return;                    // تأكيد بقراءتين

  // ═══ غائب عن الشبكة منذ ساعة أو أكثر: تنبيه المدير ليتحقق من وجوده ═══
  if (today.leftNetAt) {
    const awayMin = Math.round((nowMs() - toDate(today.leftNetAt).getTime()) / 60000);
    const slot = Math.floor(awayMin / 60);        // كل ساعة
    if (slot >= 1) {
      const aKey = `az_awaynet_${EMP.id}_${dateKey()}`;
      if (Number(LS.get(aKey, 0)) <= slot && slot <= 4) {
        LS.set(aKey, slot + 1);
        logEvent({ type: "awaynet", empId: EMP.id, empName: EMP.name, date: dateKey(),
                   at: instant().toISOString(), awayMin, since: today.leftNetAt });
        notify("⏳ ما زلت خارج شبكة الشركة",
          `${EMP.name}
مضى ${minToHuman(awayMin)} خارج الشبكة وحضورك ما زال مفتوحاً.
سجّل انصرافك أو عُد إلى المقر.`,
          { tag: "away-net", sticky: true, sound: "warn" });
      }
    }
  }

  if (LS.get(key)) return;                        // نُبّه مسبقاً اليوم
  LS.set(key, 1);

  const since = timeAr(today.checkIn);
  const leftAt = instant();
  const end = shiftEndMin();
  const cur = now().getHours() * 60 + now().getMinutes();
  const afterShift = end != null && cur >= end;          // غادر بعد انتهاء دوامه؟
  const endLabel = EMP.workEnd || ST?.settings?.workEnd || "";

  // نسجّل لحظة المغادرة في السجل ليستطيع المدير إغلاق اليوم عليها بدقة
  setRecord(dateKey(), EMP.id, {
    leftNetAt: leftAt.toISOString(), leftAfterShift: afterShift
  }).catch(() => {});

  buzz([200, 90, 200]);
  if (afterShift) {
    toast("انتهى دوامك وغادرت — سجّل انصرافك", "ok");
    notify("🔔 غادرت بعد انتهاء دوامك",
      `${EMP.name}\nانتهى دوامك${endLabel ? " الساعة " + endLabel : ""} وغادرت المقر دون تسجيل انصراف.\n` +
      `حضورك مسجَّل منذ ${since} — سجّل انصرافك ليُحتسب وقتك ووقتك الإضافي بدقة.`,
      { tag: "left-net", sticky: true, sound: "warn" });
  } else {
    toast("خرجت من شبكة الشركة قبل انتهاء دوامك", "err");
    notify("⚠️ خروج قبل انتهاء الدوام",
      `${EMP.name}\nخرجت من شبكة الشركة قبل انتهاء دوامك ولم تسجّل انصرافك.\nحضورك مسجَّل منذ ${since}.`,
      { tag: "left-net", sticky: true, sound: "warn" });
  }

  logEvent({ type: "leftnet", empId: EMP.id, empName: EMP.name,
             date: dateKey(), at: leftAt.toISOString(), checkIn: today.checkIn,
             afterShift });
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
      { tag: "auto-in", sticky: true, sound: "in" });
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
