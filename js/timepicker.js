/* ═══════════ اختيار الوقت بالعربية (صباحاً / مساءً) ═══════════
   يستبدل حقول الوقت بثلاث قوائم واضحة: الساعة، الدقيقة، صباحاً/مساءً.
   الحقل الأصلي يبقى موجوداً ويحمل القيمة بصيغة 24 ساعة (HH:MM)
   حتى يعمل باقي النظام دون أي تغيير. */

import { $$ } from "./utils.js";

const p2 = n => String(n).padStart(2, "0");
const STEP_MIN = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55];

/** "HH:MM" → { h12, min, ap } */
function parse(v) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(v || "").trim());
  if (!m) return null;
  const H = Math.min(23, Number(m[1])), M = Math.min(59, Number(m[2]));
  return { h12: H % 12 || 12, min: M, ap: H < 12 ? "ص" : "م" };
}
/** { h12, min, ap } → "HH:MM" */
function build24(h12, min, ap) {
  let H = Number(h12) % 12;
  if (ap === "م") H += 12;
  return `${p2(H)}:${p2(Number(min))}`;
}

function makeSelect(cls, options, title) {
  const sel = document.createElement("select");
  sel.className = "tp-sel " + cls;
  sel.title = title;
  for (const o of options) {
    const op = document.createElement("option");
    op.value = o.v; op.textContent = o.t;
    sel.appendChild(op);
  }
  return sel;
}

function enhance(input) {
  if (input.dataset.tpReady) return;
  input.dataset.tpReady = "1";

  const wrap = document.createElement("div");
  wrap.className = "timepick";

  const hours = Array.from({ length: 12 }, (_, i) => ({ v: i + 1, t: String(i + 1) }));
  const mins = STEP_MIN.map(m => ({ v: m, t: p2(m) }));
  const selH = makeSelect("tp-h", hours, "الساعة");
  const selM = makeSelect("tp-m", mins, "الدقيقة");
  const selA = makeSelect("tp-a", [{ v: "ص", t: "صباحاً" }, { v: "م", t: "مساءً" }], "صباحاً أو مساءً");

  wrap.append(selH, document.createTextNode(":"), selM, selA);
  input.parentNode.insertBefore(wrap, input);
  input.classList.add("tp-native");

  const push = () => {
    input.value = build24(selH.value, selM.value, selA.value);
    input.dispatchEvent(new Event("change", { bubbles: true }));
  };
  [selH, selM, selA].forEach(s => s.addEventListener("change", push));

  input._tpSync = () => {
    const p = parse(input.value);
    if (!p) { selH.value = "9"; selM.value = "0"; selA.value = "ص"; return; }
    // دقيقة غير مضمّنة في القائمة (مثل 07) نضيفها مؤقتاً
    if (!STEP_MIN.includes(p.min) && !selM.querySelector(`option[value="${p.min}"]`)) {
      const op = document.createElement("option");
      op.value = p.min; op.textContent = p2(p.min);
      selM.appendChild(op);
    }
    selH.value = String(p.h12);
    selM.value = String(p.min);
    selA.value = p.ap;
  };
  input._tpSync();
}

/** يفعّل الاختيار العربي على كل حقول الوقت */
export function enhanceTimeInputs(root = document) {
  $$('input[type="time"]', root).forEach(enhance);
}

/** يعيد مزامنة القوائم بعد تغيير القيم برمجياً */
export function refreshTimePickers(root = document) {
  $$('input[type="time"]', root).forEach(i => i._tpSync && i._tpSync());
}

/** نص عربي مقروء لقيمة وقت — مثل: 5:30 مساءً */
export function timeLabelAr(v) {
  const p = parse(v);
  return p ? `${p.h12}:${p2(p.min)} ${p.ap === "ص" ? "صباحاً" : "مساءً"}` : "—";
}
