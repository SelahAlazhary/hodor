/* ===== نقطة البداية: الإقلاع، الدخول، التوجيه، تثبيت التطبيق ===== */
import { $, $$, LS, toast, esc, normName, deviceId, initials } from "./utils.js";
import { getSettings, watchSettings, watchEmployees, findEmployee, registerDevice,
         bindDevice, consumeBindToken, watchConnection, watchServerClock,
         createPcRequest, watchPcRequest, approvePcRequest, clearPcRequest,
         flush, pendingCount } from "./store.js";
import { askPermission } from "./notify.js";
import { verifyAdmin } from "./auth.js";
import { enhanceTimeInputs } from "./timepicker.js";
import { initEmployee, disposeEmployee } from "./employee.js";
import { initAdmin, disposeAdmin } from "./admin.js";

export const state = {
  settings: null,
  employees: [],
  session: LS.get("az_session", null)   // {role:'employee'|'admin', empId, name}
};

/* ---------- Service Worker ---------- */
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(e => console.warn("SW", e));
  });
}

/* ---------- علامة الاتصال ---------- */
let dbOnline = false;

function paintNet() {
  const pend = pendingCount();
  const offline = !navigator.onLine || !dbOnline;
  const state = offline ? "off" : pend ? "sync" : "on";
  const label = offline ? "غير متصل" : pend ? `رفع ${pend}` : "متصل";
  $$(".conn").forEach(el => {
    el.dataset.state = state;
    el.title = offline
      ? "لا يوجد اتصال — يُحفظ كل شيء على الجهاز ويُرفع تلقائياً عند عودة الإنترنت"
      : pend ? `جارٍ رفع ${pend} عملية محفوظة` : "متصل — كل البيانات محفوظة";
    const b = el.querySelector("b");
    if (b) b.textContent = label;
  });
}
watchConnection(on => { dbOnline = on; paintNet(); });
window.addEventListener("online", () => { flush(); paintNet(); });
window.addEventListener("offline", paintNet);
setInterval(paintNet, 4000);
paintNet();

/* ---------- تثبيت التطبيق ---------- */
let deferredPrompt = null;

/** هل يعمل التطبيق مثبَّتاً (من الشاشة الرئيسية)؟ */
export function isInstalled() {
  return window.matchMedia("(display-mode: standalone)").matches
      || window.matchMedia("(display-mode: fullscreen)").matches
      || window.matchMedia("(display-mode: minimal-ui)").matches
      || navigator.standalone === true
      || document.referrer.startsWith("android-app://");
}
const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
const isPhone = () => /Android|iPad|iPhone|iPod|Mobile/i.test(navigator.userAgent);

/** هل يجب إجبار هذا الجهاز على التثبيت قبل الدخول؟ */
function mustInstall() {
  const s = state.settings || {};
  if (s.forceInstall === false) return false;
  if (isInstalled() || !isPhone()) return false;
  const dev = deviceId();
  if (s.kioskDeviceId && s.kioskDeviceId === dev) return false;   // جهاز الكشك مستثنى
  return true;
}

window.addEventListener("beforeinstallprompt", e => {
  e.preventDefault();
  deferredPrompt = e;
  const b = $("#installBtn"); if (b) b.hidden = false;
  const n = $("#installNow"); if (n) n.hidden = false;
});

async function runInstall() {
  if (deferredPrompt) {
    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    deferredPrompt = null;
    if (outcome === "accepted") { toast("تم تثبيت التطبيق ✅", "ok"); return true; }
    toast("لم يكتمل التثبيت — أعد المحاولة", "err");
    return false;
  }
  // آيفون أو متصفح لا يدعم الطلب المباشر: نعرض الخطوات
  $("#iosSteps").hidden = !isIOS();
  $("#androidSteps").hidden = isIOS();
  toast(isIOS() ? "اتبع الخطوات الظاهرة بالأسفل" : "من قائمة المتصفح اختر: تثبيت التطبيق");
  return false;
}

$("#installBtn")?.addEventListener("click", runInstall);
$("#installNow")?.addEventListener("click", runInstall);
$("#empInstallBtn")?.addEventListener("click", runInstall);

/** يُظهر بطاقة التثبيت داخل شاشة الموظف إن لم يكن التطبيق مثبَّتاً */
export function refreshInstallCard() {
  const card = $("#empInstallCard");
  if (card) card.hidden = isInstalled();
}
$("#installRecheck")?.addEventListener("click", () => {
  if (isInstalled()) { toast("تم التثبيت بنجاح ✅", "ok"); startSession(); }
  else toast("ما زال التطبيق غير مثبَّت — افتحه من أيقونته على الشاشة الرئيسية", "err");
});
$("#installBack")?.addEventListener("click", () => { LS.del("az_session"); state.session = null; go("login"); });

window.addEventListener("appinstalled", () => {
  $("#installBtn").hidden = true;
  refreshInstallCard();
  toast("تم تثبيت التطبيق — افتحه من الشاشة الرئيسية ✅", "ok");
});

/** يعرض شاشة الإلزام بالتثبيت */
function showInstallGate() {
  $("#iosSteps").hidden = !isIOS();
  $("#androidSteps").hidden = isIOS() || !!deferredPrompt;
  $("#installNow").hidden = isIOS();
  go("install");
}

/* ---------- التوجيه ---------- */
export function go(view) {
  $$(".view").forEach(v => v.classList.remove("active"));
  $("#view-" + view)?.classList.add("active");
  window.scrollTo(0, 0);
}

export function logout() {
  disposeEmployee(); disposeAdmin();
  LS.del("az_session");
  state.session = null;
  $("#empNameInput").value = "";
  $("#admPassInput").value = "";
  go("login");
}
$("#admLogout")?.addEventListener("click", () => { if (confirm("تسجيل الخروج من لوحة التحكم؟")) logout(); });

/* الموظف لا يملك زر خروج. مخرج مخصّص للإدارة فقط:
   الضغط المطوّل على الشعار 5 ثوانٍ ثم إدخال كلمة مرور المدير. */
(function adminExit() {
  const logo = $("#empLogoTap");
  if (!logo) return;
  let timer = null;
  const start = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const pass = prompt("خروج إداري — أدخل كلمة مرور المدير:");
      if (pass === null) return;
      const { verifyAdmin } = await import("./auth.js");
      const r = await verifyAdmin(pass, state.settings?.adminPass || null);
      if (r.ok) { toast("تم تسجيل خروج الحساب من هذا الجهاز", "ok"); logout(); }
      else toast("كلمة المرور غير صحيحة", "err");
    }, 5000);
  };
  const cancel = () => clearTimeout(timer);
  ["mousedown", "touchstart"].forEach(ev => logo.addEventListener(ev, start, { passive: true }));
  ["mouseup", "mouseleave", "touchend", "touchcancel"].forEach(ev => logo.addEventListener(ev, cancel, { passive: true }));
})();

/* ---------- تبويبات الدخول ---------- */
$$("#loginTabs .tab").forEach(t => t.addEventListener("click", () => {
  $$("#loginTabs .tab").forEach(x => x.classList.remove("active"));
  t.classList.add("active");
  $("#empLoginForm").classList.toggle("active", t.dataset.tab === "emp");
  $("#admLoginForm").classList.toggle("active", t.dataset.tab === "adm");
  $("#loginError").hidden = true;
}));

function loginError(msg) {
  const el = $("#loginError");
  el.textContent = msg; el.hidden = false;
  setTimeout(() => { el.hidden = true; }, 5000);
}

/* ---------- دخول الموظف (بالاسم فقط) ---------- */
$("#empLoginForm").addEventListener("submit", async e => {
  e.preventDefault();
  const typed = $("#empNameInput").value.trim();
  const phone = $("#empPhoneInput").value.trim();
  if (!typed || !phone) return;
  if (!state.employees.length) { loginError("جارٍ تحميل قائمة الموظفين… حاول بعد لحظات"); return; }

  const { emp, reason } = findEmployee(state.employees, typed, phone);
  if (!emp) {
    loginError(reason === "phone"
      ? "رقم الهاتف لا يطابق الاسم المسجَّل. تأكد من الرقم أو راجع الإدارة."
      : "هذا الاسم غير مسجَّل لدى الإدارة. تأكد من كتابته بشكل صحيح.");
    return;
  }
  if (emp.active === false) { loginError("حسابك موقوف حالياً — راجع الإدارة."); return; }

  // ═══ ربط الحساب بجهاز واحد ═══
  const dev = deviceId();
  const isKiosk = state.settings?.kioskDeviceId && state.settings.kioskDeviceId === dev;
  if (!isKiosk) {
    if (!emp.boundDevice) {
      await bindDevice(emp.id, dev);          // أول جهاز يستخدمه الموظف
    } else if (emp.boundDevice !== dev && emp.pcDevice !== dev) {
      loginError("هذا الحساب مسجَّل على هاتف آخر. لاستخدام هاتف جديد اطلب من الإدارة تحرير الجهاز.");
      return;
    }
  }

  await askPermission(true);
  state.session = { role: "employee", empId: emp.id, name: emp.name };
  LS.set("az_session", state.session);
  $("#empPhoneInput").value = "";
  startSession();
});

/* اقتراح الأسماء أثناء الكتابة */
$("#empNameInput").addEventListener("input", e => {
  const k = normName(e.target.value);
  const box = $("#empSuggest");
  box.innerHTML = "";
  if (k.length < 1) return;
  state.employees.filter(x => x.active !== false && normName(x.name).includes(k)).slice(0, 5)
    .forEach(x => {
      const b = document.createElement("button");
      b.type = "button"; b.textContent = x.name;
      b.onclick = () => { $("#empNameInput").value = x.name; box.innerHTML = ""; };
      box.appendChild(b);
    });
});

/* ---------- دخول المدير ---------- */
$("#admLoginForm").addEventListener("submit", async e => {
  e.preventDefault();
  const pass = $("#admPassInput").value;
  const btn = e.target.querySelector('button[type="submit"]');
  const label = btn.textContent;
  btn.disabled = true; btn.textContent = "جارٍ التحقق…";
  try {
    const s = state.settings || await getSettings();
    const r = await verifyAdmin(pass, s.adminPass || null);
    if (!r.ok) { loginError("كلمة المرور غير صحيحة"); return; }
  } catch (err) {
    loginError("تعذّر التحقق — تأكد من الاتصال بالإنترنت"); return;
  } finally {
    btn.disabled = false; btn.textContent = label;
  }
  await askPermission(true);
  state.session = { role: "admin", name: "المدير" };
  LS.set("az_session", state.session);
  startSession();
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && state.session?.role === "employee"
      && $("#view-install")?.classList.contains("active") && isInstalled()) {
    startSession();
  }
});

/* ---------- إظهار/إخفاء كلمة المرور ---------- */
document.addEventListener("click", e => {
  const b = e.target.closest("[data-pw]");
  if (!b) return;
  const inp = document.getElementById(b.dataset.pw);
  if (!inp) return;
  inp.type = inp.type === "password" ? "text" : "password";
  b.title = inp.type === "password" ? "إظهار كلمة المرور" : "إخفاء كلمة المرور";
});

/* ---------- بدء الجلسة ---------- */
export function startSession() {
  const s = state.session;
  if (!s) { go("login"); return; }
  if (s.role === "admin") { disposeEmployee(); go("admin"); initAdmin(state); }
  else {
    if (mustInstall()) { showInstallGate(); return; }
    const emp = state.employees.find(e => e.id === s.empId);
    if (!emp && state.employees.length) { toast("لم يعد حسابك موجوداً", "err"); logout(); return; }
    const me = emp || { id: s.empId, name: s.name };
    const av = $("#empAvatar");
    if (av) av.textContent = initials(me.name);
    refreshInstallCard();
    disposeAdmin(); go("emp"); initEmployee(state, me);
  }
}

/* ---------- دخول الكمبيوتر بمسح رمز من الهاتف ---------- */
const isPC = () => !/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
let unsubPc = null;

/** يعرض رمز الدخول على الكمبيوتر وينتظر موافقة الهاتف */
async function startPcLogin() {
  if (!isPC()) return;
  $("#pcLoginPane").hidden = false;
  $("#empLoginForm").classList.remove("active");
  const img = $("#pcQrImg"), st = $("#pcQrState");
  st.className = "pill pill-idle"; st.textContent = "جارٍ تجهيز الرمز…";
  img.removeAttribute("src");
  try {
    const pcId = deviceId();
    const code = await createPcRequest(pcId);
    const link = `${location.origin}${location.pathname}?pc=${pcId}.${code}`;
    img.src = `/api/qr?text=${encodeURIComponent(link)}&scale=6`;
    $("#pcCodeText").textContent = code;
    st.textContent = "بانتظار المسح من هاتفك…";

    unsubPc?.();
    unsubPc = watchPcRequest(pcId, async l => {
      if (!l || l.status !== "approved" || !l.empId) return;
      const emp = state.employees.find(e => e.id === l.empId);
      if (!emp) return;
      unsubPc?.(); unsubPc = null;
      await clearPcRequest(pcId);
      st.className = "pill pill-in"; st.textContent = `تم الربط — أهلاً ${emp.name}`;
      state.session = { role: "employee", empId: emp.id, name: emp.name };
      LS.set("az_session", state.session);
      await askPermission(true);
      setTimeout(startSession, 600);
    });
  } catch (e) {
    st.className = "pill pill-abs";
    st.textContent = "تعذّر تجهيز الرمز — تأكد من الاتصال بالإنترنت";
  }
}

$("#pcQrRefresh")?.addEventListener("click", startPcLogin);
$("#pcUseForm")?.addEventListener("click", () => {
  $("#pcLoginPane").hidden = true;
  $("#empLoginForm").classList.add("active");
  unsubPc?.(); unsubPc = null;
});

/** على الهاتف: تأكيد ربط الكمبيوتر بعد مسح الرمز */
function askPcApproval(pcId, code) {
  const modal = $("#pcApproveModal");
  const msg = $("#pcApproveMsg");
  const emp = state.employees.find(e => e.id === state.session?.empId);
  modal.hidden = false;
  if (!emp) {
    $("#pcApproveText").textContent = "سجّل دخولك على هذا الهاتف أولاً ثم أعد مسح الرمز.";
    $("#pcApproveYes").hidden = true;
    return;
  }
  $("#pcApproveText").textContent =
    `هل تريد ربط جهاز الكمبيوتر بحساب ${emp.name}؟ سيعمل حسابك على الهاتف والكمبيوتر معاً.`;
  $("#pcApproveYes").onclick = async () => {
    $("#pcApproveYes").disabled = true;
    const r = await approvePcRequest(pcId, code, emp);
    $("#pcApproveYes").disabled = false;
    if (!r.ok) { msg.textContent = r.error; msg.className = "alert error"; msg.hidden = false; return; }
    msg.textContent = "تم ربط الكمبيوتر ✅ افتح الشاشة عليه الآن";
    msg.className = "alert ok"; msg.hidden = false;
    toast("تم ربط جهاز الكمبيوتر بحسابك ✅", "ok");
    setTimeout(() => { modal.hidden = true; msg.hidden = true; }, 2500);
  };
  $("#pcApproveNo").onclick = $("#pcApproveClose").onclick = () => { modal.hidden = true; };
}

/* ---------- ربط الجهاز عبر رمز QR ---------- */
async function handleBindLink(token) {
  const r = await consumeBindToken(token);
  if (!r.ok) { toast(r.error, "err"); go("login"); return; }
  const emp = state.employees.find(e => e.id === r.empId);
  if (!emp) { toast("لم يعد هذا الموظف موجوداً", "err"); go("login"); return; }
  if (emp.active === false) { toast("حساب الموظف موقوف", "err"); go("login"); return; }

  await bindDevice(emp.id, deviceId());          // يربط هذا الجهاز بالحساب
  await askPermission(true);
  state.session = { role: "employee", empId: emp.id, name: emp.name };
  LS.set("az_session", state.session);
  toast(`تم ربط هذا الجهاز بحساب ${emp.name} ✅`, "ok");
  startSession();
}

/* ---------- الإقلاع ---------- */
(function boot() {
  // شبكة أمان: تُعرَض الواجهة خلال 3 ثوانٍ مهما كانت حالة الاتصال
  let started = false;
  const showUI = () => {
    if (started) return;
    started = true;
    state.session ? startSession() : go("login");
    hideBoot();
  };
  const fallback = setTimeout(showUI, 3000);
  enhanceTimeInputs();                       // حقول الوقت بالعربية (صباحاً/مساءً)

  watchServerClock();            // مزامنة الوقت مع الساعة العالمية
  registerDevice().catch(() => {});

  // الإعدادات (مباشر)
  watchSettings(s => {
    state.settings = s;
    document.title = `${s.company || "Spot Light"} — الحضور والانصراف`;
    document.dispatchEvent(new CustomEvent("az:settings", { detail: s }));
  });
  getSettings().then(s => { if (!state.settings) state.settings = s; }).catch(() => {});

  const qs = new URLSearchParams(location.search);
  const bindToken = qs.get("bind");
  const pcParam = qs.get("pc");
  if (bindToken || pcParam) history.replaceState({}, "", location.pathname);

  // الموظفون (مباشر)
  watchEmployees(list => {
    state.employees = list;
    const dl = $("#empNamesList");
    dl.innerHTML = list.filter(e => e.active !== false)
      .map(e => `<option value="${esc(e.name)}"></option>`).join("");
    document.dispatchEvent(new CustomEvent("az:employees", { detail: list }));

    // إن حرّرت الإدارة الجهاز أو أوقفت الحساب يُغلق التطبيق تلقائياً
    if (state.session?.role === "employee") {
      const me = list.find(e => e.id === state.session.empId);
      const dev = deviceId();
      const kiosk = state.settings?.kioskDeviceId === dev;
      const known = me && (me.boundDevice === dev || me.pcDevice === dev);
      if (me && !kiosk && me.boundDevice && !known) {
        toast("تم نقل حسابك إلى جهاز آخر", "err");
        setTimeout(logout, 1500);
      } else if (me && me.active === false) {
        toast("تم إيقاف حسابك — راجع الإدارة", "err");
        setTimeout(logout, 1500);
      }
    }

    clearTimeout(fallback);
    if (bindToken && !started) { started = true; hideBoot(); handleBindLink(bindToken); return; }
    showUI();
    if (pcParam) {
      const [pcId, code] = String(pcParam).split(".");
      if (pcId && code) askPcApproval(pcId, code);
    } else if (isPC() && !state.session) {
      startPcLogin();                          // الكمبيوتر يعرض رمز الدخول مباشرة
    }
  });
})();

function hideBoot() {
  const b = $("#boot");
  if (!b || b.classList.contains("hide")) return;
  b.classList.add("hide");
  setTimeout(() => b.remove(), 400);
}
