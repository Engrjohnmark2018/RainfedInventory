/* RAINfed-Tagging Alcala — OFFLINE edition (no server).
 * Data lives in the phone's IndexedDB; exports save files to phone storage.
 * Camera policy: in-app camera only. GPS + compass heading captured at shutter.
 */
(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };
  var MAX_ACC = 500, GPS_MAX_AGE = 5 * 60 * 1000;
  var ADMIN_PIN = "1234";

  var state = {
    first: "", middle: "", last: "", address: "",
    photoBlob: null, capturedAt: null,
    heading: null, capturedHeading: null,
    gps: null, stream: null
  };

  /* ---------------- IndexedDB ---------------- */
  var DB_NAME = "rainfedtag-local", STORE = "records";

  function openDB() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          var st = db.createObjectStore(STORE, { keyPath: "client_id" });
          st.createIndex("created_at", "created_at");
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  function dbPut(item) {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(STORE, "readwrite");
        t.objectStore(STORE).put(item);
        t.oncomplete = function () { db.close(); resolve(); };
        t.onerror = function () { db.close(); reject(t.error); };
      });
    });
  }

  function dbAll() {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(STORE, "readonly");
        var req = t.objectStore(STORE).getAll();
        req.onsuccess = function () {
          db.close();
          resolve((req.result || []).sort(function (a, b) {
            return (b.created_at || "").localeCompare(a.created_at || "");
          }));
        };
        req.onerror = function () { db.close(); reject(req.error); };
      });
    });
  }

  function dbClear() {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(STORE, "readwrite");
        t.objectStore(STORE).clear();
        t.oncomplete = function () { db.close(); resolve(); };
        t.onerror = function () { db.close(); reject(t.error); };
      });
    });
  }

  function uuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
      var r = Math.random() * 16 | 0;
      return (c === "x" ? r : (r & 3) | 8).toString(16);
    });
  }

  /* ---------------- helpers ---------------- */
  function showError(msg) {
    var box = $("form-error");
    box.textContent = msg;
    box.classList.remove("hidden");
    setTimeout(function () { box.classList.add("hidden"); }, 8000);
  }
  function setStep(n) {
    $("step-1").classList.toggle("hidden", n !== 1);
    $("step-2").classList.toggle("hidden", n !== 2);
    $("step-3").classList.toggle("hidden", n !== 3);
    Array.prototype.forEach.call(document.querySelectorAll("#steps-bar .step"), function (el) {
      var s = Number(el.dataset.step);
      el.classList.toggle("active", s === n);
      el.classList.toggle("done", s < n);
    });
    $("form-error").classList.add("hidden");
  }
  function cardinal(deg) {
    var dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
    return dirs[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
  }
  function fmtTime(iso) {
    try {
      return new Date(iso).toLocaleString("en-PH", {
        timeZone: "Asia/Manila", year: "numeric", month: "short", day: "numeric",
        hour: "2-digit", minute: "2-digit"
      });
    } catch (e) { return iso || "—"; }
  }

  function saveFile(name, mime, base64) {
    // Android bridge first, browser fallback second.
    if (window.Android && typeof window.Android.saveFile === "function") {
      window.Android.saveFile(name, mime, base64);
      return true;
    }
    var a = document.createElement("a");
    a.href = "data:" + mime + ";base64," + base64;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    return true;
  }

  function blobToBase64(blob) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () {
        resolve(String(fr.result).split(",")[1] || "");
      };
      fr.onerror = reject;
      fr.readAsDataURL(blob);
    });
  }

  /* ---------------- GPS ---------------- */
  function getGpsOnce() {
    return new Promise(function (resolve, reject) {
      if (!navigator.geolocation) { reject(new Error("no-geolocation")); return; }
      navigator.geolocation.getCurrentPosition(function (pos) {
        var lat = pos.coords.latitude, lon = pos.coords.longitude, acc = pos.coords.accuracy;
        if (!isFinite(lat) || !isFinite(lon) ||
            (Math.abs(lat) < 1e-6 && Math.abs(lon) < 1e-6)) {
          reject(new Error("invalid")); return;
        }
        resolve({ lat: lat, lon: lon, accuracy: acc, at: Date.now() });
      }, function (err) { reject(err); },
        { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 });
    });
  }

  function ensureFreshGps() {
    var stale = !state.gps || (Date.now() - state.gps.at) > GPS_MAX_AGE;
    if (!stale) return Promise.resolve(state.gps);
    $("gps-status").textContent = "⏳ Kinukuha ang GPS...";
    return getGpsOnce().then(function (gps) {
      if (gps.accuracy > MAX_ACC) {
        $("gps-status").textContent =
          "⚠️ Malabo ang signal (" + Math.round(gps.accuracy) + " m). Lumabas sa open area (kailangan ≤ " + MAX_ACC + " m).";
        $("gps-status").className = "status-line bad";
        return null;
      }
      state.gps = gps;
      $("gps-status").textContent =
        "✅ GPS: " + gps.lat.toFixed(6) + ", " + gps.lon.toFixed(6) +
        " (accuracy ≈ " + Math.round(gps.accuracy) + " m)";
      $("gps-status").className = "status-line ok";
      return gps;
    }).catch(function (err) {
      var msg = "❌ Hindi makuha ang GPS.";
      if (err && err.code === 1) msg = "❌ I-allow ang Location permission sa Android settings.";
      else if (err && err.code === 3) msg = "❌ Na-timeout ang GPS. Subukan sa open area.";
      $("gps-status").textContent = msg;
      $("gps-status").className = "status-line bad";
      return null;
    });
  }

  /* ---------------- compass ---------------- */
  var compassAttached = false;
  function updateCompass(heading) {
    if (heading == null || !isFinite(heading)) return;
    heading = ((heading % 360) + 360) % 360;
    state.heading = heading;
    $("compass").classList.remove("hidden");
    $("compass-rose").style.transform = "rotate(" + (-heading) + "deg)";
    $("compass-heading").textContent = "🧭 " + cardinal(heading) + " " + Math.round(heading) + "°";
  }
  function onOrientation(e) {
    if (typeof e.webkitCompassHeading === "number") updateCompass(e.webkitCompassHeading);
    else if (e.absolute && e.alpha != null) updateCompass(360 - e.alpha);
  }
  function attachCompass() {
    if (compassAttached) return;
    compassAttached = true;
    window.addEventListener("deviceorientationabsolute", onOrientation, true);
    window.addEventListener("deviceorientation", onOrientation, true);
    if (typeof DeviceOrientationEvent !== "undefined" &&
        typeof DeviceOrientationEvent.requestPermission === "function") {
      DeviceOrientationEvent.requestPermission().catch(function () {});
    }
    setTimeout(function () {
      if (state.heading == null) {
        $("compass-heading").textContent = "🧭 N/A";
        $("compass").classList.remove("hidden");
      }
    }, 4000);
  }

  // Native Android sensor bridge (set from MainActivity): the phone's real
  // magnetometer/rotation sensors, since WebView lacks browser compass events.
  window.__nativeCompassHeading = function (h) {
    updateCompass(h);
  };

  /* ---------------- camera ---------------- */
  function stopCamera() {
    if (state.stream) {
      state.stream.getTracks().forEach(function (t) { t.stop(); });
      state.stream = null;
    }
    $("camera-video").srcObject = null;
    $("btn-shutter").disabled = true;
    $("camera-wrap").classList.add("hidden");
    $("btn-open-camera").classList.remove("hidden");
  }

  function openCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      $("camera-note").textContent = "❌ Hindi available ang camera API. Gamitin ang bagong Android WebView/Chrome (HTTPS o app).";
      $("camera-note").className = "status-line bad";
      return;
    }
    stopCamera();
    navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false
    }).then(function (stream) {
      state.stream = stream;
      var v = $("camera-video");
      v.srcObject = stream;
      $("camera-wrap").classList.remove("hidden");
      v.play().catch(function () {});
      $("btn-open-camera").classList.add("hidden");
      $("btn-shutter").disabled = false;
      $("camera-note").textContent = "Naka-on ang camera. Pindutin ang KUNAN.";
      $("camera-note").className = "status-line ok";
      attachCompass();
    }).catch(function (err) {
      var msg = "❌ Hindi mabuksan ang camera.";
      if (err && (err.name === "NotAllowedError" || err.name === "SecurityError")) {
        msg = "❌ I-allow ang Camera permission ng app sa Android settings.";
      } else if (err && err.name === "NotFoundError") {
        msg = "❌ Walang camera sa device.";
      }
      $("camera-note").textContent = msg;
      $("camera-note").className = "status-line bad";
    });
  }

  function capturePhoto() {
    var v = $("camera-video");
    if (!state.stream || !v.videoWidth) {
      $("camera-note").textContent = "❌ Buksan muna ang camera.";
      $("camera-note").className = "status-line bad";
      return;
    }
    ensureFreshGps().then(function (gps) {
      if (!gps) {
        showError("❌ Kailangan ng tamang GPS bago kumuha ng larawan.");
        return;
      }
      var c = document.createElement("canvas");
      c.width = v.videoWidth;
      c.height = v.videoHeight;
      c.getContext("2d").drawImage(v, 0, 0);
      c.toBlob(function (blob) {
        if (!blob) { showError("❌ Hindi magawa ang larawan."); return; }
        state.photoBlob = blob;
        state.capturedAt = new Date().toISOString();
        state.capturedHeading = state.heading;
        stopCamera();
        $("photo-preview").src = URL.createObjectURL(blob);
        $("photo-preview-wrap").classList.remove("hidden");
        $("btn-retake").classList.remove("hidden");
        $("photo-status").textContent =
          "✅ Nakuha ang larawan — geotag (" + gps.lat.toFixed(6) + ", " + gps.lon.toFixed(6) + ")" +
          (state.capturedHeading != null
            ? ", direksyon: " + cardinal(state.capturedHeading) + " " + Math.round(state.capturedHeading) + "°" : "") +
          ". Handa nang i-save.";
        $("photo-status").className = "status-line ok";
        $("btn-submit").disabled = false;
      }, "image/jpeg", 0.92);
    });
  }

  /* ---------------- submit (save locally) ---------------- */
  function submitRecord() {
    if (!state.photoBlob || !state.gps) {
      showError("Kumpletuhin ang larawan at GPS bago mag-save.");
      return;
    }
    $("btn-submit").disabled = true;
    state.photoBlob.arrayBuffer().then(function (buf) {
      var stamped = buf;
      try {
        stamped = ExifWrite.stamp(buf, {
          lat: state.gps.lat,
          lon: state.gps.lon,
          altitude: state.gps.accuracy != null ? 0 : 0,
          heading: state.capturedHeading,
          takenAt: state.capturedAt
        });
      } catch (e) { /* fall back to unstamped */ }

      var photoBlob = new Blob([stamped], { type: "image/jpeg" });
      // thumbnail
      return new Promise(function (resolve) {
        var img = new Image();
        img.onload = function () {
          var c = document.createElement("canvas");
          var scale = Math.min(1, 320 / img.width);
          c.width = Math.round(img.width * scale);
          c.height = Math.round(img.height * scale);
          c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
          c.toBlob(function (thumb) { resolve({ photo: photoBlob, thumb: thumb }); }, "image/jpeg", 0.82);
        };
        img.onerror = function () { resolve({ photo: photoBlob, thumb: photoBlob }); };
        img.src = URL.createObjectURL(photoBlob);
      });
    }).then(function (blobs) {
      var item = {
        client_id: uuid(),
        first_name: state.first,
        middle_name: state.middle,
        last_name: state.last,
        address: state.address,
        latitude: state.gps.lat,
        longitude: state.gps.lon,
        accuracy_m: state.gps.accuracy,
        heading_deg: state.capturedHeading != null
          ? Math.round(state.capturedHeading * 10) / 10 : null,
        captured_at: state.capturedAt || new Date().toISOString(),
        created_at: new Date().toISOString(),
        photo: blobs.photo,
        thumb: blobs.thumb
      };
      return dbPut(item).then(function () {
        $("success-message").textContent =
          "Salamat, " + state.first + "! Naitala ang inyong rainfed rice area SA CELLPHONE (offline).";
        $("success-coords").textContent =
          "Coordinates: " + item.latitude.toFixed(6) + ", " + item.longitude.toFixed(6) +
          " — I-export mula sa Admin tab kapag kailangan.";
        setStep(3);
        refreshCount();
        resetState();
      });
    }).catch(function () {
      showError("❌ Hindi mai-save. Siguraduhing may storage space ang cellphone.");
      $("btn-submit").disabled = false;
    });
  }

  function resetState() {
    state.photoBlob = null;
    state.capturedAt = null;
    state.capturedHeading = null;
    state.gps = null;
    stopCamera();
    $("photo-preview-wrap").classList.add("hidden");
    $("photo-preview").src = "";
    $("btn-retake").classList.add("hidden");
    $("photo-status").textContent = "Wala pang larawan.";
    $("photo-status").className = "status-line";
    $("gps-status").textContent = "Wala pang lokasyon.";
    $("gps-status").className = "status-line";
    $("name-form").reset();
    $("btn-submit").disabled = true;
  }

  function refreshCount() {
    dbAll().then(function (items) {
      $("local-count").textContent = String(items.length);
    }).catch(function () {});
  }

  /* ---------------- name form ---------------- */
  $("name-form").addEventListener("submit", function (e) {
    e.preventDefault();
    var first = $("first_name").value.trim();
    var middle = $("middle_name").value.trim();
    var last = $("last_name").value.trim();
    var address = $("address").value.trim().replace(/\s+/g, " ");
    var nameRe = /^[A-Za-zÀ-ÖØ-öø-ÿÑñ' .-]{2,80}$/;
    var addrRe = /^[A-Za-zÀ-ÖØ-öø-ÿÑñ0-9][A-Za-zÀ-ÖØ-öø-ÿÑñ0-9' .,\-#/()]*$/;
    if (!nameRe.test(first)) { showError("Ilagay ang wastong First Name (2+ titik)."); return; }
    if (middle && !nameRe.test(middle) && middle.length > 80) { showError("May problema sa Middle Name."); return; }
    if (!nameRe.test(last)) { showError("Ilagay ang wastong Last Name (2+ titik)."); return; }
    if (address.length < 5 || address.length > 200 || !addrRe.test(address)) {
      showError("Ilagay ang kumpletong Address / Tirahan (5-200 titik, walang espesyal na simbolo).");
      return;
    }
    state.first = first; state.middle = middle; state.last = last; state.address = address;
    setStep(2);
    ensureFreshGps();
    attachCompass();
  });

  $("btn-back").addEventListener("click", function () { stopCamera(); setStep(1); });
  $("btn-open-camera").addEventListener("click", openCamera);
  $("btn-shutter").addEventListener("click", capturePhoto);
  $("btn-retake").addEventListener("click", function () {
    state.photoBlob = null;
    $("photo-preview-wrap").classList.add("hidden");
    $("btn-retake").classList.add("hidden");
    $("btn-submit").disabled = true;
    $("photo-status").textContent = "Wala pang larawan.";
    $("photo-status").className = "status-line";
    openCamera();
  });
  $("btn-submit").addEventListener("click", submitRecord);
  $("btn-again").addEventListener("click", function () { setStep(1); });
  $("btn-gps").addEventListener("click", ensureFreshGps);

  /* ---------------- tabs / PIN ---------------- */
  function showFarmer() {
    $("view-farmer").classList.remove("hidden");
    $("view-admin").classList.add("hidden");
  }
  function showAdmin() {
    $("view-farmer").classList.add("hidden");
    $("view-admin").classList.remove("hidden");
    if (sessionStorage.getItem("rainfed-admin") === "1") {
      $("pin-gate").classList.add("hidden");
      openAdmin();
    } else {
      $("pin-gate").classList.remove("hidden");
      $("admin-content").classList.add("hidden");
    }
  }
  $("tab-farmer").addEventListener("click", showFarmer);
  $("tab-admin").addEventListener("click", showAdmin);

  function tryPin() {
    if ($("pin-input").value === ADMIN_PIN) {
      sessionStorage.setItem("rainfed-admin", "1");
      $("pin-gate").classList.add("hidden");
      openAdmin();
    } else {
      $("pin-error").textContent = "Maling PIN.";
      $("pin-error").classList.remove("hidden");
    }
  }
  $("btn-pin").addEventListener("click", tryPin);
  $("pin-input").addEventListener("keydown", function (e) {
    if (e.key === "Enter") tryPin();
  });

  /* ---------------- admin: map + table + exports ---------------- */
  var map = null;
  function openAdmin() {
    $("admin-content").classList.remove("hidden");
    renderAll();
  }

  function renderAll() {
    dbAll().then(function (items) {
      $("stat-total").textContent = String(items.length);
      var body = $("records-body");
      body.innerHTML = "";
      $("empty-note").classList.toggle("hidden", items.length > 0);

      items.forEach(function (r, idx) {
        var name = [r.first_name, r.middle_name || "", r.last_name].filter(Boolean).join(" ");
        var tr = document.createElement("tr");
        tr.innerHTML =
          "<td>" + (items.length - idx) + "</td>" +
          "<td>" + esc(name) + "</td>" +
          "<td>" + esc(r.address || "—") + "</td>" +
          "<td>" + r.latitude.toFixed(6) + "</td>" +
          "<td>" + r.longitude.toFixed(6) + "</td>" +
          "<td>" + (r.heading_deg != null ? cardinal(r.heading_deg) + " " + Math.round(r.heading_deg) + "°" : "—") + "</td>" +
          "<td>" + fmtTime(r.created_at) + "</td>" +
          '<td><img class="thumb" alt="photo"></td>';
        var img = tr.querySelector("img");
        img.src = URL.createObjectURL(r.thumb || r.photo);
        img.addEventListener("click", function () {
          $("modal-img").src = URL.createObjectURL(r.photo);
          $("modal-caption").textContent =
            name + " — " + r.latitude.toFixed(6) + ", " + r.longitude.toFixed(6);
          $("photo-modal").classList.remove("hidden");
        });
        body.appendChild(tr);
      });

      // map
      if (map) { map.remove(); map = null; }
      map = L.map("map").setView([17.7033, 121.6686], 12);
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: "© OpenStreetMap (kailangan ng internet para sa tiles)"
      }).addTo(map);
      var group = [];
      items.forEach(function (r) {
        var name = [r.first_name, r.middle_name || "", r.last_name].filter(Boolean).join(" ");
        var m = L.marker([r.latitude, r.longitude]).addTo(map).bindPopup(
          "<strong>" + esc(name) + "</strong><br>🏠 " + esc(r.address || "—") + "<br>" +
          "📍 " + r.latitude.toFixed(6) + ", " + r.longitude.toFixed(6) +
          (r.heading_deg != null ? "<br>🧭 " + cardinal(r.heading_deg) + " (" + Math.round(r.heading_deg) + "°)" : "") +
          "<br><img src='" + URL.createObjectURL(r.thumb || r.photo) + "' style='width:180px;border-radius:8px'>"
        );
        group.push(m);
      });
      if (group.length > 0) {
        map.fitBounds(L.featureGroup(group).getBounds().pad(0.25));
        if (group.length === 1) map.setZoom(15);
      }
      setTimeout(function () { map.invalidateSize(); }, 200);
    });
  }

  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  $("modal-close").addEventListener("click", function () {
    $("photo-modal").classList.add("hidden");
    $("modal-img").src = "";
  });

  $("btn-export-csv").addEventListener("click", function () {
    dbAll().then(function (items) {
      var rows = [["client_id", "first_name", "middle_name", "last_name", "address",
                   "latitude", "longitude", "accuracy_m", "heading_deg", "captured_at", "created_at"]];
      items.forEach(function (r) {
        rows.push([r.client_id, r.first_name, r.middle_name || "", r.last_name, r.address,
                   r.latitude, r.longitude, r.accuracy_m != null ? r.accuracy_m : "",
                   r.heading_deg != null ? r.heading_deg : "",
                   r.captured_at || "", r.created_at]);
      });
      var csv = rows.map(function (row) {
        return row.map(function (c) {
          var s = String(c == null ? "" : c);
          return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
        }).join(",");
      }).join("\r\n");
      var name = "rainfed_tagging_alcala_" + Date.now() + ".csv";
      blobToBase64(new Blob(["\ufeff" + csv], { type: "text/csv" })).then(function (b64) {
        saveFile(name, "text/csv", b64);
      });
    });
  });

  $("btn-export-geojson").addEventListener("click", function () {
    dbAll().then(function (items) {
      var fc = {
        type: "FeatureCollection",
        name: "RAINfed-Tagging Alcala (offline)",
        features: items.map(function (r) {
          return {
            type: "Feature",
            geometry: { type: "Point", coordinates: [r.longitude, r.latitude] },
            properties: {
              first_name: r.first_name,
              middle_name: r.middle_name || "",
              last_name: r.last_name,
              address: r.address,
              accuracy_m: r.accuracy_m,
              heading_deg: r.heading_deg,
              captured_at: r.captured_at,
              created_at: r.created_at
            }
          };
        })
      };
      var name = "rainfed_tagging_alcala_" + Date.now() + ".geojson";
      blobToBase64(new Blob([JSON.stringify(fc, null, 2)], { type: "application/geo+json" }))
        .then(function (b64) { saveFile(name, "application/geo+json", b64); });
    });
  });

  $("btn-export-zip").addEventListener("click", function () {
    dbAll().then(function (items) {
      var zip = new JSZip();
      var manifest = ["zip_filename,first_name,middle_name,last_name"];
      items.forEach(function (r, i) {
        var safe = (r.last_name + "_" + r.first_name).replace(/[^A-Za-z0-9_-]+/g, "_");
        var fname = "photo_" + (i + 1) + "_" + safe + ".jpg";
        zip.file(fname, r.photo);
        manifest.push([fname, r.first_name, r.middle_name || "", r.last_name]
          .map(function (c) { return '"' + String(c).replace(/"/g, '""') + '"'; }).join(","));
      });
      zip.file("manifest.csv", manifest.join("\r\n"));
      zip.generateAsync({ type: "base64" }).then(function (b64) {
        saveFile("rainfed_tagging_alcala_photos_" + Date.now() + ".zip", "application/zip", b64);
      });
    });
  });

  $("btn-clear-all").addEventListener("click", function () {
    if (confirm("Burahin LAHAT ng naitalang datos sa cellphone? Hindi ito maibabalik.")) {
      dbClear().then(renderAll).then(refreshCount);
    }
  });

  /* init */
  setStep(1);
  refreshCount();
  showFarmer();
})();
