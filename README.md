# 🌾 RAINfed-Tagging Alcala

**RAINfed-Tagging Alcala** — *Rainfed Rice Area Geotagging &amp; Inventory — Alcala, Cagayan*

A web application for the **Inventory of Rainfed Rice Areas in Alcala, Cagayan**. Farmers
geotag their rainfed rice areas using their phone camera (with GPS), and only the admin can
view the collected database on a Leaflet map and export the points.

---

## ✨ Features

### Para sa Magsasaka (Farmer side — public, anyone can send data)
1. **Name + address first** — the farmer enters **First Name, Middle Name, Last Name** and
   **Address (Tirahan)** (Purok/Sitio, Barangay, Municipality, Province) before anything else.
2. **Built-in Geotag Camera** — photos can ONLY be taken with the app's in-app camera
   (`getUserMedia`). **Gallery/file uploads are not allowed** — the server rejects any
   submission without `capture_source=camera`, and the UI has no file picker at all.
3. **Geotag at capture** — right before the shutter, the app captures a fresh device GPS fix
   (browser Geolocation API). That GPS is stamped into the photo as real **EXIF GPS** on the
   server, so every stored photo is a true geotagged image. A **compass overlay** on the
   camera shows the direction the lens is pointing (N/NE/E/...); that **heading (0–360°)**
   is recorded with the submission and appears in the admin map popups and both exports.
4. **Strict GPS acceptance** — a submission is **rejected** unless it has a real GPS source:
   - ✅ accepted: capture-time **live GPS** (accuracy ≤ 500 m) → `gps_source = live` (camera geotag)
   - ✅ accepted: photo **EXIF GPS** if present → recorded as `gps_source = exif`
   - ❌ rejected: no EXIF GPS **and** no live GPS
   - ❌ rejected: invalid coordinates, (0, 0) "null island", out-of-range lat/lon,
     corrupt/non-image files, oversized uploads (> 16 MB), or non-camera uploads
   - The **server re-validates everything** (the client-side check is only for fast feedback).
5. Photos are uploaded to the server and stored with a random UUID filename + thumbnail,
   with the GPS geotag stamped as EXIF into the archived JPEG.

### 📴 Offline mode para sa field (sync when online)
Field work in remote areas of Alcala often has no signal — the app still works:
- A **service worker** caches the app shell, so the farmer form + camera work fully offline.
- Submissions made offline are queued in **IndexedDB** on the device (photo + names + GPS).
  A status bar shows **Online/Offline** and the **"Nakabinbin" (pending)** count.
- When connectivity returns, the queue **auto-syncs** (page-side `online` event + the
  **Background Sync API** in the service worker, which can upload even after the page is
  closed). The farmer can also press **"I-sync Ngayon"** manually.
- Sync is **idempotent**: each submission carries a device-generated `client_id`, and the
  server stores it at most once — retries never create duplicates.

### Para sa Admin (Admin side — login required)
- **Username + password** login (passwords stored as salted hashes, with login rate-limiting).
- **Leaflet map** showing every geotagged rainfed rice area (OpenStreetMap base map,
  centered on Alcala, Cagayan by default).
- **Database table** of all submissions: name, coordinates, GPS source, accuracy,
  submission time (Asia/Manila), photo thumbnail (click to view full photo).
- **Exports:**
  - **CSV** export of all records (`UTF-8 BOM`, Excel-friendly)
  - **GeoJSON** export of the map points (FeatureCollection of Point features — works in
    QGIS, ArcGIS, Google Earth, kepler.gl, etc.)
  - **All geotagged photos as a ZIP** archive (with a `manifest.csv` of names/IDs)
- **Photo viewing & download:** geotagged photos are stored on the server and shown
  **directly in the map popups** (click to enlarge in the photo viewer). The admin can
  **download any photo** from the map popup or the photo viewer — the file keeps its
  GPS-stamped EXIF geotag.
- **Anyone can send data, but only the admin can see the database.**

### Instructions
- Full **Tagalog instructions ("Paano Gamitin")** are shown on the farmer page.

---

## 🧰 Tech Stack

| Layer      | Technology |
|------------|------------|
| Backend    | Python 3 / Flask |
| Database   | SQLite (file-based, zero config) |
| Images     | Pillow (+ pillow-heif for iPhone HEIC), EXIF GPS parsing **and stamping** |
| Frontend   | Vanilla HTML/CSS/JS (mobile-friendly), in-app camera via `getUserMedia` |
| Offline    | Service Worker (app-shell cache + Background Sync) + IndexedDB submission queue |
| Map        | [Leaflet](https://leafletjs.com/) + OpenStreetMap tiles |
| Auth       | Flask sessions, werkzeug password hashing |

Leaflet and exifr are vendored under `static/vendor/` (no CDN needed for the app itself;
only the OSM map tiles load from the internet in the browser).

---

## 🚀 Setup & Run

```bash
pip install -r requirements.txt
python3 app.py
```

Then open `http://localhost:5000` (farmer page) and `http://localhost:5000/admin/` (admin).

### Default admin account

| Username | Password   |
|----------|------------|
| `admin`  | `admin123` |

⚠️ **Change this immediately** for any real deployment — either set environment variables
before the first run:

```bash
ADMIN_USERNAME=myadmin ADMIN_PASSWORD=a-strong-password python3 app.py
```

(delete `data/rainfed_tagging.db` first if the admin row was already created), or update the
`admins` table directly. Other useful env vars: `PORT` (default 5000), `SECRET_KEY`
(auto-generated and persisted in `data/secret_key.txt` otherwise).

---

## 📁 Project Structure

```
RainfedInventory/
├── app.py                     # Flask app: routes, strict GPS validation, EXIF parse + stamp
├── sw.js                      # Service Worker: offline shell + background sync
├── requirements.txt
├── templates/
│   ├── base.html              # shared layout + SW registration
│   ├── index.html             # farmer form (camera-only) + Tagalog instructions
│   ├── admin_login.html
│   └── admin_dashboard.html   # Leaflet map + database table + exports
├── static/
│   ├── css/style.css
│   ├── js/farmer.js           # farmer flow (name → in-app camera → submit/sync)
│   ├── js/offline-store.js    # IndexedDB offline queue (page + service worker)
│   ├── js/admin.js            # map markers, table, photo modal
│   └── vendor/                # leaflet + exifr (vendored)
├── uploads/                   # geotagged photos + thumbnails (gitignored)
├── data/                      # SQLite database + secret key (gitignored)
└── tests/smoke_test.py        # 54 automated checks (strictness, camera policy, sync, auth)
```

Run the tests with:

```bash
python3 tests/smoke_test.py
```

---

## 🔒 Strict Geotag Rules (server-side)

1. Photos must come from the app's **built-in camera** (`capture_source=camera`) —
   gallery/file uploads are rejected.
2. The file must be a real, readable image (JPEG/PNG/WebP/HEIC).
3. GPS is taken from **photo EXIF** first (tag `GPSInfo`); if absent, from the **live GPS**
   captured at shutter time and submitted with the form.
4. Coordinates must be within valid ranges; **(0, 0) is rejected**.
5. Live GPS accuracy must be **≤ 500 m**.
6. If neither source provides valid coordinates → **submission rejected** with a Tagalog
   error message.
7. The capture-time GPS is **stamped as EXIF GPS** into the archived photo — every stored
   image is a true geotagged photo.

## 🗺️ Data Model

`submissions(id, client_id, first_name, middle_name, last_name, address, photo_file,
thumb_file, original_filename, latitude, longitude, gps_source, accuracy_m, altitude_m,
heading_deg, photo_taken_at, submitted_at)`

`client_id` (UUID generated on the device) makes offline sync idempotent — retried
submissions are stored at most once.

---

## 📖 Tagalog Quick Guide (shown in-app)

1. Ilagay ang **First Name, Middle Name, Last Name** at **Address (Tirahan)** → *Susunod*.
2. I-on ang **Location Services** ng cellphone.
3. Pindutin ang **"Buksan ang Camera"** — *built-in camera lamang, bawal ang upload*.
4. Pindutin ang **"KUNAN"** — kinukuha ng app ang GPS bago kumuha ng larawan (geotag).
5. Pindutin ang **"I-submit ang Datos"** — kahit **offline**! Nai-save sa cellphone at
   **auto-sync** kapag may internet.
6. Ang **admin lamang** ang makakakita ng database at mapa.

---

## 📱 Offline APK Edition (no server, phone storage only)

The `android/` folder contains a **standalone Android APK version** of the app that runs
**100% offline with no server**:

- All data (names, address, geotagged photo with EXIF GPS + compass heading) is stored
  **inside the phone** (IndexedDB in the app). Nothing is uploaded anywhere.
- Same strict rules: **in-app camera only** (no gallery upload), GPS required at capture,
  compass heading recorded, EXIF GPS stamped into the photo (including `GPSImgDirection`).
- **Admin tab (PIN `1234`)** shows the map, database table, photo viewer, and exports:
  **CSV**, **GeoJSON**, and **all photos as ZIP** — saved to the phone's *Downloads* folder.
- The only thing that needs internet is the Leaflet map background (OSM tiles); the data,
  photos, and exports work completely offline.

### Download & install
Grab the APK from the repository's **GitHub Releases** page (or from the "Build Android
APK" Actions run artifact), send it to the Android phone, tap to install (allow
"install unknown apps" for your browser/file manager), and grant **Camera** + **Location**
permissions when asked.

### Building the APK yourself
The APK is built by GitHub Actions (`.github/workflows/build-apk.yml`) on every push that
touches `android/` — download `rainfed-tagging-alcala-apk` from the run's Artifacts.
To build locally: open `android/` in Android Studio (it will generate the Gradle wrapper),
then `gradle assembleDebug` or `./gradlew assembleDebug`. The output is
`android/app/build/outputs/apk/debug/app-debug.apk` (debug-signed and installable; add
your own release keystore for distribution).

### Notes & caveats
- WebView camera (`getUserMedia`) requires granting the Camera permission; on some
  heavily customized OEM Android builds the in-app preview may fall back poorly — the
  app shows a clear Tagalog error if the camera is blocked.
- The offline app stores a default admin PIN `1234` (visible in the UI). Change
  `ADMIN_PIN` in `assets/www/js/local-app.js` before distributing.
- Data lives in the app's private storage — remind users to **export regularly** (CSV/
  GeoJSON/ZIP) as backup; uninstalling the app erases the records.

---

- Run behind **HTTPS** (e.g., nginx + Let's Encrypt, or gunicorn behind a proxy) — browsers
  only allow the Geolocation and Camera APIs on secure origins (required for the in-app
  geotag camera and offline sync).
- Consider adding CSRF protection (Flask-WTF) and persistent rate limiting (Flask-Limiter)
  before exposing the app publicly.
- `uploads/` and `data/` are intentionally excluded from Git — back them up separately.
