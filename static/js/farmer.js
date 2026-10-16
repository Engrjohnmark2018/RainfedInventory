/* RAINfed-Tagging Alcala — farmer submission flow (strict geotag acceptance) */
(function () {
  "use strict";

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
  const btnGps = document.getElementById("btn-gps");
  const photoInput = document.getElementById("photo-input");
  const gpsStatus = document.getElementById("gps-status");
  const photoStatus = document.getElementById("photo-status");
  const previewWrap = document.getElementById("photo-preview-wrap");
  const photoPreview = document.getElementById("photo-preview");

  const MAX_LIVE_ACCURACY_M = 500;

  const state = {
    firstName: "",
    middleName: "",
    lastName: "",
    photoFile: null,
    exifGps: null,      // {lat, lon} from photo EXIF
    liveGps: null,      // {lat, lon, accuracy}
  };

  /* ---------- step navigation ---------- */
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

  /* ---------- STEP 1: names ---------- */
  nameForm.addEventListener("submit", function (e) {
    e.preventDefault();
    const first = document.getElementById("first_name").value.trim();
    const middle = document.getElementById("middle_name").value.trim();
    const last = document.getElementById("last_name").value.trim();
    const nameRe = /^[A-Za-zÀ-ÖØ-öø-ÿÑñ' .-]{2,80}$/;

    if (!nameRe.test(first)) {
      showError("Ilagay ang wastong First Name (2+ titik).");
      return;
    }
    if (middle && !/^[A-Za-zÀ-ÖØ-öø-ÿÑñ' .-]{0,80}$/.test(middle)) {
      showError("May hindi tanggap na karakter sa Middle Name.");
      return;
    }
    if (!nameRe.test(last)) {
      showError("Ilagay ang wastong Last Name (2+ titik).");
      return;
    }

    state.firstName = first;
    state.middleName = middle;
    state.lastName = last;
    hideError();
    setStep(2);
  });

  /* ---------- STEP 2-A: live GPS ---------- */
  btnGps.addEventListener("click", function () {
    if (!navigator.geolocation) {
      gpsStatus.textContent = "❌ Hindi sinusuportahan ng browser ang GPS.";
      gpsStatus.className = "status-line bad";
      return;
    }
    gpsStatus.textContent = "⏳ Kinukuha ang lokasyon... (hintayin)";
    gpsStatus.className = "status-line";
    btnGps.disabled = true;

    navigator.geolocation.getCurrentPosition(
      function (pos) {
        btnGps.disabled = false;
        const lat = pos.coords.latitude;
        const lon = pos.coords.longitude;
        const acc = pos.coords.accuracy;
        if (!isFinite(lat) || !isFinite(lon) ||
            Math.abs(lat) < 1e-6 && Math.abs(lon) < 1e-6) {
          gpsStatus.textContent = "❌ Hindi valid ang GPS na nakuha. Subukan muli.";
          gpsStatus.className = "status-line bad";
          return;
        }
        if (acc > MAX_LIVE_ACCURACY_M) {
          state.liveGps = null;
          gpsStatus.textContent =
            "⚠️ Masyadong malabo ang signal (" + Math.round(acc) + " m). " +
            "Lumabas sa open area at subukan muli (kailangan ≤ " + MAX_LIVE_ACCURACY_M + " m).";
          gpsStatus.className = "status-line bad";
          return;
        }
        state.liveGps = { lat: lat, lon: lon, accuracy: acc };
        gpsStatus.textContent =
          "✅ Live GPS: " + lat.toFixed(6) + ", " + lon.toFixed(6) +
          " (accuracy ≈ " + Math.round(acc) + " m)";
        gpsStatus.className = "status-line ok";
        refreshSubmitButton();
      },
      function (err) {
        btnGps.disabled = false;
        let msg = "❌ Hindi makuha ang lokasyon.";
        if (err.code === err.PERMISSION_DENIED) {
          msg = "❌ Tinanggihan ang pahintulot sa GPS. I-allow ang Location sa browser/cellphone settings.";
        } else if (err.code === err.TIMEOUT) {
          msg = "❌ Na-timeout ang GPS. Subukan muli sa open area.";
        }
        gpsStatus.textContent = msg;
        gpsStatus.className = "status-line bad";
      },
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 }
    );
  });

  /* ---------- STEP 2-B: photo + EXIF GPS ---------- */
  photoInput.addEventListener("change", async function () {
    hideError();
    const file = photoInput.files && photoInput.files[0];
    if (!file) return;

    if (!file.type.startsWith("image/")) {
      photoStatus.textContent = "❌ Hindi larawan ang file. Kumuha muli ng litrato.";
      photoStatus.className = "status-line bad";
      state.photoFile = null;
      refreshSubmitButton();
      return;
    }
    if (file.size > 16 * 1024 * 1024) {
      photoStatus.textContent = "❌ Masyadong malaki ang larawan (max 16 MB).";
      photoStatus.className = "status-line bad";
      state.photoFile = null;
      refreshSubmitButton();
      return;
    }

    // Preview
    const url = URL.createObjectURL(file);
    photoPreview.src = url;
    previewWrap.classList.remove("hidden");

    // Client-side EXIF GPS check (server re-validates strictly)
    photoStatus.textContent = "⏳ Sinusuri ang EXIF GPS ng larawan...";
    photoStatus.className = "status-line";
    state.photoFile = file;
    state.exifGps = null;

    try {
      if (window.exifr) {
        const exif = await window.exifr.parse(file).catch(function () { return null; });
        if (exif && exif.latitude != null && exif.longitude != null) {
          const lat = Number(exif.latitude);
          const lon = Number(exif.longitude);
          const inRange = isFinite(lat) && isFinite(lon) &&
            lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
          const notNullIsland = !(Math.abs(lat) < 1e-6 && Math.abs(lon) < 1e-6);
          if (inRange && notNullIsland) {
            state.exifGps = { lat: lat, lon: lon };
            photoStatus.textContent =
              "✅ May EXIF GPS (geotag) ang larawan: " + lat.toFixed(6) + ", " + lon.toFixed(6);
            photoStatus.className = "status-line ok";
            refreshSubmitButton();
            return;
          }
        }
      }
    } catch (e) {
      /* fall through to no-EXIF message */
    }

    if (state.liveGps) {
      photoStatus.textContent =
        "⚠️ Walang EXIF GPS ang larawan, ngunit may live GPS kayo — sapat na ito. I-submit.";
      photoStatus.className = "status-line ok";
    } else {
      photoStatus.textContent =
        "❌ Walang EXIF GPS (geotag) ang larawan. Pindutin ang 'Kunin ang Lokasyon' " +
        "AT/o i-on ang geotagging sa camera settings bago kumuha muli.";
      photoStatus.className = "status-line bad";
    }
    refreshSubmitButton();
  });

  /* ---------- submit gate ---------- */
  function hasGps() {
    return Boolean(state.exifGps || state.liveGps);
  }
  function refreshSubmitButton() {
    btnSubmit.disabled = !(state.photoFile && hasGps());
  }

  btnBack.addEventListener("click", function () {
    setStep(1);
  });

  /* ---------- STEP 3: submit ---------- */
  btnSubmit.addEventListener("click", function () {
    if (!state.photoFile || !hasGps()) {
      showError("Kumpletuhin ang larawan at GPS bago mag-submit.");
      return;
    }

    const fd = new FormData();
    fd.append("first_name", state.firstName);
    fd.append("middle_name", state.middleName);
    fd.append("last_name", state.lastName);
    fd.append("photo", state.photoFile);
    if (state.liveGps) {
      fd.append("live_lat", state.liveGps.lat);
      fd.append("live_lon", state.liveGps.lon);
      fd.append("live_accuracy", state.liveGps.accuracy);
    }

    btnSubmit.disabled = true;
    spinner.classList.remove("hidden");
    hideError();

    fetch("/api/submit", { method: "POST", body: fd })
      .then(function (res) {
        return res.json().then(function (data) {
          return { status: res.status, data: data };
        });
      })
      .then(function (result) {
        spinner.classList.add("hidden");
        if (result.data && result.data.ok) {
          const src = result.data.gps_source === "exif"
            ? "EXIF geotag ng larawan" : "live na GPS ng cellphone";
          document.getElementById("success-message").textContent =
            "Salamat, " + state.firstName + "! Naitala ang inyong rainfed rice area gamit ang " + src + ".";
          document.getElementById("success-coords").textContent =
            "Coordinates: " +
            Number(result.data.latitude).toFixed(6) + ", " +
            Number(result.data.longitude).toFixed(6) +
            " — Tanging ang admin lamang ang makakakita ng detalye.";
          setStep(3);
          resetState();
        } else {
          const errs = (result.data && result.data.errors) || ["Hindi matanggap ang datos. Subukan muli."];
          showError("❌ " + errs.join(" "));
          refreshSubmitButton();
        }
      })
      .catch(function () {
        spinner.classList.add("hidden");
        showError("❌ May problema sa koneksyon. Siguraduhing may internet at subukan muli.");
        refreshSubmitButton();
      });
  });

  function resetState() {
    state.photoFile = null;
    state.exifGps = null;
    // keep liveGps? No — reset fully so each submission captures fresh data
    state.liveGps = null;
    photoInput.value = "";
    previewWrap.classList.add("hidden");
    photoPreview.src = "";
    photoStatus.textContent = "Wala pang larawan.";
    photoStatus.className = "status-line";
    gpsStatus.textContent = "Wala pang lokasyon.";
    gpsStatus.className = "status-line";
    nameForm.reset();
  }

  btnAgain.addEventListener("click", function () {
    setStep(1);
    refreshSubmitButton();
  });

  /* init */
  setStep(1);
})();
