/* RAIN-Tag Alcala — admin dashboard (map, table, photo modal) */
(function () {
  "use strict";

  const cfg = window.RAINTAG || { records: [], center: { lat: 17.7033, lng: 121.6686, zoom: 12 } };
  const records = cfg.records || [];

  /* ---------------- Leaflet map ---------------- */
  const map = L.map("map").setView([cfg.center.lat, cfg.center.lng], cfg.center.zoom);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);

  const markers = [];
  records.forEach(function (r) {
    const srcLabel = r.gps_source === "exif" ? "EXIF geotag" : "Live GPS";
    const popupHtml =
      '<div class="popup">' +
      "<strong>" + escapeHtml(r.name) + "</strong><br>" +
      "📍 " + r.latitude.toFixed(6) + ", " + r.longitude.toFixed(6) + "<br>" +
      "🛰️ GPS: " + srcLabel +
      (r.accuracy_m != null ? " (±" + Math.round(r.accuracy_m) + " m)" : "") + "<br>" +
      "🕓 " + formatPhTime(r.submitted_at) + "<br>" +
      '<img src="' + r.thumb_url + '" alt="photo" style="width:150px;border-radius:8px;margin-top:6px;cursor:pointer" ' +
      'onclick="window.__openPhoto(' + r.id + ')">' +
      "</div>";
    const marker = L.marker([r.latitude, r.longitude]).addTo(map).bindPopup(popupHtml);
    markers.push({ marker: marker, record: r });
  });

  if (markers.length > 0) {
    const group = L.featureGroup(markers.map(function (m) { return m.marker; }));
    map.fitBounds(group.getBounds().pad(0.25));
    if (markers.length === 1) map.setZoom(15);
  }

  /* ---------------- table ---------------- */
  const tbody = document.getElementById("records-body");
  const emptyNote = document.getElementById("empty-note");

  function renderTable(filter) {
    const q = (filter || "").trim().toLowerCase();
    tbody.innerHTML = "";
    let visible = 0;
    records.forEach(function (r) {
      if (q && r.name.toLowerCase().indexOf(q) === -1) return;
      visible++;
      const tr = document.createElement("tr");

      const srcBadge = r.gps_source === "exif"
        ? '<span class="badge badge-exif">EXIF</span>'
        : '<span class="badge badge-live">LIVE GPS</span>';

      tr.innerHTML =
        "<td>" + r.id + "</td>" +
        "<td>" + escapeHtml(r.name) + "</td>" +
        "<td>" + r.latitude.toFixed(6) + "</td>" +
        "<td>" + r.longitude.toFixed(6) + "</td>" +
        "<td>" + srcBadge + "</td>" +
        "<td>" + (r.accuracy_m != null ? Math.round(r.accuracy_m) + " m" : "—") + "</td>" +
        "<td>" + formatPhTime(r.submitted_at) + "</td>" +
        '<td><img class="thumb" src="' + r.thumb_url + '" alt="photo" loading="lazy"></td>';

      tr.addEventListener("click", function () {
        map.setView([r.latitude, r.longitude], 16);
        const found = markers.find(function (m) { return m.record.id === r.id; });
        if (found) found.marker.openPopup();
      });
      tr.querySelector(".thumb").addEventListener("click", function (e) {
        e.stopPropagation();
        openPhoto(r);
      });
      tbody.appendChild(tr);
    });
    emptyNote.classList.toggle("hidden", visible > 0);
  }

  document.getElementById("table-search").addEventListener("input", function (e) {
    renderTable(e.target.value);
  });
  renderTable("");

  /* ---------------- photo modal ---------------- */
  const modal = document.getElementById("photo-modal");
  const modalImg = document.getElementById("modal-img");
  const modalCaption = document.getElementById("modal-caption");

  function openPhoto(r) {
    modalImg.src = r.photo_url;
    modalCaption.textContent =
      r.name + " — " + r.latitude.toFixed(6) + ", " + r.longitude.toFixed(6) +
      " (" + (r.gps_source === "exif" ? "EXIF geotag" : "Live GPS") + ")";
    modal.classList.remove("hidden");
  }
  window.__openPhoto = function (id) {
    const r = records.find(function (x) { return x.id === id; });
    if (r) openPhoto(r);
  };

  document.getElementById("modal-close").addEventListener("click", function () {
    modal.classList.add("hidden");
    modalImg.src = "";
  });
  modal.addEventListener("click", function (e) {
    if (e.target === modal) {
      modal.classList.add("hidden");
      modalImg.src = "";
    }
  });

  /* ---------------- helpers ---------------- */
  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function formatPhTime(iso) {
    if (!iso) return "—";
    try {
      const d = new Date(iso);
      return d.toLocaleString("en-PH", {
        timeZone: "Asia/Manila",
        year: "numeric", month: "short", day: "numeric",
        hour: "2-digit", minute: "2-digit",
      });
    } catch (e) {
      return iso;
    }
  }
})();
