/* ═══════════ مراقبة شاشة الكمبيوتر (لقطات عشوائية) ═══════════
   ملاحظة مهمة: المتصفحات لا تسمح بالتقاط الشاشة سرّاً — لا بد أن يوافق
   الموظف مرة واحدة على مشاركة الشاشة (getDisplayMedia)، ويُظهر المتصفح
   مؤشّراً دائماً بأن الشاشة تُشارَك. بعد الموافقة يلتقط النظام إطاراً
   في أوقات عشوائية ويرسله مصغَّراً ومضغوطاً إلى لوحة الإدارة.
   يعمل على الكمبيوتر فقط.  */

import { db, PATH, ref, set, get, remove, push, onValue,
         query, orderByChild, limitToLast } from "./firebase.js";
import { LS, nowMs, instant } from "./utils.js";

const SHOTS_PATH = "screenshots";      // screenshots/{empId}/{id}
const KEEP = 24;                       // نحتفظ بآخر لقطات فقط لكل موظف

let stream = null, timer = null, ctx = null;
let cfg = null;                        // { empId, empName, minGap, maxGap }

export const isSharing = () => !!stream;

/** يطلب مشاركة الشاشة (يحتاج نقرة من المستخدم) ثم يبدأ الالتقاط العشوائي */
export async function startMonitor({ empId, empName, minGap = 5, maxGap = 20 }) {
  if (stream) return true;
  if (!navigator.mediaDevices?.getDisplayMedia) throw new Error("المتصفح لا يدعم مشاركة الشاشة");

  stream = await navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: 1 }, audio: false,
    // نطلب الشاشة كاملة لا نافذة واحدة
    // @ts-ignore
    preferCurrentTab: false, surfaceSwitching: "exclude", monitorTypeSurfaces: "include"
  });
  cfg = { empId, empName, minGap: Math.max(2, minGap), maxGap: Math.max(minGap + 1, maxGap) };
  LS.set("az_screen_on", true);

  // إن أوقف الموظف المشاركة يدوياً نرصد ذلك ونبلّغ الإدارة
  stream.getVideoTracks()[0].addEventListener("ended", () => {
    stopMonitor(true);
  });

  const v = document.createElement("video");
  v.muted = true; v.srcObject = stream;
  await v.play().catch(() => {});
  ctx = { video: v };

  scheduleNext();
  captureNow().catch(() => {});         // لقطة فورية تؤكد بدء المراقبة
  markState("on");
  return true;
}

/** يوقف المراقبة */
export function stopMonitor(byUser = false) {
  clearTimeout(timer); timer = null;
  try { stream?.getTracks().forEach(t => t.stop()); } catch {}
  stream = null; ctx = null;
  LS.del("az_screen_on");
  if (byUser && cfg) markState("stopped");
}

function scheduleNext() {
  if (!stream) return;
  const { minGap, maxGap } = cfg;
  const secs = minGap + Math.random() * (maxGap - minGap);   // فاصل عشوائي
  timer = setTimeout(async () => {
    await captureNow().catch(() => {});
    scheduleNext();
  }, secs * 1000);
}

async function captureNow() {
  if (!stream || !ctx?.video) return;
  const v = ctx.video;
  const w = v.videoWidth, h = v.videoHeight;
  if (!w || !h) return;
  const scale = Math.min(1, 900 / w);              // نصغّر إلى ~900px عرضاً
  const cw = Math.round(w * scale), ch = Math.round(h * scale);
  const c = document.createElement("canvas");
  c.width = cw; c.height = ch;
  c.getContext("2d").drawImage(v, 0, 0, cw, ch);
  const img = c.toDataURL("image/jpeg", 0.45);     // ضغط قوي لتصغير الحجم
  if (img.length > 200000) return;                 // حماية من الأحجام الكبيرة

  const id = push(ref(db, `${SHOTS_PATH}/${cfg.empId}`)).key;
  await set(ref(db, `${SHOTS_PATH}/${cfg.empId}/${id}`), {
    empId: cfg.empId, empName: cfg.empName,
    at: instant().toISOString(), ts: nowMs(), img
  });
  pruneOld().catch(() => {});
}

/** يحذف اللقطات القديمة ويُبقي آخر KEEP فقط */
async function pruneOld() {
  const snap = await get(query(ref(db, `${SHOTS_PATH}/${cfg.empId}`), orderByChild("ts")));
  const val = snap.val() || {};
  const ids = Object.entries(val).sort((a, b) => (a[1].ts || 0) - (b[1].ts || 0)).map(e => e[0]);
  const extra = ids.length - KEEP;
  for (let i = 0; i < extra; i++) remove(ref(db, `${SHOTS_PATH}/${cfg.empId}/${ids[i]}`)).catch(() => {});
}

/** يسجّل حالة المراقبة في سجل الموظف ليراها المدير */
function markState(state) {
  if (!cfg) return;
  set(ref(db, `${PATH.employees}/${cfg.empId}/screen`), {
    state, at: instant().toISOString(), ts: nowMs()
  }).catch(() => {});
}

/* ───── جانب المدير ───── */
export function watchScreens(empId, cb, n = 12) {
  return onValue(query(ref(db, `${SHOTS_PATH}/${empId}`), orderByChild("ts"), limitToLast(n)),
    s => {
      const v = s.val() || {};
      cb(Object.entries(v).map(([id, x]) => ({ id, ...x })).sort((a, b) => (b.ts || 0) - (a.ts || 0)));
    }, e => console.warn("watchScreens", e.message));
}
export async function clearScreens(empId) {
  await remove(ref(db, `${SHOTS_PATH}/${empId}`)).catch(() => {});
}
