// ════════════════════════════════════════════════════════════════
//  app.js — queue engine wired to Firestore with real-time listeners
// ════════════════════════════════════════════════════════════════

import { db }         from "./firebase.js";
import { requireAuth, logOut } from "./auth.js";
import {
  collection, doc, addDoc, updateDoc, deleteDoc,
  onSnapshot, query, orderBy, where,
  serverTimestamp, getDoc, setDoc, increment
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ── GLOBALS ──────────────────────────────────────────────────────
let currentUser    = null;   // Firebase Auth user object
let currentProfile = null;   // { uid, name, email, role }
let isUrdu         = false;  // language toggle state

// Active onSnapshot unsubscribe handles (so we can clean them up)
const listeners = [];

// ════════════════════════════════════════════════════════════════
//  BOOT — runs once the page is loaded
// ════════════════════════════════════════════════════════════════
async function boot() {
  // requireAuth() redirects to index.html if nobody is logged in
  const { user, profile } = await requireAuth();
  currentUser    = user;
  currentProfile = profile;

  // Greet the user
  document.querySelectorAll(".user-name-display").forEach(el => {
    el.textContent = profile.name;
  });

  // Show only the nav tabs the user's role is allowed to see
  applyRoleVisibility(profile.role);

  // Always default to the correct starting panel for this role
  const defaultPanel = {
    patient:      "patient",
    receptionist: "receptionist",
    doctor:       "doctor"
  }[profile.role] || "patient";
  showPanel(defaultPanel);

  // Attach logout handler
  document.getElementById("logout-btn").addEventListener("click", async () => {
    // Remove all Firestore listeners before logging out
    listeners.forEach(unsub => unsub());
    await logOut();
  });
}

// ── ROLE VISIBILITY ──────────────────────────────────────────────
function applyRoleVisibility(role) {
  // Hide tabs the user shouldn't see
  document.querySelectorAll("[data-role-required]").forEach(el => {
    const allowed = el.dataset.roleRequired.split(",");
    el.style.display = allowed.includes(role) ? "" : "none";
  });
}

// ════════════════════════════════════════════════════════════════
//  PANEL SWITCHING
// ════════════════════════════════════════════════════════════════
function showPanel(id) {
  document.querySelectorAll(".panel").forEach(p => p.classList.remove("active"));
  document.querySelectorAll(".nav-tab").forEach(t => t.classList.remove("active"));

  const panel = document.getElementById("panel-" + id);
  const tab   = document.querySelector(`[data-panel="${id}"]`);
  if (panel) panel.classList.add("active");
  if (tab)   tab.classList.add("active");

  // Start the relevant real-time listeners for this panel
  attachListeners(id);
}

// Expose globally so onclick="" attributes in HTML can call it
window.showPanel = showPanel;

// ════════════════════════════════════════════════════════════════
//  REAL-TIME LISTENERS  (onSnapshot)
// ════════════════════════════════════════════════════════════════
function attachListeners(panelId) {
  // Unsubscribe ALL existing listeners whenever we switch panels
  // to avoid duplicates
  listeners.forEach(unsub => unsub());
  listeners.length = 0;

  // Every panel needs queue + patient data
  listeners.push(listenToQueue());
  listeners.push(listenToPatients());
}

// ── Listen to ALL queues (one per doctor) ───────────────────────
function listenToQueue() {
  return onSnapshot(collection(db, "queues"), (snap) => {
    snap.forEach(docSnap => {
      const data = docSnap.data();
      updateQueueUI(docSnap.id, data);
    });
  });
}

// ── Listen to patients collection, ordered by timestamp ─────────
// NOTE: We query ALL patients (no where-filter here) so we don't need
// a composite index. We filter by status client-side instead.
function listenToPatients() {
  const q = query(
    collection(db, "patients"),
    orderBy("timestamp", "asc")
  );
  return onSnapshot(q, (snap) => {
    const patients = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    updateAllPanels(patients);
  });
}

// ════════════════════════════════════════════════════════════════
//  QUEUE UI UPDATE (called from snapshot listener)
// ════════════════════════════════════════════════════════════════
function updateQueueUI(doctorId, queueData) {
  const { currentToken, isPaused, doctorStatus } = queueData;

  // Update display screen now-serving number
  const displayEl = document.getElementById("display-number");
  if (displayEl) displayEl.textContent = formatToken(currentToken);

  // Update receptionist panel now-serving
  const recNow = document.getElementById("rec-now-serving");
  if (recNow) recNow.textContent = formatToken(currentToken);

  // Update patient status panel now-serving
  const nowServing = document.getElementById("now-serving");
  if (nowServing) nowServing.textContent = formatToken(currentToken);

  // Update pause button label
  const pauseBtn = document.getElementById("pause-btn");
  if (pauseBtn) {
    if (isPaused) {
      pauseBtn.textContent = "▶ Resume Queue";
      pauseBtn.style.color = "var(--success)";
      pauseBtn.style.borderColor = "var(--success)";
    } else {
      pauseBtn.textContent = "⏸ Pause Queue";
      pauseBtn.style.color = "var(--warn)";
      pauseBtn.style.borderColor = "var(--warn)";
    }
  }

  // Doctor status badge (receptionist + display panels)
  updateDoctorStatusBadge(doctorId, doctorStatus);

  // Break alert for patient panel
  const breakAlert = document.getElementById("break-alert");
  if (breakAlert) breakAlert.style.display = doctorStatus === "break" ? "block" : "none";
}

function updateDoctorStatusBadge(doctorId, status) {
  // Map status → styles
  const configs = {
    available:   { cls: "status-available", dot: "dot-green", label: "Available" },
    break:       { cls: "status-break",     dot: "dot-yellow",label: "On Break" },
    unavailable: { cls: "status-unavailable",dot: "dot-red", label: "Done for Day" }
  };
  const cfg = configs[status] || configs.available;

  // Doctor names map
  const doctorNames = {
    imran: "Dr. Imran Ali",
    nadia: "Dr. Nadia Khan",
    tariq: "Dr. Tariq Hassan"
  };
  const name = doctorNames[doctorId] || "Doctor";

  const ids = ["rec-doc-badge", "pat-doctor-badge", "display-doc-status"];
  ids.forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.className = `doctor-status ${cfg.cls}`;
    el.innerHTML = `<div class="status-dot ${cfg.dot}"></div><span>${name} — ${cfg.label}</span>`;
  });

  const recTxt = document.getElementById("rec-doc-status-text");
  if (recTxt) recTxt.textContent = `${name} — ${cfg.label}`;
}

// ════════════════════════════════════════════════════════════════
//  PATIENT-LIST DRIVEN UI
// ════════════════════════════════════════════════════════════════
const CONSULT_MINS = 2; // average minutes per consultation

function updateAllPanels(patients) {
  const waiting = patients.filter(p => p.status === "waiting");
  const serving = patients.filter(p => p.status === "serving");
  const done    = patients.filter(p => p.status === "done").length;

  updateReceptionDash(patients, waiting, done);
  updateDoctorPanel(serving, waiting, done);
  updateDisplayScreen(waiting, serving);
  updatePatientStatusPanel(waiting);
}

function updateReceptionDash(all, waiting, done) {
  safeSet("rec-total",   all.length);
  safeSet("rec-waiting", waiting.length);
  safeSet("rec-served",  done);
  safeSet("rec-avg",     `${CONSULT_MINS}m`);
  safeSet("waiting-count", waiting.length);

  // Current patient
  const curr = waiting[0];
  const recCurr = document.getElementById("rec-current-patient");
  if (recCurr) recCurr.textContent = curr ? `${curr.name} — ${curr.phone}` : "—";

  // Waiting list
  const list  = document.getElementById("waiting-list");
  const empty = document.getElementById("empty-list-msg");
  if (!list) return;
  list.innerHTML = "";
  if (empty) empty.style.display = waiting.length === 0 ? "block" : "none";

  waiting.forEach((p, i) => {
    const li = document.createElement("li");
    li.className = "queue-item" + (i === 0 ? " current" : "");
    li.innerHTML = `
      <span class="qi-token">${formatToken(p.tokenNumber)}</span>
      <span class="qi-name">${p.name}</span>
      <span class="qi-wait">~${(i + 1) * CONSULT_MINS}m</span>
    `;
    list.appendChild(li);
  });
}

function updateDoctorPanel(serving, waiting, done) {
  safeSet("doc-waiting", waiting.length);
  safeSet("doc-done",    done);

  const curr     = serving[0];
  const emptyEl  = document.getElementById("doc-current-empty");
  const currEl   = document.getElementById("doc-current-patient");

  if (curr && currEl && emptyEl) {
    emptyEl.style.display = "none";
    currEl.style.display  = "block";
    safeSet("doc-token", formatToken(curr.tokenNumber));
    safeSet("doc-name",  curr.name);
    safeSet("doc-phone", curr.phone);
    const waited = curr.timestamp
      ? Math.round((Date.now() - curr.timestamp.toDate().getTime()) / 60000)
      : 0;
    safeSet("doc-wait-display", `Waited: ~${waited} min`);
  } else if (emptyEl && currEl) {
    emptyEl.style.display = "block";
    currEl.style.display  = "none";
  }

  // Next-in-queue list for doctor
  const docList  = document.getElementById("doc-queue-list");
  const docEmpty = document.getElementById("doc-empty-msg");
  if (!docList) return;
  docList.innerHTML = "";
  const next = waiting.slice(0, 5);
  if (docEmpty) docEmpty.style.display = next.length === 0 ? "block" : "none";

  next.forEach((p, i) => {
    const li = document.createElement("li");
    li.className = "queue-item";
    li.innerHTML = `
      <span class="qi-token">${formatToken(p.tokenNumber)}</span>
      <span class="qi-name">${p.name}</span>
      <span class="qi-wait">~${(i + 2) * CONSULT_MINS}m</span>
    `;
    docList.appendChild(li);
  });
}

function updateDisplayScreen(waiting, serving) {
  const nextArea = document.getElementById("display-next");
  if (nextArea) {
    nextArea.innerHTML = "";
    waiting.slice(0, 3).forEach(p => {
      const div = document.createElement("div");
      div.className = "display-next-token";
      div.textContent = formatToken(p.tokenNumber);
      nextArea.appendChild(div);
    });
  }
  // Show currently-serving token on the big display screen
  const displayNum = document.getElementById("display-number");
  if (displayNum) {
    const curr = serving && serving[0];
    displayNum.textContent = curr ? formatToken(curr.tokenNumber) : "—";
  }
  safeSet("display-waiting", waiting.length);
  safeSet("display-avg", `~${waiting.length * CONSULT_MINS} min`);
}

function updatePatientStatusPanel(waiting) {
  // my-token-live is set separately when patient gets a token
  const myToken = sessionStorage.getItem("myToken");
  if (!myToken) return;

  safeSet("my-token-live", myToken);

  const myNum  = parseInt(myToken.replace(/^A-0*/, ""), 10);
  const myIdx = waiting.findIndex(p => p.tokenNumber === myNum);
  const ahead = myIdx >= 0 ? myIdx : 0;
  safeSet("status-ahead-text", `${ahead} people ahead`);
  safeSet("status-wait-text",  `~${ahead * CONSULT_MINS} min`);

  // Upcoming tokens
  const upcomingArea = document.getElementById("upcoming-tokens");
  if (upcomingArea) {
    upcomingArea.innerHTML = "";
    waiting.slice(0, 5).forEach(p => {
      const tok = formatToken(p.tokenNumber);
      const isMe = tok === myToken;
      const span = document.createElement("span");
      span.className = `badge ${isMe ? "badge-accent" : "badge-primary"}`;
      span.textContent = tok + (isMe ? " 👈 You" : "");
      upcomingArea.appendChild(span);
    });
  }
}

// ════════════════════════════════════════════════════════════════
//  FIRESTORE WRITE OPERATIONS
// ════════════════════════════════════════════════════════════════

// ── Ensure a queue document exists for a doctor ─────────────────
async function ensureQueueDoc(doctorId) {
  const ref  = doc(db, "queues", doctorId);
  const snap = await getDoc(ref);
  if (!snap.exists()) {
    await setDoc(ref, {
      doctorId,
      currentToken: 0,
      isPaused:     false,
      doctorStatus: "available"
    });
  }
  return ref;
}

// ── GENERATE TOKEN (patient self-registration) ───────────────────
window.generateToken = async function () {
  const name       = document.getElementById("pat-name").value.trim();
  const phone      = document.getElementById("pat-phone").value.trim();
  const doctorSel  = document.getElementById("pat-doctor");
  const doctorId   = doctorSel.value;
  const doctorLabel= doctorSel.options[doctorSel.selectedIndex].text;

  if (!name || !phone) {
    toast("⚠️ Please enter your name and phone number.", "warn"); return;
  }
  if (!/^0[0-9]{3}[-\s]?[0-9]{7}$/.test(phone.replace(/\s/g, ""))) {
    toast("⚠️ Phone format: 0311-1234567", "warn"); return;
  }

  try {
    // Get next token number by incrementing the queue doc counter
    const qRef = await ensureQueueDoc(doctorId);
    await updateDoc(qRef, { currentToken: increment(1) });
    const qSnap = await getDoc(qRef);
    const tokenNumber = qSnap.data().currentToken;

    // Add patient record
    await addDoc(collection(db, "patients"), {
      tokenNumber,
      name,
      phone,
      doctorId,
      status:    "waiting",
      timestamp: serverTimestamp()
    });

    const tokenStr = formatToken(tokenNumber);

    // Persist token in session so status panel can highlight "You"
    sessionStorage.setItem("myToken", tokenStr);

    // Count how many are ahead (already-waiting patients for same doctor)
    const queueSnap = await new Promise(res => {
      const unsub = onSnapshot(
        query(collection(db, "patients"), orderBy("timestamp", "asc")),
        s => { unsub(); res(s); }
      );
    });
    const ahead = queueSnap.docs.filter(
      d => d.data().status === "waiting" && d.data().doctorId === doctorId && d.data().tokenNumber < tokenNumber
    ).length;

    // Show token result card
    safeSet("my-token",           tokenStr);
    safeSet("token-doctor-label", doctorLabel.split("—")[0].trim());
    safeSet("my-token-live",      tokenStr);
    safeSet("ahead-count",        ahead);
    safeSet("wait-time",          ahead * CONSULT_MINS);

    const result = document.getElementById("token-result");
    if (result) result.style.display = "block";

    toast(`🎫 Token ${tokenStr} assigned! SMS sent to ${phone}`, "success");
  } catch (err) {
    console.error("generateToken error:", err);
    toast("❌ Failed to generate token. Please try again.", "danger");
  }
};

// ── RECEPTIONIST: REGISTER PATIENT ──────────────────────────────
window.registerPatient = async function () {
  const name     = document.getElementById("rec-name").value.trim();
  const phone    = document.getElementById("rec-phone").value.trim();
  const doctorId = document.getElementById("rec-doctor").value;

  if (!name || !phone) {
    toast("⚠️ Enter patient name and phone.", "warn"); return;
  }

  try {
    const qRef = await ensureQueueDoc(doctorId);
    await updateDoc(qRef, { currentToken: increment(1) });
    const qSnap = await getDoc(qRef);
    const tokenNumber = qSnap.data().currentToken;

    await addDoc(collection(db, "patients"), {
      tokenNumber,
      name,
      phone,
      doctorId,
      status:    "waiting",
      timestamp: serverTimestamp()
    });

    document.getElementById("rec-name").value  = "";
    document.getElementById("rec-phone").value = "";

    toast(`✅ Token ${formatToken(tokenNumber)} assigned to ${name}.`, "success");
  } catch (err) {
    console.error("registerPatient error:", err);
    toast("❌ Failed to register patient.", "danger");
  }
};

// ── CALL NEXT ────────────────────────────────────────────────────
// Uses orderBy only (no compound where+orderBy) to avoid needing a composite index.
// We filter client-side for status === "waiting".
window.callNext = async function () {
  try {
    const q    = query(collection(db, "patients"), orderBy("timestamp", "asc"));
    const snap = await new Promise(res => {
      const unsub = onSnapshot(q, s => { unsub(); res(s); });
    });

    const waitingDocs = snap.docs.filter(d => d.data().status === "waiting");
    if (waitingDocs.length === 0) { toast("ℹ️ No patients in queue.", "info"); return; }

    const first = waitingDocs[0];
    const firstData = first.data();

    // Mark as serving
    await updateDoc(doc(db, "patients", first.id), { status: "serving" });

    // Also keep the queue doc's currentToken in sync so the display screen updates
    const qRef = doc(db, "queues", firstData.doctorId || "imran");
    await setDoc(qRef, { currentToken: firstData.tokenNumber }, { merge: true });

    toast(`📢 Now serving: ${formatToken(firstData.tokenNumber)} — ${firstData.name}`, "success");
  } catch (err) {
    console.error("callNext error:", err);
    toast("❌ Error calling next patient.", "danger");
  }
};

// ── MARK DONE ────────────────────────────────────────────────────
window.markDone = async function () {
  try {
    const q    = query(collection(db, "patients"), orderBy("timestamp", "asc"));
    const snap = await new Promise(res => {
      const unsub = onSnapshot(q, s => { unsub(); res(s); });
    });

    const servingDocs = snap.docs.filter(d => d.data().status === "serving");
    if (servingDocs.length > 0) {
      await updateDoc(doc(db, "patients", servingDocs[0].id), { status: "done" });
    }
    await window.callNext();
  } catch (err) {
    console.error("markDone error:", err);
    toast("❌ Error marking patient done.", "danger");
  }
};

// ── SKIP CURRENT ─────────────────────────────────────────────────
window.skipCurrent = async function () {
  try {
    const q    = query(collection(db, "patients"), orderBy("timestamp", "asc"));
    const snap = await new Promise(res => {
      const unsub = onSnapshot(q, s => { unsub(); res(s); });
    });

    const waitingDocs = snap.docs.filter(d => d.data().status === "waiting");
    if (waitingDocs.length === 0) return;

    const first = waitingDocs[0];
    await updateDoc(doc(db, "patients", first.id), {
      timestamp: serverTimestamp()
    });

    toast(`⏭ Skipped ${formatToken(first.data().tokenNumber)} — moved to end.`, "warn");
  } catch (err) {
    console.error("skipCurrent error:", err);
    toast("❌ Error skipping patient.", "danger");
  }
};

// ── TOGGLE QUEUE PAUSE ────────────────────────────────────────────
window.toggleQueuePause = async function () {
  try {
    // Try to find any existing queue doc; initialise "imran" as default
    const doctorId = (currentProfile && currentProfile.doctorId) || "imran";
    const qRef  = doc(db, "queues", doctorId);
    // Ensure it exists
    await ensureQueueDoc(doctorId);
    const qSnap = await getDoc(qRef);

    const newPaused = !qSnap.data().isPaused;
    await updateDoc(qRef, { isPaused: newPaused });
    toast(newPaused ? "⏸ Queue paused." : "▶ Queue resumed!", newPaused ? "warn" : "success");
  } catch (err) {
    console.error("toggleQueuePause error:", err);
    toast("❌ Error toggling queue pause.", "danger");
  }
};

// ── SET DOCTOR STATUS ─────────────────────────────────────────────
window.setDoctorStatus = async function (status) {
  try {
    // Update queue doc for the selected/active doctor
    const qRef = doc(db, "queues", "imran");
    await setDoc(qRef, { doctorStatus: status }, { merge: true });

    const labels = {
      available:   "Doctor marked as Available.",
      break:       "Doctor on break. Patients notified.",
      unavailable: "Doctor marked as Done for Day."
    };
    const types = { available: "success", break: "warn", unavailable: "danger" };
    toast(`${labels[status]}`, types[status]);
  } catch (err) {
    console.error("setDoctorStatus error:", err);
    toast("❌ Error updating doctor status.", "danger");
  }
};

// ── DOCTOR BREAK ──────────────────────────────────────────────────
window.doctorBreak = async function () {
  const dur = document.getElementById("break-duration").value;
  await window.setDoctorStatus("break");
  toast(`⏸ Break started (${dur} min). Patients notified.`, "warn");

  const btn = document.getElementById("doc-break-btn");
  if (btn) {
    btn.textContent = `▶ Back from Break (${dur}m)`;
    btn.onclick = async () => {
      await window.setDoctorStatus("available");
      btn.textContent = "⏸ Go on Break (Patients Will Be Notified)";
      btn.onclick = window.doctorBreak;
    };
  }
};

// ── INNER TAB SWITCHING (patient panel) ──────────────────────────
window.patientTab = function (tab) {
  document.querySelectorAll("#patient-inner-tabs .inner-tab").forEach((t, i) => {
    t.classList.toggle("active", (i === 0 && tab === "register") || (i === 1 && tab === "status"));
  });
  const regEl = document.getElementById("patient-register");
  const stEl  = document.getElementById("patient-status");
  if (regEl) regEl.style.display = tab === "register" ? "block" : "none";
  if (stEl)  stEl.style.display  = tab === "status"   ? "block" : "none";
};

// ── LANGUAGE TOGGLE ──────────────────────────────────────────────
window.toggleLang = function () {
  isUrdu = !isUrdu;
  document.body.classList.toggle("urdu-mode", isUrdu);
  document.documentElement.setAttribute("dir", isUrdu ? "rtl" : "ltr");
  document.querySelectorAll(".ur-text").forEach(el => el.style.display = isUrdu ? "block" : "none");
  document.querySelectorAll(".en-text").forEach(el => el.style.display = isUrdu ? "none" : "block");
};

// ── SMS SIMULATOR (unchanged — local only) ───────────────────────
window.smsSimulate = function (keyword) {
  const phone = document.getElementById("sms-phone").value.trim() || "0311-XXXXXXX";
  const chat  = document.getElementById("sms-chat");
  document.getElementById("sms-empty").style.display = "none";

  const outDiv = document.createElement("div");
  outDiv.innerHTML = `<div style="text-align:right; margin:8px 0;">
    <div style="display:inline-block; background:#e9ecef; border-radius:12px 12px 0 12px; padding:10px 14px; font-size:14px; max-width:80%;">${keyword}</div>
    <div style="font-size:11px; color:var(--text-muted); margin-top:2px;">${phone} → OPD-QUEUE</div>
  </div>`;
  chat.appendChild(outDiv);

  setTimeout(() => {
    const replyDiv = document.createElement("div");
    const msgs = {
      TOKEN:  `Assalam u Alaikum! Shifa Hospital OPD. TOKEN request mila. App ko queue mein shamil kar liya gaya hai. — Shifa Hospital`,
      STATUS: `Aapka queue status: Mulahiza farmayein dashboard. — Shifa Hospital`,
      CANCEL: `Aapka token cancel kar diya gaya hai. Shukriya. — Shifa Hospital`,
      HELP:   `Commands:\nTOKEN - Queue join karein\nSTATUS - Apna number check karein\nCANCEL - Token cancel karein\nMadad: 021-1234567`
    };
    replyDiv.innerHTML = `<div style="margin:8px 0;">
      <div class="sms-bubble">${msgs[keyword] || "Unknown command."}</div>
      <div class="sms-sender">OPD-QUEUE → ${phone}</div>
    </div>`;
    chat.appendChild(replyDiv);
    chat.scrollTop = chat.scrollHeight;
  }, 800);
};

// ════════════════════════════════════════════════════════════════
//  HELPERS
// ════════════════════════════════════════════════════════════════

// Format token number as "A-042"
function formatToken(n) {
  if (!n && n !== 0) return "—";
  return "A-" + String(n).padStart(3, "0");
}

// Safe textContent setter (no-op if element not found)
function safeSet(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

// Toast notification
window.toast = function (msg, type = "info") {
  const c = document.getElementById("toast-container");
  if (!c) return;
  const t = document.createElement("div");
  t.className = "toast";
  const colours = { success: "var(--success)", warn: "var(--warn)", danger: "var(--danger)", info: "var(--primary)" };
  t.style.borderLeftColor = colours[type] || colours.info;
  t.textContent = msg;
  c.appendChild(t);
  setTimeout(() => t.remove(), 3500);
};

// ════════════════════════════════════════════════════════════════
//  START
// ════════════════════════════════════════════════════════════════
boot().catch(err => console.error("Boot error:", err));
