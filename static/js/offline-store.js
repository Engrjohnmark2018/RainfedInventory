/*
 * RAINfed-Tagging Alcala — offline queue store (IndexedDB).
 * Works both in the browser page and inside the Service Worker
 * (via importScripts) so submissions can sync even after the page is closed.
 */
(function (global) {
  "use strict";

  var DB_NAME = "rainfedtag-offline";
  var DB_VERSION = 1;
  var STORE = "queue";

  function openDB() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          var store = db.createObjectStore(STORE, { keyPath: "client_id" });
          store.createIndex("status", "status", { unique: false });
          store.createIndex("created_at", "created_at", { unique: false });
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  function tx(mode, fn) {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(STORE, mode);
        var store = t.objectStore(STORE);
        var result = fn(store);
        t.oncomplete = function () {
          db.close();
          resolve(result && result.result !== undefined ? result.result : result);
        };
        t.onerror = function () { db.close(); reject(t.error); };
        t.onabort = function () { db.close(); reject(t.error); };
      });
    });
  }

  var OfflineStore = {
    enqueue: function (item) {
      item.status = item.status || "pending";
      item.created_at = item.created_at || new Date().toISOString();
      return tx("readwrite", function (store) {
        return store.put(item);
      });
    },

    getAll: function () {
      return tx("readonly", function (store) { return store.getAll(); });
    },

    getPending: function () {
      return OfflineStore.getAll().then(function (items) {
        return (items || []).filter(function (i) { return i.status === "pending"; })
          .sort(function (a, b) { return (a.created_at || "").localeCompare(b.created_at || ""); });
      });
    },

    remove: function (client_id) {
      return tx("readwrite", function (store) { return store.delete(client_id); });
    },

    markRejected: function (client_id, error) {
      return tx("readwrite", function (store) {
        var get = store.get(client_id);
        get.onsuccess = function () {
          var item = get.result;
          if (item) {
            item.status = "rejected";
            item.error = error;
            store.put(item);
          }
        };
        return get;
      });
    },

    clearRejected: function () {
      return OfflineStore.getAll().then(function (items) {
        var rejected = (items || []).filter(function (i) { return i.status === "rejected"; });
        return Promise.all(rejected.map(function (i) { return OfflineStore.remove(i.client_id); }));
      });
    },

    countPending: function () {
      return OfflineStore.getPending().then(function (items) { return items.length; });
    }
  };

  global.OfflineStore = OfflineStore;
})(typeof self !== "undefined" ? self : this);
