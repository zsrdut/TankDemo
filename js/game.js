/*
 * 坦克大战 · 游戏核心
 *
 * 设计要点：
 * - 固定逻辑步长 1/60 秒推进模拟，渲染由 requestAnimationFrame 驱动；
 * - 所有碰撞基于移动后的稳定结果结算，敌我子弹对撞按双方轨迹统一处理；
 * - 状态契约 window.__tankGame 由 main.js 冻结暴露，本类只提供 getState() 快照。
 */
(function (root) {
  'use strict';

  var C = root.TankConfig;

  var DIRS = {
    up: { x: 0, y: -1, angle: 0 },
    right: { x: 1, y: 0, angle: Math.PI / 2 },
    down: { x: 0, y: 1, angle: Math.PI },
    left: { x: -1, y: 0, angle: -Math.PI / 2 }
  };

  var OPPOSITE = { up: 'down', down: 'up', left: 'right', right: 'left' };
  var PASSABLE = { '.': true, P: true, X: true, T: true, I: true };
  var TANK_BLOCKED = { B: true, S: true, W: true, E: true };

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function round1(value) {
    return Math.round(value * 10) / 10;
  }

  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a += 0x6D2B79F5;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function approach(current, target, maxDelta) {
    if (current < target) return Math.min(target, current + maxDelta);
    if (current > target) return Math.max(target, current - maxDelta);
    return target;
  }

  function overlapPoint(x1, y1, half1, x2, y2, half2) {
    return Math.abs(x1 - x2) < half1 + half2 && Math.abs(y1 - y2) < half1 + half2;
  }

  function overlapRect(x1, y1, w1, h1, x2, y2, w2, h2) {
    return x1 < x2 + w2 && x1 + w1 > x2 && y1 < y2 + h2 && y1 + h1 > y2;
  }

  function snapAxis(value) {
    return Math.round((value - 8) / 16) * 16 + 8;
  }

  function TankGame(options) {
    this.canvas = options.canvas;
    this.ctx = options.ctx;
    this.dom = options.dom;
    this.audio = options.audio;
    this.storage = options.storage;

    this.status = 'idle';
    this.fatal = false;
    this.levelIndex = 0;
    this.lives = C.PLAYER.lives;
    this.score = 0;
    this.highScore = this.storage.readHighScore();
    this.muted = this.storage.readMuted();
    this.baseAlive = true;
    this.failReason = '';
    this.overlayKind = '';
    this.overlayShownAt = 0;

    this.grid = null;
    this.player = null;
    this.enemies = [];
    this.bullets = [];
    this.items = [];
    this.explosions = [];
    this.warnings = [];
    this.queue = [];
    this.effects = {
      power: 1,
      invincible: 0,
      clock: 0,
      shovel: 0
    };

    this.spawnTimer = 0;
    this.freeze = 0;
    this.endDelay = 0;
    this.levelTimer = 0;
    this.respawnWaiting = false;
    this.respawnWaitElapsed = 0;
    this.respawnRetryTimer = 0;
    this.nextEnemyId = 1;
    this.acc = 0;
    this.animTime = 0;
    this.flashTimer = 0;
    this.shootRequested = false;
    this.noticeTimer = 0;
    this.ariaCache = '';

    this.keys = { up: false, down: false, left: false, right: false };
    this.dirStack = [];
    this.rng = mulberry32(1);

    this.lastTs = 0;
    this.rafId = 0;
    this.resizeRaf = 0;

    this._onKeyDown = this.onKeyDown.bind(this);
    this._onKeyUp = this.onKeyUp.bind(this);
    this._onBlur = this.onBlur.bind(this);
    this._onVisibility = this.onVisibility.bind(this);
    this._onPageHide = this.onPageHide.bind(this);
    this._onResize = this.onResize.bind(this);
    this._loop = this.loop.bind(this);

    this.audio.setMuted(this.muted);
    this.bindEvents();
    this.resize();
    this.resetIdle();
    this.updateOverlay('idle');
    this.updateHud();
    this.render();
    this.rafId = root.requestAnimationFrame(this._loop);
  }

  TankGame.prototype.bindEvents = function () {
    root.addEventListener('keydown', this._onKeyDown, { passive: false });
    root.addEventListener('keyup', this._onKeyUp);
    root.addEventListener('blur', this._onBlur);
    root.addEventListener('resize', this._onResize);
    root.addEventListener('pagehide', this._onPageHide);
    document.addEventListener('visibilitychange', this._onVisibility);

    var self = this;
    this.dom.primaryBtn.addEventListener('click', function () { self.onPrimary(); });
    this.dom.secondaryBtn.addEventListener('click', function () { self.onSecondary(); });
    this.dom.muteBtn.addEventListener('click', function () { self.toggleMute(); });
    this.dom.pauseBtn.addEventListener('click', function () { self.togglePause(); });
  };

  TankGame.prototype.isInteractiveTarget = function (target) {
    if (!target || !target.tagName) return false;
    var tag = target.tagName.toLowerCase();
    if (tag === 'button' || tag === 'a' || tag === 'input' || tag === 'select' || tag === 'textarea') return true;
    return !!target.isContentEditable;
  };

  TankGame.prototype.onKeyDown = function (event) {
    if (this.fatal) return;
    var code = event.code || '';
    var key = event.key || '';
    var interactive = this.isInteractiveTarget(event.target);

    if (event.repeat && (code === 'Enter' || code === 'KeyP' || code === 'KeyM')) return;

    if (code === 'KeyM' || key === 'm' || key === 'M') {
      event.preventDefault();
      this.toggleMute();
      return;
    }

    if (code === 'Enter' || key === 'Enter') {
      if (interactive) return;
      event.preventDefault();
      if (this.status === 'idle') this.startNewGame();
      else if (this.status === 'paused') this.resume();
      else if (this.status === 'gameOver' || this.status === 'victory') this.restart();
      return;
    }

    if (code === 'KeyP' || key === 'p' || key === 'P') {
      event.preventDefault();
      this.togglePause();
      return;
    }

    if (code === 'Space' || code === 'KeyJ' || key === ' ' || key === 'j' || key === 'J') {
      if (interactive && (code === 'Space' || key === ' ')) return;
      if (this.status === 'playing') {
        event.preventDefault();
        if (!event.repeat) this.shootRequested = true;
      } else if (this.status === 'paused') {
        event.preventDefault();
      }
      return;
    }

    var dir = null;
    if (code === 'ArrowUp' || code === 'KeyW' || key === 'ArrowUp' || key === 'w' || key === 'W') dir = 'up';
    else if (code === 'ArrowDown' || code === 'KeyS' || key === 'ArrowDown' || key === 's' || key === 'S') dir = 'down';
    else if (code === 'ArrowLeft' || code === 'KeyA' || key === 'ArrowLeft' || key === 'a' || key === 'A') dir = 'left';
    else if (code === 'ArrowRight' || code === 'KeyD' || key === 'ArrowRight' || key === 'd' || key === 'D') dir = 'right';

    if (dir) {
      if (this.status === 'playing' || this.status === 'paused') event.preventDefault();
      if (this.status !== 'playing') return;
      if (!this.keys[dir]) {
        this.keys[dir] = true;
        this.dirStack.push(dir);
      }
    }
  };

  TankGame.prototype.onKeyUp = function (event) {
    var code = event.code || '';
    var key = event.key || '';
    var dir = null;
    if (code === 'ArrowUp' || code === 'KeyW' || key === 'ArrowUp' || key === 'w' || key === 'W') dir = 'up';
    else if (code === 'ArrowDown' || code === 'KeyS' || key === 'ArrowDown' || key === 's' || key === 'S') dir = 'down';
    else if (code === 'ArrowLeft' || code === 'KeyA' || key === 'ArrowLeft' || key === 'a' || key === 'A') dir = 'left';
    else if (code === 'ArrowRight' || code === 'KeyD' || key === 'ArrowRight' || key === 'd' || key === 'D') dir = 'right';
    if (!dir) return;
    this.keys[dir] = false;
    for (var i = this.dirStack.length - 1; i >= 0; i -= 1) {
      if (this.dirStack[i] === dir) this.dirStack.splice(i, 1);
    }
  };

  TankGame.prototype.clearInput = function () {
    this.keys.up = false;
    this.keys.down = false;
    this.keys.left = false;
    this.keys.right = false;
    this.dirStack = [];
    this.shootRequested = false;
  };

  TankGame.prototype.getPressedDirection = function () {
    for (var i = this.dirStack.length - 1; i >= 0; i -= 1) {
      if (this.keys[this.dirStack[i]]) return this.dirStack[i];
    }
    return null;
  };

  TankGame.prototype.onBlur = function () {
    this.clearInput();
    if (this.status === 'playing') this.pause(true);
  };

  TankGame.prototype.onVisibility = function () {
    if (document.hidden) {
      this.clearInput();
      if (this.status === 'playing') this.pause(true);
    }
  };

  TankGame.prototype.onPageHide = function () {
    this.storage.writeHighScore(this.highScore);
  };

  TankGame.prototype.onResize = function () {
    var self = this;
    if (this.resizeRaf) root.cancelAnimationFrame(this.resizeRaf);
    this.resizeRaf = root.requestAnimationFrame(function () {
      self.resizeRaf = 0;
      self.resize();
    });
  };

  TankGame.prototype.resize = function () {
    var vw = root.innerWidth || 1024;
    var vh = root.innerHeight || 768;
    var availableW = Math.max(180, Math.min(vw - 48, 960));
    var availableH = Math.max(180, vh - 340);
    var raw = Math.min(availableW / C.WIDTH, availableH / C.HEIGHT, C.MAX_SCALE);
    var scale = raw >= 1 ? Math.floor(raw) : Math.max(0.5, raw);
    scale = clamp(scale, 0.5, C.MAX_SCALE);
    var size = Math.round(C.WIDTH * scale);
    document.documentElement.style.setProperty('--canvas-size', size + 'px');
  };

  TankGame.prototype.loop = function (ts) {
    if (this.fatal) return;
    try {
      if (!this.lastTs) this.lastTs = ts;
      var dt = (ts - this.lastTs) / 1000;
      this.lastTs = ts;
      if (!isFinite(dt) || dt < 0) dt = 0;
      dt = Math.min(dt, 0.1);
      this.tick(dt);
      this.render();
      this.updateHud();
    } catch (e) {
      this.handleRuntimeError(e);
      return;
    }
    this.rafId = root.requestAnimationFrame(this._loop);
  };

  TankGame.prototype.tick = function (dt) {
    if (this.fatal) return;
    if (this.status !== 'paused') this.animTime += dt;

    if (this.flashTimer > 0) this.flashTimer = Math.max(0, this.flashTimer - dt);
    if (this.noticeTimer > 0) {
      this.noticeTimer -= dt;
      if (this.noticeTimer <= 0) {
        this.noticeTimer = 0;
        this.dom.toast.textContent = '';
        this.dom.toast.setAttribute('data-visible', 'false');
      }
    }

    if (this.status === 'playing') {
      if (this.freeze > 0) {
        this.freeze -= dt;
        this.acc = 0;
        this.tickExplosions(dt);
        if (this.freeze <= 0) {
          this.freeze = 0;
          this.tryRespawn();
        }
        return;
      }

      this.acc += dt;
      var steps = 0;
      while (this.acc >= C.STEP && steps < 6) {
        this.step(C.STEP);
        this.acc -= C.STEP;
        steps += 1;
        if (this.status !== 'playing' || this.freeze > 0) break;
      }
      if (steps >= 6) this.acc = Math.min(this.acc, C.STEP);
      this.tickExplosions(dt);
      return;
    }

    if (this.status === 'levelClear') {
      this.tickExplosions(dt);
      this.levelTimer -= dt;
      if (this.levelTimer <= 0) this.nextLevel();
      return;
    }

    if (this.status === 'gameOver' || this.status === 'victory') {
      this.tickExplosions(dt);
      if (this.endDelay > 0) {
        this.endDelay -= dt;
        if (this.endDelay <= 0) {
          this.endDelay = 0;
          this.updateOverlay(this.status);
        }
      }
    }
  };

  TankGame.prototype.step = function (dt) {
    if (this.status !== 'playing' || this.fatal) return;
    if (this.freeze > 0) return;

    if (this.respawnWaiting) {
      this.respawnWaitElapsed += dt;
      this.respawnRetryTimer -= dt;
      if (this.respawnRetryTimer <= 0) this.tryRespawn();
      return;
    }

    this.tickEffects(dt);
    this.updatePlayer(dt);
    this.updateEnemies(dt);
    this.updateWarnings(dt);
    this.updateSpawner(dt);
    this.moveBullets(dt);
    if (this.status !== 'playing') return;
    this.updateItems(dt);
    this.checkLevelEnd();
  };

  TankGame.prototype.tickEffects = function (dt) {
    if (this.effects.invincible > 0) this.effects.invincible = Math.max(0, this.effects.invincible - dt);
    if (this.effects.clock > 0) this.effects.clock = Math.max(0, this.effects.clock - dt);
    if (this.effects.shovel > 0) {
      this.effects.shovel = Math.max(0, this.effects.shovel - dt);
      if (this.effects.shovel === 0) this.restoreProtection();
    }
  };

  TankGame.prototype.tileAt = function (x, y) {
    var col = Math.floor(x / C.TILE);
    var row = Math.floor(y / C.TILE);
    if (row < 0 || row >= C.ROWS || col < 0 || col >= C.COLS) return null;
    return this.grid[row][col];
  };

  TankGame.prototype.tileAtCell = function (col, row) {
    if (row < 0 || row >= C.ROWS || col < 0 || col >= C.COLS) return null;
    return this.grid[row][col];
  };

  TankGame.prototype.tankBlockedAt = function (x, y, self) {
    var half = C.PLAYER.body / 2;
    if (x - half < 0 || x + half > C.WIDTH || y - half < 0 || y + half > C.HEIGHT) return true;

    var left = Math.floor((x - half) / C.TILE);
    var right = Math.floor((x + half - 0.001) / C.TILE);
    var top = Math.floor((y - half) / C.TILE);
    var bottom = Math.floor((y + half - 0.001) / C.TILE);
    var r;
    var c;
    for (r = top; r <= bottom; r += 1) {
      for (c = left; c <= right; c += 1) {
        var ch = this.tileAtCell(c, r);
        if (ch && TANK_BLOCKED[ch]) return true;
      }
    }

    var i;
    if (this.player && this.player.alive && this.player !== self) {
      if (overlapPoint(x, y, half, this.player.x, this.player.y, half)) return true;
    }
    for (i = 0; i < this.enemies.length; i += 1) {
      var enemy = this.enemies[i];
      if (!enemy.alive || enemy === self) continue;
      if (overlapPoint(x, y, half, enemy.x, enemy.y, half)) return true;
    }
    for (i = 0; i < this.warnings.length; i += 1) {
      var warning = this.warnings[i];
      if (overlapPoint(x, y, half, warning.x, warning.y, C.TILE / 2)) return true;
    }
    return false;
  };

  TankGame.prototype.moveTankBy = function (tank, dx, dy) {
    var total = Math.abs(dx) + Math.abs(dy);
    if (total <= 0) return true;
    var steps = Math.max(1, Math.ceil(total));
    var sx = dx / steps;
    var sy = dy / steps;
    for (var i = 0; i < steps; i += 1) {
      var nx = tank.x + sx;
      var ny = tank.y + sy;
      if (this.tankBlockedAt(nx, ny, tank)) {
        if (typeof tank.vx === 'number') {
          tank.vx = 0;
          tank.vy = 0;
        }
        return false;
      }
      tank.x = nx;
      tank.y = ny;
    }
    return true;
  };

  TankGame.prototype.changeDirection = function (tank, dir) {
    if (tank.dir === dir) return;
    tank.dir = dir;
    var sx = tank.x;
    var sy = tank.y;
    if (dir === 'up' || dir === 'down') {
      sx = clamp(snapAxis(tank.x), C.PLAYER.body / 2, C.WIDTH - C.PLAYER.body / 2);
    } else {
      sy = clamp(snapAxis(tank.y), C.PLAYER.body / 2, C.HEIGHT - C.PLAYER.body / 2);
    }
    if (!this.tankBlockedAt(sx, sy, tank)) {
      tank.x = sx;
      tank.y = sy;
    }
  };

  TankGame.prototype.updatePlayer = function (dt) {
    var player = this.player;
    if (!player || !player.alive) return;

    if (player.cooldown > 0) player.cooldown = Math.max(0, player.cooldown - dt);
    if (player.muzzle > 0) player.muzzle = Math.max(0, player.muzzle - dt);

    var dir = this.getPressedDirection();
    if (dir) this.changeDirection(player, dir);

    var onIce = this.tileAt(player.x, player.y) === 'I';
    if (onIce) {
      var targetVx = dir ? DIRS[dir].x * C.PLAYER.speed : 0;
      var targetVy = dir ? DIRS[dir].y * C.PLAYER.speed : 0;
      var rate = dir ? 240 : 120;
      player.vx = approach(player.vx, targetVx, rate * dt);
      player.vy = approach(player.vy, targetVy, rate * dt);
      this.moveTankBy(player, player.vx * dt, player.vy * dt);
    } else {
      player.vx = 0;
      player.vy = 0;
      if (dir) {
        this.moveTankBy(player, DIRS[dir].x * C.PLAYER.speed * dt, DIRS[dir].y * C.PLAYER.speed * dt);
      }
    }

    var wantShoot = this.shootRequested;
    this.shootRequested = false;
    if (!wantShoot || player.cooldown > 0) return;
    var maxBullets = this.effects.power >= 2 ? C.PLAYER.maxBulletsPowered : C.PLAYER.maxBullets;
    var live = 0;
    for (var i = 0; i < this.bullets.length; i += 1) {
      if (this.bullets[i].alive && this.bullets[i].owner === 'player') live += 1;
    }
    if (live >= maxBullets) return;
    this.spawnBullet('player', null, player.x, player.y, player.dir, this.effects.power);
    player.cooldown = this.effects.power >= 2 ? C.PLAYER.cooldownPowered : C.PLAYER.cooldown;
    player.muzzle = C.FX.muzzle;
    this.audio.play('shoot');
  };

  TankGame.prototype.spawnBullet = function (owner, enemy, x, y, dir, power) {
    var vec = DIRS[dir];
    var speed;
    var offset = 9;
    if (owner === 'player') {
      speed = power >= 2 ? C.PLAYER.bulletSpeedPowered : C.PLAYER.bulletSpeed;
    } else {
      speed = enemy.bulletSpeed;
    }
    this.bullets.push({
      owner: owner,
      ownerId: enemy ? enemy.id : 0,
      x: x + vec.x * offset,
      y: y + vec.y * offset,
      prevX: x + vec.x * offset,
      prevY: y + vec.y * offset,
      dir: dir,
      speed: speed,
      power: power || 1,
      alive: true
    });
  };

  TankGame.prototype.updateEnemies = function (dt) {
    var frozen = this.effects.clock > 0;
    var level = C.LEVELS[this.levelIndex];
    for (var i = 0; i < this.enemies.length; i += 1) {
      var enemy = this.enemies[i];
      if (!enemy.alive) continue;
      if (enemy.muzzle > 0) enemy.muzzle = Math.max(0, enemy.muzzle - dt);
      if (enemy.hitFlash > 0) enemy.hitFlash = Math.max(0, enemy.hitFlash - dt);
      if (frozen) continue;

      enemy.decisionTimer -= dt;
      enemy.fireTimer -= dt;

      if (enemy.decisionTimer <= 0) {
        this.chooseEnemyDirection(enemy);
        enemy.decisionTimer = C.ENEMY.decisionInterval + this.rng() * 0.2;
      }

      var vec = DIRS[enemy.dir];
      var moved = this.moveTankBy(enemy, vec.x * enemy.speed * dt, vec.y * enemy.speed * dt);
      if (!moved) enemy.decisionTimer = 0;

      if (enemy.fireTimer <= 0) this.enemyFire(enemy, level);
    }
  };

  TankGame.prototype.chooseEnemyDirection = function (enemy) {
    var options = [];
    var dirs = ['up', 'down', 'left', 'right'];
    for (var i = 0; i < dirs.length; i += 1) {
      var probe = DIRS[dirs[i]];
      if (!this.tankBlockedAt(enemy.x + probe.x * 3, enemy.y + probe.y * 3, enemy)) {
        options.push(dirs[i]);
      }
    }
    if (options.length === 0) return;

    var targetX = this.baseCenter().x;
    var targetY = this.baseCenter().y;
    if (this.player && this.player.alive) {
      var pdx = this.player.x - enemy.x;
      var pdy = this.player.y - enemy.y;
      if (Math.abs(pdx) + Math.abs(pdy) < 96) {
        targetX = this.player.x;
        targetY = this.player.y;
      }
    }

    var dx = targetX - enemy.x;
    var dy = targetY - enemy.y;
    var preferred;
    if (Math.abs(dx) > Math.abs(dy)) preferred = dx > 0 ? 'right' : 'left';
    else preferred = dy > 0 ? 'down' : 'up';

    var choice = null;
    if (options.indexOf(preferred) >= 0 && this.rng() < 0.7) {
      choice = preferred;
    } else {
      var pool = [];
      for (var j = 0; j < options.length; j += 1) {
        if (options[j] !== OPPOSITE[enemy.dir]) pool.push(options[j]);
      }
      if (pool.length === 0) pool = options;
      choice = pool[Math.floor(this.rng() * pool.length)];
    }
    if (choice) this.changeDirection(enemy, choice);
  };

  TankGame.prototype.enemyFire = function (enemy, level) {
    var live = 0;
    for (var i = 0; i < this.bullets.length; i += 1) {
      if (this.bullets[i].alive && this.bullets[i].owner === 'enemy' && this.bullets[i].ownerId === enemy.id) live += 1;
    }
    if (live >= enemy.maxBullets) {
      enemy.fireTimer = 0.3;
      return;
    }

    var target = this.findEnemyTarget(enemy);
    var shootDir = null;
    if (target) shootDir = this.alignedDirection(enemy, target.x, target.y);
    if (shootDir) {
      this.spawnBullet('enemy', enemy, enemy.x, enemy.y, shootDir, 1);
      enemy.muzzle = C.FX.muzzle;
      enemy.fireTimer = this.randomFireInterval(enemy.def, level);
      return;
    }

    if (this.rng() < C.ENEMY.randomFireChance) {
      this.spawnBullet('enemy', enemy, enemy.x, enemy.y, enemy.dir, 1);
      enemy.muzzle = C.FX.muzzle;
    }
    enemy.fireTimer = this.randomFireInterval(enemy.def, level);
  };

  TankGame.prototype.findEnemyTarget = function (enemy) {
    if (this.player && this.player.alive) {
      var d = Math.abs(this.player.x - enemy.x) + Math.abs(this.player.y - enemy.y);
      if (d <= C.ENEMY.maxShootTiles * C.TILE) return { x: this.player.x, y: this.player.y };
    }
    if (this.baseAlive) {
      var base = this.baseCenter();
      if (Math.abs(this.baseCenter().x - enemy.x) <= C.ENEMY.maxShootTiles * C.TILE) return base;
    }
    return null;
  };

  TankGame.prototype.alignedDirection = function (enemy, tx, ty) {
    var tol = C.ENEMY.alignTolerance;
    var dir = null;
    if (Math.abs(enemy.x - tx) <= tol) dir = ty > enemy.y ? 'down' : 'up';
    else if (Math.abs(enemy.y - ty) <= tol) dir = tx > enemy.x ? 'right' : 'left';
    if (!dir) return null;

    var dx = DIRS[dir].x;
    var dy = DIRS[dir].y;
    var dist = Math.abs(tx - enemy.x) + Math.abs(ty - enemy.y);
    if (dist > C.ENEMY.maxShootTiles * C.TILE) return null;

    var stepX = enemy.x;
    var stepY = enemy.y;
    var guard = 0;
    while (Math.abs(stepX - tx) > C.TILE / 2 || Math.abs(stepY - ty) > C.TILE / 2) {
      stepX += dx * C.TILE / 2;
      stepY += dy * C.TILE / 2;
      if (dy !== 0 && Math.abs(stepY - ty) <= C.TILE / 2) break;
      if (dx !== 0 && Math.abs(stepX - tx) <= C.TILE / 2) break;
      var ch = this.tileAt(stepX, stepY);
      if (ch === 'S') return null;
      if (ch === 'E') break;
      guard += 1;
      if (guard > 30) break;
    }
    return dir;
  };

  TankGame.prototype.randomFireInterval = function (def, level) {
    var ms = def.fireMin + this.rng() * (def.fireMax - def.fireMin);
    return Math.max(0.25, (ms / 1000) * level.fireIntervalMultiplier);
  };

  TankGame.prototype.baseCenter = function () {
    return {
      x: (C.BASE.col + C.BASE.cols / 2) * C.TILE,
      y: (C.BASE.row + C.BASE.rows / 2) * C.TILE
    };
  };

  TankGame.prototype.spawnPointFree = function (col, row) {
    var x = col * C.TILE + C.TILE / 2;
    var y = row * C.TILE + C.TILE / 2;
    var half = C.TILE / 2;
    if (this.player && this.player.alive && overlapPoint(x, y, half, this.player.x, this.player.y, C.PLAYER.body / 2)) return false;
    for (var i = 0; i < this.enemies.length; i += 1) {
      if (this.enemies[i].alive && overlapPoint(x, y, half, this.enemies[i].x, this.enemies[i].y, C.PLAYER.body / 2)) return false;
    }
    for (var j = 0; j < this.warnings.length; j += 1) {
      if (overlapPoint(x, y, half, this.warnings[j].x, this.warnings[j].y, half)) return false;
    }
    return true;
  };

  TankGame.prototype.updateSpawner = function (dt) {
    if (this.queue.length === 0) return;
    if (this.enemies.length + this.warnings.length >= C.ENEMY.maxOnScreen) return;
    if (this.warnings.length > 0) return;

    this.spawnTimer -= dt;
    if (this.spawnTimer > 0) return;

    var spot = null;
    for (var i = 0; i < C.ENEMY_SPAWNS.length; i += 1) {
      var candidate = C.ENEMY_SPAWNS[i];
      if (this.spawnPointFree(candidate.col, candidate.row)) {
        spot = candidate;
        break;
      }
    }
    if (!spot) {
      this.spawnTimer = C.ENEMY.spawnRetry;
      return;
    }

    var entry = this.queue.shift();
    this.warnings.push({
      col: spot.col,
      row: spot.row,
      x: spot.col * C.TILE + C.TILE / 2,
      y: spot.row * C.TILE + C.TILE / 2,
      time: C.ENEMY.spawnWarning,
      entry: entry
    });
    this.spawnTimer = C.LEVELS[this.levelIndex].spawnInterval;
  };

  TankGame.prototype.updateWarnings = function (dt) {
    for (var i = this.warnings.length - 1; i >= 0; i -= 1) {
      var warning = this.warnings[i];
      warning.time -= dt;
      if (warning.time > 0) continue;
      var free = this.spawnPointFreeExcept(warning);
      if (!free) {
        warning.time = 0.2;
        continue;
      }
      this.spawnEnemy(warning);
      this.warnings.splice(i, 1);
    }
  };

  TankGame.prototype.spawnPointFreeExcept = function (warning) {
    var x = warning.x;
    var y = warning.y;
    var half = C.TILE / 2;
    if (this.player && this.player.alive && overlapPoint(x, y, half, this.player.x, this.player.y, C.PLAYER.body / 2)) return false;
    for (var i = 0; i < this.enemies.length; i += 1) {
      if (this.enemies[i].alive && overlapPoint(x, y, half, this.enemies[i].x, this.enemies[i].y, C.PLAYER.body / 2)) return false;
    }
    for (var j = 0; j < this.warnings.length; j += 1) {
      var other = this.warnings[j];
      if (other !== warning && overlapPoint(x, y, half, other.x, other.y, half)) return false;
    }
    return true;
  };

  TankGame.prototype.spawnEnemy = function (warning) {
    var def = C.ENEMY_TYPES[warning.entry.type];
    var level = C.LEVELS[this.levelIndex];
    this.enemies.push({
      id: this.nextEnemyId++,
      type: def.key,
      def: def,
      hp: def.hp,
      maxHp: def.hp,
      x: warning.x,
      y: warning.y,
      dir: 'down',
      speed: def.speed * level.speedMultiplier,
      bulletSpeed: def.bulletSpeed,
      maxBullets: def.maxBullets,
      score: def.score,
      dropItem: warning.entry.item || null,
      flash: !!warning.entry.item,
      decisionTimer: 0,
      fireTimer: this.randomFireInterval(def, level),
      muzzle: 0,
      vx: 0,
      vy: 0,
      alive: true
    });
  };

  TankGame.prototype.moveBullets = function (dt) {
    var i;
    var j;
    for (i = 0; i < this.bullets.length; i += 1) {
      var b = this.bullets[i];
      if (!b.alive) continue;
      var vec = DIRS[b.dir];
      b.prevX = b.x;
      b.prevY = b.y;
      b.x += vec.x * b.speed * dt;
      b.y += vec.y * b.speed * dt;
      if (b.x < -2 || b.x > C.WIDTH + 2 || b.y < -2 || b.y > C.HEIGHT + 2) b.alive = false;
    }

    for (i = 0; i < this.bullets.length; i += 1) {
      var a = this.bullets[i];
      if (!a.alive) continue;
      for (j = i + 1; j < this.bullets.length; j += 1) {
        var c = this.bullets[j];
        if (!c.alive || a.owner === c.owner) continue;
        if (bulletsIntersect(a, c)) {
          a.alive = false;
          c.alive = false;
          break;
        }
      }
    }

    var baseHit = false;
    var playerHit = false;

    for (i = 0; i < this.bullets.length; i += 1) {
      var bullet = this.bullets[i];
      if (!bullet.alive) continue;

      if (this.bulletHitsTile(bullet)) {
        if (bullet.hitBase) baseHit = true;
        continue;
      }

      if (bullet.owner === 'player') {
        for (j = 0; j < this.enemies.length; j += 1) {
          var enemy = this.enemies[j];
          if (!enemy.alive) continue;
          if (overlapRect(bullet.x - 2, bullet.y - 2, 4, 4, enemy.x - 7, enemy.y - 7, 14, 14)) {
            bullet.alive = false;
            enemy.hp -= C.PLAYER.bulletDamage;
            if (enemy.hp <= 0) {
              this.killEnemy(enemy, true);
            } else {
              this.audio.play('hit');
              enemy.hitFlash = 0.12;
            }
            break;
          }
        }
      } else if (this.player && this.player.alive) {
        if (overlapRect(bullet.x - 2, bullet.y - 2, 4, 4, this.player.x - 7, this.player.y - 7, 14, 14)) {
          bullet.alive = false;
          if (this.effects.invincible > 0) {
            this.audio.play('hit');
          } else {
            playerHit = true;
          }
        }
      }
    }

    this.bullets = this.bullets.filter(function (b) { return b.alive; });
    this.enemies = this.enemies.filter(function (e) { return e.alive; });

    if (baseHit) {
      this.baseAlive = false;
      this.setGameOver('base');
      return;
    }
    if (playerHit && this.status === 'playing') {
      this.killPlayer();
    }
  };

  TankGame.prototype.bulletHitsTile = function (bullet) {
    var vec = DIRS[bullet.dir];
    var leadX = bullet.x + vec.x * 2;
    var leadY = bullet.y + vec.y * 2;
    var cells = [];
    var seen = {};
    var xs = [bullet.x - 2, bullet.x + 2, leadX];
    var ys = [bullet.y - 2, bullet.y + 2, leadY];
    for (var i = 0; i < xs.length; i += 1) {
      for (var j = 0; j < ys.length; j += 1) {
        var col = Math.floor(xs[i] / C.TILE);
        var row = Math.floor(ys[j] / C.TILE);
        var key = col + ',' + row;
        if (seen[key]) continue;
        seen[key] = true;
        cells.push({ col: col, row: row, proj: (col * C.TILE + C.TILE / 2 - bullet.x) * vec.x + (row * C.TILE + C.TILE / 2 - bullet.y) * vec.y });
      }
    }
    cells.sort(function (a, b) { return b.proj - a.proj; });

    for (var k = 0; k < cells.length; k += 1) {
      var cell = cells[k];
      var ch = this.tileAtCell(cell.col, cell.row);
      if (!ch) continue;
      if (ch === 'B') {
        this.grid[cell.row][cell.col] = '.';
        bullet.alive = false;
        this.audio.play('hit');
        return true;
      }
      if (ch === 'S') {
        if (bullet.owner === 'player' && bullet.power >= 2) {
          this.grid[cell.row][cell.col] = '.';
          this.audio.play('hit');
        } else {
          this.audio.play('hit');
        }
        bullet.alive = false;
        return true;
      }
      if (ch === 'E') {
        bullet.alive = false;
        bullet.hitBase = true;
        this.audio.play('explode');
        return true;
      }
    }
    return false;
  };

  function bulletsIntersect(a, b) {
    var px = a.prevX - b.prevX;
    var py = a.prevY - b.prevY;
    var vx = (a.x - a.prevX) - (b.x - b.prevX);
    var vy = (a.y - a.prevY) - (b.y - b.prevY);
    var t = 0;
    var denom = vx * vx + vy * vy;
    if (denom > 0) t = clamp(-(px * vx + py * vy) / denom, 0, 1);
    var dx = px + vx * t;
    var dy = py + vy * t;
    return dx * dx + dy * dy <= 16;
  }

  TankGame.prototype.killEnemy = function (enemy, allowDrop) {
    if (!enemy.alive) return;
    enemy.alive = false;
    this.addScore(enemy.score);
    this.explosions.push({ x: enemy.x, y: enemy.y, age: 0, duration: C.FX.explosion, big: true });
    this.audio.play('explode');
    if (allowDrop && enemy.dropItem) {
      this.spawnItem(enemy.dropItem, enemy.x, enemy.y);
    }
  };

  TankGame.prototype.killPlayer = function () {
    var player = this.player;
    if (!player || !player.alive) return;
    player.alive = false;
    this.lives = Math.max(0, this.lives - 1);
    this.effects.power = 1;
    this.clearInput();
    this.explosions.push({ x: player.x, y: player.y, age: 0, duration: C.FX.explosion, big: true });
    this.audio.play('explode');
    if (this.lives <= 0) {
      this.setGameOver('lives');
    } else {
      this.freeze = C.PLAYER.respawnDelay;
    }
  };

  TankGame.prototype.tryRespawn = function () {
    if (this.status !== 'playing') return;
    if (!this.spawnBlocked()) {
      this.respawnWaiting = false;
      this.respawnPlayer();
      return;
    }
    if (this.respawnWaiting && this.respawnWaitElapsed >= C.PLAYER.respawnMaxWait) {
      this.clearSpawnEnemies();
      this.respawnWaiting = false;
      this.respawnPlayer();
      return;
    }
    if (!this.respawnWaiting) {
      this.respawnWaiting = true;
      this.respawnWaitElapsed = 0;
    }
    this.respawnRetryTimer = C.PLAYER.respawnRetry;
    this.explosions.push({ x: this.playerSpawn().x, y: this.playerSpawn().y, age: 0, duration: 0.12, big: false });
  };

  TankGame.prototype.spawnBlocked = function () {
    var spawn = this.playerSpawn();
    for (var i = 0; i < this.enemies.length; i += 1) {
      if (this.enemies[i].alive && overlapPoint(spawn.x, spawn.y, C.TILE / 2, this.enemies[i].x, this.enemies[i].y, C.PLAYER.body / 2)) return true;
    }
    return !!this.tankBlockedAt(spawn.x, spawn.y, this.player || null);
  };

  TankGame.prototype.clearSpawnEnemies = function () {
    var spawn = this.playerSpawn();
    for (var i = 0; i < this.enemies.length; i += 1) {
      var enemy = this.enemies[i];
      if (enemy.alive && overlapPoint(spawn.x, spawn.y, C.TILE / 2, enemy.x, enemy.y, C.PLAYER.body / 2)) {
        enemy.alive = false;
        this.explosions.push({ x: enemy.x, y: enemy.y, age: 0, duration: C.FX.explosion, big: false });
      }
    }
    this.enemies = this.enemies.filter(function (e) { return e.alive; });
  };

  TankGame.prototype.respawnPlayer = function () {
    var spawn = this.playerSpawn();
    var player = this.player;
    player.x = spawn.x;
    player.y = spawn.y;
    player.dir = 'up';
    player.vx = 0;
    player.vy = 0;
    player.cooldown = 0;
    player.muzzle = 0;
    player.alive = true;
    this.effects.invincible = Math.max(this.effects.invincible, C.PLAYER.spawnInvincible);
    this.acc = 0;
  };

  TankGame.prototype.setGameOver = function (reason) {
    if (this.status === 'gameOver') return;
    this.status = 'gameOver';
    this.failReason = reason;
    if (reason === 'base') this.baseAlive = false;
    this.endDelay = C.FX.endDelay;
    this.overlayKind = '';
    this.overlayShownAt = 0;
    this.clearInput();
    if (reason === 'base') {
      var base = this.baseCenter();
      this.explosions.push({ x: base.x, y: base.y, age: 0, duration: C.FX.explosion, big: true });
    }
    this.audio.play('fail');
    this.persistHighScore();
    this.updateHud();
  };

  TankGame.prototype.setVictory = function () {
    this.status = 'victory';
    this.endDelay = 0;
    this.clearInput();
    this.audio.play('victory');
    this.persistHighScore();
    this.updateOverlay('victory');
    this.updateHud();
  };

  TankGame.prototype.setLevelClear = function () {
    this.addScore(C.SCORE.levelClear);
    if (this.levelIndex >= C.LEVELS.length - 1) {
      this.setVictory();
      return;
    }
    this.status = 'levelClear';
    this.levelTimer = C.FX.levelClear;
    this.acc = 0;
    this.clearInput();
    this.audio.play('level');
    this.updateOverlay('levelClear');
    this.updateHud();
  };

  TankGame.prototype.nextLevel = function () {
    var keepPower = this.effects.power;
    this.levelIndex += 1;
    this.setupLevel(this.levelIndex);
    this.effects.power = keepPower;
    this.status = 'playing';
    this.hideOverlay();
    this.updateHud();
    var inactive = document.hidden || (typeof document.hasFocus === 'function' && !document.hasFocus());
    if (inactive) this.pause(true);
    else this.focusCanvas();
  };

  TankGame.prototype.checkLevelEnd = function () {
    if (this.status !== 'playing' || this.freeze > 0 || this.respawnWaiting) return;
    if (this.queue.length === 0 && this.enemies.length === 0 && this.warnings.length === 0) {
      this.setLevelClear();
    }
  };

  TankGame.prototype.updateItems = function (dt) {
    var i;
    for (i = this.items.length - 1; i >= 0; i -= 1) {
      this.items[i].ttl -= dt;
      if (this.items[i].ttl <= 0) {
        this.items.splice(i, 1);
      }
    }
    if (!this.player || !this.player.alive) return;
    for (i = this.items.length - 1; i >= 0; i -= 1) {
      var item = this.items[i];
      if (Math.abs(this.player.x - item.x) < 15 && Math.abs(this.player.y - item.y) < 15) {
        this.items.splice(i, 1);
        this.applyItem(item.type);
      }
    }
  };

  TankGame.prototype.spawnItem = function (type, x, y) {
    var pos = this.findItemPosition(x, y);
    if (!pos) return;
    this.items = [{
      type: type,
      x: pos.x,
      y: pos.y,
      ttl: C.ITEM.ttl
    }];
  };

  TankGame.prototype.findItemPosition = function (x, y) {
    var startCol = clamp(Math.floor(x / C.TILE), 0, C.COLS - 1);
    var startRow = clamp(Math.floor(y / C.TILE), 0, C.ROWS - 1);
    if (PASSABLE[this.grid[startRow][startCol]]) {
      return { x: startCol * C.TILE + C.TILE / 2, y: startRow * C.TILE + C.TILE / 2 };
    }
    var best = null;
    var bestDist = Infinity;
    for (var r = startRow - 2; r <= startRow + 2; r += 1) {
      for (var c = startCol - 2; c <= startCol + 2; c += 1) {
        if (r < 0 || r >= C.ROWS || c < 0 || c >= C.COLS) continue;
        if (!PASSABLE[this.grid[r][c]]) continue;
        var dist = Math.abs(r - startRow) + Math.abs(c - startCol);
        if (dist < bestDist) {
          bestDist = dist;
          best = { x: c * C.TILE + C.TILE / 2, y: r * C.TILE + C.TILE / 2 };
        }
      }
    }
    return best;
  };

  TankGame.prototype.applyItem = function (type) {
    var label = C.ITEMS[type] ? C.ITEMS[type].label : '道具';
    var message = '获得' + label;
    switch (type) {
      case 'grenade':
        this.useGrenade();
        break;
      case 'helmet':
        this.effects.invincible = Math.max(this.effects.invincible, C.EFFECT.helmet);
        break;
      case 'shovel':
        this.effects.shovel = C.EFFECT.shovel;
        this.applyProtectionSteel();
        break;
      case 'star':
        if (this.effects.power < 2) this.effects.power = 2;
        else message = '火力已满';
        break;
      case 'tank':
        this.lives = Math.min(C.PLAYER.maxLives, this.lives + 1);
        break;
      case 'clock':
        this.effects.clock = C.EFFECT.clock;
        break;
      default:
        break;
    }
    this.audio.play('pickup');
    this.showNotice(message);
  };

  TankGame.prototype.useGrenade = function () {
    this.flashTimer = 0.14;
    for (var i = 0; i < this.enemies.length; i += 1) {
      var enemy = this.enemies[i];
      if (!enemy.alive) continue;
      enemy.alive = false;
      this.addScore(enemy.score);
      this.explosions.push({ x: enemy.x, y: enemy.y, age: 0, duration: C.FX.explosion, big: true });
    }
    this.enemies = [];
    this.bullets = this.bullets.filter(function (b) { return b.owner !== 'enemy'; });
    this.audio.play('explode');
  };

  TankGame.prototype.applyProtectionSteel = function () {
    for (var i = 0; i < C.PROTECTION.length; i += 1) {
      var cell = C.PROTECTION[i];
      this.grid[cell.row][cell.col] = 'S';
    }
  };

  TankGame.prototype.restoreProtection = function () {
    for (var i = 0; i < C.PROTECTION.length; i += 1) {
      var cell = C.PROTECTION[i];
      this.grid[cell.row][cell.col] = 'B';
      var left = cell.col * C.TILE;
      var top = cell.row * C.TILE;
      this.bullets = this.bullets.filter(function (b) {
        return !overlapRect(b.x - 2, b.y - 2, 4, 4, left, top, C.TILE, C.TILE);
      });
    }
  };

  TankGame.prototype.showNotice = function (text) {
    this.dom.toast.textContent = text;
    this.dom.toast.setAttribute('data-visible', 'true');
    this.noticeTimer = C.ITEM.pickupNotice;
  };

  TankGame.prototype.addScore = function (value) {
    this.score = clamp(this.score + value, 0, C.SCORE.max);
    if (this.score > this.highScore) this.highScore = this.score;
  };

  TankGame.prototype.persistHighScore = function () {
    this.storage.writeHighScore(this.highScore);
  };

  TankGame.prototype.playerSpawn = function () {
    return {
      x: C.PLAYER_SPAWN.col * C.TILE + C.TILE / 2,
      y: C.PLAYER_SPAWN.row * C.TILE + C.TILE / 2
    };
  };

  TankGame.prototype.createPlayer = function () {
    var spawn = this.playerSpawn();
    return {
      x: spawn.x,
      y: spawn.y,
      dir: 'up',
      vx: 0,
      vy: 0,
      cooldown: 0,
      muzzle: 0,
      alive: true
    };
  };

  TankGame.prototype.setupLevel = function (index) {
    var level = C.LEVELS[index];
    this.grid = level.map.map(function (row) { return row.split(''); });
    this.queue = level.queue.map(function (entry) { return { type: entry.type, item: entry.item }; });
    this.enemies = [];
    this.bullets = [];
    this.items = [];
    this.explosions = [];
    this.warnings = [];
    this.baseAlive = true;
    this.failReason = '';
    this.spawnTimer = level.spawnInterval;
    this.freeze = 0;
    this.endDelay = 0;
    this.levelTimer = 0;
    this.respawnWaiting = false;
    this.respawnWaitElapsed = 0;
    this.respawnRetryTimer = 0;
    this.nextEnemyId = 1;
    this.acc = 0;
    this.effects.invincible = C.PLAYER.spawnInvincible;
    this.effects.clock = 0;
    this.effects.shovel = 0;
    this.player = this.createPlayer();
    this.rng = mulberry32(0x51F15E + index * 7919);
    this.ariaCache = '';
  };

  TankGame.prototype.resetIdle = function () {
    this.status = 'idle';
    this.levelIndex = 0;
    this.lives = C.PLAYER.lives;
    this.score = 0;
    this.baseAlive = true;
    this.failReason = '';
    this.effects.power = 1;
    this.effects.invincible = 0;
    this.effects.clock = 0;
    this.effects.shovel = 0;
    this.grid = C.LEVELS[0].map.map(function (row) { return row.split(''); });
    this.queue = C.LEVELS[0].queue.map(function (entry) { return { type: entry.type, item: entry.item }; });
    this.enemies = [];
    this.bullets = [];
    this.items = [];
    this.explosions = [];
    this.warnings = [];
    this.player = this.createPlayer();
    this.freeze = 0;
    this.endDelay = 0;
    this.levelTimer = 0;
    this.respawnWaiting = false;
    this.spawnTimer = 0;
    this.acc = 0;
    this.fatal = false;
  };

  TankGame.prototype.startNewGame = function () {
    if (this.fatal) return;
    this.audio.init();
    this.audio.resume();
    this.audio.setMuted(this.muted);
    this.levelIndex = 0;
    this.lives = C.PLAYER.lives;
    this.score = 0;
    this.effects.power = 1;
    this.setupLevel(0);
    this.status = 'playing';
    this.flashTimer = 0;
    this.noticeTimer = 0;
    this.dom.toast.textContent = '';
    this.dom.toast.setAttribute('data-visible', 'false');
    this.clearInput();
    this.hideOverlay();
    this.updateHud();
    this.focusCanvas();
  };

  TankGame.prototype.restart = function () {
    if (this.fatal) return;
    this.audio.init();
    this.audio.resume();
    this.startNewGame();
  };

  TankGame.prototype.pause = function (auto) {
    if (this.status !== 'playing') return;
    this.status = 'paused';
    this.clearInput();
    this.audio.suspend();
    this.updateOverlay('paused', auto);
    this.updateHud();
  };

  TankGame.prototype.resume = function () {
    if (this.status !== 'paused') return;
    this.status = 'playing';
    this.acc = 0;
    this.clearInput();
    this.audio.resume();
    this.hideOverlay();
    this.updateHud();
    this.focusCanvas();
  };

  TankGame.prototype.togglePause = function () {
    if (this.fatal) return;
    if (this.status === 'playing') this.pause(false);
    else if (this.status === 'paused') this.resume();
  };

  TankGame.prototype.toggleMute = function () {
    if (this.fatal) return;
    this.muted = !this.muted;
    this.storage.writeMuted(this.muted);
    if (!this.muted && this.status !== 'idle') {
      this.audio.init();
      this.audio.resume();
    }
    this.audio.setMuted(this.muted);
    this.updateHud();
  };

  TankGame.prototype.onPrimary = function () {
    if (this.overlayKind === 'idle') this.startNewGame();
    else if (this.overlayKind === 'paused') this.resume();
    else if (this.overlayKind === 'gameOver' || this.overlayKind === 'victory') this.restart();
  };

  TankGame.prototype.onSecondary = function () {
    if (this.overlayKind === 'paused' || this.overlayKind === 'gameOver' || this.overlayKind === 'victory') {
      this.restart();
    }
  };

  TankGame.prototype.updateOverlay = function (kind, auto) {
    var previous = this.overlayKind;
    this.overlayKind = kind;
    if (!kind) {
      this.hideOverlay();
      return;
    }

    var title = '';
    var text = '';
    var stats = '';
    var primary = '';
    var secondary = '';
    var showPrimary = true;
    var showSecondary = false;
    var level = this.levelIndex + 1;

    if (kind === 'idle') {
      title = '准备战斗';
      text = '方向键 / WASD 移动，空格 / J 射击，P 暂停，M 静音';
      stats = '最高分 ' + this.highScore;
      primary = '开始游戏';
    } else if (kind === 'paused') {
      title = '游戏已暂停';
      text = auto ? '窗口失焦，游戏已自动暂停' : '模拟与音效已冻结';
      stats = '第 ' + level + ' 关 · 得分 ' + this.score;
      primary = '继续游戏';
      secondary = '重新开始';
      showSecondary = true;
    } else if (kind === 'levelClear') {
      title = '第 ' + level + ' 关完成';
      text = '准备进入下一关';
      stats = '当前得分 ' + this.score;
      showPrimary = false;
    } else if (kind === 'gameOver') {
      title = '游戏结束';
      text = this.failReason === 'base' ? '基地被摧毁' : '生命耗尽';
      stats = '本局得分 ' + this.score + ' · 最高分 ' + this.highScore;
      primary = '重新开始';
    } else if (kind === 'victory') {
      title = '胜利';
      text = '全部关卡完成';
      stats = '本局得分 ' + this.score + ' · 最高分 ' + this.highScore;
      primary = '重新开始';
    } else if (kind === 'error') {
      title = '游戏加载失败';
      text = '游戏加载失败，请刷新页面重试';
      showPrimary = false;
    } else if (kind === 'runtimeError') {
      title = '游戏运行异常';
      text = '游戏运行异常，请刷新页面重试';
      showPrimary = false;
    }

    this.dom.overlayTitle.textContent = title;
    this.dom.overlayText.textContent = text;
    this.dom.overlayStats.textContent = stats;
    this.dom.primaryBtn.textContent = primary || '开始游戏';
    this.dom.primaryBtn.hidden = !showPrimary;
    this.dom.secondaryBtn.textContent = secondary || '重新开始';
    this.dom.secondaryBtn.hidden = !showSecondary;
    this.dom.overlay.hidden = false;
    this.dom.overlay.setAttribute('data-kind', kind);

    if (showPrimary && (previous !== kind || kind !== 'levelClear')) {
      try { this.dom.primaryBtn.focus({ preventScroll: true }); } catch (e) { this.dom.primaryBtn.focus(); }
    }
  };

  TankGame.prototype.hideOverlay = function () {
    this.dom.overlay.hidden = true;
    this.overlayKind = '';
  };

  TankGame.prototype.focusCanvas = function () {
    try { this.canvas.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
  };

  TankGame.prototype.handleRuntimeError = function (error) {
    if (this.fatal) return;
    this.fatal = true;
    this.status = 'paused';
    this.clearInput();
    this.audio.suspend();
    this.updateOverlay('runtimeError');
    if (root.console && root.console.error) root.console.error('TankGame runtime error', error);
  };

  TankGame.prototype.getState = function () {
    if (this.status === 'idle') {
      var spawn = this.playerSpawn();
      return {
        status: 'idle',
        level: 1,
        lives: C.PLAYER.lives,
        enemiesRemaining: C.LEVELS[0].queue.length,
        enemiesOnScreen: 0,
        score: 0,
        highScore: this.highScore,
        baseAlive: true,
        muted: this.muted,
        playerX: spawn.x,
        playerY: spawn.y,
        playerDirection: 'up'
      };
    }

    var remaining = this.queue.length + this.enemies.length + this.warnings.length;
    var px = this.playerSpawn().x;
    var py = this.playerSpawn().y;
    var dir = 'up';
    if (this.player && this.player.alive) {
      px = this.player.x;
      py = this.player.y;
      dir = this.player.dir;
    }
    return {
      status: this.status,
      level: clamp(this.levelIndex + 1, 1, C.LEVELS.length),
      lives: clamp(this.lives, 0, C.PLAYER.maxLives),
      enemiesRemaining: clamp(remaining, 0, C.LEVELS[0].queue.length),
      enemiesOnScreen: this.enemies.length,
      score: clamp(this.score, 0, C.SCORE.max),
      highScore: clamp(this.highScore, 0, C.SCORE.max),
      baseAlive: this.baseAlive,
      muted: this.muted,
      playerX: round1(px),
      playerY: round1(py),
      playerDirection: dir
    };
  };

  TankGame.prototype.updateHud = function () {
    var state = this.getState();
    this.dom.hudLevel.textContent = String(state.level);
    this.dom.hudLives.textContent = String(state.lives);
    this.dom.hudEnemies.textContent = String(state.enemiesRemaining);
    this.dom.hudScore.textContent = String(state.score);
    this.dom.hudHighScore.textContent = String(state.highScore);

    var parts = [];
    var expiring = false;
    if (this.effects.power >= 2) parts.push('火力 Lv2');
    if (this.effects.invincible > 0) {
      parts.push('护盾 ' + Math.ceil(this.effects.invincible) + 's');
      if (this.effects.invincible <= 3) expiring = true;
    }
    if (this.effects.clock > 0) {
      parts.push('冻结 ' + Math.ceil(this.effects.clock) + 's');
      if (this.effects.clock <= 3) expiring = true;
    }
    if (this.effects.shovel > 0) {
      parts.push('基地钢墙 ' + Math.ceil(this.effects.shovel) + 's');
      if (this.effects.shovel <= 3) expiring = true;
    }
    if (this.items.length > 0) {
      parts.push('道具 ' + Math.ceil(this.items[0].ttl) + 's');
      if (this.items[0].ttl <= 3) expiring = true;
    }
    this.dom.hudEffects.textContent = parts.length ? parts.join(' · ') : '—';
    this.dom.hudEffects.classList.toggle('is-expiring', expiring);

    this.dom.muteBtn.textContent = this.muted ? '音效：关' : '音效：开';
    this.dom.muteBtn.setAttribute('aria-pressed', this.muted ? 'true' : 'false');
    this.dom.pauseBtn.textContent = this.status === 'paused' ? '继续' : '暂停';
    this.dom.pauseBtn.disabled = this.status !== 'playing' && this.status !== 'paused';

    var aria = '状态 ' + state.status + '，第 ' + state.level + ' 关，生命 ' + state.lives + '，剩余敌人 ' + state.enemiesRemaining + '，得分 ' + state.score;
    if (aria !== this.ariaCache) {
      this.ariaCache = aria;
      this.dom.ariaStatus.textContent = aria;
    }
  };

  TankGame.prototype.tickExplosions = function (dt) {
    for (var i = this.explosions.length - 1; i >= 0; i -= 1) {
      this.explosions[i].age += dt;
      if (this.explosions[i].age >= this.explosions[i].duration) this.explosions.splice(i, 1);
    }
  };

  /* ------------------------------ 渲染 ------------------------------ */

  TankGame.prototype.render = function () {
    var ctx = this.ctx;
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.imageSmoothingEnabled = false;

    ctx.fillStyle = '#05070a';
    ctx.fillRect(0, 0, C.WIDTH, C.HEIGHT);
    if (!this.grid) return;

    var r;
    var c;
    for (r = 0; r < C.ROWS; r += 1) {
      for (c = 0; c < C.COLS; c += 1) {
        var x = c * C.TILE;
        var y = r * C.TILE;
        var ch = this.grid[r][c];
        if (ch === 'T' || ch === 'E') continue;
        this.drawGroundTile(ctx, x, y, r, c);
        this.drawTerrainTile(ctx, x, y, ch, r, c);
      }
    }

    this.drawBase(ctx);
    this.drawItems(ctx);
    this.drawTanks(ctx);
    this.drawTrees(ctx);
    this.drawBullets(ctx);
    this.drawMuzzles(ctx);
    this.drawExplosions(ctx);
    this.drawWarnings(ctx);

    if (this.flashTimer > 0) {
      ctx.globalAlpha = Math.min(0.3, this.flashTimer / 0.14 * 0.3);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, C.WIDTH, C.HEIGHT);
      ctx.globalAlpha = 1;
    }
  };

  TankGame.prototype.drawGroundTile = function (ctx, x, y, row, col) {
    ctx.fillStyle = (row + col) % 2 === 0 ? '#0a0f15' : '#0c1219';
    ctx.fillRect(x, y, C.TILE, C.TILE);
    if ((row + col) % 2 === 0) {
      ctx.fillStyle = 'rgba(255,255,255,0.025)';
      ctx.fillRect(x + 7, y + 7, 2, 2);
    }
  };

  TankGame.prototype.drawTerrainTile = function (ctx, x, y, ch, row, col) {
    if (ch === 'B') {
      ctx.fillStyle = '#5c2413';
      ctx.fillRect(x, y, C.TILE, C.TILE);
      for (var i = 0; i < 2; i += 1) {
        for (var j = 0; j < 2; j += 1) {
          var bx = x + 1 + i * 7;
          var by = y + 1 + j * 7;
          ctx.fillStyle = '#c25a2e';
          ctx.fillRect(bx, by, 6, 6);
          ctx.fillStyle = '#e8844a';
          ctx.fillRect(bx, by, 6, 1);
          ctx.fillStyle = '#8e3a1c';
          ctx.fillRect(bx + 4, by + 1, 2, 1);
        }
      }
      return;
    }
    if (ch === 'S') {
      var shovelBlink = this.effects.shovel > 0 && this.effects.shovel <= 3 && Math.floor(this.animTime * 5) % 2 === 1;
      ctx.fillStyle = '#3d4652';
      ctx.fillRect(x, y, C.TILE, C.TILE);
      ctx.fillStyle = shovelBlink ? '#e8edf5' : '#8d99a8';
      ctx.fillRect(x + 1, y + 1, 14, 14);
      ctx.fillStyle = '#c6d2df';
      ctx.fillRect(x + 2, y + 2, 5, 5);
      ctx.fillRect(x + 9, y + 2, 5, 5);
      ctx.fillRect(x + 2, y + 9, 5, 5);
      ctx.fillRect(x + 9, y + 9, 5, 5);
      ctx.fillStyle = '#5f6b7a';
      ctx.fillRect(x + 7, y + 2, 2, 12);
      ctx.fillRect(x + 2, y + 7, 12, 2);
      return;
    }
    if (ch === 'W') {
      ctx.fillStyle = '#123b6d';
      ctx.fillRect(x, y, C.TILE, C.TILE);
      var phase = Math.sin(this.animTime * 3 + col * 0.8 + row * 0.4);
      ctx.fillStyle = '#2a6fb5';
      ctx.fillRect(x + 2 + Math.round(phase), y + 4, 7, 2);
      ctx.fillRect(x + 8 - Math.round(phase), y + 10, 6, 2);
      ctx.fillStyle = '#4a95d6';
      ctx.fillRect(x + 4, y + 7, 5, 1);
      return;
    }
    if (ch === 'I') {
      ctx.fillStyle = '#b9e3f1';
      ctx.fillRect(x, y, C.TILE, C.TILE);
      ctx.fillStyle = '#ddf5fb';
      ctx.fillRect(x + 2, y + 2, 12, 2);
      ctx.fillRect(x + 2, y + 8, 8, 2);
      ctx.fillStyle = '#7fc4dd';
      ctx.fillRect(x + 2, y + 13, 12, 1);
      ctx.fillRect(x + 10, y + 7, 4, 1);
      return;
    }
    if (ch === 'P' || ch === 'X') {
      ctx.strokeStyle = 'rgba(89,211,255,0.18)';
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 4.5, y + 4.5, 7, 7);
    }
  };

  TankGame.prototype.drawBase = function (ctx) {
    var x = C.BASE.col * C.TILE;
    var y = C.BASE.row * C.TILE;
    var w = C.BASE.cols * C.TILE;
    var h = C.BASE.rows * C.TILE;
    ctx.fillStyle = '#0f141b';
    ctx.fillRect(x, y, w, h);
    if (this.baseAlive) {
      ctx.fillStyle = '#6b5113';
      ctx.fillRect(x + 3, y + 24, 26, 6);
      ctx.fillStyle = '#f5c542';
      ctx.beginPath();
      ctx.moveTo(x + 16, y + 4);
      ctx.lineTo(x + 21, y + 10);
      ctx.lineTo(x + 28, y + 8);
      ctx.lineTo(x + 24, y + 17);
      ctx.lineTo(x + 28, y + 25);
      ctx.lineTo(x + 18, y + 22);
      ctx.lineTo(x + 16, y + 28);
      ctx.lineTo(x + 14, y + 22);
      ctx.lineTo(x + 4, y + 25);
      ctx.lineTo(x + 8, y + 17);
      ctx.lineTo(x + 4, y + 8);
      ctx.lineTo(x + 11, y + 10);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#fff3c4';
      ctx.fillRect(x + 12, y + 8, 8, 8);
      ctx.fillStyle = '#3a2a06';
      ctx.fillRect(x + 14, y + 10, 2, 2);
      ctx.fillRect(x + 19, y + 10, 2, 2);
      ctx.fillRect(x + 15, y + 14, 4, 1);
    } else {
      ctx.fillStyle = '#3a3f47';
      ctx.fillRect(x + 4, y + 20, 24, 10);
      ctx.fillStyle = '#6e747e';
      ctx.fillRect(x + 8, y + 16, 7, 6);
      ctx.fillRect(x + 18, y + 18, 8, 5);
      ctx.fillStyle = '#a83b2a';
      ctx.fillRect(x + 13, y + 24, 7, 3);
      ctx.fillStyle = '#ff7a45';
      ctx.fillRect(x + 15, y + 21, 3, 5);
    }
  };

  TankGame.prototype.drawItems = function (ctx) {
    for (var i = 0; i < this.items.length; i += 1) {
      var item = this.items[i];
      if (item.ttl <= C.ITEM.blinkFrom && Math.floor(this.animTime * 5) % 2 === 1) continue;
      var x = Math.round(item.x) - 8;
      var y = Math.round(item.y) - 8;
      ctx.fillStyle = 'rgba(8,12,18,0.9)';
      ctx.fillRect(x, y, 16, 16);
      ctx.strokeStyle = '#f5c542';
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, y + 0.5, 15, 15);
      ctx.save();
      ctx.translate(x, y);
      this.drawItemIcon(ctx, item.type);
      ctx.restore();
    }
  };

  TankGame.prototype.drawItemIcon = function (ctx, type) {
    if (type === 'star') {
      ctx.fillStyle = '#ffe066';
      ctx.beginPath();
      for (var i = 0; i < 10; i += 1) {
        var r = i % 2 === 0 ? 6 : 2.6;
        var a = -Math.PI / 2 + i * Math.PI / 5;
        var px = 8 + Math.cos(a) * r;
        var py = 8 + Math.sin(a) * r;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fill();
      return;
    }
    if (type === 'helmet') {
      ctx.fillStyle = '#59d3ff';
      ctx.beginPath();
      ctx.arc(8, 8, 5.4, Math.PI, 0);
      ctx.lineTo(13, 12);
      ctx.lineTo(3, 12);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#d9f7ff';
      ctx.fillRect(3, 11, 10, 2);
      return;
    }
    if (type === 'shovel') {
      ctx.strokeStyle = '#c98b4b';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(5, 3);
      ctx.lineTo(10, 10);
      ctx.stroke();
      ctx.fillStyle = '#aab4bf';
      ctx.beginPath();
      ctx.moveTo(9, 9);
      ctx.lineTo(13, 13);
      ctx.lineTo(10, 14);
      ctx.lineTo(7, 11);
      ctx.closePath();
      ctx.fill();
      return;
    }
    if (type === 'grenade') {
      ctx.fillStyle = '#5b8f3a';
      ctx.beginPath();
      ctx.arc(8, 9, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#8ad04d';
      ctx.fillRect(6, 2, 4, 3);
      ctx.strokeStyle = '#d8d8d8';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(12, 3, 2, 0, Math.PI * 2);
      ctx.stroke();
      return;
    }
    if (type === 'tank') {
      ctx.fillStyle = '#7bd88f';
      ctx.fillRect(3, 6, 10, 7);
      ctx.fillStyle = '#d8ffe0';
      ctx.fillRect(6, 4, 4, 4);
      ctx.fillRect(7, 2, 2, 3);
      ctx.fillStyle = '#3d7f4a';
      ctx.fillRect(3, 9, 10, 1);
      ctx.fillRect(2, 12, 3, 2);
      ctx.fillRect(11, 12, 3, 2);
      return;
    }
    if (type === 'clock') {
      ctx.fillStyle = '#e8edf5';
      ctx.beginPath();
      ctx.arc(8, 8, 5.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#263243';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(8, 8);
      ctx.lineTo(8, 5);
      ctx.moveTo(8, 8);
      ctx.lineTo(11, 9);
      ctx.stroke();
      ctx.fillStyle = '#59d3ff';
      ctx.fillRect(7, 1, 2, 2);
    }
  };

  TankGame.prototype.drawTanks = function (ctx) {
    if (this.player && this.player.alive) {
      var blink = this.effects.invincible > 0 && Math.floor(this.animTime * 5) % 2 === 1;
      if (!blink) this.drawTank(ctx, this.player, '#f5c542', '#8c6b12', '#fff3c4', true);
      if (this.effects.invincible > 0) {
        ctx.strokeStyle = 'rgba(89,211,255,0.85)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(Math.round(this.player.x), Math.round(this.player.y), 9, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    for (var i = 0; i < this.enemies.length; i += 1) {
      var enemy = this.enemies[i];
      if (!enemy.alive) continue;
      var flashing = enemy.flash && Math.floor(this.animTime * 5) % 2 === 1;
      var frozen = this.effects.clock > 0;
      var body = flashing || enemy.hitFlash > 0 ? '#ffffff' : (frozen ? '#a7adb6' : enemy.def.body);
      var track = frozen ? '#565c66' : enemy.def.track;
      var trim = frozen ? '#dfe4ea' : enemy.def.trim;
      this.drawTank(ctx, enemy, body, track, trim, false);
      if (enemy.maxHp > 1) {
        var bx = Math.round(enemy.x) - 6;
        var by = Math.round(enemy.y) - 11;
        for (var p = 0; p < enemy.maxHp; p += 1) {
          ctx.fillStyle = p < enemy.hp ? enemy.def.trim : 'rgba(255,255,255,0.18)';
          ctx.fillRect(bx + p * 3, by, 2, 2);
        }
      }
    }
  };

  TankGame.prototype.drawTank = function (ctx, tank, body, track, trim, isPlayer) {
    var angle = DIRS[tank.dir] ? DIRS[tank.dir].angle : 0;
    ctx.save();
    ctx.translate(Math.round(tank.x), Math.round(tank.y));
    ctx.rotate(angle);

    ctx.fillStyle = '#05070a';
    ctx.fillRect(-8, -7, 16, 14);
    ctx.fillStyle = track;
    ctx.fillRect(-7, -7, 3, 14);
    ctx.fillRect(4, -7, 3, 14);
    ctx.fillStyle = 'rgba(255,255,255,0.22)';
    for (var i = -6; i <= 6; i += 4) {
      ctx.fillRect(-7, i, 3, 1);
      ctx.fillRect(4, i, 3, 1);
    }

    ctx.fillStyle = body;
    ctx.fillRect(-5, -5, 10, 10);
    ctx.fillStyle = trim;
    ctx.fillRect(-3, -3, 6, 6);
    ctx.fillStyle = body;
    ctx.fillRect(-2, -2, 4, 4);
    ctx.fillRect(-1, -9, 2, 7);
    ctx.fillStyle = isPlayer ? '#fffbe6' : trim;
    ctx.fillRect(-1, -9, 2, 2);

    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.lineWidth = 1;
    ctx.strokeRect(-5.5, -5.5, 11, 11);
    ctx.restore();
  };

  TankGame.prototype.drawTrees = function (ctx) {
    for (var r = 0; r < C.ROWS; r += 1) {
      for (var c = 0; c < C.COLS; c += 1) {
        if (this.grid[r][c] !== 'T') continue;
        var x = c * C.TILE;
        var y = r * C.TILE;
        ctx.fillStyle = '#0d3219';
        ctx.fillRect(x, y, C.TILE, C.TILE);
        ctx.fillStyle = '#1f6b2f';
        ctx.beginPath();
        ctx.arc(x + 5, y + 6, 5, 0, Math.PI * 2);
        ctx.arc(x + 11, y + 5, 5, 0, Math.PI * 2);
        ctx.arc(x + 8, y + 11, 6, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#2f8f42';
        ctx.beginPath();
        ctx.arc(x + 6, y + 6, 2.5, 0, Math.PI * 2);
        ctx.arc(x + 11, y + 8, 2, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  };

  TankGame.prototype.drawBullets = function (ctx) {
    for (var i = 0; i < this.bullets.length; i += 1) {
      var b = this.bullets[i];
      if (!b.alive) continue;
      ctx.fillStyle = b.owner === 'player' ? '#ffe066' : '#ff6b6b';
      ctx.fillRect(Math.round(b.x) - 2, Math.round(b.y) - 2, 4, 4);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(Math.round(b.x) - 1, Math.round(b.y) - 1, 2, 2);
    }
  };

  TankGame.prototype.drawMuzzles = function (ctx) {
    var tanks = [];
    if (this.player && this.player.alive) tanks.push(this.player);
    for (var i = 0; i < this.enemies.length; i += 1) {
      if (this.enemies[i].alive) tanks.push(this.enemies[i]);
    }
    for (var j = 0; j < tanks.length; j += 1) {
      var tank = tanks[j];
      if (!tank.muzzle || tank.muzzle <= 0) continue;
      var vec = DIRS[tank.dir];
      ctx.fillStyle = '#fff6b0';
      ctx.fillRect(
        Math.round(tank.x + vec.x * 10) - 2,
        Math.round(tank.y + vec.y * 10) - 2,
        4,
        4
      );
    }
  };

  TankGame.prototype.drawExplosions = function (ctx) {
    for (var i = 0; i < this.explosions.length; i += 1) {
      var e = this.explosions[i];
      var p = clamp(e.age / e.duration, 0, 1);
      var radius = (e.big ? 4 : 2.5) + (e.big ? 10 : 6) * p;
      ctx.globalAlpha = 1 - p;
      ctx.fillStyle = '#ff8c42';
      ctx.beginPath();
      ctx.arc(e.x, e.y, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#ffe066';
      ctx.beginPath();
      ctx.arc(e.x, e.y, Math.max(1, radius * 0.55), 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(e.x, e.y, Math.max(0.8, radius * 0.22), 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  };

  TankGame.prototype.drawWarnings = function (ctx) {
    if (Math.floor(this.animTime * 5) % 2 === 1) return;
    for (var i = 0; i < this.warnings.length; i += 1) {
      var w = this.warnings[i];
      var x = w.x;
      var y = w.y;
      ctx.strokeStyle = '#ffe066';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(x, y, 7, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = '#ffe066';
      ctx.beginPath();
      ctx.moveTo(x, y - 6);
      ctx.lineTo(x + 2, y - 1);
      ctx.lineTo(x + 6, y);
      ctx.lineTo(x + 2, y + 1);
      ctx.lineTo(x, y + 6);
      ctx.lineTo(x - 2, y + 1);
      ctx.lineTo(x - 6, y);
      ctx.lineTo(x - 2, y - 1);
      ctx.closePath();
      ctx.fill();
    }
  };

  root.TankGame = TankGame;
})(typeof window !== 'undefined' ? window : globalThis);
