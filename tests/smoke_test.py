"""Smoke tests for RAINfed-Tagging Alcala — strict geotag acceptance, camera-only, offline sync."""
import io
import os
import sys

sys.path.insert(0, "/home/user/RainfedInventory")
os.chdir("/home/user/RainfedInventory")

from PIL import Image
from app import app, init_db, extract_exif_meta, valid_coordinates, UPLOAD_FOLDER

init_db()
client = app.test_client()

passed, failed = 0, 0


def check(name, cond, extra=""):
    global passed, failed
    if cond:
        passed += 1
        print(f"  PASS  {name}")
    else:
        failed += 1
        print(f"  FAIL  {name}  {extra}")


def make_jpeg_with_gps() -> bytes:
    img = Image.new("RGB", (640, 480), (60, 140, 60))
    exif = Image.Exif()
    exif[0x8825] = {
        1: "N", 2: (17.0, 42.0, 11.88),
        3: "E", 4: (121.0, 40.0, 7.56),
        5: 0, 6: 42.0,
    }
    exif[36867] = "2026:10:16 08:30:00"
    buf = io.BytesIO()
    img.save(buf, "JPEG", exif=exif)
    return buf.getvalue()


def make_jpeg_no_gps() -> bytes:
    img = Image.new("RGB", (640, 480), (140, 60, 60))
    buf = io.BytesIO()
    img.save(buf, "JPEG")
    return buf.getvalue()


def make_png_no_gps() -> bytes:
    img = Image.new("RGB", (320, 240), (60, 60, 140))
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()


def multipart(photo_bytes, filename, form: dict):
    data = {"photo": (io.BytesIO(photo_bytes), filename)}
    data.update({k: str(v) for k, v in form.items()})
    return data


NAME = {"first_name": "Juan", "middle_name": "Santos", "last_name": "Dela Cruz",
        "capture_source": "camera"}

print("== EXIF extraction ==")
with open("/tmp/t_gps.jpg", "wb") as fh:
    fh.write(make_jpeg_with_gps())
meta = extract_exif_meta("/tmp/t_gps.jpg")
check("EXIF lat parsed", meta["lat"] is not None and abs(meta["lat"] - 17.7033) < 0.01, str(meta))
check("EXIF lon parsed", meta["lon"] is not None and abs(meta["lon"] - 121.6686) < 0.01, str(meta))
check("EXIF taken_at parsed", meta["taken_at"] is not None, str(meta))
check("EXIF altitude parsed", meta["altitude"] is not None, str(meta))

print("== valid_coordinates ==")
check("rejects None", not valid_coordinates(None, 1.0))
check("rejects null island", not valid_coordinates(0.0, 0.0))
check("rejects out of range", not valid_coordinates(91.0, 10.0))
check("accepts Alcala", valid_coordinates(17.7033, 121.6686))

print("== POST /api/submit: camera-only policy ==")
# Without capture_source=camera -> rejected (no gallery uploads)
r = client.post("/api/submit",
                data=multipart(make_jpeg_no_gps(), "up.jpg",
                               {"first_name": "Juan", "middle_name": "", "last_name": "Cruz",
                                "live_lat": "17.71", "live_lon": "121.67", "live_accuracy": "20"}),
                content_type="multipart/form-data")
j = r.get_json()
check("upload without capture_source rejected", r.status_code == 400 and not j.get("ok"),
      f"{r.status_code} {j}")
check("camera-only error mentions camera",
      any("built-in" in e for e in (j.get("errors") or [])), str(j))

# capture_source=upload (explicit gallery) -> rejected
form = dict(NAME, capture_source="upload", live_lat="17.71", live_lon="121.67", live_accuracy="20")
r = client.post("/api/submit", data=multipart(make_jpeg_no_gps(), "up2.jpg", form),
                content_type="multipart/form-data")
check("capture_source=upload rejected", r.status_code == 400, f"{r.status_code}")

print("== POST /api/submit: strict GPS ==")
# 1. Photo with EXIF GPS -> accept (source exif)
r = client.post("/api/submit", data=multipart(make_jpeg_with_gps(), "field1.jpg", NAME),
                content_type="multipart/form-data")
j = r.get_json()
check("EXIF photo accepted", r.status_code == 200 and j.get("ok"), f"{r.status_code} {j}")
check("gps_source=exif", j.get("gps_source") == "exif", str(j))
check("coords near Alcala", abs(j.get("latitude", 0) - 17.7033) < 0.01, str(j))

# 2. Photo WITHOUT GPS + no live GPS -> reject
r = client.post("/api/submit", data=multipart(make_jpeg_no_gps(), "field2.jpg", NAME),
                content_type="multipart/form-data")
j = r.get_json()
check("no-GPS photo rejected", r.status_code == 422 and not j.get("ok"), f"{r.status_code} {j}")

# 3. Photo WITHOUT GPS + valid live GPS -> accept (source live = camera geotag)
form = dict(NAME, live_lat="17.710000", live_lon="121.670000", live_accuracy="25",
            captured_at="2026-10-16T10:00:00+00:00")
r = client.post("/api/submit", data=multipart(make_jpeg_no_gps(), "field3.jpg", form),
                content_type="multipart/form-data")
j = r.get_json()
check("no-EXIF + live GPS accepted", r.status_code == 200 and j.get("ok"), f"{r.status_code} {j}")
check("gps_source=live", j.get("gps_source") == "live", str(j))
camera_upload_id = j.get("id")

# 3b. The stored photo must now be a REAL geotagged image (EXIF stamped server-side)
if camera_upload_id:
    row_path = None
    conn = __import__("app").get_db()
    try:
        row = conn.execute("SELECT photo_file FROM submissions WHERE id = ?", (camera_upload_id,)).fetchone()
        row_path = os.path.join(UPLOAD_FOLDER, row["photo_file"]) if row else None
    finally:
        conn.close()
    if row_path and os.path.exists(row_path):
        stamped = extract_exif_meta(row_path)
        check("stored photo has EXIF GPS (stamped)",
              abs(stamped["lat"] - 17.71) < 0.01 and abs(stamped["lon"] - 121.67) < 0.01, str(stamped))
        check("stamped EXIF has taken_at", stamped["taken_at"] is not None, str(stamped))
    else:
        check("stored photo has EXIF GPS (stamped)", False, "photo file missing")
else:
    check("stored photo has EXIF GPS (stamped)", False, "no upload id")

# 4. Live GPS with terrible accuracy -> reject
form = dict(NAME, live_lat="17.71", live_lon="121.67", live_accuracy="9000")
r = client.post("/api/submit", data=multipart(make_jpeg_no_gps(), "field4.jpg", form),
                content_type="multipart/form-data")
check("bad accuracy rejected", r.status_code == 422, f"{r.status_code}")

# 5. No photo at all -> reject
r = client.post("/api/submit", data=dict(NAME), content_type="multipart/form-data")
check("missing photo rejected", r.status_code == 400, f"{r.status_code}")

# 6. Bad name -> reject
r = client.post("/api/submit",
                data=multipart(make_jpeg_with_gps(), "f.jpg",
                               {"first_name": "1", "middle_name": "", "last_name": "X",
                                "capture_source": "camera"}),
                content_type="multipart/form-data")
check("bad name rejected", r.status_code == 400, f"{r.status_code}")

# 7. Fake image (text file with .jpg extension) -> reject
r = client.post("/api/submit", data=multipart(b"not an image at all", "fake.jpg", NAME),
                content_type="multipart/form-data")
check("corrupt image rejected", r.status_code == 422, f"{r.status_code}")

# 8. PNG without GPS + live GPS -> accept
form = dict(NAME, live_lat="17.72", live_lon="121.68", live_accuracy="30")
r = client.post("/api/submit", data=multipart(make_png_no_gps(), "p.png", form),
                content_type="multipart/form-data")
check("PNG + live accepted", r.status_code == 200, f"{r.status_code} {r.get_json()}")

print("== offline sync idempotency (client_id) ==")
cid = "test-client-id-0001"
form = dict(NAME, live_lat="17.73", live_lon="121.69", live_accuracy="15", client_id=cid,
            captured_at="2026-10-16T11:00:00+00:00")
r1 = client.post("/api/submit", data=multipart(make_jpeg_no_gps(), "q1.jpg", form),
                 content_type="multipart/form-data")
j1 = r1.get_json()
r2 = client.post("/api/submit", data=multipart(make_jpeg_no_gps(), "q1.jpg", form),
                 content_type="multipart/form-data")
j2 = r2.get_json()
check("first sync accepted", r1.status_code == 200 and j1.get("ok"), f"{r1.status_code} {j1}")
check("retry with same client_id -> duplicate ok",
      r2.status_code == 200 and j2.get("ok") and j2.get("duplicate"), f"{r2.status_code} {j2}")
check("duplicate keeps same row id", j1.get("id") == j2.get("id"), f"{j1} vs {j2}")

conn = __import__("app").get_db()
try:
    n = conn.execute("SELECT COUNT(*) AS n FROM submissions WHERE client_id = ?", (cid,)).fetchone()["n"]
finally:
    conn.close()
check("client_id stored exactly once", n == 1, f"count={n}")

print("== frontend policy (camera-only + offline) ==")
html = client.get("/").get_data(as_text=True)
check("index has no file input (no uploads)",
      'type="file"' not in html.replace(" ", ""), html.count("type="))
check("index has built-in camera UI", "btn-open-camera" in html and "btn-shutter" in html)
check("index has offline queue UI", "btn-sync-now" in html and "pending-count" in html)
check("index has Tagalog instructions", "Paano Gamitin" in html)
check("index loads offline-store.js", "offline-store.js" in html)

sw = client.get("/sw.js").get_data(as_text=True)
check("service worker served", "sync-submissions" in sw)

print("== access control ==")
r = client.get("/admin/")
check("anonymous /admin/ redirects to login",
      r.status_code in (302,) and "/admin/login" in r.headers.get("Location", ""))
r = client.get("/admin/export/csv")
check("anonymous CSV export blocked",
      r.status_code in (302,) and "/admin/login" in r.headers.get("Location", ""))
r = client.get("/admin/photo/1")
check("anonymous photo blocked", r.status_code in (302,))
r = client.get("/api/submit", data={})
check("GET submit not allowed", r.status_code == 405, f"{r.status_code}")

print("== admin login & dashboard ==")
r = client.post("/admin/login", data={"username": "admin", "password": "wrong"})
check("wrong password rejected",
      r.status_code == 200 and "Maling username o password" in r.get_data(as_text=True))
r = client.post("/admin/login", data={"username": "admin", "password": "admin123"}, follow_redirects=False)
check("correct password works", r.status_code == 302 and "/admin/" in r.headers.get("Location", ""),
      f"{r.status_code}")

r = client.get("/admin/")
html = r.get_data(as_text=True)
check("dashboard loads", r.status_code == 200)
check("dashboard has Leaflet map div", 'id="map"' in html)
check("dashboard lists records", "Juan" in html and "Dela Cruz" in html)
check("dashboard has CSV export", "/admin/export/csv" in html)
check("dashboard has GeoJSON export", "/admin/export/geojson" in html)

r = client.get("/admin/photo/1?thumb=1")
check("admin photo thumb serves", r.status_code == 200 and r.content_type == "image/jpeg")
r = client.get("/admin/photo/1")
check("admin photo full serves", r.status_code == 200)

print("== exports ==")
r = client.get("/admin/export/csv")
csv_text = r.get_data(as_text=True)
check("CSV export 200", r.status_code == 200)
check("CSV has header + rows", "first_name" in csv_text and "Juan" in csv_text and "gps_source" in csv_text)

r = client.get("/admin/export/geojson")
gj = r.get_json()
check("GeoJSON export 200", r.status_code == 200)
check("GeoJSON FeatureCollection", gj and gj.get("type") == "FeatureCollection", str(gj)[:200])
check("GeoJSON has features", gj and len(gj.get("features", [])) >= 3,
      str(len((gj or {}).get("features", []))))
f0 = gj["features"][0]
check("GeoJSON point geometry", f0["geometry"]["type"] == "Point" and len(f0["geometry"]["coordinates"]) == 2)

r = client.get("/admin/logout", follow_redirects=False)
check("logout works", r.status_code == 302)

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
