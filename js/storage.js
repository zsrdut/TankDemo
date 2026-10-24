/*
 * localStorage 安全包装：不可用、被禁用或数据非法时静默降级为内存态。
 */
(function (root) {
  'use strict';

  var C = root.TankConfig;
  var memory = { highScore: 0, muted: false };

  function getStore() {
    try {
      var store = root.localStorage;
      if (!store) return null;
      return store;
    } catch (e) {
      return null;
    }
  }

  function read(key) {
    var store = getStore();
    if (!store) return null;
    try {
      return store.getItem(key);
    } catch (e) {
      return null;
    }
  }

  function write(key, value) {
    var store = getStore();
    if (!store) return false;
    try {
      store.setItem(key, value);
      return true;
    } catch (e) {
      return false;
    }
  }

  root.TankStorage = {
    readHighScore: function () {
      var raw = read(C.STORAGE.highScore);
      if (raw === null) return memory.highScore;
      if (!/^\d+$/.test(raw)) return memory.highScore;
      var value = parseInt(raw, 10);
      if (!isFinite(value) || value < 0 || value > C.SCORE.max) return memory.highScore;
      memory.highScore = value;
      return value;
    },

    writeHighScore: function (value) {
      var safe = Math.max(0, Math.min(C.SCORE.max, Math.floor(value) || 0));
      memory.highScore = safe;
      write(C.STORAGE.highScore, String(safe));
    },

    readMuted: function () {
      var raw = read(C.STORAGE.muted);
      if (raw === '1') {
        memory.muted = true;
        return true;
      }
      if (raw === '0') {
        memory.muted = false;
        return false;
      }
      return memory.muted;
    },

    writeMuted: function (muted) {
      memory.muted = !!muted;
      write(C.STORAGE.muted, muted ? '1' : '0');
    }
  };
})(typeof window !== 'undefined' ? window : globalThis);
