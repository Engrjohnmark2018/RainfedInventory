/* RAINfed-Tagging Alcala — farmer flow: names → built-in geotag camera → submit/sync
 *
 * Camera policy: ONLY the in-app camera (getUserMedia) is allowed — no file/gallery
 * uploads. Every capture is geotagged with the device GPS taken at shutter time;
 * the server stamps that GPS as EXIF into the stored photo.
 *
 * Offline policy: submissions are queued in IndexedDB and auto-synced when
 * the device is back online (page-side sync + Background Sync in the SW).
 */
(function () {
  "use strict";

  /* ---------------- elements ---------------- */
  const stepsBar = document.getElementById("steps-bar");
  const step1 = document.getElementById("step-1");
  const step2 = document.getElementById("step-2");
  const step3 = document.getElementById("step-3");
  const errorBox = document.getElementById("form-error");
  const spinner = document.getElementById("form-spinner");

  const nameForm = document.getElementById("name-form");
  const btnBack = document.getElementById("btn-back");
  const btnSubmit = document.getElementById("btn-submit");
  const btnAgain = document.getElementById("btn-again");

  const connDot = document.getElementById("conn-dot");
  const connText = document.getElementById("conn-text");
  const pendingCount = document.getElementById("pending-count");
  const btnSyncNow = document.getElementById("btn-sync-now");
  const syncStatus = document.getElementById("sync-status");

  const btnOpenCamera = document.getElementById("btn-open-camera");
  const btnShutter = document.getElementById("btn-shutter");
  const btnRetake = document.getElementById("btn-retake");
  const cameraWrap = document.getElementById("camera-wrap");
  const cameraVideo = document.getElementById("camera-video");
  const cameraNote = document.getElementById("camera-note");
  const gpsStatus = document.getElementById("gps-status");
  const photoStatus = document.getElementById("photo-status");
  const previewWrap = document.getElementById("photo-preview-wrap");
  const photoPreview = document.getElementById("photo-preview");

  const MAX_LIVE_ACCURACY_M = 500;
  const GPS_MAX_AGE_MS = 5 * 60 * 1000; // a fix older than 5 min is stale at capture

  const state = {
    firstName: "",
    middleName: "",
    lastName: "",
    address: "",
    photoBlob: null,
    capturedAt: null,
    heading: null,          // live compass heading (deg, 0=N)
    capturedHeading: null,  // heading frozen at shutter time
    liveGps: null,        // {lat, lon, accuracy, at}
    stream: null,
  };

  /* ---------------- small utils ---------------- */
  function uuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
      const r = (Math.random() * 16) | 0;
      return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
    });
  }

  function setStep(n) {
    step1.classList.toggle("hidden", n !== 1);
    step2.classList.toggle("hidden", n !== 2);
    step3.classList.toggle("hidden", n !== 3);
    stepsBar.querySelectorAll(".step").forEach(function (el) {
      const s = Number(el.dataset.step);
      el.classList.toggle("active", s === n);
      el.classList.toggle("done", s < n);
    });
    hideError();
  }

  function showError(msg) {
    errorBox.textContent = msg;
    errorBox.classList.remove("hidden");
  }
  function hideError() {
    errorBox.classList.add("hidden");
    errorBox.textContent = "";
  }

  /* ================= compass (camera overlay) ================= */
  const compassEl = document.getElementById("compass");
  const compassRose = document.getElementById("compass-rose");
  const compassHeadingEl = document.getElementById("compass-heading");
  let compassAttached = false;
  let compassGotReading = false;

  function cardinal(deg) {
    const dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
    return dirs[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
  }

  function updateCompass(heading) {
    if (heading == null || !isFinite(heading)) return;
    heading = ((heading % 360) + 360) % 360;
    state.heading = heading;
    compassGotReading = true;
    compassEl.classList.remove("hidden");
    compassRose.style.transform = "rotate(" + (-heading) + "deg)";
    compassHeadingEl.textContent =
      "🧭 " + cardinal(heading) + " " + Math.round(heading) + "°";
  }

  function onOrientation(e) {
    // iOS Safari exposes webkitCompassHeading; Android/Chrome uses absolute alpha.
    if (typeof e.webkitCompassHeading === "number") {
      updateCompass(e.webkitCompassHeading);
    } else if (e.absolute && e.alpha != null) {
      updateCompass(360 - e.alpha);
    }
  }

  function attachCompass() {
    if (compassAttached) return;
    compassAttached = true;
    // Show the compass immediately so the farmer can see it is active.
    compassEl.classList.remove("hidden");
    compassHeadingEl.textContent = "🧭 kinukuha...";
    window.addEventListener("deviceorientationabsolute", onOrientation, true);
    window.addEventListener("deviceorientation", onOrientation, true);
    // If nothing arrives shortly, tell the farmer the compass is unavailable.
    setTimeout(function () {
      if (!compassGotReading && !cameraWrap.classList.contains("hidden")) {
        compassHeadingEl.textContent = "🧭 N/A";
        compassEl.classList.remove("hidden");
        cameraNote.textContent =
          "ℹ️ Hindi available ang compass sa device/browser na ito — patuloy pa rin ang pagkuha ng geotag na larawan.";
        cameraNote.className = "status-line";
      }
    }, 8000);
  }

  async function requestCompassPermission() {
    if (typeof DeviceOrientationEvent !== "undefined" &&
        typeof DeviceOrientationEvent.requestPermission === "function") {
      try {
        const res = await DeviceOrientationEvent.requestPermission();
        return res === "granted";
      } catch (e) {
        return false;
      }
    }
    return true;
  }

  /* ================= camera (in-app only — no file upload) ================= */
  async function openCamera() {
    cameraNote.textContent = "";
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      cameraNote.textContent =
        "❌ Hindi sinusuportahan ng browser/app ang built-in camera. Gamitin ang mas bagong browser (HTTPS).";
      cameraNote.className = "status-line bad";
      return;
    }
    stopCamera();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false,
      });
      state.stream = stream;
      cameraVideo.srcObject = stream;
      cameraWrap.classList.remove("hidden");
      await cameraVideo.play().catch(function () {});
      btnOpenCamera.classList.add("hidden");
      btnShutter.disabled = false;
      cameraNote.textContent = "Naka-on ang camera. Pindutin ang KUNAN kapag handa na ang kuha.";
      cameraNote.className = "status-line ok";
      // Start the compass alongside the camera (permission prompt on iOS).
      const compassOk = await requestCompassPermission();
      if (compassOk) {
        attachCompass();
      } else {
        compassHeadingEl.textContent = "🧭 N/A";
        compassEl.classList.remove("hidden");
      }
    } catch (err) {
      cameraWrap.classList.add("hidden");
      let msg = "❌ Hindi mabuksan ang camera.";
      if (err && (err.name === "NotAllowedError" || err.name === "SecurityError")) {
        msg = "❌ Tinanggihan ang pahintulot sa camera. I-allow ang camera sa browser/cellphone settings. " +
              "Tanging ang built-in camera ng app ang maaaring gamitin (bawal ang upload).";
      } else if (err && err.name === "NotFoundError") {
        msg = "❌ Walang makitang camera sa device.";
      } else if (err && err.name === "NotReadableError") {
        msg = "❌ Busy ang camera ng ibang app. Isara ito at subukan muli.";
      }
      cameraNote.textContent = msg;
      cameraNote.className = "status-line bad";
    }
  }

  function stopCamera() {
    if (state.stream) {
      state.stream.getTracks().forEach(function (t) { t.stop(); });
      state.stream = null;
    }
    cameraVideo.srcObject = null;
    btnShutter.disabled = true;
    btnOpenCamera.classList.remove("hidden");
    cameraWrap.classList.add("hidden");
  }

  /* ================= GPS ================= */
  function getGpsOnce() {
    return new Promise(function (resolve, reject) {
      if (!navigator.geolocation) {
        reject(new Error("no-geolocation"));
        return;
      }
      navigator.geolocation.getCurrentPosition(
        function (pos) {
          const lat = pos.coords.latitude;
          const lon = pos.coords.longitude;
          const acc = pos.coords.accuracy;
          const notNullIsland = !(Math.abs(lat) < 1e-6 && Math.abs(lon) < 1e-6);
          if (!isFinite(lat) || !isFinite(lon) || !notNullIsland) {
            reject(new Error("invalid"));
            return;
          }
          resolve({ lat: lat, lon: lon, accuracy: acc, at: Date.now() });
        },
        function (err) { reject(err); },
        { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 }
      );
    });
  }

  function renderGps(gps) {
    gpsStatus.textContent =
      "✅ GPS: " + gps.lat.toFixed(6) + ", " + gps.lon.toFixed(6) +
      " (accuracy ≈ " + Math.round(gps.accuracy) + " m)";
    gpsStatus.className = "status-line ok";
  }

  async function ensureFreshGps() {
    const stale = !state.liveGps || (Date.now() - state.liveGps.at) > GPS_MAX_AGE_MS;
    if (!stale) return state.liveGps;
    gpsStatus.textContent = "⏳ Kinukuha ang GPS...";
    gpsStatus.className = "status-line";
    try {
      const gps = await getGpsOnce();
      if (gps.accuracy > MAX_LIVE_ACCURACY_M) {
        gpsStatus.textContent =
          "⚠️ Masyadong malabo ang GPS signal (" + Math.round(gps.accuracy) + " m). " +
          "Lumabas sa open area at subukan muli (kailangan ≤ " + MAX_LIVE_ACCURACY_M + " m).";
        gpsStatus.className = "status-line bad";
        return null;
      }
      state.liveGps = gps;
      renderGps(gps);
      return gps;
    } catch (err) {
      let msg = "❌ Hindi makuha ang GPS.";
      if (err && err.code === 1) {
        msg = "❌ Tinanggihan ang pahintulot sa GPS. I-allow ang Location sa browser/cellphone settings.";
      } else if (err && err.code === 3) {
        msg = "❌ Na-timeout ang GPS. Subukan muli sa open area.";
      }
      gpsStatus.textContent = msg;
      gpsStatus.className = "status-line bad";
      return null;
    }
  }

  /* ================= capture (shutter) ================= */
  async function capturePhoto() {
    if (!state.stream || !cameraVideo.videoWidth) {
      cameraNote.textContent = "❌ Buksan muna ang camera bago kumuha.";
      cameraNote.className = "status-line bad";
      return;
    }

    // Geotag first: a capture without a fresh GPS fix is not allowed.
    const gps = await ensureFreshGps();
    if (!gps) {
      showError("❌ Kailangan ng tamang GPS bago kumuha ng larawan. Subukan muli sa open area.");
      return;
    }

    const canvas = document.createElement("canvas");
    // Square (1:1) photo: centered crop from the camera frame.
    const side = Math.min(cameraVideo.videoWidth, cameraVideo.videoHeight);
    const sx = (cameraVideo.videoWidth - side) / 2;
    const sy = (cameraVideo.videoHeight - side) / 2;
    canvas.width = side;
    canvas.height = side;
    canvas.getContext("2d").drawImage(cameraVideo, sx, sy, side, side, 0, 0, side, side);

    const blob = await new Promise(function (resolve) {
      canvas.toBlob(resolve, "image/jpeg", 0.92);
    });
    if (!blob) {
      showError("❌ Hindi magawa ang larawan. Subukan muli.");
      return;
    }

    state.photoBlob = blob;
    state.capturedAt = new Date().toISOString();
    state.capturedHeading = state.heading; // freeze the compass heading at shutter time
    stopCamera();

    photoPreview.src = URL.createObjectURL(blob);
    previewWrap.classList.remove("hidden");
    btnRetake.classList.remove("hidden");
    photoStatus.textContent =
      "✅ Nakuha ang larawan mula sa built-in camera — may geotag (" +
      gps.lat.toFixed(6) + ", " + gps.lon.toFixed(6) + ")" +
      (state.capturedHeading != null
        ? ", direksyon: " + cardinal(state.capturedHeading) + " " + Math.round(state.capturedHeading) + "°"
        : "") +
      ". Handa nang i-submit.";
    photoStatus.className = "status-line ok";
    refreshSubmitButton();
  }

  function retake() {
    state.photoBlob = null;
    state.capturedAt = null;
    previewWrap.classList.add("hidden");
    photoPreview.src = "";
    btnRetake.classList.add("hidden");
    photoStatus.textContent = "Wala pang larawan. Gamitin ang built-in camera ng app.";
    photoStatus.className = "status-line";
    refreshSubmitButton();
    openCamera();
  }

  function refreshSubmitButton() {
    btnSubmit.disabled = !(state.photoBlob && state.liveGps);
  }

  /* ================= offline queue + sync ================= */
  function updateConnUI() {
    const online = navigator.onLine;
    connDot.className = "conn-dot " + (online ? "online" : "offline");
    connText.textContent = online ? "Online" : "Offline mode — nai-save sa cellphone, a-upload pag may internet";
    refreshPending();
  }

  async function refreshPending() {
    try {
      const pending = await OfflineStore.getPending();
      const all = await OfflineStore.getAll();
      const rejected = all.filter(function (i) { return i.status === "rejected"; });
      pendingCount.textContent = String(pending.length);
      if (rejected.length > 0) {
        syncStatus.textContent = "⚠️ " + rejected.length + " hindi tinanggap ng server — " +
          (rejected[0].error || "tingnan ang detalye");
        syncStatus.className = "status-line bad";
      } else if (pending.length > 0) {
        syncStatus.textContent = "📦 " + pending.length + " submission(s) nakaimbak — mag-sync pag may internet.";
        syncStatus.className = "status-line";
      } else {
        syncStatus.textContent = "";
      }
    } catch (e) { /* IndexedDB unavailable — sync disabled */ }
  }

  function buildFd(item) {
    const fd = new FormData();
    fd.append("first_name", item.first_name);
    fd.append("middle_name", item.middle_name || "");
    fd.append("last_name", item.last_name);
    fd.append("address", item.address || "");
    fd.append("capture_source", "camera");
    fd.append("client_id", item.client_id);
    fd.append("captured_at", item.captured_at || "");
    if (item.heading_deg != null) {
      fd.append("heading_deg", item.heading_deg);
    }
    if (item.live_lat != null) {
      fd.append("live_lat", item.live_lat);
      fd.append("live_lon", item.live_lon);
      fd.append("live_accuracy", item.live_accuracy != null ? item.live_accuracy : "");
    }
    fd.append("photo", item.photo, "capture.jpg");
    return fd;
  }

  async function postItem(item) {
    const res = await fetch("/api/submit", { method: "POST", body: buildFd(item) });
    let data = {};
    try { data = await res.json(); } catch (e) {}
    return { status: res.status, ok: res.ok && !!data.ok, data: data, networkError: false };
  }

  async function syncNow() {
    if (!navigator.onLine) {
      syncStatus.textContent = "📡 Offline pa — awtomatikong mag-sync pag may internet.";
      syncStatus.className = "status-line";
      return;
    }
    syncStatus.textContent = "🔄 Nag-sysync...";
    syncStatus.className = "status-line";
    try {
      const pending = await OfflineStore.getPending();
      let sent = 0;
      for (const item of pending) {
        try {
          const result = await postItem(item);
          if (result.ok) {
            await OfflineStore.remove(item.client_id);
            sent++;
          } else if (result.status >= 400 && result.status < 500) {
            await OfflineStore.markRejected(item.client_id,
              (result.data.errors && result.data.errors.join(" ")) || "Tinanggihan ng server.");
          }
        } catch (e) { break; } // network died mid-sync — retry later
      }
      await refreshPending();
      if (sent > 0 && !syncStatus.classList.contains("bad")) {
        syncStatus.textContent = "✅ Na-upload ang " + sent + " submission(s).";
        syncStatus.className = "status-line ok";
      }
    } catch (e) { /* ignore */ }
    // Ask the SW to attempt background sync too (registers for closed-page retries).
    registerBgSync();
  }

  function registerBgSync() {
    if (!("serviceWorker" in navigator) || !("SyncManager" in window)) return;
    navigator.serviceWorker.ready.then(function (reg) {
      return reg.sync.register("sync-submissions");
    }).catch(function () {});
  }

  /* ================= submit (online direct / offline queue) ================= */
  async function doSubmit() {
    if (!state.photoBlob || !state.liveGps) {
      showError("Kumpletuhin ang larawan (built-in camera) at GPS bago mag-submit.");
      return;
    }

    const item = {
      client_id: uuid(),
      first_name: state.firstName,
      middle_name: state.middleName,
      last_name: state.lastName,
      address: state.address,
      capture_source: "camera",
      photo: state.photoBlob,
      live_lat: state.liveGps.lat,
      live_lon: state.liveGps.lon,
      live_accuracy: state.liveGps.accuracy,
      heading_deg: state.capturedHeading != null ? Math.round(state.capturedHeading * 10) / 10 : null,
      captured_at: state.capturedAt || new Date().toISOString(),
      created_at: new Date().toISOString(),
    };

    btnSubmit.disabled = true;
    hideError();

    if (navigator.onLine) {
      spinner.classList.remove("hidden");
      try {
        const result = await postItem(item);
        spinner.classList.add("hidden");
        if (result.ok) {
          const srcNote = result.data.duplicate
            ? "Naitala na ito kanina (offline sync)."
            : "Naitala ang inyong rainfed rice area gamit ang geotag ng built-in camera.";
          showSuccess(srcNote, result.data);
          return;
        }
        if (result.status >= 400 && result.status < 500) {
          const errs = (result.data && result.data.errors) || ["Hindi matanggap ang datos."];
          showError("❌ " + errs.join(" "));
          refreshSubmitButton();
          return;
        }
        // Server error (5xx): queue it like an offline submission.
      } catch (e) {
        spinner.classList.add("hidden");
        // Network failure — fall through to offline queue.
      }
    }

    // Offline (or unreachable): store locally and sync later.
    try {
      await OfflineStore.enqueue(item);
      await refreshPending();
      showSuccess("Nai-save ang datos OFFLINE sa inyong cellphone. A-upload ito awtomatikong pag may internet (i-check ang 'Nakabinbin' sa itaas).", {
        latitude: item.live_lat, longitude: item.live_lon, gps_source: "live",
      });
      registerBgSync();
    } catch (e) {
      showError("❌ Hindi mai-save offline. Siguraduhing may storage space ang browser at subukan muli.");
      refreshSubmitButton();
    }
  }

  function showSuccess(message, data) {
    document.getElementById("success-message").textContent = message;
    document.getElementById("success-coords").textContent =
      "Coordinates: " +
      Number(data.latitude).toFixed(6) + ", " +
      Number(data.longitude).toFixed(6) +
      " — Tanging ang admin lamang ang makakakita ng detalye.";
    setStep(3);
    resetState();
  }

  function resetState() {
    state.photoBlob = null;
    state.capturedAt = null;
    state.capturedHeading = null;
    state.liveGps = null;
    stopCamera();
    previewWrap.classList.add("hidden");
    photoPreview.src = "";
    btnRetake.classList.add("hidden");
    photoStatus.textContent = "Wala pang larawan. Gamitin ang built-in camera ng app.";
    photoStatus.className = "status-line";
    gpsStatus.textContent = "Wala pang lokasyon.";
    gpsStatus.className = "status-line";
    nameForm.reset();
  }

  /* ================= wiring ================= */
  nameForm.addEventListener("submit", function (e) {
    e.preventDefault();
    const first = document.getElementById("first_name").value.trim();
    const middle = document.getElementById("middle_name").value.trim();
    const last = document.getElementById("last_name").value.trim();
    const address = document.getElementById("address").value.trim()
      .replace(/\s+/g, " ");
    const nameRe = /^[A-Za-zÀ-ÖØ-öø-ÿÑñ' .-]{2,80}$/;
    const addressRe = /^[A-Za-zÀ-ÖØ-öø-ÿÑñ0-9][A-Za-zÀ-ÖØ-öø-ÿÑñ0-9' .,\-#/()]*$/;

    if (!nameRe.test(first)) { showError("Ilagay ang wastong First Name (2+ titik)."); return; }
    if (middle && !/^[A-Za-zÀ-ÖØ-öø-ÿÑñ' .-]{0,80}$/.test(middle)) {
      showError("May hindi tanggap na karakter sa Middle Name."); return;
    }
    if (!nameRe.test(last)) { showError("Ilagay ang wastong Last Name (2+ titik)."); return; }
    if (address.length < 5 || address.length > 200) {
      showError("Ilagay ang kumpletong Address / Tirahan (5-200 titik)."); return;
    }
    if (!addressRe.test(address)) {
      showError("May hindi tanggap na karakter sa Address / Tirahan."); return;
    }

    state.firstName = first;
    state.middleName = middle;
    state.lastName = last;
    state.address = address;
    hideError();
    setStep(2);
    ensureFreshGps(); // warm up the GPS fix while the farmer opens the camera
  });

  btnBack.addEventListener("click", function () { stopCamera(); setStep(1); });
  btnOpenCamera.addEventListener("click", openCamera);
  btnShutter.addEventListener("click", capturePhoto);
  btnRetake.addEventListener("click", retake);
  btnSubmit.addEventListener("click", doSubmit);
  btnAgain.addEventListener("click", function () { setStep(1); refreshSubmitButton(); });
  btnSyncNow.addEventListener("click", syncNow);

  window.addEventListener("online", function () { updateConnUI(); syncNow(); });
  window.addEventListener("offline", updateConnUI);
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.addEventListener("message", function (event) {
      if (event.data && event.data.type === "SYNC_DONE") refreshPending();
    });
  }
  setInterval(refreshPending, 45000);

  updateConnUI();
  registerBgSync();
  setStep(1);
})();
