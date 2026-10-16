"""
RAINfed-Tagging Alcala — Rainfed Rice Area Geotagging & Inventory
================================================================
Web application for the inventory of rainfed rice areas in Alcala, Cagayan.

Flow:
  * Farmers encode First / Middle / Last name, then submit a geotagged photo
    of their rainfed rice area (photo EXIF GPS and/or live device GPS).
  * The server STRICTLY validates that a real GPS fix exists before accepting.
  * Only the admin (username + password) can see the database and the map.

Run:  python3 app.py
"""

from __future__ import annotations

import csv
import io
import json
import os
import re
import sqlite3
import time
import uuid
from datetime import datetime, timezone
from functools import wraps

from flask import (
    Flask,
    abort,
    jsonify,
    redirect,
    render_template,
    request,
    send_file,
    session,
    url_for,
)
from PIL import Image, ImageOps, ExifTags
from werkzeug.security import check_password_hash, generate_password_hash
from werkzeug.utils import secure_filename

try:  # HEIC/HEIF support (iPhone photos)
    from pillow_heif import register_heif_opener

    register_heif_opener()
    HEIF_ENABLED = True
except Exception:  # pragma: no cover
    HEIF_ENABLED = False

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
BASE_DIR = os.path.abspath(os.path.dirname(__file__))
UPLOAD_FOLDER = os.path.join(BASE_DIR, "uploads")
DATA_FOLDER = os.path.join(BASE_DIR, "data")
DB_PATH = os.path.join(DATA_FOLDER, "rainfed_tagging.db")
SECRET_KEY_FILE = os.path.join(DATA_FOLDER, "secret_key.txt")

MAX_CONTENT_LENGTH = 16 * 1024 * 1024  # 16 MB per upload
ALLOWED_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif"}
THUMB_WIDTH = 320

# Strict GPS acceptance rules
REJECT_NULL_ISLAND = True          # (0, 0) is treated as "no GPS"
MAX_LIVE_ACCURACY_M = 500.0        # live GPS fix must be at least this precise
MIN_NAME_LEN = 2

# Alcala, Cagayan — default map view
ALCALA_CENTER = {"lat": 17.7033, "lng": 121.6686, "zoom": 12}

# Simple in-memory login rate limiting
LOGIN_MAX_FAILURES = 5
LOGIN_WINDOW_SEC = 15 * 60
_login_failures: dict[str, list[float]] = {}

GPS_TAG_NAMES = {
    1: "GPSLatitudeRef",
    2: "GPSLatitude",
    3: "GPSLongitudeRef",
    4: "GPSLongitude",
    5: "GPSAltitudeRef",
    6: "GPSAltitude",
    12: "GPSSpeedRef",
    13: "GPSSpeed",
}
for _id, _name in ExifTags.GPSTAGS.items():
    GPS_TAG_NAMES.setdefault(_id, _name)

EXIF_TAG_DATETIME_ORIGINAL = 36867
EXIF_TAG_DATETIME = 306

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = MAX_CONTENT_LENGTH
app.config["UPLOAD_FOLDER"] = UPLOAD_FOLDER


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _load_or_create_secret_key() -> str:
    os.makedirs(DATA_FOLDER, exist_ok=True)
    if os.environ.get("SECRET_KEY"):
        return os.environ["SECRET_KEY"]
    if os.path.exists(SECRET_KEY_FILE):
        with open(SECRET_KEY_FILE, "r", encoding="utf-8") as fh:
            key = fh.read().strip()
            if key:
                return key
    key = uuid.uuid4().hex + uuid.uuid4().hex
    with open(SECRET_KEY_FILE, "w", encoding="utf-8") as fh:
        fh.write(key)
    try:
        os.chmod(SECRET_KEY_FILE, 0o600)
    except OSError:
        pass
    return key


app.secret_key = _load_or_create_secret_key()


def get_db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db() -> None:
    os.makedirs(UPLOAD_FOLDER, exist_ok=True)
    os.makedirs(DATA_FOLDER, exist_ok=True)
    conn = get_db()
    try:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS admins (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                username      TEXT    UNIQUE NOT NULL,
                password_hash TEXT    NOT NULL,
                created_at    TEXT    NOT NULL
            );

            CREATE TABLE IF NOT EXISTS submissions (
                id                INTEGER PRIMARY KEY AUTOINCREMENT,
                client_id         TEXT    UNIQUE,
                first_name        TEXT    NOT NULL,
                middle_name       TEXT,
                last_name         TEXT    NOT NULL,
                photo_file        TEXT    NOT NULL,
                thumb_file        TEXT,
                original_filename TEXT,
                latitude          REAL    NOT NULL,
                longitude         REAL    NOT NULL,
                gps_source        TEXT    NOT NULL CHECK (gps_source IN ('exif','live')),
                accuracy_m        REAL,
                altitude_m        REAL,
                photo_taken_at    TEXT,
                submitted_at      TEXT    NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_submissions_time
                ON submissions (submitted_at);
            """
        )
        # Lightweight migration for databases created before client_id existed
        cols = {row[1] for row in conn.execute("PRAGMA table_info(submissions)")}
        if "client_id" not in cols:
            conn.execute("ALTER TABLE submissions ADD COLUMN client_id TEXT UNIQUE")
        # Bootstrap admin account (override with ADMIN_USERNAME / ADMIN_PASSWORD)
        cur = conn.execute("SELECT COUNT(*) AS n FROM admins")
        if cur.fetchone()["n"] == 0:
            username = os.environ.get("ADMIN_USERNAME", "admin").strip() or "admin"
            password = os.environ.get("ADMIN_PASSWORD", "admin123")
            conn.execute(
                "INSERT INTO admins (username, password_hash, created_at) VALUES (?, ?, ?)",
                (username, generate_password_hash(password), _utc_now()),
            )
        conn.commit()
    finally:
        conn.close()


def _utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def login_required(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        if not session.get("admin_id"):
            return redirect(url_for("admin_login", next=request.path))
        return view(*args, **kwargs)

    return wrapped


def _client_ip() -> str:
    return request.headers.get("X-Forwarded-For", request.remote_addr or "unknown").split(",")[0].strip()


def _login_blocked(ip: str) -> bool:
    now = time.time()
    stamps = [t for t in _login_failures.get(ip, []) if now - t < LOGIN_WINDOW_SEC]
    _login_failures[ip] = stamps
    return len(stamps) >= LOGIN_MAX_FAILURES


def _record_login_failure(ip: str) -> None:
    _login_failures.setdefault(ip, []).append(time.time())


# ---------------------------------------------------------------------------
# EXIF / GPS handling (strict)
# ---------------------------------------------------------------------------
def _dms_to_decimal(dms, ref) -> float | None:
    try:
        values = [float(x) for x in dms]
        if len(values) != 3:
            return None
        decimal = values[0] + values[1] / 60.0 + values[2] / 3600.0
        if ref in ("S", "W", b"S", b"W"):
            decimal = -decimal
        return decimal
    except (TypeError, ValueError):
        return None


def _to_float(value) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def extract_exif_meta(path: str) -> dict:
    """Return {lat, lon, altitude, taken_at} parsed from image EXIF (may be empty)."""
    meta: dict = {"lat": None, "lon": None, "altitude": None, "taken_at": None}
    try:
        img = Image.open(path)
    except Exception:
        return meta

    exif_obj = None
    try:
        exif_obj = img.getexif()
    except Exception:
        exif_obj = None
    if not exif_obj:
        return meta

    gps_ifd = {}
    try:
        gps_ifd = dict(exif_obj.get_ifd(0x8825))  # GPSInfo IFD
    except Exception:
        gps_ifd = {}
    if not gps_ifd:
        try:
            raw = exif_obj.get(34853)
            if hasattr(raw, "items"):
                gps_ifd = dict(raw)
        except Exception:
            gps_ifd = {}

    gps = {GPS_TAG_NAMES.get(k, k): v for k, v in gps_ifd.items()}

    lat = _dms_to_decimal(gps.get("GPSLatitude"), gps.get("GPSLatitudeRef"))
    lon = _dms_to_decimal(gps.get("GPSLongitude"), gps.get("GPSLongitudeRef"))
    meta["lat"], meta["lon"] = lat, lon

    alt = _to_float(gps.get("GPSAltitude"))
    if alt is not None and gps.get("GPSAltitudeRef") in (1, b"\x01"):
        alt = -alt
    meta["altitude"] = alt

    # EXIF timestamps live in the Exif sub-IFD
    taken = None
    try:
        exif_ifd = dict(exif_obj.get_ifd(0x8769))
        taken = exif_ifd.get(EXIF_TAG_DATETIME_ORIGINAL) or exif_ifd.get(EXIF_TAG_DATETIME)
    except Exception:
        taken = None
    if not taken:
        taken = exif_obj.get(EXIF_TAG_DATETIME_ORIGINAL) or exif_obj.get(EXIF_TAG_DATETIME)
    if isinstance(taken, bytes):
        taken = taken.decode("utf-8", "ignore")
    if isinstance(taken, str) and taken.strip():
        taken = taken.strip()
        for fmt in ("%Y:%m:%d %H:%M:%S", "%Y-%m-%d %H:%M:%S", "%Y:%m:%d"):
            try:
                meta["taken_at"] = datetime.strptime(taken, fmt).replace(tzinfo=timezone.utc).isoformat()
                break
            except ValueError:
                continue

    return meta


def valid_coordinates(lat, lon) -> bool:
    if lat is None or lon is None:
        return False
    try:
        lat_f, lon_f = float(lat), float(lon)
    except (TypeError, ValueError):
        return False
    if not (-90.0 <= lat_f <= 90.0) or not (-180.0 <= lon_f <= 180.0):
        return False
    if REJECT_NULL_ISLAND and abs(lat_f) < 1e-6 and abs(lon_f) < 1e-6:
        return False  # (0, 0) almost always means missing GPS
    return True


def _decimal_to_dms(value: float) -> tuple:
    value = abs(float(value))
    degrees = int(value)
    minutes_full = (value - degrees) * 60.0
    minutes = int(minutes_full)
    seconds = (minutes_full - minutes) * 60.0
    return (float(degrees), float(minutes), round(seconds, 4))


def stamp_exif_gps(path: str, lat: float, lon: float, altitude, taken_iso: str | None) -> None:
    """Write EXIF GPS (geotag) into the stored photo so the archive itself is geotagged.

    In-app camera captures (canvas JPEGs) carry no EXIF, so the GPS fix taken at
    capture time is stamped here — the saved photo becomes a true geotagged image.
    """
    try:
        img = Image.open(path)
        exif = Image.Exif()

        gps = {
            1: "N" if lat >= 0 else "S",
            2: _decimal_to_dms(lat),
            3: "E" if lon >= 0 else "W",
            4: _decimal_to_dms(lon),
            5: 0,
        }
        if altitude is not None:
            gps[6] = float(abs(altitude))
            gps[5] = 0 if altitude >= 0 else 1
        exif[0x8825] = gps

        stamp_str = None
        if taken_iso:
            try:
                stamp_str = (
                    datetime.fromisoformat(taken_iso)
                    .strftime("%Y:%m:%d %H:%M:%S")
                )
            except (ValueError, TypeError):
                stamp_str = None
        if not stamp_str:
            stamp_str = datetime.now(timezone.utc).strftime("%Y:%m:%d %H:%M:%S")
        exif[36867] = stamp_str  # DateTimeOriginal
        exif[306] = stamp_str    # DateTime
        exif[0x0131] = "RAINfed-Tagging Alcala"  # Software

        if img.mode not in ("RGB", "L"):
            img = img.convert("RGB")
        img.save(path, "JPEG", quality=90, exif=exif)
    except Exception:
        # Never fail the submission because of stamping; the DB keeps the coords.
        app.logger.warning("EXIF stamping failed for %s", path)


# ---------------------------------------------------------------------------
# Public: farmer submission
# ---------------------------------------------------------------------------
NAME_RE = re.compile(r"^[A-Za-zÀ-ÖØ-öø-ÿÑñ' .-]+$")


def _clean_name(value: str) -> str:
    return re.sub(r"\s+", " ", (value or "").strip())


def validate_name(value: str, field_label: str, required: bool) -> str | None:
    value = _clean_name(value)
    if not value:
        return f"{field_label} ay kinakailangan." if required else None
    if len(value) < MIN_NAME_LEN:
        return f"{field_label} ay masyadong maikli (kailangan ng {MIN_NAME_LEN}+ titik)."
    if len(value) > 80:
        return f"{field_label} ay masyadong mahaba (max 80 titik)."
    if not NAME_RE.match(value):
        return f"{field_label} ay may hindi tanggap na karakter."
    return None


@app.route("/")
def index():
    return render_template("index.html", heif_enabled=HEIF_ENABLED)


@app.route("/api/submit", methods=["POST"])
def api_submit():
    """Accept a farmer submission. Strictly requires a real GPS source.

    Policy: photos must come from the app's built-in geotagged camera
    (`capture_source == 'camera'`) — gallery/file uploads are not accepted.
    `client_id` (UUID from the device) makes offline sync retries idempotent.
    """
    first_name = _clean_name(request.form.get("first_name", ""))
    middle_name = _clean_name(request.form.get("middle_name", ""))
    last_name = _clean_name(request.form.get("last_name", ""))
    capture_source = (request.form.get("capture_source") or "").strip().lower()
    client_id = (request.form.get("client_id") or "").strip() or None
    captured_at = (request.form.get("captured_at") or "").strip() or None

    if len(client_id or "") > 64:
        client_id = client_id[:64]

    errors = []
    if capture_source != "camera":
        errors.append(
            "TINANGGIHAN: Tanging built-in geotag camera ng app ang maaaring gamitin. "
            "Bawal ang pag-upload ng larawan mula sa gallery/files."
        )
    for value, label, required in (
        (first_name, "First Name", True),
        (middle_name, "Middle Name", False),
        (last_name, "Last Name", True),
    ):
        err = validate_name(value, label, required)
        if err:
            errors.append(err)

    photo = request.files.get("photo")
    if photo is None or not photo.filename:
        errors.append("Kinakailangan ng geotag na larawan ng inyong rainfed rice area.")
    else:
        ext = os.path.splitext(photo.filename)[1].lower()
        if ext not in ALLOWED_EXTENSIONS:
            errors.append("Hindi tanggap na uri ng larawan. Gamit ang JPEG, PNG, o WebP.")

    # --- GPS sources ------------------------------------------------------
    def parse_float(key):
        raw = (request.form.get(key) or "").strip()
        if not raw:
            return None
        try:
            return float(raw)
        except ValueError:
            return None

    live_lat = parse_float("live_lat")
    live_lon = parse_float("live_lon")
    live_acc = parse_float("live_accuracy")

    if errors:
        return jsonify({"ok": False, "errors": errors}), 400

    # --- Offline-sync idempotency: a retried submission is stored once -----
    if client_id:
        conn = get_db()
        try:
            existing = conn.execute(
                "SELECT id, gps_source, latitude, longitude FROM submissions WHERE client_id = ?",
                (client_id,),
            ).fetchone()
        finally:
            conn.close()
        if existing:
            return jsonify(
                {
                    "ok": True,
                    "duplicate": True,
                    "message": "Naitala na ang datos na ito (galing sa offline sync).",
                    "id": existing["id"],
                    "gps_source": existing["gps_source"],
                    "latitude": existing["latitude"],
                    "longitude": existing["longitude"],
                }
            )

    # --- Store the photo in a staging path and validate it -----------------
    ext = os.path.splitext(photo.filename)[1].lower()
    token = uuid.uuid4().hex
    staged_name = f"{token}{ext}"
    staged_path = os.path.join(UPLOAD_FOLDER, staged_name)
    photo.save(staged_path)

    def reject(msg: str, code: int = 422):
        try:
            os.remove(staged_path)
        except OSError:
            pass
        return jsonify({"ok": False, "errors": [msg]}), code

    # 1. It must be a real, readable image.
    try:
        with Image.open(staged_path) as probe:
            probe.verify()
        img = Image.open(staged_path)
        img.load()
    except Exception:
        return reject("Sira o hindi larawan ang na-upload na file. Kumuha muli ng litrato.")

    # 2. EXIF GPS first (the photo's own geotag), then live GPS fallback.
    meta = extract_exif_meta(staged_path)
    gps_source = None
    lat = lon = None
    accuracy_m = None
    altitude_m = meta.get("altitude")

    if valid_coordinates(meta["lat"], meta["lon"]):
        gps_source = "exif"
        lat, lon = float(meta["lat"]), float(meta["lon"])
    elif valid_coordinates(live_lat, live_lon):
        if live_acc is not None and live_acc > MAX_LIVE_ACCURACY_M:
            return reject(
                "Masyadong malabo ang live GPS na nakuha "
                f"({live_acc:.0f} m, max {MAX_LIVE_ACCURACY_M:.0f} m). "
                "Subukan muli sa open area o labas ng bahay."
            )
        gps_source = "live"
        lat, lon = float(live_lat), float(live_lon)
        accuracy_m = live_acc
    else:
        return reject(
            "TINANGGIHAN: Walang GPS ang larawan at walang valid na live na lokasyon. "
            "Siguraduhing naka-on ang Location Services at Geotagging ng camera ng inyong "
            "cellphone bago kumuha ng litrato, o pindutin ang 'Kunin ang Lokasyon' bago mag-take ng photo."
        )

    # 3. Final coordinate sanity check (never trust partial data).
    if not valid_coordinates(lat, lon):
        return reject("TINANGGIHAN: Hindi valid ang GPS coordinates ng inyong isinumite.")

    # --- Normalize + save --------------------------------------------------
    try:
        img = ImageOps.exif_transpose(img)
    except Exception:
        pass

    if img.mode not in ("RGB", "L"):
        img = img.convert("RGB")
    final_name = f"{token}.jpg"
    final_path = os.path.join(UPLOAD_FOLDER, final_name)
    img.save(final_path, "JPEG", quality=90)

    # Stamp the capture-time GPS into the stored photo (real EXIF geotag).
    taken_at = meta.get("taken_at") or captured_at
    stamp_exif_gps(final_path, lat, lon, altitude_m, taken_at)

    thumb_name = f"{token}_thumb.jpg"
    thumb_path = os.path.join(UPLOAD_FOLDER, thumb_name)
    thumb = img.copy()
    thumb.thumbnail((THUMB_WIDTH, THUMB_WIDTH * 10))
    thumb.convert("RGB").save(thumb_path, "JPEG", quality=82)

    for stale in (staged_path,):
        if os.path.exists(stale) and stale != final_path:
            try:
                os.remove(stale)
            except OSError:
                pass

    original_filename = secure_filename(photo.filename) or None

    conn = get_db()
    try:
        try:
            cur = conn.execute(
                """
                INSERT INTO submissions (
                    client_id, first_name, middle_name, last_name,
                    photo_file, thumb_file, original_filename,
                    latitude, longitude, gps_source, accuracy_m, altitude_m,
                    photo_taken_at, submitted_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    client_id,
                    first_name,
                    middle_name or None,
                    last_name,
                    final_name,
                    thumb_name,
                    original_filename,
                    lat,
                    lon,
                    gps_source,
                    accuracy_m,
                    altitude_m,
                    taken_at,
                    _utc_now(),
                ),
            )
            conn.commit()
            submission_id = cur.lastrowid
        except sqlite3.IntegrityError:
            # Parallel sync retries raced past the SELECT above — already stored.
            conn.rollback()
            existing = conn.execute(
                "SELECT id, gps_source, latitude, longitude FROM submissions WHERE client_id = ?",
                (client_id,),
            ).fetchone()
            if existing:
                return jsonify(
                    {
                        "ok": True,
                        "duplicate": True,
                        "message": "Naitala na ang datos na ito (galing sa offline sync).",
                        "id": existing["id"],
                        "gps_source": existing["gps_source"],
                        "latitude": existing["latitude"],
                        "longitude": existing["longitude"],
                    }
                )
            raise
    finally:
        conn.close()

    return jsonify(
        {
            "ok": True,
            "message": "Matagumpay na naitala ang inyong rainfed rice area. Salamat, magsasaka!",
            "id": submission_id,
            "gps_source": gps_source,
            "latitude": lat,
            "longitude": lon,
        }
    )


# ---------------------------------------------------------------------------
# Admin: authentication
# ---------------------------------------------------------------------------
@app.route("/admin/login", methods=["GET", "POST"])
def admin_login():
    if session.get("admin_id"):
        return redirect(url_for("admin_dashboard"))

    error = None
    if request.method == "POST":
        ip = _client_ip()
        if _login_blocked(ip):
            error = "Masyadong maraming subok. Maghintay ng ilang minuto bago muling sumubok."
        else:
            username = (request.form.get("username") or "").strip()
            password = request.form.get("password") or ""
            conn = get_db()
            try:
                row = conn.execute(
                    "SELECT * FROM admins WHERE username = ?", (username,)
                ).fetchone()
            finally:
                conn.close()
            if row and check_password_hash(row["password_hash"], password):
                session.clear()
                session["admin_id"] = row["id"]
                session["admin_username"] = row["username"]
                _login_failures.pop(ip, None)
                nxt = request.args.get("next") or url_for("admin_dashboard")
                if not nxt.startswith("/"):
                    nxt = url_for("admin_dashboard")
                return redirect(nxt)
            _record_login_failure(ip)
            error = "Maling username o password."

    return render_template("admin_login.html", error=error)


@app.route("/admin/logout")
def admin_logout():
    session.clear()
    return redirect(url_for("admin_login"))


# ---------------------------------------------------------------------------
# Admin: dashboard, photos, exports
# ---------------------------------------------------------------------------
@app.route("/admin/")
@login_required
def admin_dashboard():
    conn = get_db()
    try:
        rows = conn.execute(
            """
            SELECT id, first_name, middle_name, last_name,
                   latitude, longitude, gps_source, accuracy_m, altitude_m,
                   photo_taken_at, submitted_at, photo_file
            FROM submissions
            ORDER BY submitted_at DESC
            """
        ).fetchall()
    finally:
        conn.close()

    records = []
    for r in rows:
        name = " ".join(
            p for p in (r["first_name"], r["middle_name"] or "", r["last_name"]) if p
        )
        records.append(
            {
                "id": r["id"],
                "name": name,
                "latitude": r["latitude"],
                "longitude": r["longitude"],
                "gps_source": r["gps_source"],
                "accuracy_m": r["accuracy_m"],
                "altitude_m": r["altitude_m"],
                "photo_taken_at": r["photo_taken_at"],
                "submitted_at": r["submitted_at"],
                "photo_url": url_for("admin_photo", pid=r["id"]),
                "thumb_url": url_for("admin_photo", pid=r["id"], thumb=1),
            }
        )

    return render_template(
        "admin_dashboard.html",
        records_json=json.dumps(records),
        total=len(records),
        center=ALCALA_CENTER,
        username=session.get("admin_username", "admin"),
    )


def _get_submission_or_404(pid: int):
    conn = get_db()
    try:
        row = conn.execute("SELECT * FROM submissions WHERE id = ?", (pid,)).fetchone()
    finally:
        conn.close()
    if row is None:
        abort(404)
    return row


@app.route("/admin/photo/<int:pid>")
@login_required
def admin_photo(pid):
    row = _get_submission_or_404(pid)
    want_thumb = request.args.get("thumb") not in (None, "", "0", "false")
    filename = row["thumb_file"] if (want_thumb and row["thumb_file"]) else row["photo_file"]
    path = os.path.join(UPLOAD_FOLDER, filename)
    if not os.path.exists(path):
        abort(404)
    return send_file(path, mimetype="image/jpeg", max_age=60)


@app.route("/admin/export/csv")
@login_required
def export_csv():
    conn = get_db()
    try:
        rows = conn.execute(
            """
            SELECT id, first_name, middle_name, last_name,
                   latitude, longitude, gps_source, accuracy_m, altitude_m,
                   photo_taken_at, submitted_at, photo_file
            FROM submissions ORDER BY submitted_at DESC
            """
        ).fetchall()
    finally:
        conn.close()

    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(
        [
            "id",
            "first_name",
            "middle_name",
            "last_name",
            "latitude",
            "longitude",
            "gps_source",
            "accuracy_m",
            "altitude_m",
            "photo_taken_at",
            "submitted_at",
            "photo_file",
        ]
    )
    for r in rows:
        writer.writerow(
            [
                r["id"],
                r["first_name"],
                r["middle_name"] or "",
                r["last_name"],
                r["latitude"],
                r["longitude"],
                r["gps_source"],
                r["accuracy_m"] if r["accuracy_m"] is not None else "",
                r["altitude_m"] if r["altitude_m"] is not None else "",
                r["photo_taken_at"] or "",
                r["submitted_at"],
                r["photo_file"],
            ]
        )

    stamp = datetime.now(timezone.utc).strftime("%Y%m%d")
    return send_file(
        io.BytesIO(buf.getvalue().encode("utf-8-sig")),
        mimetype="text/csv; charset=utf-8",
        as_attachment=True,
        download_name=f"rainfed_tagging_alcala_submissions_{stamp}.csv",
    )


@app.route("/admin/export/geojson")
@login_required
def export_geojson():
    conn = get_db()
    try:
        rows = conn.execute(
            """
            SELECT id, first_name, middle_name, last_name,
                   latitude, longitude, gps_source, accuracy_m, altitude_m,
                   photo_taken_at, submitted_at
            FROM submissions ORDER BY submitted_at DESC
            """
        ).fetchall()
    finally:
        conn.close()

    features = []
    for r in rows:
        features.append(
            {
                "type": "Feature",
                "geometry": {
                    "type": "Point",
                    "coordinates": [r["longitude"], r["latitude"]],
                },
                "properties": {
                    "id": r["id"],
                    "first_name": r["first_name"],
                    "middle_name": r["middle_name"] or "",
                    "last_name": r["last_name"],
                    "gps_source": r["gps_source"],
                    "accuracy_m": r["accuracy_m"],
                    "altitude_m": r["altitude_m"],
                    "photo_taken_at": r["photo_taken_at"],
                    "submitted_at": r["submitted_at"],
                },
            }
        )

    collection = {
        "type": "FeatureCollection",
        "name": "RAINfed-Tagging Alcala — Rainfed Rice Areas",
        "crs": {"type": "name", "properties": {"name": "urn:ogc:def:crs:OGC:1.3:CRS84"}},
        "features": features,
    }
    payload = json.dumps(collection, ensure_ascii=False, indent=2).encode("utf-8")

    stamp = datetime.now(timezone.utc).strftime("%Y%m%d")
    return send_file(
        io.BytesIO(payload),
        mimetype="application/geo+json",
        as_attachment=True,
        download_name=f"rainfed_tagging_alcala_points_{stamp}.geojson",
    )


@app.route("/health")
def health():
    return jsonify({"status": "ok", "app": "RAINfed-Tagging Alcala"})


@app.route("/sw.js")
def service_worker():
    """Serve the service worker from the site root so its scope covers the app."""
    return send_file(
        os.path.join(BASE_DIR, "sw.js"),
        mimetype="text/javascript",
        max_age=0,
    )


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    init_db()
    port = int(os.environ.get("PORT", 5000))
    print(f"* RAINfed-Tagging Alcala running on http://0.0.0.0:{port}")
    app.run(host="0.0.0.0", port=port, debug=False)
