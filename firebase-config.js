// firebase-config.js
// Uses the same Firebase project as your other Quantum9X apps (personal-task-manager-4e017),
// with a new Firestore collection "medvaani_scans" dedicated to this project.

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getFirestore,
  collection,
  addDoc,
  serverTimestamp,
  query,
  orderBy,
  limit,
  getDocs,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyBoKjM0VOfRU7O_qCHGgOVXVwJxq0DQtvY",
  authDomain: "personal-task-manager-4e017.firebaseapp.com",
  projectId: "personal-task-manager-4e017",
  storageBucket: "personal-task-manager-4e017.firebasestorage.app",
  messagingSenderId: "875733171949",
  appId: "1:875733171949:web:0eda6cb86b650cbe8116e4",
  measurementId: "G-0W8SDLHSWB",
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

const SCANS_COLLECTION = "medvaani_scans";

/**
 * Save a completed scan to Firestore.
 * Called after a successful translation, so history reflects real completed scans.
 */
export async function saveScan({ originalText, translatedText, langCode, dangerLevel, warnings }) {
  try {
    await addDoc(collection(db, SCANS_COLLECTION), {
      originalText,
      translatedText,
      langCode,
      dangerLevel,
      warnings,
      createdAt: serverTimestamp(),
    });
  } catch (err) {
    // Non-fatal: history saving should never block the core user flow
    console.error("Failed to save scan to Firestore:", err);
  }
}

/**
 * Fetch the most recent scans (default: last 10) for the history view.
 */
export async function getRecentScans(count = 10) {
  try {
    const q = query(collection(db, SCANS_COLLECTION), orderBy("createdAt", "desc"), limit(count));
    const snapshot = await getDocs(q);
    return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  } catch (err) {
    console.error("Failed to fetch scan history:", err);
    return [];
  }
}