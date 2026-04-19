// ════════════════════════════════════════════════════════════════
//  app.js — queue engine wired to Firestore with real-time listeners
//
//  NEW (Doctor Portal):
//    • boot() hides booking form for doctors (Requirement 1)
//    • updateDoctorPanel() renders a full live appointments table
//      with token, name, age, symptoms, status pill (Requirement 2)
//    • callNext() marks patient "in-consultation"; markDone() marks
//      "completed" then calls next (Requirement 3)
//    • openPatientModal() / openCurrentPatientModal() show briefing
//      with age, symptoms, wait time (Requirement 4)
//    • savePrescription() writes remarks back to Firestore (Requirement 5)
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

// Tracks which patient the modal is currently showing (for prescription save)
let modalPatientId = null;

// Active onSnapshot unsubscribe handles (so we can clean them up)
const listeners = [];

// ════════════════════════════════════════════════════════════════
//  BOOT — runs once the page is loaded
// ════════════════════════════════════════════════════════════════
async function boot() {
  const { user, profile } = await requireAuth();
  currentUser    = user;
  currentProfile = profile;

  // Greet the user
  document.querySelectorAll(".user-name-display").forEach(el => {
    el.textContent = profile.name;
  });

  // Show only the nav tabs the user's role is allowed to see
  applyRoleVisibility(profile.role);

  // ── REQUIREMENT 1: Hide booking form for doctors ──────────────
  // Doctors land on the Patient panel but should NOT see the booking form.
  // We hide the inner tab strip and the register form, then
  // jump straight to the status sub-panel.
  if (profile.role === "doctor") {
    const tabsWrap = document.getElementById("patient-inner-tabs-wrap");
    const registerPane = document.getElementById("patient-register");
    if (tabsWrap)     tabsWrap.style.display = "none";
    if (registerPane) registerPane.style.display = "none";
    // Show the status view by default for doctors
    const statusPane = document.getElementById("patient-status");
    if (statusPane) statusPane.style.display = "block";
  }

  // Default starting panel per role
  const defaultPanel = {
    patient:      "patient",
    receptionist: "receptionist",
    doctor:       "doctor"
  }[profile.role] || "patient";
  showPanel(defaultPanel);

  // Attach logout handler
  document.getElementById("logout-btn").addEventListener("click", async () => {
    listeners.forEach(unsub => unsub());
    await logOut();
  });
}

// ── ROLE VISIBILITY ──────────────────────────────────────────────
function applyRoleVisibility(role) {
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

  attachListeners(id);
}
window.showPanel = showPanel;

// ════════════════════════════════════════════════════════════════
//  REAL-TIME LISTENERS  (onSnapshot)
// ════════════════════════════════════════════════════════════════
function attachListeners(panelId) {
  listeners.forEach(unsub => unsub());
  listeners.length = 0;

  listeners.push(listenToQueue());
  listeners.push(listenToPatients());
}

function listenToQueue() {
  return onSnapshot(collection(db, "queues"), (snap) => {
    snap.forEach(docSnap => {
      updateQueueUI(docSnap.id, docSnap.data());
    });
  });
}

// Listen to ALL patients ordered by timestamp (no composite index needed)
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

  const displayEl = document.getElementById("display-number");
  if (displayEl) displayEl.textContent = formatToken(currentToken);

  const recNow = document.getElementById("rec-now-serving");
  if (recNow) recNow.textContent = formatToken(currentToken);

  const nowServing = document.getElementById("now-serving");
  if (nowServing) nowServing.textContent = formatToken(currentToken);

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

  updateDoctorStatusBadge(doctorId, doctorStatus);

  const breakAlert = document.getElementById("break-alert");
  if (breakAlert) breakAlert.style.display = doctorStatus === "break" ? "block" : "none";
}

function updateDoctorStatusBadge(doctorId, status) {
  const configs = {
    available:   { cls: "status-available",   dot: "dot-green",  label: "Available" },
    break:       { cls: "status-break",        dot: "dot-yellow", label: "On Break" },
    unavailable: { cls: "status-unavailable",  dot: "dot-red",    label: "Done for Day" }
  };
  const cfg = configs[status] || configs.available;
  const doctorNames = { imran: "Dr. Imran Ali", nadia: "Dr. Nadia Khan", tariq: "Dr. Tariq Hassan" };
  const name = doctorNames[doctorId] || "Doctor";

  ["rec-doc-badge", "pat-doctor-badge", "display-doc-status"].forEach(id => {
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
const CONSULT_MINS = 2;

function updateAllPanels(patients) {
  // "waiting" = in queue, "in-consultation" = with doctor, "completed" = done
  // Support legacy "serving" and "done" field values too
  const waiting     = patients.filter(p => p.status === "waiting");
  const consulting  = patients.filter(p => p.status === "in-consultation" || p.status === "serving");
  const done        = patients.filter(p => p.status === "completed"       || p.status === "done");

  updateReceptionDash(patients, waiting, done.length);
  updateDoctorPanel(consulting, waiting, done.length);
  updateDisplayScreen(waiting, consulting);
  updatePatientStatusPanel(waiting);
}

// ── RECEPTIONIST PANEL ────────────────────────────────────────────
function updateReceptionDash(all, waiting, done) {
  safeSet("rec-total",     all.length);
  safeSet("rec-waiting",   waiting.length);
  safeSet("rec-served",    done);
  safeSet("rec-avg",       `${CONSULT_MINS}m`);
  safeSet("waiting-count", waiting.length);

  const curr    = waiting[0];
  const recCurr = document.getElementById("rec-current-patient");
  if (recCurr) recCurr.textContent = curr ? `${curr.name} — ${curr.phone}` : "—";

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

// ── DOCTOR PANEL (REQUIREMENTS 2, 3, 4) ──────────────────────────
function updateDoctorPanel(consulting, waiting, done) {
  safeSet("doc-waiting",    waiting.length);
  safeSet("doc-consulting", consulting.length);
  safeSet("doc-done",       done);

  const curr     = consulting[0];
  const emptyEl  = document.getElementById("doc-current-empty");
  const currEl   = document.getElementById("doc-current-patient");
  const callBtn  = document.getElementById("doc-call-next-btn");

  if (curr && currEl && emptyEl) {
    emptyEl.style.display = "none";
    currEl.style.display  = "block";
    // Hide the standalone "Call Next" button when someone is already in room
    if (callBtn) callBtn.style.display = "none";

    safeSet("doc-token", formatToken(curr.tokenNumber));
    safeSet("doc-name",  curr.name);
    safeSet("doc-phone", curr.phone || "—");

    const waited = curr.timestamp
      ? Math.round((Date.now() - curr.timestamp.toDate().getTime()) / 60000)
      : 0;
    safeSet("doc-wait-display", `⏱ Waited: ~${waited} min`);

  } else if (emptyEl && currEl) {
    emptyEl.style.display = "block";
    currEl.style.display  = "none";
    if (callBtn) callBtn.style.display = "flex";
  }

  // REQUIREMENT 2: Build appointments table
  // Show ALL patients for today: waiting + in-consultation + completed
  // We use the global snapshot — reconstruct from waiting + consulting + done array
  // via a combined list pulled fresh from the last snapshot.
  // The table is updated here directly.
  buildAppointmentsTable(waiting, consulting);
}

// ── REQUIREMENTS 2: Full appointments table for doctor ────────────
function buildAppointmentsTable(waiting, consulting) {
  const tbody  = document.getElementById("doc-appointments-body");
  const empty  = document.getElementById("doc-appointments-empty");
  if (!tbody) return;

  // Combine all "active" patients: consulting first, then waiting
  const allActive = [...consulting, ...waiting];

  if (allActive.length === 0) {
    tbody.innerHTML = "";
    if (empty) empty.style.display = "block";
    return;
  }
  if (empty) empty.style.display = "none";

  tbody.innerHTML = "";
  allActive.forEach((p) => {
    const isConsulting = p.status === "in-consultation" || p.status === "serving";
    const statusPill   = isConsulting
      ? `<span class="pill pill-consulting">In Room</span>`
      : `<span class="pill pill-waiting">Waiting</span>`;

    const rowClass = isConsulting ? "row-consulting" : "";
    const symptoms = p.symptoms ? escapeHtml(p.symptoms).substring(0, 40) + (p.symptoms.length > 40 ? "…" : "") : "—";
    const age      = p.age ? p.age + " yrs" : "—";

    const tr = document.createElement("tr");
    tr.className = rowClass;
    tr.innerHTML = `
      <td><span style="font-family:var(--font-mono); font-weight:700; color:var(--primary);">${formatToken(p.tokenNumber)}</span></td>
      <td>
        <button class="patient-name-btn" onclick="openPatientModal('${p.id}')">
          ${escapeHtml(p.name)}
        </button>
      </td>
      <td>${age}</td>
      <td style="color:var(--text-muted); font-size:13px;">${symptoms}</td>
      <td>${statusPill}</td>
    `;
    tbody.appendChild(tr);
  });
}

// ── DISPLAY SCREEN ────────────────────────────────────────────────
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
  const displayNum = document.getElementById("display-number");
  if (displayNum) {
    const curr = serving && serving[0];
    displayNum.textContent = curr ? formatToken(curr.tokenNumber) : "—";
  }
  safeSet("display-waiting", waiting.length);
  safeSet("display-avg", `~${waiting.length * CONSULT_MINS} min`);
}

// ── PATIENT STATUS PANEL ─────────────────────────────────────────
function updatePatientStatusPanel(waiting) {
  const myToken = sessionStorage.getItem("myToken");
  if (!myToken) return;

  safeSet("my-token-live", myToken);

  const myNum  = parseInt(myToken.replace(/^A-0*/, ""), 10);
  const myIdx  = waiting.findIndex(p => p.tokenNumber === myNum);
  const ahead  = myIdx >= 0 ? myIdx : 0;
  safeSet("status-ahead-text", `${ahead} people ahead`);
  safeSet("status-wait-text",  `~${ahead * CONSULT_MINS} min`);

  const upcomingArea = document.getElementById("upcoming-tokens");
  if (upcomingArea) {
    upcomingArea.innerHTML = "";
    waiting.slice(0, 5).forEach(p => {
      const tok  = formatToken(p.tokenNumber);
      const isMe = tok === myToken;
      const span = document.createElement("span");
      span.className = `badge ${isMe ? "badge-accent" : "badge-primary"}`;
      span.textContent = tok + (isMe ? " 👈 You" : "");
      upcomingArea.appendChild(span);
    });
  }
}

// ════════════════════════════════════════════════════════════════
//  PATIENT BRIEFING MODAL  (Requirements 4 & 5)
// ════════════════════════════════════════════════════════════════

// Opens modal for any patient row clicked in the appointments table
window.openPatientModal = async function (patientId) {
  try {
    const snap = await getDoc(doc(db, "patients", patientId));
    if (!snap.exists()) { toast("⚠️ Patient record not found.", "warn"); return; }

    const p = snap.data();
    populateModal(patientId, p);
  } catch (err) {
    console.error("openPatientModal error:", err);
    toast("❌ Could not load patient details.", "danger");
  }
};

// Opens modal for the CURRENT in-room patient (button on current patient bar)
window.openCurrentPatientModal = async function () {
  const nameEl = document.getElementById("doc-name");
  if (!nameEl || nameEl.textContent === "—") {
    toast("ℹ️ No patient currently in room.", "info");
    return;
  }
  // Find the in-consultation patient from Firestore
  try {
    const q    = query(collection(db, "patients"), orderBy("timestamp", "asc"));
    const snap = await new Promise(res => {
      const unsub = onSnapshot(q, s => { unsub(); res(s); });
    });
    const consulting = snap.docs.find(d =>
      d.data().status === "in-consultation" || d.data().status === "serving"
    );
    if (!consulting) { toast("ℹ️ No patient currently in consultation.", "info"); return; }
    populateModal(consulting.id, consulting.data());
  } catch (err) {
    console.error("openCurrentPatientModal error:", err);
    toast("❌ Could not load patient details.", "danger");
  }
};

function populateModal(patientId, p) {
  modalPatientId = patientId;

  // Requirement 4: fill in all detail fields
  safeSet("modal-token",  formatToken(p.tokenNumber));
  safeSet("modal-name",   p.name   || "—");
  safeSet("modal-phone",  p.phone  || "—");
  safeSet("modal-age",    p.age    ? p.age + " years" : "Not specified");
  safeSet("modal-status", statusLabel(p.status));

  const waited = p.timestamp
    ? Math.round((Date.now() - p.timestamp.toDate().getTime()) / 60000)
    : null;
  safeSet("modal-waited", waited !== null ? `~${waited} min` : "—");

  const symptomsEl = document.getElementById("modal-symptoms");
  if (symptomsEl) symptomsEl.textContent = p.symptoms || "Not specified";

  // Requirement 5: pre-fill prescription if one already exists
  const rxInput = document.getElementById("modal-prescription");
  if (rxInput) rxInput.value = p.prescription || "";

  // Reset save confirmation
  const savedMsg = document.getElementById("rx-saved-msg");
  if (savedMsg) savedMsg.style.display = "none";

  // Show the modal
  const overlay = document.getElementById("patient-modal-overlay");
  if (overlay) overlay.classList.add("open");
}

// Close when clicking outside the modal box
window.closePatientModal = function (e) {
  if (e.target.id === "patient-modal-overlay") closePatientModalDirect();
};
window.closePatientModalDirect = function () {
  const overlay = document.getElementById("patient-modal-overlay");
  if (overlay) overlay.classList.remove("open");
  modalPatientId = null;
};

// REQUIREMENT 5: Save prescription / remarks back to Firestore
window.savePrescription = async function () {
  if (!modalPatientId) { toast("⚠️ No patient selected.", "warn"); return; }
  const rxInput = document.getElementById("modal-prescription");
  if (!rxInput) return;

  const remarks = rxInput.value.trim();
  if (!remarks) { toast("⚠️ Please type your remarks before saving.", "warn"); return; }

  try {
    await updateDoc(doc(db, "patients", modalPatientId), {
      prescription: remarks,
      prescribedAt: serverTimestamp()
    });
    const savedMsg = document.getElementById("rx-saved-msg");
    if (savedMsg) { savedMsg.style.display = "block"; }
    toast("✅ Prescription saved to patient record.", "success");
  } catch (err) {
    console.error("savePrescription error:", err);
    toast("❌ Failed to save prescription.", "danger");
  }
};

// ════════════════════════════════════════════════════════════════
//  FIRESTORE WRITE OPERATIONS
// ════════════════════════════════════════════════════════════════

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
  const ageInput   = document.getElementById("pat-age");
  const sympInput  = document.getElementById("pat-symptoms");
  const doctorSel  = document.getElementById("pat-doctor");
  const doctorId   = doctorSel.value;
  const doctorLabel= doctorSel.options[doctorSel.selectedIndex].text;
  const age        = ageInput  ? ageInput.value.trim()  : "";
  const symptoms   = sympInput ? sympInput.value.trim() : "";

  if (!name || !phone) {
    toast("⚠️ Please enter your name and phone number.", "warn"); return;
  }
  if (!/^0[0-9]{3}[-\s]?[0-9]{7}$/.test(phone.replace(/\s/g, ""))) {
    toast("⚠️ Phone format: 0311-1234567", "warn"); return;
  }

  try {
    const qRef = await ensureQueueDoc(doctorId);
    await updateDoc(qRef, { currentToken: increment(1) });
    const qSnap = await getDoc(qRef);
    const tokenNumber = qSnap.data().currentToken;

    // Store age + symptoms alongside existing fields
    await addDoc(collection(db, "patients"), {
      tokenNumber,
      name,
      phone,
      age:      age      || null,
      symptoms: symptoms || null,
      doctorId,
      status:    "waiting",
      timestamp: serverTimestamp()
    });

    const tokenStr = formatToken(tokenNumber);
    sessionStorage.setItem("myToken", tokenStr);

    const queueSnap = await new Promise(res => {
      const unsub = onSnapshot(
        query(collection(db, "patients"), orderBy("timestamp", "asc")),
        s => { unsub(); res(s); }
      );
    });
    const ahead = queueSnap.docs.filter(
      d => d.data().status === "waiting" && d.data().doctorId === doctorId && d.data().tokenNumber < tokenNumber
    ).length;

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

// ── CALL NEXT  (REQUIREMENT 3) ────────────────────────────────────
// Marks the next WAITING patient as "in-consultation".
// Status flow: waiting → in-consultation → completed
window.callNext = async function () {
  try {
    const q    = query(collection(db, "patients"), orderBy("timestamp", "asc"));
    const snap = await new Promise(res => {
      const unsub = onSnapshot(q, s => { unsub(); res(s); });
    });

    const waitingDocs = snap.docs.filter(d => d.data().status === "waiting");
    if (waitingDocs.length === 0) { toast("ℹ️ No patients waiting in queue.", "info"); return; }

    const first     = waitingDocs[0];
    const firstData = first.data();

    // REQUIREMENT 3: mark as in-consultation (not just "serving")
    await updateDoc(doc(db, "patients", first.id), { status: "in-consultation" });

    // Keep queue doc in sync for the display screen
    const qRef = doc(db, "queues", firstData.doctorId || "imran");
    await setDoc(qRef, { currentToken: firstData.tokenNumber }, { merge: true });

    toast(`📢 Now calling: ${formatToken(firstData.tokenNumber)} — ${firstData.name}`, "success");
  } catch (err) {
    console.error("callNext error:", err);
    toast("❌ Error calling next patient.", "danger");
  }
};

// ── MARK DONE  (REQUIREMENT 3) ────────────────────────────────────
// Marks current "in-consultation" patient as "completed",
// then immediately calls the next waiting patient.
window.markDone = async function () {
  try {
    const q    = query(collection(db, "patients"), orderBy("timestamp", "asc"));
    const snap = await new Promise(res => {
      const unsub = onSnapshot(q, s => { unsub(); res(s); });
    });

    // REQUIREMENT 3: previous patient → "completed"
    const consultingDocs = snap.docs.filter(
      d => d.data().status === "in-consultation" || d.data().status === "serving"
    );
    if (consultingDocs.length > 0) {
      await updateDoc(doc(db, "patients", consultingDocs[0].id), { status: "completed" });
    }

    // Pull in next waiting patient
    await window.callNext();
  } catch (err) {
    console.error("markDone error:", err);
    toast("❌ Error completing consultation.", "danger");
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
    await updateDoc(doc(db, "patients", first.id), { timestamp: serverTimestamp() });

    toast(`⏭ Skipped ${formatToken(first.data().tokenNumber)} — moved to end.`, "warn");
  } catch (err) {
    console.error("skipCurrent error:", err);
    toast("❌ Error skipping patient.", "danger");
  }
};

// ── TOGGLE QUEUE PAUSE ────────────────────────────────────────────
window.toggleQueuePause = async function () {
  try {
    const doctorId = (currentProfile && currentProfile.doctorId) || "imran";
    const qRef  = doc(db, "queues", doctorId);
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
    const qRef = doc(db, "queues", "imran");
    await setDoc(qRef, { doctorStatus: status }, { merge: true });
    const labels = { available: "Doctor marked as Available.", break: "Doctor on break.", unavailable: "Doctor marked as Done for Day." };
    const types  = { available: "success", break: "warn", unavailable: "danger" };
    toast(labels[status], types[status]);
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

// ── SMS SIMULATOR ─────────────────────────────────────────────────
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

function formatToken(n) {
  if (!n && n !== 0) return "—";
  return "A-" + String(n).padStart(3, "0");
}

function safeSet(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function statusLabel(status) {
  const map = {
    "waiting":         "Waiting",
    "in-consultation": "In Consultation",
    "serving":         "In Consultation",
    "completed":       "Completed",
    "done":            "Completed"
  };
  return map[status] || status || "—";
}

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
