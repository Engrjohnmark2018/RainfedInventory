package ph.alcala.rainfedtagging;

import android.Manifest;
import android.app.Activity;
import android.hardware.GeomagneticField;
import android.content.ContentValues;
import android.content.pm.PackageManager;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.webkit.DownloadListener;
import android.webkit.GeolocationPermissions;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.List;
import android.util.Base64;

/**
 * RAINfed-Tagging Alcala — offline edition.
 * A single WebView hosting the bundled app (file:///android_asset/www/index.html).
 * No server: all data stays in the phone (IndexedDB), exports are saved to Downloads.
 * Compass heading comes from the phone's native rotation sensors (WebView does not
 * reliably deliver browser DeviceOrientation events).
 */
public class MainActivity extends Activity implements SensorEventListener {

    private static final int REQ_PERMS = 101;
    private WebView web;
    private GeolocationPermissions.Callback pendingGeoCallback;
    private String pendingGeoOrigin;

    private SensorManager sensorManager;
    private Sensor compassSensor;
    private long lastHeadingSentMs = 0;

    // Compass state: smoothed heading of the CAMERA axis (not the phone top),
    // referenced to true north via GeomagneticField declination.
    private final float[] rotMatrix = new float[9];
    private float smoothSin = Float.NaN;
    private float smoothCos = 1f;
    private float declinationDeg = 0f;
    private int compassAccuracy = 3; // 0=unreliable .. 3=high

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        web = new WebView(this);
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(true);
        s.setAllowContentAccess(true);
        s.setGeolocationEnabled(true);
        s.setCacheMode(WebSettings.LOAD_NO_CACHE);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView view, String url) {
                // Tell the web layer whether this phone has a native compass sensor.
                view.evaluateJavascript(
                        "window.__nativeCompassAvailable = " + (compassSensor != null) + ";",
                        null);
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        if (hasPermission(Manifest.permission.CAMERA)) {
                            request.grant(request.getResources());
                        } else {
                            request.deny();
                        }
                    }
                });
            }

            @Override
            public void onGeolocationPermissionsShowPrompt(String origin,
                                                          GeolocationPermissions.Callback callback) {
                if (hasPermission(Manifest.permission.ACCESS_FINE_LOCATION)) {
                    callback.invoke(origin, true, false);
                } else {
                    pendingGeoCallback = callback;
                    pendingGeoOrigin = origin;
                    requestNeededPermissions();
                }
            }

            @Override
            public boolean onShowFileChooser(WebView webView,
                                             ValueCallback<Uri[]> filePathCallback,
                                             FileChooserParams fileChooserParams) {
                // Camera-only policy: never open the system file picker.
                filePathCallback.onReceiveValue(null);
                Toast.makeText(MainActivity.this,
                        "Bawal ang upload — gamitin ang camera ng app.", Toast.LENGTH_SHORT).show();
                return true;
            }
        });

        // Fallback for <a download> navigations
        web.setDownloadListener(new DownloadListener() {
            @Override
            public void onDownloadStart(String url, String userAgent, String contentDisposition,
                                        String mimetype, long contentLength) {
                Toast.makeText(MainActivity.this,
                        "Gamitin ang export buttons upang i-save ang file.", Toast.LENGTH_SHORT).show();
            }
        });

        // Bridge used by the web app to save exports into phone storage
        web.addJavascriptInterface(new Object() {
            @JavascriptInterface
            public void saveFile(String name, String mime, String base64Data) {
                try {
                    byte[] bytes = Base64.decode(base64Data, Base64.DEFAULT);
                    Uri saved = writeDownloads(name, mime, bytes);
                    final String msg = saved != null
                            ? "Na-save: " + name
                            : "Hindi ma-save ang file: " + name;
                    runOnUiThread(new Runnable() {
                        @Override
                        public void run() {
                            Toast.makeText(MainActivity.this, msg, Toast.LENGTH_LONG).show();
                        }
                    });
                } catch (Exception e) {
                    runOnUiThread(new Runnable() {
                        @Override
                        public void run() {
                            Toast.makeText(MainActivity.this,
                                    "Error sa pag-save ng file.", Toast.LENGTH_LONG).show();
                        }
                    });
                }
            }

            @JavascriptInterface
            public void setMagLocation(double lat, double lon, double alt) {
                // Let the compass know where we are so it can convert magnetic
                // north to true north (declination differs per location).
                GeomagneticField field = new GeomagneticField(
                        (float) lat, (float) lon, (float) alt, System.currentTimeMillis());
                declinationDeg = field.getDeclination();
            }
        }, "Android");

        requestNeededPermissions();
        setupCompassSensors();
        web.loadUrl("file:///android_asset/www/index.html");
    }

    /* ---------------- native compass (heading of the CAMERA axis, true north) ---------------- */

    private void setupCompassSensors() {
        sensorManager = (SensorManager) getSystemService(SENSOR_SERVICE);
        // Prefer the gyro-fused rotation vector (smooth + tracks motion), then
        // the geomagnetic rotation vector, then the legacy orientation sensor.
        compassSensor = sensorManager.getDefaultSensor(Sensor.TYPE_ROTATION_VECTOR);
        if (compassSensor == null) {
            compassSensor = sensorManager.getDefaultSensor(Sensor.TYPE_GEOMAGNETIC_ROTATION_VECTOR);
        }
        if (compassSensor == null) {
            compassSensor = sensorManager.getDefaultSensor(Sensor.TYPE_ORIENTATION);
        }
    }

    @Override
    public void onSensorChanged(SensorEvent event) {
        float heading;
        if (event.sensor.getType() == Sensor.TYPE_ORIENTATION) {
            heading = event.values[0];
        } else {
            SensorManager.getRotationMatrixFromVector(rotMatrix, event.values);
            // Heading of the CAMERA direction (the -Z axis of the device = out
            // the back where the camera points), projected to the horizontal.
            // The usual "azimuth of the phone top" is wrong for photo capture:
            // it swings wildly when the phone is held upright (top pointing up).
            float cx = -rotMatrix[2];
            float cy = -rotMatrix[5];
            float cz = -rotMatrix[8];
            if (Math.abs(cz) > 0.95f) {
                // Phone is flat (camera points at the sky/ground): the camera
                // axis has no compass direction. Fall back to the phone top.
                cx = rotMatrix[1];
                cy = rotMatrix[4];
            }
            heading = (float) Math.toDegrees(Math.atan2(cx, cy));
        }

        // Convert magnetic north -> true north using local declination.
        heading = heading + declinationDeg;
        heading = ((heading % 360f) + 360f) % 360f;

        // Smooth on the unit circle so 0/360 wraparounds do not jump.
        float rad = (float) Math.toRadians(heading);
        float s = (float) Math.sin(rad);
        float c = (float) Math.cos(rad);
        if (Float.isNaN(smoothSin)) {
            smoothSin = s;
            smoothCos = c;
        } else {
            smoothSin += 0.25f * (s - smoothSin);
            smoothCos += 0.25f * (c - smoothCos);
        }
        float smooth = (float) Math.toDegrees(Math.atan2(smoothSin, smoothCos));
        smooth = ((smooth % 360f) + 360f) % 360f;

        long now = System.currentTimeMillis();
        if (now - lastHeadingSentMs < 120) return; // throttle ~8 Hz
        lastHeadingSentMs = now;
        final float h = smooth;
        final int acc = compassAccuracy;
        web.evaluateJavascript(
                "window.__nativeCompassHeading && window.__nativeCompassHeading(" + h + ", " + acc + ");",
                null);
    }

    @Override
    public void onAccuracyChanged(Sensor sensor, int accuracy) {
        compassAccuracy = accuracy;
    }

    private Uri writeDownloads(String name, String mime, byte[] bytes) throws Exception {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ContentValues values = new ContentValues();
            values.put(MediaStore.Downloads.DISPLAY_NAME, name);
            values.put(MediaStore.Downloads.MIME_TYPE, mime);
            values.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
            Uri uri = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
            if (uri != null) {
                OutputStream out = getContentResolver().openOutputStream(uri);
                out.write(bytes);
                out.close();
            }
            return uri;
        }
        File dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
        if (!dir.exists()) dir.mkdirs();
        File file = new File(dir, name);
        FileOutputStream fos = new FileOutputStream(file);
        fos.write(bytes);
        fos.close();
        return Uri.fromFile(file);
    }

    private boolean hasPermission(String perm) {
        return checkSelfPermission(perm) == PackageManager.PERMISSION_GRANTED;
    }

    private void requestNeededPermissions() {
        List<String> need = new ArrayList<>();
        String[] all = new String[]{
                Manifest.permission.CAMERA,
                Manifest.permission.ACCESS_FINE_LOCATION,
                Manifest.permission.ACCESS_COARSE_LOCATION
        };
        if (Build.VERSION.SDK_INT <= Build.VERSION_CODES.P) {
            // older devices write exports via plain files
        }
        for (String p : all) {
            if (!hasPermission(p)) need.add(p);
        }
        if (!need.isEmpty()) {
            requestPermissions(need.toArray(new String[0]), REQ_PERMS);
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQ_PERMS && pendingGeoCallback != null) {
            boolean granted = hasPermission(Manifest.permission.ACCESS_FINE_LOCATION);
            pendingGeoCallback.invoke(pendingGeoOrigin, granted, false);
            pendingGeoCallback = null;
            pendingGeoOrigin = null;
        }
    }

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) {
            web.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        web.onResume();
        if (sensorManager != null && compassSensor != null) {
            sensorManager.registerListener(this, compassSensor, SensorManager.SENSOR_DELAY_GAME);
        }
    }

    @Override
    protected void onPause() {
        if (sensorManager != null) {
            sensorManager.unregisterListener(this);
        }
        web.onPause();
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        web.destroy();
        super.onDestroy();
    }
}
