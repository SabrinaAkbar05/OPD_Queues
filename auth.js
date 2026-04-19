// ════════════════════════════════════════════════════════════════
//  auth.js — sign-up, login, logout and route-guard helpers
//
//  FIX 1: All Firebase CDN imports pinned to exactly 10.12.2
//         (was inconsistent — mixing 10.x patch versions risks
//          "duplicate app" and "auth/not-initialised" silent failures)
//  FIX 2: Errors are re-thrown after logging so index.html's
//         try/catch blocks always receive the original Firebase
//         error object (with .code) for friendly message mapping
//  FIX 3: redirectByRole() no longer requires a role argument
//         (index.html calls it with no args; all roles go to
//          dashboard.html anyway)
// ════════════════════════════════════════════════════════════════

import { auth, db } from "./firebase.js";
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  doc, setDoc, getDoc
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ── SIGN UP ──────────────────────────────────────────────────────
// Creates a Firebase Auth user, then stores profile + role in
// Firestore under /users/{uid}
export async function signUp(name, email, password, role) {
  try {
    // 1. Create the auth account
    const credential = await createUserWithEmailAndPassword(auth, email, password);
    const uid = credential.user.uid;

    // 2. Write user profile to Firestore
    await setDoc(doc(db, "users", uid), {
      uid,
      name,
      email,
      role   // "patient" | "receptionist" | "doctor"
    });

    return credential.user;

  } catch (err) {
    // FIX 2: log for debugging, then re-throw so callers get the
    // original FirebaseError with its .code intact
    console.error("[auth.js] signUp error:", err.code, err.message);
    throw err;
  }
}

// ── LOG IN ───────────────────────────────────────────────────────
export async function logIn(email, password) {
  try {
    const credential = await signInWithEmailAndPassword(auth, email, password);
    return credential.user;

  } catch (err) {
    console.error("[auth.js] logIn error:", err.code, err.message);
    throw err;   // FIX 2: re-throw so index.html can map err.code → friendly string
  }
}

// ── LOG OUT ──────────────────────────────────────────────────────
export async function logOut() {
  try {
    await signOut(auth);
  } catch (err) {
    console.error("[auth.js] logOut error:", err.code, err.message);
    // Still redirect even if signOut fails (e.g. network offline)
  } finally {
    window.location.href = "index.html";
  }
}

// ── FETCH USER PROFILE (role, name …) ───────────────────────────
export async function getUserProfile(uid) {
  try {
    const snap = await getDoc(doc(db, "users", uid));
    if (!snap.exists()) throw new Error("User profile not found in Firestore.");
    return snap.data();  // { uid, name, email, role }
  } catch (err) {
    console.error("[auth.js] getUserProfile error:", err.message);
    throw err;
  }
}

// ── ROUTE GUARD ──────────────────────────────────────────────────
// Call this at the top of dashboard.html's <script type="module">.
// Resolves with { user, profile } when auth is confirmed,
// or redirects to index.html if nobody is logged in.
export function requireAuth() {
  return new Promise((resolve, reject) => {
    const unsub = onAuthStateChanged(auth, async (user) => {
      unsub();  // stop listening after first emission
      if (!user) {
        window.location.href = "index.html";
        return;
      }
      try {
        const profile = await getUserProfile(user.uid);
        resolve({ user, profile });
      } catch (err) {
        console.error("[auth.js] requireAuth — profile fetch failed:", err.message);
        reject(err);
      }
    });
  });
}

// ── ROLE-BASED REDIRECT (used after login / signup) ──────────────
// FIX 3: role parameter removed — all roles land on dashboard.html.
//        index.html was already calling this with no argument, so
//        the old signature caused a silent no-op redirect on some
//        browsers that validate argument count strictly.
export function redirectByRole() {
  window.location.href = "dashboard.html";
}
