'use strict';
const assert = require('assert');
const path = require('path');
const repo = path.join(__dirname, '..');

function el() {
  return {
    textContent: '', hidden: false, disabled: false, value: '', id: '',
    classList: { toggle() {}, add() {}, remove() {}, contains() { return false; } },
    setAttribute() {}, getAttribute() { return null; }, addEventListener() {}, focus() {},
    style: { setProperty() {} }
  };
}

global.window = globalThis;
global.document = {
  hidden: false,
  addEventListener() {},
  documentElement: { style: { setProperty() {} } }
};
global.addEventListener = function () {};
global.requestAnimationFrame = function () { return 1; };
global.cancelAnimationFrame = function () {};
global.innerWidth = 1280;
global.innerHeight = 900;

const C = require(path.join(repo, 'js/config.js'));
require(path.join(repo, 'js/game.js'));

const dom = {};
['stage','overlay','overlayTitle','overlayText','overlayStats','primaryBtn','secondaryBtn','muteBtn','pauseBtn','hudLevel','hudLives','hudEnemies','hudScore','hudHighScore','hudEffects','toast','ariaStatus'].forEach(k => { dom[k] = el(); });
const ctx = new Proxy({}, { get(t, p) { return p in t ? t[p] : function () {}; }, set(t, p, v) { t[p] = v; return true; } });
const canvas = { width: 208, height: 208, style: {}, getContext() { return ctx; }, focus() {}, addEventListener() {} };
const audio = { setMuted() {}, init() {}, resume() {}, suspend() {}, play() {} };
const store = { highScore: 0, muted: false, readHighScore() { return this.highScore; }, writeHighScore(v) { this.highScore = v; }, readMuted() { return this.muted; }, writeMuted(v) { this.muted = v; } };

function newGame() {
  return new global.TankGame({ canvas, ctx, dom, audio, storage: store });
}

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('PASS ' + name); }
  catch (e) { console.error('FAIL ' + name); console.error(e && e.stack || e); process.exitCode = 1; }
}

test('storage degrades to memory when localStorage throws', () => {
  Object.defineProperty(global, 'localStorage', {
    configurable: true,
    get() { throw new Error('localStorage blocked'); }
  });
  delete require.cache[require.resolve(path.join(repo, 'js/storage.js'))];
  require(path.join(repo, 'js/storage.js'));
  assert.strictEqual(global.TankStorage.readHighScore(), 0);
  assert.strictEqual(global.TankStorage.readMuted(), false);
  assert.doesNotThrow(() => global.TankStorage.writeHighScore(321));
  assert.doesNotThrow(() => global.TankStorage.writeMuted(true));
  assert.strictEqual(global.TankStorage.readHighScore(), 321);
  delete global.localStorage;
});

test('audio degrades silently when AudioContext is unavailable', () => {
  delete global.AudioContext;
  delete global.webkitAudioContext;
  delete require.cache[require.resolve(path.join(repo, 'js/audio.js'))];
  require(path.join(repo, 'js/audio.js'));
  const a = global.TankAudio;
  assert.doesNotThrow(() => a.init());
  assert.strictEqual(a.unavailable, true);
  assert.doesNotThrow(() => a.play('shoot'));
  assert.doesNotThrow(() => a.setMuted(true));
  assert.doesNotThrow(() => a.suspend());
  assert.doesNotThrow(() => a.resume());
});

test('idle snapshot contract', () => {
  const g = newGame();
  const s = g.getState();
  assert.strictEqual(s.status, 'idle');
  assert.strictEqual(s.level, 1);
  assert.strictEqual(s.lives, 3);
  assert.strictEqual(s.enemiesRemaining, 20);
  assert.strictEqual(s.baseAlive, true);
  assert.strictEqual(s.playerDirection, 'up');
  assert.strictEqual(s.playerX, 56);
  assert.strictEqual(s.playerY, 200);
});

test('start game enters level 1 with 20 enemies and 2s shield', () => {
  const g = newGame();
  g.startNewGame();
  const s = g.getState();
  assert.strictEqual(s.status, 'playing');
  assert.strictEqual(s.level, 1);
  assert.strictEqual(s.lives, 3);
  assert.strictEqual(s.enemiesRemaining, 20);
  assert.strictEqual(g.effects.power, 1);
  assert.ok(g.effects.invincible >= 1.9);
});

test('level clear adds 1000 once and advances to level 2', () => {
  const g = newGame();
  g.startNewGame();
  g.queue = []; g.enemies = []; g.warnings = [];
  g.checkLevelEnd();
  g.checkLevelEnd();
  assert.strictEqual(g.status, 'levelClear');
  assert.strictEqual(g.score, 1000);
  assert.strictEqual(g.levelIndex, 0);
  g.tick(2.1);
  assert.strictEqual(g.status, 'playing');
  assert.strictEqual(g.levelIndex, 1);
  assert.strictEqual(g.getState().level, 2);
  assert.strictEqual(g.getState().enemiesRemaining, 20);
  assert.strictEqual(g.getState().lives, 3);
  assert.strictEqual(g.score, 1000);
});

test('level 3 clear goes to victory and keeps score', () => {
  const g = newGame();
  g.startNewGame();
  g.levelIndex = 2;
  g.setupLevel(2);
  g.status = 'playing';
  g.effects.power = 2;
  g.queue = []; g.enemies = []; g.warnings = [];
  g.checkLevelEnd();
  assert.strictEqual(g.status, 'victory');
  assert.strictEqual(g.score, 1000);
  assert.strictEqual(g.effects.power, 2);
  assert.strictEqual(g.getState().baseAlive, true);
});

test('base hit ends game immediately with base reason', () => {
  const g = newGame();
  g.startNewGame();
  g.bullets = [{ owner: 'player', ownerId: 0, x: 88, y: 200, prevX: 88, prevY: 200, dir: 'right', speed: 200, power: 1, alive: true }];
  g.moveBullets(1 / 60);
  const s = g.getState();
  assert.strictEqual(s.status, 'gameOver');
  assert.strictEqual(s.baseAlive, false);
  assert.strictEqual(s.lives, 3);
  assert.strictEqual(g.failReason, 'base');
});

test('player death consumes life and respawns with 2s shield', () => {
  const g = newGame();
  g.startNewGame();
  g.lives = 2;
  g.killPlayer();
  assert.strictEqual(g.getState().lives, 1);
  assert.strictEqual(g.effects.power, 1);
  assert.ok(g.freeze > 0.5);
  g.tick(0.61);
  assert.strictEqual(g.status, 'playing');
  assert.strictEqual(g.player.alive, true);
  assert.strictEqual(g.player.x, 56);
  assert.strictEqual(g.player.y, 200);
  assert.ok(g.effects.invincible >= 1.9);
});

test('zero lives ends game with lives reason', () => {
  const g = newGame();
  g.startNewGame();
  g.lives = 1;
  g.killPlayer();
  assert.strictEqual(g.getState().status, 'gameOver');
  assert.strictEqual(g.getState().lives, 0);
  assert.strictEqual(g.failReason, 'lives');
  assert.strictEqual(g.getState().baseAlive, true);
});

test('star raises power to 2, caps, and allows 2 bullets', () => {
  const g = newGame();
  g.startNewGame();
  g.applyItem('star');
  assert.strictEqual(g.effects.power, 2);
  g.applyItem('star');
  assert.strictEqual(g.effects.power, 2);
  g.player.cooldown = 0;
  g.shootRequested = true;
  g.updatePlayer(1 / 60);
  g.player.cooldown = 0;
  g.shootRequested = true;
  g.updatePlayer(1 / 60);
  let count = g.bullets.filter(b => b.owner === 'player').length;
  assert.strictEqual(count, 2);
  g.player.cooldown = 0;
  g.shootRequested = true;
  g.updatePlayer(1 / 60);
  count = g.bullets.filter(b => b.owner === 'player').length;
  assert.strictEqual(count, 2);
});

test('helmet extends invincibility, tank adds life up to 9', () => {
  const g = newGame();
  g.startNewGame();
  g.effects.invincible = 1;
  g.applyItem('helmet');
  assert.strictEqual(g.effects.invincible, 8);
  g.lives = 8;
  g.applyItem('tank');
  assert.strictEqual(g.lives, 9);
  g.applyItem('tank');
  assert.strictEqual(g.lives, 9);
});

test('grenade clears enemies, scores by type, no drops', () => {
  const g = newGame();
  g.startNewGame();
  g.enemies = [
    { id: 1, alive: true, x: 40, y: 40, score: 100, def: C.ENEMY_TYPES.normal, dropItem: 'star' },
    { id: 2, alive: true, x: 80, y: 40, score: 400, def: C.ENEMY_TYPES.elite, dropItem: null }
  ];
  g.bullets = [{ owner: 'enemy', ownerId: 1, x: 50, y: 50, prevX: 50, prevY: 50, dir: 'down', speed: 100, power: 1, alive: true }];
  g.applyItem('grenade');
  assert.strictEqual(g.enemies.length, 0);
  assert.strictEqual(g.score, 500);
  assert.strictEqual(g.bullets.length, 0);
  assert.strictEqual(g.items.length, 0);
});

test('shovel turns protection to steel and restores bricks later', () => {
  const g = newGame();
  g.startNewGame();
  g.applyItem('shovel');
  assert.strictEqual(g.grid[12][4], 'S');
  assert.strictEqual(g.grid[10][5], 'S');
  assert.strictEqual(g.effects.shovel, 15);
  g.effects.shovel = 0.01;
  g.tickEffects(0.02);
  assert.strictEqual(g.grid[12][4], 'B');
  assert.strictEqual(g.grid[10][5], 'B');
});

test('opposing bullets annihilate each other', () => {
  const g = newGame();
  g.startNewGame();
  g.bullets = [
    { owner: 'player', ownerId: 0, x: 103, y: 100, prevX: 100, prevY: 100, dir: 'right', speed: 200, power: 1, alive: true },
    { owner: 'enemy', ownerId: 9, x: 105, y: 100, prevX: 110, prevY: 100, dir: 'left', speed: 200, power: 1, alive: true }
  ];
  g.moveBullets(1 / 60);
  assert.strictEqual(g.bullets.length, 0);
  assert.strictEqual(g.getState().lives, 3);
});

test('invincible player ignores enemy bullet without losing life', () => {
  const g = newGame();
  g.startNewGame();
  g.player.x = 100;
  g.player.y = 100;
  g.effects.invincible = 1;
  g.bullets = [{ owner: 'enemy', ownerId: 7, x: 96, y: 100, prevX: 96, prevY: 100, dir: 'right', speed: 100, power: 1, alive: true }];
  g.moveBullets(1 / 60);
  assert.strictEqual(g.getState().lives, 3);
  assert.strictEqual(g.bullets.length, 0);
});

test('non-invincible player loses a life when hit', () => {
  const g = newGame();
  g.startNewGame();
  g.player.x = 100;
  g.player.y = 100;
  g.effects.invincible = 0;
  g.bullets = [{ owner: 'enemy', ownerId: 7, x: 96, y: 100, prevX: 96, prevY: 100, dir: 'right', speed: 100, power: 1, alive: true }];
  g.moveBullets(1 / 60);
  assert.strictEqual(g.getState().lives, 2);
  assert.ok(g.freeze > 0);
});

test('brick destroyed by bullet; steel immune to power-1 player bullet', () => {
  const g = newGame();
  g.startNewGame();
  g.grid[5][5] = 'B';
  g.grid[5][6] = 'S';
  let b = { owner: 'player', ownerId: 0, x: 5 * 16 + 8, y: 5 * 16 + 8, prevX: 5 * 16 + 8, prevY: 5 * 16 + 8, dir: 'right', speed: 200, power: 1, alive: true };
  g.bullets = [b];
  g.moveBullets(1 / 60);
  assert.strictEqual(g.grid[5][5], '.');
  g.bullets = [{ owner: 'player', ownerId: 0, x: 6 * 16 + 8, y: 5 * 16 + 8, prevX: 6 * 16 + 8, prevY: 5 * 16 + 8, dir: 'right', speed: 200, power: 1, alive: true }];
  g.moveBullets(1 / 60);
  assert.strictEqual(g.grid[5][6], 'S');
  g.bullets = [{ owner: 'player', ownerId: 0, x: 6 * 16 + 8, y: 5 * 16 + 8, prevX: 6 * 16 + 8, prevY: 5 * 16 + 8, dir: 'right', speed: 260, power: 2, alive: true }];
  g.moveBullets(1 / 60);
  assert.strictEqual(g.grid[5][6], '.');
});

test('flashing enemy drop creates at most one item and replaces old', () => {
  const g = newGame();
  g.startNewGame();
  g.spawnItem('star', 40, 40);
  g.spawnItem('clock', 80, 80);
  assert.strictEqual(g.items.length, 1);
  assert.strictEqual(g.items[0].type, 'clock');
  const enemy = { id: 3, alive: true, x: 56, y: 120, score: 100, dropItem: 'helmet' };
  g.killEnemy(enemy, true);
  assert.strictEqual(g.items.length, 1);
  assert.strictEqual(g.items[0].type, 'helmet');
});

test('enemy spawn respects 4 on-screen cap and queue count', () => {
  const g = newGame();
  g.startNewGame();
  g.spawnTimer = 0;
  for (let i = 0; i < 20; i++) {
    g.spawnTimer = 0;
    g.updateSpawner(0.01);
    g.updateWarnings(1);
    g.spawnTimer = 0;
  }
  assert.ok(g.enemies.length <= 4);
  assert.ok(g.enemies.length + g.warnings.length + g.queue.length === 20);
});

test('level transition while page hidden auto-pauses', () => {
  const g = newGame();
  g.startNewGame();
  g.status = 'levelClear';
  g.levelIndex = 0;
  g.levelTimer = 0;
  document.hidden = true;
  g.tick(0.02);
  document.hidden = false;
  assert.strictEqual(g.status, 'paused');
  assert.strictEqual(g.getState().level, 2);
});

test('game over overlay shows failure reason and restart action', () => {
  const g = newGame();
  g.startNewGame();
  g.setGameOver('base');
  g.tick(0.7);
  assert.strictEqual(dom.overlay.hidden, false);
  assert.strictEqual(dom.overlayText.textContent, '基地被摧毁');
  assert.strictEqual(dom.primaryBtn.textContent, '重新开始');
  assert.strictEqual(dom.secondaryBtn.hidden, true);
  assert.strictEqual(dom.overlayTitle.textContent, '游戏结束');
});

test('high score updates on kill and persists on game over', () => {
  store.highScore = 0;
  const g = newGame();
  g.startNewGame();
  const enemy = { id: 9, alive: true, x: 56, y: 120, score: 400, dropItem: null };
  g.killEnemy(enemy, false);
  assert.strictEqual(g.score, 400);
  assert.strictEqual(g.highScore, 400);
  g.setGameOver('lives');
  assert.strictEqual(store.highScore, 400);
});

test('restart resets level, lives, score, power and effects', () => {
  const g = newGame();
  g.startNewGame();
  g.levelIndex = 1;
  g.setupLevel(1);
  g.lives = 1;
  g.score = 5000;
  g.effects.power = 2;
  g.effects.clock = 3;
  g.items = [{ type: 'star', x: 50, y: 50, ttl: 5 }];
  g.bullets = [{ owner: 'enemy', alive: true }];
  g.restart();
  const s = g.getState();
  assert.strictEqual(s.level, 1);
  assert.strictEqual(s.lives, 3);
  assert.strictEqual(s.score, 0);
  assert.strictEqual(s.baseAlive, true);
  assert.strictEqual(g.effects.power, 1);
  assert.strictEqual(g.effects.clock, 0);
  assert.strictEqual(g.items.length, 0);
  assert.strictEqual(g.bullets.length, 0);
});

console.log('--- ' + passed + ' tests passed ---');
