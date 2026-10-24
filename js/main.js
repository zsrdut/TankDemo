/*
 * 启动入口：初始化游戏、暴露只读调试状态、兜底展示可读错误。
 */
(function (root) {
  'use strict';

  function getDom() {
    return {
      canvas: document.getElementById('gameCanvas'),
      stage: document.getElementById('stage'),
      overlay: document.getElementById('overlay'),
      overlayTitle: document.getElementById('overlayTitle'),
      overlayText: document.getElementById('overlayText'),
      overlayStats: document.getElementById('overlayStats'),
      primaryBtn: document.getElementById('primaryBtn'),
      secondaryBtn: document.getElementById('secondaryBtn'),
      muteBtn: document.getElementById('muteBtn'),
      pauseBtn: document.getElementById('pauseBtn'),
      hudLevel: document.getElementById('hudLevel'),
      hudLives: document.getElementById('hudLives'),
      hudEnemies: document.getElementById('hudEnemies'),
      hudScore: document.getElementById('hudScore'),
      hudHighScore: document.getElementById('hudHighScore'),
      hudEffects: document.getElementById('hudEffects'),
      toast: document.getElementById('toast'),
      ariaStatus: document.getElementById('ariaStatus')
    };
  }

  function showFatalInit(dom) {
    if (!dom || !dom.overlay) return;
    dom.overlay.hidden = false;
    dom.overlay.setAttribute('data-kind', 'error');
    if (dom.overlayTitle) dom.overlayTitle.textContent = '游戏加载失败';
    if (dom.overlayText) dom.overlayText.textContent = '游戏加载失败，请刷新页面重试';
    if (dom.overlayStats) dom.overlayStats.textContent = '';
    if (dom.primaryBtn) dom.primaryBtn.hidden = true;
    if (dom.secondaryBtn) dom.secondaryBtn.hidden = true;
  }

  function boot() {
    var dom = getDom();
    try {
      if (!dom.canvas || typeof dom.canvas.getContext !== 'function') {
        throw new Error('Canvas is not supported');
      }
      var ctx = dom.canvas.getContext('2d');
      if (!ctx) throw new Error('Canvas 2D context is unavailable');

      if (!root.TankConfig || !root.TankStorage || !root.TankAudio || !root.TankGame) {
        throw new Error('Game modules are missing');
      }

      var game = new root.TankGame({
        canvas: dom.canvas,
        ctx: ctx,
        dom: dom,
        audio: root.TankAudio,
        storage: root.TankStorage
      });

      var api = {
        getState: function () {
          return Object.freeze(game.getState());
        }
      };
      root.__tankGame = Object.freeze(api);

      root.addEventListener('error', function (event) {
        game.handleRuntimeError(event && (event.error || event.message));
      });
      root.addEventListener('unhandledrejection', function (event) {
        game.handleRuntimeError(event && event.reason);
      });
    } catch (error) {
      if (root.console && root.console.error) root.console.error('TankGame init failed', error);
      showFatalInit(dom);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(typeof window !== 'undefined' ? window : globalThis);
