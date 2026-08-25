/* ===== لوحة تحكم المدير ===== */
import {
  $, $$, esc, toast, dateKey, monthKey, dateAr, dayAr, fullDateAr, timeAr,
  minToHuman, minToHours, relAr, toDate, downloadCSV, hhmmToMin, now, nowMs, zoned, msFromCairo,
  samePhone, LS
} from "./utils.js";
import {
  watchDay, getMonth, summarize, markAbsent, clearRecord, editTimes, overtimeOf, requiredMinOf,
  compensateLate,
  addEmployee, updateEmployee, removeEmployee, setRecord, releaseDevice,
  saveSettings, watchEvents, clearEvents, watchDevices, addNetwork, removeNetwork, logEvent,
  removeDeviceEntry, createBindToken, sendNotice, watchNotices, removeNotice, releasePcDevice
} from "./store.js";
import { notify, askPermission, notifState, buzz } from "./notify.js";
import { statusTag } from "./employee.js";
import { getPublicIP } from "./network.js";
import { changeAdminPassword } from "./auth.js";
import { refreshTimePickers, timeLabelAr } from "./timepicker.js";

let ST = null;
let unsubDay = null, unsubEvents = null, unsubDevices = null, unsubNotices = null;
let dayRows = [], devices = [];
let seenEvents = new Set(), eventsPrimed = false;
let curDate = dateKey();

export function disposeAdmin() {
  unsubDay?.(); unsubEvents?.(); unsubDevices?.(); unsubNotices?.();
  unsubDay = unsubEvents = unsubDevices = unsubNotices = null;
  dayRows = []; devices = [];
  seenEvents = new Set();
  eventsPrimed = false;
  document.removeEventListener("az:employees", refreshOnEmployees);
}

export function initAdmin(state) {
  disposeAdmin();
  ST = state;
  curDate = dateKey();

  $("#admHeadDate").textContent = fullDateAr();
  $("#todayDate").value = curDate;
  $("#repMonth").value = monthKey();
  $("#notifState").textContent = notifLabel();

  bindNav();
  bindToday();
  bindEmployees();
  bindReport();
  bindSettings();

  startDay();
  unsubEvents = watchEvents(onEvents);
  unsubDevices = watchDevices(list => { devices = list; paintDevices(); });
  unsubNotices = watchNotices(paintNotices);
  bindNotice();

  document.addEventListener("az:employees", refreshOnEmployees);
  paintEmployees(); fillSettings(); loadReport();
}

function refreshOnEmployees() { paintEmployees(); paintDash(); paintToday(); paintNoticePick(); }

/* ---------- التنقل ---------- */
function bindNav() {
  $$(".navbtn").forEach(b => b.onclick = () => {
    $$(".navbtn").forEach(x => x.classList.remove("active"));
    b.classList.add("active");
    $$(".pane").forEach(p => p.classList.remove("active"));
    $("#pane-" + b.dataset.pane).classList.add("active");
    if (b.dataset.pane === "report") loadReport();
    window.scrollTo(0, 0);
  });
  $("#admBell").onclick = async () => {
    const ok = await askPermission();
    toast(ok ? "تم تفعيل إشعارات الحضور ✅" : "لم يتم تفعيل الإشعارات", ok ? "ok" : "err");
    $("#notifState").textContent = notifLabel();
    $("#admBellBadge").hidden = true;
  };
}
const notifLabel = () => ({ granted: "الإشعارات مفعّلة ✅", denied: "الإشعارات محظورة ❌", default: "الإشعارات غير مفعّلة", unsupported: "غير مدعومة" })[notifState()];

/* ---------- بيانات اليوم ---------- */
function startDay() {
  unsubDay?.();
  unsubDay = watchDay(curDate, rows => {
    dayRows = rows.slice().sort((a, b) => String(a.empName).localeCompare(String(b.empName), "ar"));
    paintDash(); paintToday();
  });
}

function paintDash() {
  const emps = (ST.employees || []).filter(e => e.active !== false);
  // نحسب من سجلات الموظفين الموجودين فقط — نتجاهل سجلات موظفين محذوفين
  const ids = new Set(emps.map(e => e.id));
  const rows = dayRows.filter(r => ids.has(r.empId));

  const present = rows.filter(r => r.checkIn);
  const late = present.filter(r => r.status === "late");
  const out = present.filter(r => r.checkOut);
  const notIn = emps.filter(e => !rows.some(r => r.empId === e.id && r.checkIn)).length;
  const mins = present.reduce((a, r) => a + Number(r.workedMin || 0), 0);

  $("#kTotal").textContent = emps.length;
  $("#kPresent").textContent = present.length;
  $("#kLate").textContent = late.length;
  $("#kAbsent").textContent = notIn;   // من لم يسجّل حضوراً (يشمل المسجّلين كغياب)
  $("#kOut").textContent = out.length;
  $("#kHours").textContent = minToHours(mins);

  // حلقة SVG لنسبة الحضور اليوم — من 100 دائماً
  const RATE_C = 414.69;
  const rate = emps.length ? Math.max(0, Math.min(1, present.length / emps.length)) : 0;
  const pct = Math.round(rate * 100);
  const ring = $("#attRing");
  if (ring) ring.style.strokeDashoffset = RATE_C * (1 - rate);
  $("#attPct").textContent = pct + "%";
  const sub = $("#attSub");
  if (sub) sub.textContent = emps.length ? `${present.length} من ${emps.length} موظف` : "لا يوجد موظفون";
  $("#lgPresent").textContent = present.length - late.length;
  $("#lgLate").textContent = late.length;
  $("#lgAbsent").textContent = notIn;
}

/* ---------- جدول اليوم ---------- */
function bindToday() {
  $("#todayDate").onchange = e => {
    curDate = e.target.value || dateKey();
    startDay();
  };
  $("#markAllAbsent").onclick = async () => {
    const emps = (ST.employees || []).filter(e => e.active !== false)
      .filter(e => !dayRows.some(r => r.empId === e.id));
    if (!emps.length) { toast("لا يوجد موظفون بدون سجل في هذا اليوم"); return; }
    if (!confirm(`سيتم تسجيل غياب لـ ${emps.length} موظف في يوم ${dateAr(curDate)}. متابعة؟`)) return;
    for (const e of emps) await markAbsent(e, curDate, "تسجيل جماعي", "admin");
    toast(`تم تسجيل غياب ${emps.length} موظف`, "ok");
  };
  $("#xlsxToday").onclick = () => apiDownload(`/api/report/daily?date=${curDate}`);
  $("#exportToday").onclick = () => {
    const known = new Set((ST.employees || []).map(e => e.id));
    const rows = [["الموظف", "التاريخ", "الحضور", "الانصراف", "الساعات", "الإضافي (ساعة)", "الحالة"]];
    dayRows.filter(r => known.has(r.empId)).forEach(r => rows.push([r.empName, r.date,
      r.checkIn ? timeAr(r.checkIn) : "", r.checkOut ? timeAr(r.checkOut) : "",
      minToHours(r.workedMin), minToHours(overtimeOf(r, ST.settings || {})), statusAr(r)]));
    downloadCSV(`حضور-${curDate}.csv`, rows);
  };
}

/** تنزيل ملف من خدمة بايثون مع رسائل واضحة عند التعذّر */
async function apiDownload(path) {
  toast("جارٍ تجهيز الملف…");
  try {
    const res = await fetch(path, { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const blob = await res.blob();
    if (blob.size < 500) throw new Error("ملف فارغ");
    const cd = res.headers.get("content-disposition") || "";
    const m = decodeURIComponent((cd.match(/filename\*=UTF-8''([^;]+)/) || [])[1] || "");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = m || "report.xlsx";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    toast("تم تنزيل الملف ✅", "ok");
  } catch (e) {
    toast("تعذّر تجهيز الملف — خدمة التقارير غير متاحة الآن", "err");
    console.warn("apiDownload", path, e);
  }
}

const statusAr = r => r.status === "absent" ? "غياب" : r.checkOut ? "انصرف" : r.status === "late" ? "متأخر" : r.checkIn ? "حاضر" : "—";

function paintToday() {
  $("#todayLbl").textContent = `${dayAr(curDate)} ${dateAr(curDate)}`;
  const emps = (ST.employees || []).filter(e => e.active !== false);
  const tb = $("#todayTable tbody");

  const rows = emps.map(e => {
    const r = dayRows.find(x => x.empId === e.id) || { empId: e.id, empName: e.name, date: curDate };
    return { emp: e, r };
  });

  tb.innerHTML = rows.map(({ emp, r }) => `
    <tr>
      <td><b>${esc(emp.name)}</b><br><span class="sub">${esc(emp.job || "")}</span></td>
      <td>${r.checkIn ? timeAr(r.checkIn) : "—"}</td>
      <td>${r.checkOut ? timeAr(r.checkOut) : "—"}</td>
      <td>${r.checkOut ? minToHuman(r.workedMin) : (r.checkIn ? "جارٍ" : "—")}</td>
      <td>${(() => { const ot = overtimeOf(r, ST.settings || {}, emp);
              return ot > 0 ? `<span class="ot">+${minToHuman(ot)}</span>` : "—"; })()}</td>
      <td>${statusTag(r)}</td>
      <td>
        ${!r.checkIn && r.status !== "absent" ? `<button class="mini ok" data-act="in" data-id="${emp.id}"><svg class="ico"><use href="#i-check"/></svg> حضر</button>` : ""}
        ${r.checkIn && !r.checkOut ? `<button class="mini warn" data-act="out" data-id="${emp.id}"><svg class="ico"><use href="#i-out"/></svg> انصرف</button>` : ""}
        ${r.checkIn && !r.checkOut && r.leftNetAt ? `<button class="mini ok" data-act="closeleft" data-id="${emp.id}" title="إنهاء اليوم على لحظة مغادرته المقر"><svg class="ico"><use href="#i-wifi-off"/></svg> أنهِ عند ${timeAr(r.leftNetAt)}</button>` : ""}
        ${r.status !== "absent" ? `<button class="mini danger" data-act="abs" data-id="${emp.id}"><svg class="ico"><use href="#i-ban"/></svg> غاب</button>` : ""}
        <button class="mini" data-act="edit" data-id="${emp.id}"><svg class="ico"><use href="#i-edit"/></svg> تعديل</button>
        ${r.checkIn || r.status === "absent" ? `<button class="mini" data-act="del" data-id="${emp.id}"><svg class="ico"><use href="#i-trash"/></svg> مسح</button>` : ""}
      </td>
    </tr>`).join("");

  tb.querySelectorAll("button[data-act]").forEach(b => b.onclick = () => todayAction(b.dataset.act, b.dataset.id));
}

async function todayAction(act, empId) {
  const emp = ST.employees.find(e => e.id === empId); if (!emp) return;
  const isToday = curDate === dateKey();
  const st = ST.settings || {};

  // تسجيل حضور يدوي
  if (act === "in") {
    const ms = isToday ? nowMs() : msFromCairo(curDate, emp.workStart || st.workStart || "09:00");
    const t = zoned(ms);
    const startMin = hhmmToMin(emp.workStart || st.workStart || "09:00") || 0;
    const lateMin = (t.getHours() * 60 + t.getMinutes()) - (startMin + Number(st.graceMin || 0));
    await setRecord(curDate, empId, {
      empId, empName: emp.name, date: curDate,
      checkIn: new Date(ms).toISOString(), checkOut: null, workedMin: 0,
      status: lateMin > 0 ? "late" : "present", lateMin: lateMin > 0 ? lateMin : 0,
      expectedStart: emp.workStart || st.workStart || "",
      expectedEnd: emp.workEnd || st.workEnd || "",
      note: null, source: "admin", createdAt: nowMs()
    });
    logEvent({ type: "in", empId, empName: emp.name, date: curDate,
               at: new Date(ms).toISOString(), status: lateMin > 0 ? "late" : "present" });
    toast(`تم تسجيل حضور ${emp.name} — ${timeAr(ms)}`, "ok");
    return;
  }

  // إنهاء اليوم على لحظة مغادرة الموظف للشبكة
  if (act === "closeleft") {
    const rec = dayRows.find(x => x.empId === empId);
    if (!rec || !rec.leftNetAt) { toast("لا توجد لحظة مغادرة مسجَّلة", "err"); return; }
    const ms = toDate(rec.leftNetAt).getTime();
    if (!confirm(`إنهاء يوم ${emp.name} على لحظة مغادرته المقر (${timeAr(rec.leftNetAt)})؟`)) return;
    const workedMin = Math.max(0, Math.round((ms - toDate(rec.checkIn).getTime()) / 60000));
    const comp = compensateLate(rec, workedMin, requiredMinOf(rec, st, emp));
    await setRecord(curDate, empId, {
      checkOut: new Date(ms).toISOString(), ...comp, closedFromNetworkExit: true
    });
    logEvent({ type: "out", empId, empName: emp.name, date: curDate,
               at: new Date(ms).toISOString(), workedMin });
    toast(`أُنهي يوم ${emp.name} عند ${timeAr(rec.leftNetAt)} — ${minToHuman(workedMin)}`, "ok");
    return;
  }

  // تسجيل انصراف يدوي
  if (act === "out") {
    const rec = dayRows.find(x => x.empId === empId);
    if (!rec || !rec.checkIn) { toast("لا يوجد تسجيل حضور في هذا اليوم", "err"); return; }
    const ms = isToday ? nowMs() : msFromCairo(curDate, emp.workEnd || st.workEnd || "17:00");
    const workedMin = Math.max(0, Math.round((ms - toDate(rec.checkIn).getTime()) / 60000));
    const req = requiredMinOf(rec, st, emp);
    const comp = compensateLate(rec, workedMin, req);
    await setRecord(curDate, empId, { checkOut: new Date(ms).toISOString(), ...comp });
    if (comp.lateExcused > 0) toast(`عُوِّض تأخير ${emp.name} بالوقت الإضافي`, "ok");
    logEvent({ type: "out", empId, empName: emp.name, date: curDate, at: new Date(ms).toISOString(), workedMin });
    toast(`تم تسجيل انصراف ${emp.name} — ${minToHuman(workedMin)}`, "ok");
    return;
  }

  if (act === "abs") {
    const note = prompt(`سبب غياب ${emp.name} (اختياري):`, ""); if (note === null) return;
    await markAbsent(emp, curDate, note || "", "admin");
    toast("تم تسجيل الغياب", "ok");
  }
  if (act === "del") {
    if (!confirm(`مسح سجل ${emp.name} ليوم ${dateAr(curDate)}؟`)) return;
    await clearRecord(curDate, empId);
    toast("تم المسح", "ok");
  }
  if (act === "edit") {
    const r = dayRows.find(x => x.empId === empId) || {};
    const cin = prompt("ساعة الحضور (HH:MM) — اتركه فارغاً للإلغاء:", r.checkIn ? hhmm(r.checkIn) : "09:00");
    if (cin === null) return;
    const cout = prompt("ساعة الانصراف (HH:MM) — اتركه فارغاً إن لم ينصرف:", r.checkOut ? hhmm(r.checkOut) : "");
    if (cout === null) return;
    const iso = t => t && /^\d{1,2}:\d{2}$/.test(t.trim())
      ? new Date(msFromCairo(curDate, t.trim().padStart(5, "0"))).toISOString() : null;
    const inISO = iso(cin), outISO = iso(cout);
    if (!inISO) { toast("صيغة الوقت غير صحيحة", "err"); return; }
    const base = {
      empId, empName: emp.name, date: curDate, checkIn: inISO, checkOut: outISO,
      workedMin: outISO ? Math.max(0, Math.round((new Date(outISO) - new Date(inISO)) / 60000)) : 0,
      status: "present", editedByAdmin: true
    };
    await setRecord(curDate, empId, base);
    toast("تم تعديل السجل", "ok");
  }
}
const hhmm = v => { const d = toDate(v); if (!d) return ""; const z = zoned(d);
  return `${String(z.getHours()).padStart(2, "0")}:${String(z.getMinutes()).padStart(2, "0")}`; };

/* ---------- الموظفون ---------- */
function bindEmployees() {
  $("#empForm").onsubmit = async e => {
    e.preventDefault();
    const id = $("#empId").value;
    const data = {
      name: $("#fName").value.trim(),
      job: $("#fJob").value.trim(),
      phone: $("#fPhone").value.trim(),
      workStart: $("#fStart").value,
      workEnd: $("#fEnd").value,
      active: $("#fActive").value === "1"
    };
    if (!data.name) return;
    if (!data.phone) { toast("رقم الهاتف مطلوب — يستخدمه الموظف للدخول", "err"); return; }
    const dup = (ST.employees || []).find(x => x.id !== id && samePhone(x.phone, data.phone));
    if (dup) { toast(`رقم الهاتف مستخدم بالفعل للموظف ${dup.name}`, "err"); return; }
    try {
      if (id) { await updateEmployee(id, data); toast("تم تحديث بيانات الموظف", "ok"); }
      else { await addEmployee(data); toast("تمت إضافة الموظف ✅", "ok"); }
      resetEmpForm();
    } catch (err) { toast("خطأ في الحفظ: " + err.message, "err"); }
  };
  $("#empFormReset").onclick = resetEmpForm;
  $("#fStart").addEventListener("change", paintShiftSum);
  $("#fEnd").addEventListener("change", paintShiftSum);
  paintShiftSum();
  $("#empSearch").oninput = paintEmployees;
}
/** ملخّص مواعيد الدوام بالعربية مع عدد الساعات */
function paintShiftSum() {
  const el = $("#fShiftSum"); if (!el) return;
  const a = $("#fStart").value, b = $("#fEnd").value;
  if (!a || !b) { el.textContent = "دوام الشركة الافتراضي"; el.className = "ef-sum"; return; }
  let d = (hhmmToMin(b) || 0) - (hhmmToMin(a) || 0);
  if (d < 0) d += 1440;
  el.textContent = `${timeLabelAr(a)} ← ${timeLabelAr(b)} • ${minToHuman(d)}`;
  el.className = "ef-sum on";
}

function resetEmpForm() {
  $("#empForm").reset(); $("#empId").value = "";
  refreshTimePickers($("#empForm"));
  paintShiftSum();
  $("#empFormBtnLabel").textContent = "حفظ الموظف";
}

function paintEmployees() {
  const q = ($("#empSearch")?.value || "").trim();
  const list = (ST?.employees || []).filter(e => !q || String(e.name).includes(q));
  $("#empCount").textContent = (ST?.employees || []).length;
  const tb = $("#empsTable tbody");
  tb.innerHTML = list.map(e => `
    <tr>
      <td><b>${esc(e.name)}</b></td>
      <td>${esc(e.job || "—")}</td>
      <td>${esc(e.phone || "—")}</td>
      <td>${e.workStart ? timeLabelAr(e.workStart) : "—"} <span class="sub">←</span> ${e.workEnd ? timeLabelAr(e.workEnd) : "—"}</td>
      <td>${e.boundDevice
        ? `<span class="tag t-present">هاتف</span>`
        : '<span class="tag t-off">بلا هاتف</span>'}
        ${e.pcDevice ? '<br><span class="tag t-out">كمبيوتر</span>' : ""}</td>
      <td>${e.active === false ? '<span class="tag t-absent">موقوف</span>' : '<span class="tag t-present">نشط</span>'}</td>
      <td>
        <button class="mini" data-e="qr" data-id="${e.id}"><svg class="ico"><use href="#i-mobile"/></svg> ربط بـQR</button>
        ${e.boundDevice ? `<button class="mini ok" data-e="free" data-id="${e.id}"><svg class="ico"><use href="#i-mobile"/></svg> هاتف جديد</button>` : ""}
        ${e.pcDevice ? `<button class="mini warn" data-e="unpc" data-id="${e.id}"><svg class="ico"><use href="#i-monitor"/></svg> فصل الكمبيوتر</button>` : ""}
        <button class="mini" data-e="edit" data-id="${e.id}"><svg class="ico"><use href="#i-edit"/></svg> تعديل</button>
        <button class="mini danger" data-e="del" data-id="${e.id}"><svg class="ico"><use href="#i-trash"/></svg> حذف</button>
      </td>
    </tr>`).join("");

  tb.querySelectorAll("button[data-e]").forEach(b => b.onclick = async () => {
    const emp = ST.employees.find(x => x.id === b.dataset.id); if (!emp) return;
    if (b.dataset.e === "edit") {
      $("#empId").value = emp.id; $("#fName").value = emp.name; $("#fJob").value = emp.job || "";
      $("#fPhone").value = emp.phone || ""; $("#fStart").value = emp.workStart || "";
      $("#fEnd").value = emp.workEnd || "";
      refreshTimePickers($("#empForm"));
      paintShiftSum(); $("#fActive").value = emp.active === false ? "0" : "1";
      $("#empFormBtnLabel").textContent = "تحديث البيانات";
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
    if (b.dataset.e === "qr") { await openQr(emp); return; }
    if (b.dataset.e === "unpc") {
      if (!confirm(`فصل جهاز الكمبيوتر عن حساب ${emp.name}؟`)) return;
      await releasePcDevice(emp.id);
      toast("تم فصل الكمبيوتر", "ok");
      return;
    }
    if (b.dataset.e === "free") {
      if (!confirm(`السماح لـ ${emp.name} بتسجيل الدخول من هاتف جديد؟\n` +
                   `سيُفصل حسابه عن الهاتف الحالي، وأول هاتف يدخل منه سيصبح هاتفه المعتمد.`)) return;
      await releaseDevice(emp.id);
      toast(`تم تحرير حساب ${emp.name} — يمكنه الدخول من هاتف جديد`, "ok");
      return;
    }
    if (b.dataset.e === "del") {
      if (!confirm(`حذف ${emp.name} نهائياً؟ (سجلات الحضور السابقة تبقى محفوظة)`)) return;
      await removeEmployee(emp.id); toast("تم الحذف", "ok");
    }
  });
}

/* ---------- ربط الجهاز عبر QR ---------- */
async function openQr(emp) {
  const modal = $("#qrModal");
  $("#qrEmpName").textContent = emp.name;
  $("#qrImg").removeAttribute("src");
  modal.hidden = false;
  try {
    const token = await createBindToken(emp.id, emp.name);
    const link = `${location.origin}${location.pathname}?bind=${token}`;
    $("#qrLink").value = link;
    $("#qrImg").src = `/api/qr?text=${encodeURIComponent(link)}&scale=7`;
  } catch (e) {
    const denied = String(e?.code || e?.message || "").toLowerCase().includes("permission");
    toast(denied
      ? "قواعد قاعدة البيانات تمنع إنشاء الرمز — انشر ملف database.rules.json"
      : "تعذّر إنشاء رمز الربط — تأكد من الاتصال", "err");
    modal.hidden = true;
  }
}
$("#qrClose")?.addEventListener("click", () => { $("#qrModal").hidden = true; });
$("#qrModal")?.addEventListener("click", e => { if (e.target.id === "qrModal") e.target.hidden = true; });
$("#qrCopy")?.addEventListener("click", () => {
  const i = $("#qrLink");
  i.select();
  navigator.clipboard?.writeText(i.value).then(() => toast("تم نسخ الرابط", "ok"))
    .catch(() => toast("انسخ الرابط يدوياً"));
});

/* ---------- إرسال الإشعارات ---------- */
let noticeMode = "all";

function bindNotice() {
  $$("#noticeTarget .seg-btn").forEach(b => b.onclick = () => {
    $$("#noticeTarget .seg-btn").forEach(x => x.classList.remove("active"));
    b.classList.add("active");
    noticeMode = b.dataset.t;
    $("#noticePick").hidden = noticeMode !== "some";
    paintNoticePick();
  });

  $("#noticeForm").onsubmit = async e => {
    e.preventDefault();
    const box = $("#noticeMsg");
    const show = (t, ok) => { box.textContent = t; box.className = "alert " + (ok ? "ok" : "error"); box.hidden = false; };
    const title = $("#noticeTitle").value.trim(), body = $("#noticeBody").value.trim();
    if (!title || !body) return;
    let to = "all", count = (ST.employees || []).length;
    if (noticeMode === "some") {
      const ids = $$("#noticePick input:checked").map(i => i.value);
      if (!ids.length) { show("اختر موظفاً واحداً على الأقل", false); return; }
      to = ids; count = ids.length;
    }
    const btn = e.target.querySelector('button[type="submit"]');
    btn.disabled = true;
    const r = await sendNotice({ to, title, body });
    btn.disabled = false;
    if (!r.ok) { show(r.error, false); toast("لم يُرسل الإشعار", "err"); return; }
    e.target.reset();
    $$("#noticePick input").forEach(i => i.checked = false);
    show(`تم إرسال الإشعار إلى ${count} موظف ✅`, true);
    toast("تم إرسال الإشعار", "ok");
  };
}

function paintNoticePick() {
  const box = $("#noticePick"); if (!box) return;
  box.innerHTML = (ST.employees || []).filter(e => e.active !== false).map(e => `
    <label class="pick"><input type="checkbox" value="${e.id}" /> <span>${esc(e.name)}</span></label>`).join("")
    || '<div class="empty">لا يوجد موظفون</div>';
}

function paintNotices(list) {
  const ul = $("#noticeList"); if (!ul) return;
  const names = id => (ST.employees || []).find(e => e.id === id)?.name || "—";
  ul.innerHTML = list.map(n => {
    const to = n.to === "all" ? "كل الموظفين"
      : Object.keys(n.to || {}).map(names).join("، ") || "—";
    return `<li>
      <span class="fi fi-msg"><svg class="ico"><use href="#i-bell"/></svg></span>
      <span><b>${esc(n.title)}</b><br>${esc(n.body)}
        <small>إلى: ${esc(to)} • ${relAr(n.createdAt || n.at)}</small></span>
      <button class="mini danger" data-notice="${n.id}"><svg class="ico"><use href="#i-trash"/></svg></button>
    </li>`;
  }).join("");
  $("#noticeEmpty").hidden = list.length > 0;
  ul.querySelectorAll("button[data-notice]").forEach(b => b.onclick = async () => {
    if (!confirm("حذف هذا الإشعار؟")) return;
    await removeNotice(b.dataset.notice);
    toast("تم الحذف", "ok");
  });
}

/* ---------- التقرير الشهري ---------- */
let repRows = [];
function bindReport() {
  $("#repMonth").onchange = loadReport;
  $("#exportRep").onclick = () => {
    const mk = $("#repMonth").value;
    const rows = [["الموظف", "الدوام", "أيام الحضور", "أيام الغياب", "مرات التأخير",
                   "إجمالي الساعات", "ساعات إضافية", "متوسط اليوم (ساعة)"]];
    repRows.forEach(x => rows.push([
      x.name,
      `${x.emp.workStart || ST.settings?.workStart || ""} - ${x.emp.workEnd || ST.settings?.workEnd || ""}`,
      x.s.days, x.s.absent, x.s.late, x.s.hours, x.s.overtimeHours, minToHours(x.s.avgMin)]));
    rows.push([]);
    rows.push(["الإجمالي", "", "", "", "",
      repRows.reduce((a, x) => a + x.s.hours, 0).toFixed(2),
      repRows.reduce((a, x) => a + x.s.overtimeHours, 0).toFixed(2), ""]);
    downloadCSV(`تقرير-${mk}.csv`, rows);
  };
  $("#printRep").onclick = () => window.print();

  // تقارير Excel الاحترافية من خدمة بايثون
  $("#xlsxRep").onclick = () => apiDownload(`/api/report?month=${$("#repMonth").value || monthKey()}`);
  $("#repDetailClose").onclick = () => { $("#repDetailCard").hidden = true; };
}

async function loadReport() {
  const mk = $("#repMonth").value || monthKey();
  let all = [];
  try { all = await getMonth(mk); } catch (e) { console.warn(e); toast("تعذّر تحميل التقرير", "err"); }
  const emps = ST?.employees || [];
  repRows = emps.map(e => ({
    id: e.id, name: e.name, emp: e,
    s: summarize(all.filter(r => r.empId === e.id), ST?.settings || {}, e)
  }));

  const tb = $("#repTable tbody");
  tb.innerHTML = repRows.map(x => `
    <tr>
      <td><b>${esc(x.name)}</b></td>
      <td>${x.s.days}</td>
      <td>${x.s.absent}</td>
      <td>${x.s.late}</td>
      <td><b style="color:var(--green)">${x.s.hours}</b> ساعة</td>
      <td>${x.s.overtimeHours > 0 ? `<span class="ot">+${x.s.overtimeHours} ساعة</span>` : "—"}</td>
      <td>${minToHuman(x.s.avgMin)}</td>
      <td><button class="mini" data-r="${x.id}"><svg class="ico"><use href="#i-eye"/></svg> عرض</button></td>
    </tr>`).join("");
  $("#repGrand").textContent = repRows.reduce((a, x) => a + x.s.hours, 0).toFixed(2);
  $("#repOt").textContent = repRows.reduce((a, x) => a + x.s.overtimeHours, 0).toFixed(2);

  tb.querySelectorAll("button[data-r]").forEach(b => b.onclick = () => {
    const id = b.dataset.r;
    const emp = emps.find(e => e.id === id);
    const rows = all.filter(r => r.empId === id).sort((a, b2) => a.date.localeCompare(b2.date));
    $("#repDetailName").textContent = emp?.name || "";
    $("#repDetailTable tbody").innerHTML = rows.map(r => `
      <tr><td>${dateAr(r.date)}</td><td>${dayAr(r.date)}</td>
      <td>${r.checkIn ? timeAr(r.checkIn) : "—"}</td>
      <td>${r.checkOut ? timeAr(r.checkOut) : "—"}</td>
      <td>${r.checkOut ? minToHuman(r.workedMin) : "—"}</td>
      <td>${(() => { const ot = overtimeOf(r, ST?.settings || {}, emp);
              return ot > 0 ? `<span class="ot">+${minToHuman(ot)}</span>` : "—"; })()}</td>
      <td>${statusTag(r)}</td></tr>`).join("") || `<tr><td colspan="7" style="text-align:center;color:var(--muted)">لا توجد سجلات</td></tr>`;
    $("#repDetailCard").hidden = false;
    $("#repDetailCard").scrollIntoView({ behavior: "smooth" });
  });
}

/* ---------- الأحداث والإشعارات ---------- */
function onEvents(list) {
  const ul = $("#feedList");
  ul.innerHTML = list.map(ev => {
    const ico = { in: "i-in", out: "i-out", abs: "i-ban", leftnet: "i-wifi-off", awaynet: "i-alert" }[ev.type] || "i-bell";
    const cls = { in: "fi-in", out: "fi-out", abs: "fi-abs" }[ev.type]
      || (ev.type === "leftnet" ? (ev.afterShift ? "fi-warn" : "fi-abs")
       : ev.type === "awaynet" ? "fi-abs" : "fi-in");
    const txt = ev.type === "in" ? `سجّل حضوره${ev.status === "late" ? " (متأخر)" : ""} الساعة ${timeAr(ev.at)}`
      : ev.type === "out" ? `سجّل انصرافه الساعة ${timeAr(ev.at)} — ${minToHuman(ev.workedMin)}`
      : ev.type === "leftnet" ? (ev.afterShift
          ? `غادر <b>بعد انتهاء دوامه</b> الساعة ${timeAr(ev.at)} دون تسجيل انصراف`
          : `<b class="danger-txt">غادر قبل انتهاء دوامه</b> الساعة ${timeAr(ev.at)} دون تسجيل انصراف`)
      : ev.type === "awaynet"
        ? `<b class="danger-txt">خارج شبكة الشركة منذ ${minToHuman(ev.awayMin)}</b> وحضوره ما زال مفتوحاً — تحقّق من وجوده`
      : `تم تسجيل غياب${ev.note ? " — " + esc(ev.note) : ""}`;
    return `<li><span class="fi ${cls}"><svg class="ico"><use href="#${ico}"/></svg></span><span><b>${esc(ev.empName || "")}</b> ${txt}<small>${relAr(ev.createdAt || ev.at)}</small></span></li>`;
  }).join("");
  $("#feedEmpty").hidden = list.length > 0;

  // إشعار فوري للمدير عند كل حدث جديد
  if (!eventsPrimed) { list.forEach(e => seenEvents.add(e.id)); eventsPrimed = true; return; }
  let newCount = 0;
  for (const ev of list) {
    if (seenEvents.has(ev.id)) continue;
    seenEvents.add(ev.id); newCount++;
    if (ev.type === "in") notify("🟢 حضور جديد", `${ev.empName} سجّل حضوره الساعة ${timeAr(ev.at)}${ev.status === "late" ? " (متأخر)" : ""}`, { tag: "adm-" + ev.id, sound: ev.type === "in" ? "in" : ev.type === "out" ? "out" : "warn" });
    if (ev.type === "out") notify("🔴 انصراف", `${ev.empName} انصرف الساعة ${timeAr(ev.at)} — ${minToHuman(ev.workedMin)}`, { tag: "adm-" + ev.id, sound: ev.type === "in" ? "in" : ev.type === "out" ? "out" : "warn" });
    if (ev.type === "abs") notify("🚫 غياب", `${ev.empName} — ${dateAr(ev.date)}${ev.note ? "\n" + ev.note : ""}`, { tag: "adm-" + ev.id, sound: ev.type === "in" ? "in" : ev.type === "out" ? "out" : "warn" });
    if (ev.type === "awaynet") notify("⏳ موظف خارج الشبكة",
      `${ev.empName} خارج شبكة الشركة منذ ${minToHuman(ev.awayMin)} وحضوره ما زال مفتوحاً.
تحقّق من وجوده.`,
      { tag: "adm-" + ev.id, sticky: true, sound: "warn" });
    if (ev.type === "leftnet") notify(
      ev.afterShift ? "🔔 غادر بعد انتهاء دوامه" : "⚠️ غادر قبل انتهاء دوامه",
      `${ev.empName} غادر شبكة الشركة الساعة ${timeAr(ev.at)} ولم يسجّل انصرافه` +
      (ev.afterShift ? " — بعد انتهاء دوامه" : " — قبل انتهاء دوامه") +
      (ev.checkIn ? `\nحضوره مسجَّل منذ ${timeAr(ev.checkIn)}` : ""),
      { tag: "adm-" + ev.id, sticky: true, sound: "warn" });
  }
  if (newCount) {
    buzz();
    const b = $("#admBellBadge");
    b.textContent = Number(b.textContent || 0) + newCount; b.hidden = false;
  }
}
$("#clearFeed")?.addEventListener("click", async () => {
  if (!confirm("مسح سجل الأحداث؟")) return;
  await clearEvents(); toast("تم المسح", "ok");
});

/* ---------- الإعدادات ---------- */
function fillSettings() {
  const s = ST?.settings || {};
  $("#sCompany").value = s.company || "";
  $("#sStart").value = s.workStart || "09:00";
  $("#sEnd").value = s.workEnd || "17:00";
  $("#sGrace").value = s.graceMin ?? 15;
  $("#sDaily").value = s.dailyHours ?? 8;
  const mode = s.checkinMode || "self";
  $$('input[name="mode"]').forEach(r => r.checked = r.value === mode);

  $("#sManualCheckin").checked = s.manualCheckin === true;
  paintManualWarn();
  $("#sForceInstall").checked = s.forceInstall !== false;
  $("#sAuto").checked = !!s.autoCheckin;
  $("#sAutoFrom").value = s.autoWindowStart || "06:00";
  $("#sAutoTo").value = s.autoWindowEnd || "17:30";
  refreshTimePickers();
  paintNetworks();
}

/** يحذّر المدير إن أغلق التسجيل اليدوي بلا بديل مفعّل */
function paintManualWarn() {
  const el = $("#manualWarn"); if (!el) return;
  const s = ST?.settings || {};
  const nets = Object.keys(s.networks || {}).length;
  const risky = s.manualCheckin !== true && !(s.autoCheckin && nets) && !s.kioskDeviceId;
  el.hidden = !risky;
  el.textContent = risky
    ? "⚠ تنبيه: التسجيل اليدوي مغلق ولا يوجد حضور تلقائي ولا جهاز كشك — لن يستطيع الموظفون تسجيل حضورهم إلا بتسجيلك اليدوي من «حضور اليوم»."
    : "";
}

/* ---------- شبكات الشركة للحضور التلقائي ---------- */
function paintNetworks() {
  paintManualWarn();
  const nets = Object.values(ST?.settings?.networks || {});
  const tb = $("#netTable tbody");
  if (!tb) return;
  tb.innerHTML = nets.map(n => `
    <tr>
      <td><b>${esc(n.label || "شبكة الشركة")}</b></td>
      <td><code>${esc(n.ip)}</code>${String(n.ip).endsWith(".") ? ' <span class="tag t-off">نطاق</span>' : ""}</td>
      <td>${n.addedAt ? relAr(n.addedAt) : "—"}</td>
      <td><button class="mini danger" data-net="${esc(n.ip)}"><svg class="ico"><use href="#i-trash"/></svg> حذف</button></td>
    </tr>`).join("");
  $("#netEmpty").hidden = nets.length > 0;
  tb.querySelectorAll("button[data-net]").forEach(b => b.onclick = async () => {
    if (!confirm(`حذف الشبكة ${b.dataset.net}؟`)) return;
    await removeNetwork(b.dataset.net);
    toast("تم حذف الشبكة", "ok");
  });
}

async function showCurrentIP() {
  const el = $("#curIP"); if (!el) return;
  el.textContent = "جارٍ الفحص…";
  const ip = await getPublicIP(true);
  el.textContent = ip || "تعذّر تحديد العنوان";
  el.dataset.ip = ip || "";
}

function bindSettings() {
  $("#setForm").onsubmit = async e => {
    e.preventDefault();
    await saveSettings({
      company: $("#sCompany").value.trim() || "Spot Light",
      workStart: $("#sStart").value || "09:00",
      workEnd: $("#sEnd").value || "17:00",
      graceMin: Number($("#sGrace").value || 0),
      dailyHours: Number($("#sDaily").value || 8)
    });
    toast("تم حفظ الإعدادات ✅", "ok");
  };
  $$('input[name="mode"]').forEach(r => r.onchange = async () => {
    await saveSettings({ checkinMode: r.value });
    toast("تم تحديث طريقة التسجيل", "ok");
    if (r.value !== "self" && !(ST.settings?.kioskDeviceId))
      toast("اختر الجهاز المعتمد من جدول الأجهزة بالأسفل");
  });
  $("#passForm").onsubmit = async e => {
    e.preventDefault();
    const msg = $("#passMsg");
    const show = (t, ok) => { msg.textContent = t; msg.className = "alert " + (ok ? "ok" : "error"); msg.hidden = false; };
    const cur = $("#curPass").value, np = $("#newPass").value, np2 = $("#newPass2").value;
    if (np !== np2) { show("كلمة المرور الجديدة وتأكيدها غير متطابقين", false); return; }
    const btn = e.target.querySelector('button[type="submit"]');
    btn.disabled = true;
    const r = await changeAdminPassword(cur, np, ST.settings?.adminPass || null);
    btn.disabled = false;
    if (!r.ok) { show(r.error, false); return; }
    e.target.reset();
    show("تم تغيير كلمة المرور بنجاح — استخدمها في الدخول القادم", true);
    toast("تم تغيير كلمة المرور", "ok");
  };

  $("#refreshDev").onclick = () => paintDevices();

  $("#sManualCheckin").onchange = async e => {
    await saveSettings({ manualCheckin: e.target.checked });
    toast(e.target.checked
      ? "ظهر زر تسجيل الحضور للموظفين"
      : "أُخفي زر تسجيل الحضور — يُسجَّل الحضور تلقائياً أو من الإدارة", "ok");
  };

  $("#sForceInstall").onchange = async e => {
    await saveSettings({ forceInstall: e.target.checked });
    toast(e.target.checked ? "أصبح تثبيت التطبيق إلزامياً للموظفين" : "تم إلغاء إلزام التثبيت", "ok");
  };

  $("#sAuto").onchange = async e => {
    await saveSettings({ autoCheckin: e.target.checked });
    toast(e.target.checked ? "تم تفعيل الحضور التلقائي ✅" : "تم إيقاف الحضور التلقائي", "ok");
    if (e.target.checked && !Object.keys(ST.settings?.networks || {}).length)
      toast("أضف شبكة الشركة أولاً حتى تعمل الميزة");
  };
  const saveWindow = async () => {
    await saveSettings({
      autoWindowStart: $("#sAutoFrom").value || "05:00",
      autoWindowEnd: $("#sAutoTo").value || "23:59"
    });
    toast("تم حفظ وقت الفحص التلقائي", "ok");
  };
  $("#sAutoFrom").onchange = saveWindow;
  $("#sAutoTo").onchange = saveWindow;

  $("#addCurNet").onclick = async () => {
    const el = $("#curIP");
    let ip = el.dataset.ip;
    if (!ip) { await showCurrentIP(); ip = el.dataset.ip; }
    if (!ip) { toast("تعذّر تحديد عنوان الشبكة — تأكد من الاتصال بالإنترنت", "err"); return; }
    const label = prompt("اسم الشبكة (للتوضيح فقط):", "واي فاي الشركة");
    if (label === null) return;
    await addNetwork(ip, label || "واي فاي الشركة");
    toast(`تم اعتماد شبكة الشركة (${ip}) ✅`, "ok");
  };
  showCurrentIP();
  $("#admEnableNotif").onclick = async () => {
    const ok = await askPermission();
    $("#notifState").textContent = notifLabel();
    toast(ok ? "تم التفعيل ✅" : "لم يتم التفعيل", ok ? "ok" : "err");
  };
  $("#admTestNotif").onclick = async () => {
    if (!await askPermission()) return;
    notify("🔔 إشعار تجريبي", "إشعارات نظام الحضور تعمل بنجاح — Spot Light", { tag: "test", sound: "ok" });
  };
}

function paintDevices() {
  const s = ST?.settings || {};
  const tb = $("#devTable tbody");
  tb.innerHTML = devices.map(d => `
    <tr>
      <td>${esc(d.name || "جهاز")}${d.kind ? `<br><span class="sub">${
        d.kind === "phone" ? "هاتف" : d.kind === "tablet" ? "لوحي" : "كمبيوتر"}</span>` : ""}</td>
      <td>${relAr(d.lastSeen)}</td>
      <td><code>${esc(d.id)}</code></td>
      <td>${s.kioskDeviceId === d.id
        ? `<span class="tag t-present">معتمد</span> <button class="mini danger" data-d="off" data-id="${d.id}"><svg class="ico"><use href="#i-close"/></svg> إلغاء</button>`
        : `<button class="mini ok" data-d="on" data-id="${d.id}" data-name="${esc(d.name || "")}"><svg class="ico"><use href="#i-check"/></svg> اعتماد</button>
           <button class="mini danger" data-d="rm" data-id="${d.id}"><svg class="ico"><use href="#i-trash"/></svg> حذف</button>`}</td>
    </tr>`).join("");
  $("#devEmpty").hidden = devices.length > 0;

  tb.querySelectorAll("button[data-d]").forEach(b => b.onclick = async () => {
    if (b.dataset.d === "rm") {
      if (!confirm("حذف هذا الجهاز من القائمة؟ سيظهر من جديد إذا فُتح النظام منه مرة أخرى.")) return;
      await removeDeviceEntry(b.dataset.id);
      toast("تم حذف الجهاز", "ok");
      return;
    }
    if (b.dataset.d === "on") {
      await saveSettings({ kioskDeviceId: b.dataset.id, kioskDeviceName: b.dataset.name });
      toast("تم اعتماد الجهاز لتسجيل الحضور ✅", "ok");
    } else {
      await saveSettings({ kioskDeviceId: "", kioskDeviceName: "" });
      toast("تم إلغاء اعتماد الجهاز", "ok");
    }
  });
}

/* تحديث الإعدادات لحظياً في اللوحة */
document.addEventListener("az:settings", () => { fillSettings(); paintDevices(); });
