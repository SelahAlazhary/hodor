/* ===== واجهة الموظف ===== */
import {
  $, $$, esc, toast, clockStr, fullDateAr, dateKey, monthKey, dateAr, dayAr,
  timeAr, minToHuman, minToHours, toDate, deviceId, LS
} from "./utils.js";
import {
  checkIn, checkOut, markAbsent, watchRecord, getMonth, summarize,
  sendMessage, watchThread, markThreadRead
} from "./store.js";
import { notify, askPermission, buzz } from "./notify.js";

let ST = null, EMP = null;
let unsubRec = null, unsubChat = null, clockTimer = null;
let today = null, kioskTarget = null, lastMsgCount = 0, chatOpen = false;

export function disposeEmployee() {
  unsubRec?.(); unsubChat?.(); clearInterval(clockTimer);
  unsubRec = unsubChat = clockTimer = null;
  ST = EMP = today = kioskTarget = null;
  chatOpen = false; lastMsgCount = 0;
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
  bindChat();
  applyKiosk();
  watchToday();
  loadHistory();

  document.addEventListener("az:employees", onEmployeesChanged);
  document.addEventListener("az:settings", onSettingsChanged);
}

function onSettingsChanged() { applyKiosk(); paintToday(); }

function onEmployeesChanged(e) {
  const fresh = e.detail.find(x => x.id === EMP?.id);
  if (fresh) { EMP = fresh; $("#empHeadName").textContent = fresh.name; }
  applyKiosk();
}

/* ---------- الساعة ---------- */
function startClock() {
  const tick = () => {
    $("#bigClock").textContent = clockStr();
    $("#bigDate").textContent = fullDateAr();
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
  unsubRec = watchRecord(dateKey(), t.id, rec => { today = rec; paintToday(); });
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

/* ---------- الشات مع المدير ---------- */
function bindChat() {
  const modal = $("#chatModal");
  $("#btnChat").onclick = () => { modal.hidden = false; chatOpen = true; $("#empUnread").hidden = true; markRead(); };
  $("#chatClose").onclick = () => { modal.hidden = true; chatOpen = false; };
  modal.onclick = e => { if (e.target === modal) { modal.hidden = true; chatOpen = false; } };

  $("#empChatForm").onsubmit = async e => {
    e.preventDefault();
    const inp = $("#empChatInput");
    const txt = inp.value.trim(); if (!txt) return;
    inp.value = "";
    await sendMessage(EMP.id, EMP.name, "employee", txt);
  };

  unsubChat?.();
  let msgs = [];
  unsubChat = watchThread(EMP.id, list => {
    msgs = list;
    const box = $("#empChatMsgs");
    box.innerHTML = list.map(m => `
      <div class="msg ${m.from === "employee" ? "me" : "them"}">
        ${esc(m.text)}<time>${timeAr(m.ts)}</time>
      </div>`).join("");
    box.scrollTop = box.scrollHeight;

    const unread = list.filter(m => m.from === "admin" && !m.readByEmp);
    if (chatOpen) { markRead(); $("#empUnread").hidden = true; }
    else if (unread.length) {
      const b = $("#empUnread"); b.textContent = unread.length; b.hidden = false;
      if (list.length > lastMsgCount && lastMsgCount) {
        const last = list[list.length - 1];
        if (last.from === "admin") notify("💬 رسالة من المدير", last.text, { tag: "chat" });
      }
    }
    lastMsgCount = list.length;
  });

  function markRead() { markThreadRead(msgs, "employee"); }
}
