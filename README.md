# 🌾 RAINfed-Tagging Alcala

**RAINfed-Tagging Alcala** — *Rainfed Rice Area Geotagging &amp; Inventory — Alcala, Cagayan*

A web application for the **Inventory of Rainfed Rice Areas in Alcala, Cagayan**. Farmers
geotag their rainfed rice areas using their phone camera (with GPS), and only the admin can
view the collected database on a Leaflet map and export the points.

---

## ✨ Features

### Para sa Magsasaka (Farmer side — public, anyone can send data)
1. **Name first** — the farmer enters **First Name, Middle Name, Last Name** before anything else.
2. **Geotag step** — the farmer:
   - captures **live GPS** from the device (browser Geolocation API), and/or
   - takes a **geotagged photo** of the rainfed rice area using the phone's built-in camera
     (`capture="environment"`, EXIF GPS a.k.a. geotag).
3. **Strict geotag acceptance** — a submission is **rejected** unless it has a real GPS source:
   - ✅ accepted: photo **EXIF GPS (geotag)** → recorded as `gps_source = exif`
   - ✅ accepted: no EXIF GPS but a valid **live GPS fix** (accuracy ≤ 500 m) captured at
     submission time → recorded as `gps_source = live`
   - ❌ rejected: no EXIF GPS **and** no live GPS
   - ❌ rejected: invalid coordinates, (0, 0) "null island", out-of-range lat/lon,
     corrupt/non-image files, oversized uploads (> 16 MB)
   - The **server re-validates everything** (the client-side check is only for fast feedback).
4. Photos are uploaded to the server and stored with a random UUID filename + thumbnail.

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
- **Anyone can send data, but only the admin can see the database.**

### Instructions
- Full **Tagalog instructions ("Paano Gamitin")** are shown on the farmer page.

---

## 🧰 Tech Stack

| Layer      | Technology |
|------------|------------|
| Backend    | Python 3 / Flask |
| Database   | SQLite (file-based, zero config) |
| Images     | Pillow (+ pillow-heif for iPhone HEIC), EXIF GPS parsing |
| Frontend   | Vanilla HTML/CSS/JS (mobile-friendly), [exifr](https://github.com/MikeKovarik/exifr) for client-side EXIF checks |
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
├── app.py                     # Flask app: routes, strict GPS validation, EXIF parsing
├── requirements.txt
├── templates/
│   ├── base.html              # shared layout
│   ├── index.html             # farmer form + Tagalog instructions
│   ├── admin_login.html
│   └── admin_dashboard.html   # Leaflet map + database table + exports
├── static/
│   ├── css/style.css
│   ├── js/farmer.js           # farmer flow (name → geotag → submit)
│   ├── js/admin.js            # map markers, table, photo modal
│   └── vendor/                # leaflet + exifr (vendored)
├── uploads/                   # geotagged photos + thumbnails (gitignored)
├── data/                      # SQLite database + secret key (gitignored)
└── tests/smoke_test.py        # 41 automated checks (strictness, auth, exports)
```

Run the tests with:

```bash
python3 tests/smoke_test.py
```

---

## 🔒 Strict Geotag Rules (server-side)

1. The file must be a real, readable image (JPEG/PNG/WebP/HEIC).
2. GPS is taken from **photo EXIF** first (tag `GPSInfo`); if absent, from the **live GPS**
   submitted with the form.
3. Coordinates must be within valid ranges; **(0, 0) is rejected**.
4. Live GPS accuracy must be **≤ 500 m**.
5. If neither source provides valid coordinates → **submission rejected** with a Tagalog
   error message.

## 🗺️ Data Model

`submissions(id, first_name, middle_name, last_name, photo_file, thumb_file,
original_filename, latitude, longitude, gps_source, accuracy_m, altitude_m,
photo_taken_at, submitted_at)`

---

## 📖 Tagalog Quick Guide (shown in-app)

1. Ilagay ang **First Name, Middle Name, Last Name** → *Susunod*.
2. I-on ang **Location Services** at **geotagging** ng camera sa cellphone.
3. Pindutin ang **"Kunin ang Lokasyon"** (live GPS) — mas mainam sa open area.
4. Pindutin ang **"Kunan ng Larawan"** at kuhanan ang rainfed rice area.
5. Kung may **EXIF GPS** o **live GPS**, pindutin ang **"I-submit ang Datos"**.
6. Ang **admin lamang** ang makakakita ng database at mapa.

---

## ⚠️ Notes for Production

- Run behind **HTTPS** (e.g., nginx + Let's Encrypt, or gunicorn behind a proxy) — browsers
  only allow the Geolocation API on secure origins.
- Consider adding CSRF protection (Flask-WTF) and persistent rate limiting (Flask-Limiter)
  before exposing the app publicly.
- `uploads/` and `data/` are intentionally excluded from Git — back them up separately.
