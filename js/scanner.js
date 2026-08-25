/* ═══════════ ماسح رمز QR بالكاميرا ═══════════
   يستخدم BarcodeDetector المدمج في المتصفح — بلا أي مكتبات خارجية،
   فيعمل بسرعة وبدون إنترنت. وإن لم يدعمه المتصفح يبقى الإدخال اليدوي للرمز. */

export const scannerSupported = () =>
  typeof window !== "undefined" && "BarcodeDetector" in window;

export const cameraSupported = () =>
  !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);

/**
 * يشغّل الكاميرا ويقرأ أول رمز QR يظهر أمامها.
 * @returns {Promise<function>} دالة لإيقاف المسح وإطفاء الكاميرا
 */
export async function startScan(video, onResult, onError) {
  if (!cameraSupported()) throw new Error("الكاميرا غير متاحة على هذا الجهاز");

  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 } },
    audio: false
  });

  video.srcObject = stream;
  video.setAttribute("playsinline", "");
  await video.play().catch(() => {});

  let stopped = false;
  const stop = () => {
    stopped = true;
    try { stream.getTracks().forEach(t => t.stop()); } catch {}
    try { video.srcObject = null; } catch {}
  };

  if (!scannerSupported()) {
    onError?.("متصفحك لا يدعم قراءة الرموز تلقائياً — أدخل الرمز يدوياً");
    return stop;
  }

  const detector = new BarcodeDetector({ formats: ["qr_code"] });
  const tick = async () => {
    if (stopped) return;
    try {
      const codes = await detector.detect(video);
      if (codes && codes.length) {
        const value = codes[0].rawValue || "";
        if (value) { stop(); onResult(value); return; }
      }
    } catch { /* إطار غير صالح — نكمل */ }
    setTimeout(tick, 220);
  };
  tick();

  return stop;
}

/** يستخرج معرّف الجهاز والرمز من رابط أو نص ممسوح */
export function parsePcCode(text) {
  const raw = String(text || "").trim();
  let value = raw;
  try {
    if (/^https?:\/\//i.test(raw)) value = new URL(raw).searchParams.get("pc") || "";
  } catch {}
  const [pcId, code] = String(value).split(".");
  if (pcId && code) return { pcId, code: code.toUpperCase() };
  // رمز قصير أُدخل يدوياً
  if (/^[A-Z0-9]{4,10}$/i.test(raw)) return { pcId: null, code: raw.toUpperCase() };
  return null;
}
