/* ═══════════ صوت التنبيهات ═══════════
   نغمات مولَّدة داخل المتصفح (بلا ملفات صوتية) فتعمل حتى بدون إنترنت،
   وتُصدر صوتاً مسموعاً مع كل إشعار حتى لو كان الهاتف صامتاً على الإشعارات. */

import { LS } from "./utils.js";

let ctx = null;
let unlocked = false;

/** هل صوت التنبيهات مفعّل على هذا الجهاز؟ */
export const soundOn = () => LS.get("az_sound", true) !== false;
export function setSound(on) { LS.set("az_sound", !!on); }

function audio() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
  }
  if (ctx.state === "suspended") ctx.resume().catch(() => {});
  return ctx;
}

/** المتصفحات تمنع الصوت قبل أول تفاعل — نفتح القناة عند أول لمسة */
export function unlockSound() {
  if (unlocked) return;
  unlocked = true;
  const c = audio();
  if (!c) return;
  try {
    const o = c.createOscillator(), g = c.createGain();
    g.gain.value = 0.0001;                       // نغمة صامتة لفتح القناة
    o.connect(g); g.connect(c.destination);
    o.start(); o.stop(c.currentTime + 0.01);
  } catch {}
}
["click", "touchstart", "keydown"].forEach(ev =>
  document.addEventListener(ev, unlockSound, { once: true, passive: true }));

function note(c, freq, at, dur, vol = 0.22, type = "sine") {
  const o = c.createOscillator(), g = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, c.currentTime + at);
  g.gain.setValueAtTime(0.0001, c.currentTime + at);
  g.gain.exponentialRampToValueAtTime(vol, c.currentTime + at + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + at + dur);
  o.connect(g); g.connect(c.destination);
  o.start(c.currentTime + at);
  o.stop(c.currentTime + at + dur + 0.02);
}

/** نغمات مختلفة حسب نوع الحدث */
const TUNES = {
  in:     [[784, 0, .16], [1046, .14, .26]],                    // صعودية — حضور
  out:    [[698, 0, .16], [523, .14, .30]],                     // هبوطية — انصراف
  notice: [[880, 0, .14], [1174, .13, .14], [880, .27, .28]],   // جرس — إشعار إدارة
  warn:   [[440, 0, .18], [392, .20, .18], [349, .40, .34]],    // تحذير
  ok:     [[659, 0, .12], [880, .11, .22]],
};

/** يشغّل نغمة التنبيه */
export function playAlert(kind = "notice") {
  if (!soundOn()) return;
  const c = audio();
  if (!c) return;
  try {
    (TUNES[kind] || TUNES.notice).forEach(([f, at, d]) => note(c, f, at, d));
  } catch {}
}
