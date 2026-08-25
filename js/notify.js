/* ===== الإشعارات على الهاتف ===== */
import { toast } from "./utils.js";

const ICON = "./icons/icon-192.png";

export function notifSupported() {
  return "Notification" in window;
}
export function notifState() {
  return notifSupported() ? Notification.permission : "unsupported";
}

/** يطلب إذن الإشعارات (يجب استدعاؤه من نقرة مستخدم) */
export async function askPermission(silent = false) {
  if (!notifSupported()) { if (!silent) toast("المتصفح لا يدعم الإشعارات", "err"); return false; }
  if (Notification.permission === "granted") return true;
  if (Notification.permission === "denied") {
    if (!silent) toast("الإشعارات محظورة — فعّلها من إعدادات المتصفح", "err");
    return false;
  }
  const r = await Notification.requestPermission();
  return r === "granted";
}

/** إشعار على الهاتف (عبر Service Worker حتى يظهر في شريط الإشعارات) */
export async function notify(title, body, opts = {}) {
  try {
    if (!notifSupported() || Notification.permission !== "granted") return false;
    const options = {
      body,
      icon: ICON,
      badge: ICON,
      dir: "rtl",
      lang: "ar",
      tag: opts.tag || "azhari",
      renotify: true,
      requireInteraction: !!opts.sticky,
      vibrate: opts.vibrate || [120, 60, 120],
      data: opts.data || {}
    };
    const reg = await navigator.serviceWorker?.ready.catch(() => null);
    if (reg) await reg.showNotification(title, options);
    else new Notification(title, options);
    return true;
  } catch (e) {
    console.warn("notify failed", e);
    return false;
  }
}

/** اهتزاز خفيف عند نجاح عملية */
export function buzz(pattern = [60, 40, 60]) {
  try { navigator.vibrate?.(pattern); } catch {}
}
