/*
 * ExifWrite — minimal JPEG APP1 (EXIF) writer for GPS geotag stamping.
 * Works offline in the browser/WebView: takes a camera JPEG (ArrayBuffer)
 * and returns a new JPEG with EXIF GPS (lat/lon/altitude), GPSImgDirection
 * (compass heading) and DateTimeOriginal written in.
 *
 * Layout (after "Exif\0\0"): TIFF header | IFD0 | IFD0 data | Exif IFD |
 * Exif data | GPS IFD | GPS data. Each IFD's data area follows its table.
 */
(function (global) {
  "use strict";

  var TYPE_BYTE = 1, TYPE_ASCII = 2, TYPE_LONG = 4, TYPE_RATIONAL = 5;

  function ascii(str) {
    var out = new Uint8Array(str.length + 1);
    for (var i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff;
    out[str.length] = 0;
    return out;
  }

  function rational(num, den) {
    var b = new Uint8Array(8);
    var dv = new DataView(b.buffer);
    dv.setUint32(0, num >>> 0, true);
    dv.setUint32(4, den >>> 0, true);
    return b;
  }

  function floatToRational(v) {
    return rational(Math.round(Math.abs(v) * 10000), 10000);
  }

  function dmsRationals(v) {
    var abs = Math.abs(v);
    var d = Math.floor(abs);
    var m = Math.floor((abs - d) * 60);
    var s = (abs - d - m / 60) * 3600;
    return [rational(d, 1), rational(m, 1), rational(Math.round(s * 10000), 10000)];
  }

  function concat(parts) {
    var len = 0, i;
    for (i = 0; i < parts.length; i++) len += parts[i].length;
    var out = new Uint8Array(len);
    var off = 0;
    for (i = 0; i < parts.length; i++) { out.set(parts[i], off); off += parts[i].length; }
    return out;
  }

  function entry(tag, type, count, data) {
    return { tag: tag, type: type, count: count, data: data };
  }

  function tableSize(entries) {
    var n = 0;
    for (var i = 0; i < entries.length; i++) {
      if (entries[i].data.length > 4) n += entries[i].data.length;
    }
    return 2 + entries.length * 12 + 4 + n;
  }

  function buildIfd(entries, ifdStart) {
    var headerLen = 2 + entries.length * 12 + 4;
    var dataStart = ifdStart + headerLen;      // data area follows the table
    var header = new Uint8Array(headerLen);
    var dv = new DataView(header.buffer);
    dv.setUint16(0, entries.length, true);
    var dataParts = [];
    var dataOff = 0;
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      var base = 2 + i * 12;
      dv.setUint16(base, e.tag, true);
      dv.setUint16(base + 2, e.type, true);
      dv.setUint32(base + 4, e.count, true);
      if (e.data.length <= 4) {
        header.set(e.data, base + 8);
      } else {
        dv.setUint32(base + 8, dataStart + dataOff, true);
        dataParts.push(e.data);
        dataOff += e.data.length;
      }
    }
    dv.setUint32(headerLen - 4, 0, true); // next-IFD = none
    return concat([header].concat(dataParts));
  }

  function pad2(n) { return (n < 10 ? "0" : "") + n; }

  function formatExifDate(d) {
    return d.getUTCFullYear() + ":" + pad2(d.getUTCMonth() + 1) + ":" + pad2(d.getUTCDate()) +
      " " + pad2(d.getUTCHours()) + ":" + pad2(d.getUTCMinutes()) + ":" + pad2(d.getUTCSeconds());
  }

  function setLong(bytes, entryIndex, value) {
    // Patch the inline LONG value of entry #entryIndex inside a built IFD byte array.
    var dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    dv.setUint32(2 + entryIndex * 12 + 8, value >>> 0, true);
  }

  function stamp(jpegBuffer, opts) {
    var src = new Uint8Array(jpegBuffer);
    if (src.length < 4 || src[0] !== 0xff || src[1] !== 0xd8) {
      throw new Error("Not a JPEG");
    }
    var lat = opts.lat, lon = opts.lon;
    var dateStr = formatExifDate(opts.takenAt ? new Date(opts.takenAt) : new Date());

    var gpsEntries = [
      entry(0x0001, TYPE_ASCII, 2, ascii(lat >= 0 ? "N" : "S")),
      entry(0x0002, TYPE_RATIONAL, 3, concat(dmsRationals(lat))),
      entry(0x0003, TYPE_ASCII, 2, ascii(lon >= 0 ? "E" : "W")),
      entry(0x0004, TYPE_RATIONAL, 3, concat(dmsRationals(lon))),
      entry(0x0005, TYPE_BYTE, 1, new Uint8Array([opts.altitude && opts.altitude < 0 ? 1 : 0])),
      entry(0x0006, TYPE_RATIONAL, 1, floatToRational(opts.altitude || 0)),
      entry(0x0010, TYPE_ASCII, 2, ascii("T")),
      entry(0x0011, TYPE_RATIONAL, 1, floatToRational(opts.heading || 0))
    ];
    var exifEntries = [
      entry(0x9003, TYPE_ASCII, 20, ascii(dateStr))
    ];
    var ifd0Entries = [
      entry(0x010F, TYPE_ASCII, 11, ascii("Smartphone")),
      entry(0x0131, TYPE_ASCII, 23, ascii("RAINfed-Tagging Alcala")),
      entry(0x0132, TYPE_ASCII, 20, ascii(dateStr)),
      entry(0x8769, TYPE_LONG, 1, new Uint8Array(4)),
      entry(0x8825, TYPE_LONG, 1, new Uint8Array(4))
    ];

    // Resolve IFD positions (sizes are known up front)
    var ifd0Start = 8;
    var exifStart = ifd0Start + tableSize(ifd0Entries);
    var gpsStart = exifStart + tableSize(exifEntries);

    var ifd0Bytes = buildIfd(ifd0Entries, ifd0Start);
    setLong(ifd0Bytes, 3, exifStart); // ExifIFD pointer
    setLong(ifd0Bytes, 4, gpsStart);  // GPSIFD pointer
    var exifBytes = buildIfd(exifEntries, exifStart);
    var gpsBytes = buildIfd(gpsEntries, gpsStart);

    var tiff = concat([
      new Uint8Array([0x49, 0x49, 42, 0, 8, 0, 0, 0]), // II* TIFF header, IFD0 @ 8
      ifd0Bytes, exifBytes, gpsBytes
    ]);
    var app1Body = concat([new Uint8Array([0x45, 0x78, 0x69, 0x66, 0, 0]), tiff]);

    var segLen = app1Body.length + 2;
    if (segLen > 0xffff) throw new Error("EXIF segment too large");
    var seg = new Uint8Array(4 + app1Body.length);
    seg[0] = 0xff; seg[1] = 0xe1;
    seg[2] = (segLen >> 8) & 0xff; seg[3] = segLen & 0xff;
    seg.set(app1Body, 4);

    // SOI + optional JFIF APP0 + new APP1 + rest (existing APP1s dropped)
    var p = 2, app0 = null;
    if (p + 4 <= src.length && src[p] === 0xff && src[p + 1] === 0xe0) {
      var l0 = (src[p + 2] << 8) | src[p + 3];
      app0 = src.subarray(p, p + 2 + l0);
      p += 2 + l0;
    }
    while (p + 4 <= src.length && src[p] === 0xff && src[p + 1] === 0xe1) {
      p += 2 + ((src[p + 2] << 8) | src[p + 3]);
    }
    var parts = [src.subarray(0, 2)];
    if (app0) parts.push(app0);
    parts.push(seg);
    parts.push(src.subarray(p));
    return concat(parts).buffer;
  }

  var api = { stamp: stamp };
  global.ExifWrite = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
