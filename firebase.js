// ════════════════════════════════════════════════════════════════
//  firebase.js — Firebase initialisation & exported service handles
//  Replace the placeholder values below with your own Firebase
//  project credentials (Firebase Console → Project Settings → SDK)
// ════════════════════════════════════════════════════════════════

import { initializeApp }        from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth }              from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore }         from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ── YOUR FIREBASE PROJECT CONFIG ─────────────────────────────────
// Get this from: Firebase Console → Project Settings → General →
//   Your apps → Web app → SDK setup and configuration
const firebaseConfig = {
  apiKey: "AIzaSyAmFf52OGumh2CTfGMhS0ZGrhblW3C_4pI",
  authDomain: "opdqueue-e965b.firebaseapp.com",
  projectId: "opdqueue-e965b",
  storageBucket: "opdqueue-e965b.firebasestorage.app",
  messagingSenderId: "981180575842",
  appId: "1:981180575842:web:8224b7a9ba73ca7880213b"
};

// Initialise Firebase (runs once)
const app = initializeApp(firebaseConfig);

// Export the two services used throughout the app
export const auth = getAuth(app);
export const db   = getFirestore(app);
