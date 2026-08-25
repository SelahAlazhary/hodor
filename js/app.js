/* ===== نقطة البداية: الإقلاع، الدخول، التوجيه، تثبيت التطبيق ===== */
import { $, $$, LS, toast, esc, normName } from "./utils.js";
import { getSettings, watchSettings, watchEmployees, findEmployeeByName, registerDevice,
         watchConnection, flush, pendingCount } from "./store.js";
import { askPermission } from "./notify.js";
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

/* ---------- حالة الشبكة والمزامنة ---------- */
const netbar = $("#netbar");
let dbOnline = false;

function paintNet() {
  const pend = pendingCount();
  if (!navigator.onLine || !dbOnline) {
    netbar.classList.remove("online");
    netbar.innerHTML = `<span class="dot"></span> لا يوجد اتصال — يتم الحفظ على الجهاز${pend ? ` (${pend} عملية بانتظار الرفع)` : ""} وسيُرفع تلقائياً عند عودة الإنترنت`;
    netbar.hidden = false;
  } else if (pend) {
    netbar.classList.add("online");
    netbar.innerHTML = `<span class="dot"></span> جارٍ رفع ${pend} عملية محفوظة…`;
    netbar.hidden = false;
  } else {
    netbar.classList.add("online");
    netbar.innerHTML = '<span class="dot"></span> متصل — كل البيانات محفوظة';
    setTimeout(() => { if (dbOnline && !pendingCount()) netbar.hidden = true; }, 2200);
  }
}
watchConnection(on => { dbOnline = on; paintNet(); });
window.addEventListener("online", () => { flush(); paintNet(); });
window.addEventListener("offline", paintNet);
setInterval(paintNet, 4000);

/* ---------- تثبيت التطبيق ---------- */
let deferredPrompt = null;
window.addEventListener("beforeinstallprompt", e => {
  e.preventDefault();
  deferredPrompt = e;
  const b = $("#installBtn"); if (b) b.hidden = false;
});
$("#installBtn")?.addEventListener("click", async () => {
  if (!deferredPrompt) {
    toast("من قائمة المتصفح اختر: إضافة إلى الشاشة الرئيسية");
    return;
  }
  deferredPrompt.prompt();
  const { outcome } = await deferredPrompt.userChoice;
  if (outcome === "accepted") toast("تم تثبيت التطبيق ✅", "ok");
  deferredPrompt = null;
  $("#installBtn").hidden = true;
});
window.addEventListener("appinstalled", () => { $("#installBtn").hidden = true; });

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
$("#empLogout")?.addEventListener("click", () => { if (confirm("تسجيل الخروج من التطبيق؟")) logout(); });
$("#admLogout")?.addEventListener("click", () => { if (confirm("تسجيل الخروج من لوحة التحكم؟")) logout(); });

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
  if (!typed) return;
  if (!state.employees.length) { loginError("جارٍ تحميل قائمة الموظفين… حاول بعد لحظات"); return; }
  const emp = findEmployeeByName(state.employees, typed);
  if (!emp) { loginError("هذا الاسم غير مسجَّل لدى الإدارة. تأكد من كتابته بشكل صحيح."); return; }
  if (emp.active === false) { loginError("حسابك موقوف حالياً — راجع الإدارة."); return; }
  await askPermission(true);
  state.session = { role: "employee", empId: emp.id, name: emp.name };
  LS.set("az_session", state.session);
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
  const s = state.settings || await getSettings();
  if (pass !== (s.adminPass || "azhari2026")) { loginError("كلمة المرور غير صحيحة"); return; }
  await askPermission(true);
  state.session = { role: "admin", name: "المدير" };
  LS.set("az_session", state.session);
  startSession();
});

/* ---------- بدء الجلسة ---------- */
export function startSession() {
  const s = state.session;
  if (!s) { go("login"); return; }
  if (s.role === "admin") { disposeEmployee(); go("admin"); initAdmin(state); }
  else {
    const emp = state.employees.find(e => e.id === s.empId);
    if (!emp && state.employees.length) { toast("لم يعد حسابك موجوداً", "err"); logout(); return; }
    disposeAdmin(); go("emp"); initEmployee(state, emp || { id: s.empId, name: s.name });
  }
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

  registerDevice().catch(() => {});

  // الإعدادات (مباشر)
  watchSettings(s => {
    state.settings = s;
    document.title = `${s.company || "سلاح الأزهري"} — الحضور والانصراف`;
    document.dispatchEvent(new CustomEvent("az:settings", { detail: s }));
  });
  getSettings().then(s => { if (!state.settings) state.settings = s; }).catch(() => {});

  // الموظفون (مباشر)
  watchEmployees(list => {
    state.employees = list;
    const dl = $("#empNamesList");
    dl.innerHTML = list.filter(e => e.active !== false)
      .map(e => `<option value="${esc(e.name)}"></option>`).join("");
    document.dispatchEvent(new CustomEvent("az:employees", { detail: list }));
    clearTimeout(fallback);
    showUI();
  });
})();

function hideBoot() {
  const b = $("#boot");
  if (!b || b.classList.contains("hide")) return;
  b.classList.add("hide");
  setTimeout(() => b.remove(), 400);
}
