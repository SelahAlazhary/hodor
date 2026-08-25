/* ===== تهيئة Firebase — Realtime Database ===== */
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js";
import {
  getDatabase, ref, get, set, update, remove, push, child,
  onValue, off, query, orderByKey, orderByChild, startAt, endAt, limitToLast,
  serverTimestamp, goOnline, goOffline
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-database.js";

/* عنوان قاعدة البيانات اللحظية.
   ⚠ إن أنشأت القاعدة في منطقة أوروبا فسيكون العنوان بالشكل:
   https://hodor-abfe0-default-rtdb.europe-west1.firebasedatabase.app
   يمكنك تغييره بلا تعديل الكود بفتح الرابط مرة واحدة هكذا:
   https://your-site.vercel.app/?db=https://....firebasedatabase.app  */
const DEFAULT_DB_URL = "https://hodor-abfe0-default-rtdb.firebaseio.com";

function resolveDbUrl() {
  try {
    const p = new URLSearchParams(location.search).get("db");
    if (p) { localStorage.setItem("az_db_url", p); history.replaceState({}, "", location.pathname); return p; }
    return localStorage.getItem("az_db_url") || DEFAULT_DB_URL;
  } catch { return DEFAULT_DB_URL; }
}

export const firebaseConfig = {
  apiKey: "AIzaSyCixzPKpRuQI956_wqhQv_9FuUhG1p0MHQ",
  authDomain: "hodor-abfe0.firebaseapp.com",
  databaseURL: resolveDbUrl(),
  projectId: "hodor-abfe0",
  storageBucket: "hodor-abfe0.firebasestorage.app",
  messagingSenderId: "489309050676",
  appId: "1:489309050676:web:875b5b341319c408733761",
  measurementId: "G-0MWVH2QBPG"
};

export const DB_URL = firebaseConfig.databaseURL;
export const app = initializeApp(firebaseConfig);
export const db = getDatabase(app);

/* مسارات البيانات */
export const PATH = {
  settings:   "settings/global",
  employees:  "employees",
  attendance: "attendance",   // attendance/{YYYY-MM-DD}/{empId}
  messages:   "messages",     // messages/{empId}/{msgId}
  events:     "events",
  devices:    "devices"
};

export {
  ref, get, set, update, remove, push, child,
  onValue, off, query, orderByKey, orderByChild, startAt, endAt, limitToLast,
  serverTimestamp, goOnline, goOffline
};
