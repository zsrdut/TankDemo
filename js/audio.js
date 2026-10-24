/*
 * WebAudio 程序化音效。无外部音频素材；AudioContext 不可用时静默降级。
 */
(function (root) {
  'use strict';

  function noop() {}

  function TankAudio() {
    this.ctx = null;
    this.master = null;
    this.noiseBuffer = null;
    this.muted = false;
    this.volume = 0.2;
    this.unavailable = false;
  }

  TankAudio.prototype.init = function () {
    if (this.ctx || this.unavailable) return;
    var Ctor = root.AudioContext || root.webkitAudioContext;
    if (!Ctor) {
      this.unavailable = true;
      return;
    }
    try {
      this.ctx = new Ctor();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.muted ? 0 : this.volume;
      this.master.connect(this.ctx.destination);
      this._buildNoise();
      if (this.ctx.state === 'suspended') {
        var p = this.ctx.resume();
        if (p && typeof p.catch === 'function') p.catch(noop);
      }
    } catch (e) {
      this.ctx = null;
      this.master = null;
      this.unavailable = true;
    }
  };

  TankAudio.prototype._buildNoise = function () {
    try {
      var length = Math.floor(this.ctx.sampleRate * 0.4);
      var buffer = this.ctx.createBuffer(1, length, this.ctx.sampleRate);
      var data = buffer.getChannelData(0);
      for (var i = 0; i < length; i += 1) {
        data[i] = Math.random() * 2 - 1;
      }
      this.noiseBuffer = buffer;
    } catch (e) {
      this.noiseBuffer = null;
    }
  };

  TankAudio.prototype.setMuted = function (muted) {
    this.muted = !!muted;
    if (this.master) {
      try {
        this.master.gain.value = this.muted ? 0 : this.volume;
      } catch (e) { /* ignore */ }
    }
  };

  TankAudio.prototype.suspend = function () {
    if (!this.ctx || this.ctx.state !== 'running') return;
    try {
      var p = this.ctx.suspend();
      if (p && typeof p.catch === 'function') p.catch(noop);
    } catch (e) { /* ignore */ }
  };

  TankAudio.prototype.resume = function () {
    if (!this.ctx) return;
    try {
      if (this.ctx.state === 'suspended') {
        var p = this.ctx.resume();
        if (p && typeof p.catch === 'function') p.catch(noop);
      }
    } catch (e) { /* ignore */ }
  };

  TankAudio.prototype._tone = function (freq, endFreq, duration, type, level, delay) {
    if (!this.ctx || !this.master) return;
    try {
      var now = this.ctx.currentTime + (delay || 0);
      var osc = this.ctx.createOscillator();
      var gain = this.ctx.createGain();
      osc.type = type || 'square';
      osc.frequency.setValueAtTime(Math.max(20, freq), now);
      if (endFreq && endFreq !== freq) {
        osc.frequency.exponentialRampToValueAtTime(Math.max(20, endFreq), now + duration);
      }
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, level || 0.2), now + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
      osc.connect(gain);
      gain.connect(this.master);
      osc.start(now);
      osc.stop(now + duration + 0.02);
    } catch (e) { /* ignore */ }
  };

  TankAudio.prototype._noise = function (duration, level, filterFreq, delay) {
    if (!this.ctx || !this.master || !this.noiseBuffer) return;
    try {
      var now = this.ctx.currentTime + (delay || 0);
      var src = this.ctx.createBufferSource();
      src.buffer = this.noiseBuffer;
      var filter = this.ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(filterFreq || 1200, now);
      var gain = this.ctx.createGain();
      gain.gain.setValueAtTime(Math.max(0.0002, level || 0.2), now);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
      src.connect(filter);
      filter.connect(gain);
      gain.connect(this.master);
      src.start(now);
      src.stop(now + duration + 0.02);
    } catch (e) { /* ignore */ }
  };

  TankAudio.prototype.play = function (name) {
    if (!this.ctx || !this.master || this.muted || this.ctx.state !== 'running') return;
    switch (name) {
      case 'shoot':
        this._tone(620, 260, 0.06, 'square', 0.16);
        break;
      case 'hit':
        this._noise(0.05, 0.16, 2200);
        break;
      case 'explode':
        this._noise(0.26, 0.3, 800);
        this._tone(120, 48, 0.24, 'sawtooth', 0.1);
        break;
      case 'pickup':
        this._tone(660, 660, 0.07, 'square', 0.14, 0);
        this._tone(990, 990, 0.1, 'square', 0.13, 0.07);
        break;
      case 'level':
        this._tone(523, 523, 0.1, 'square', 0.13, 0);
        this._tone(659, 659, 0.1, 'square', 0.13, 0.1);
        this._tone(784, 784, 0.1, 'square', 0.13, 0.2);
        this._tone(1046, 1046, 0.18, 'square', 0.13, 0.3);
        break;
      case 'fail':
        this._tone(330, 110, 0.5, 'sawtooth', 0.15, 0);
        this._noise(0.35, 0.18, 600, 0.05);
        break;
      case 'victory':
        this._tone(523, 523, 0.12, 'square', 0.13, 0);
        this._tone(659, 659, 0.12, 'square', 0.13, 0.12);
        this._tone(784, 784, 0.12, 'square', 0.13, 0.24);
        this._tone(1046, 1046, 0.12, 'square', 0.13, 0.36);
        this._tone(1318, 1318, 0.24, 'square', 0.13, 0.48);
        break;
      default:
        break;
    }
  };

  root.TankAudio = new TankAudio();
})(typeof window !== 'undefined' ? window : globalThis);
