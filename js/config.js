/*
 * 坦克大战 · 静态配置
 *
 * 本文件只包含纯数据与常量，不访问 DOM，便于在浏览器和 Node 校验脚本中复用。
 * 地图字符：
 *   . 空地   B 砖墙   S 钢墙   W 水面   T 树林   I 冰面
 *   E 基地   P 玩家出生点   X 敌人出生点
 */
(function (root) {
  'use strict';

  var TILE = 16;
  var COLS = 13;
  var ROWS = 13;

  var MAPS = {
    L1: [
      'X.....X.....X',
      '..BB.....BB..',
      '..BB.....BB..',
      '.....BBB.....',
      'BB...BSB...BB',
      'BB.........BB',
      '...BB...BB...',
      '...BB...BB...',
      '......TT.....',
      '.BB......BB..',
      '....BBBB.....',
      '....BEEB.....',
      '...PBEEB.....'
    ],
    L2: [
      'X.....X.....X',
      '..BB.....BB..',
      '..BB..WW.BB..',
      '......WW.....',
      'S..BB...BB..S',
      'S..BB...BB..S',
      '..TT.....TT..',
      '..TT.BBB.TT..',
      '.....BSB.....',
      'BB.........BB',
      '....BBBB.....',
      '....BEEB.....',
      '...PBEEB.....'
    ],
    L3: [
      'X.....X.....X',
      '.II..S.S..II.',
      '.II..S.S..II.',
      '.............',
      'BB.BB.S.BB.BB',
      'BB.BB...BB.BB',
      '.....III.....',
      '.S.BBIIIBB.S.',
      '.S.BB...BB.S.',
      '.....BBB.....',
      '....BBBB.....',
      '....BEEB.....',
      '...PBEEB.....'
    ]
  };

  function enemy(type, item) {
    return { type: type, item: item || null };
  }

  var LEVELS = [
    {
      id: 'L1',
      name: '训练场',
      map: MAPS.L1,
      spawnInterval: 3.0,
      speedMultiplier: 1.0,
      fireIntervalMultiplier: 1.0,
      queue: [
        enemy('normal'), enemy('normal'), enemy('fast'), enemy('normal', 'star'),
        enemy('armor'), enemy('normal'), enemy('normal'), enemy('fast'),
        enemy('normal'), enemy('normal'), enemy('armor'), enemy('normal'),
        enemy('fast'), enemy('normal', 'helmet'), enemy('normal'), enemy('armor'),
        enemy('normal'), enemy('fast'), enemy('normal'), enemy('elite')
      ]
    },
    {
      id: 'L2',
      name: '河岸',
      map: MAPS.L2,
      spawnInterval: 2.6,
      speedMultiplier: 1.1,
      fireIntervalMultiplier: 0.9,
      queue: [
        enemy('normal'), enemy('fast'), enemy('normal'), enemy('armor'),
        enemy('fast'), enemy('normal'), enemy('armor'), enemy('elite', 'shovel'),
        enemy('normal'), enemy('fast'), enemy('armor', 'star'), enemy('normal'),
        enemy('fast'), enemy('normal'), enemy('elite', 'tank'), enemy('armor'),
        enemy('fast'), enemy('normal'), enemy('fast'), enemy('normal')
      ]
    },
    {
      id: 'L3',
      name: '冰原',
      map: MAPS.L3,
      spawnInterval: 2.2,
      speedMultiplier: 1.2,
      fireIntervalMultiplier: 0.8,
      queue: [
        enemy('fast'), enemy('normal'), enemy('armor'), enemy('elite', 'grenade'),
        enemy('fast'), enemy('armor'), enemy('normal'), enemy('elite'),
        enemy('armor', 'star'), enemy('fast'), enemy('elite'), enemy('normal'),
        enemy('armor', 'clock'), enemy('fast'), enemy('elite'), enemy('armor'),
        enemy('normal', 'tank'), enemy('fast'), enemy('armor'), enemy('elite')
      ]
    }
  ];

  var ENEMY_TYPES = {
    normal: {
      key: 'normal', label: '普通', hp: 1, speed: 40, bulletSpeed: 160,
      maxBullets: 1, fireMin: 1400, fireMax: 2000, score: 100,
      body: '#c8c8c8', track: '#7a7a7a', trim: '#ffffff'
    },
    fast: {
      key: 'fast', label: '快速', hp: 1, speed: 72, bulletSpeed: 160,
      maxBullets: 1, fireMin: 1600, fireMax: 2200, score: 200,
      body: '#59d3ff', track: '#227b9c', trim: '#d9f7ff'
    },
    armor: {
      key: 'armor', label: '装甲', hp: 2, speed: 44, bulletSpeed: 180,
      maxBullets: 2, fireMin: 1000, fireMax: 1500, score: 300,
      body: '#9aa84a', track: '#4e5a20', trim: '#e2f09a'
    },
    elite: {
      key: 'elite', label: '精英', hp: 4, speed: 52, bulletSpeed: 200,
      maxBullets: 2, fireMin: 700, fireMax: 1100, score: 400,
      body: '#ff5f6d', track: '#8f2530', trim: '#ffd0d4'
    }
  };

  var ITEMS = {
    grenade: { key: 'grenade', label: '手雷' },
    helmet: { key: 'helmet', label: '头盔' },
    shovel: { key: 'shovel', label: '铲子' },
    star: { key: 'star', label: '星星' },
    tank: { key: 'tank', label: '坦克' },
    clock: { key: 'clock', label: '时钟' }
  };

  var CONFIG = {
    TILE: TILE,
    COLS: COLS,
    ROWS: ROWS,
    WIDTH: COLS * TILE,
    HEIGHT: ROWS * TILE,
    STEP: 1 / 60,
    MAX_SCALE: 6,

    PLAYER: {
      lives: 3,
      maxLives: 9,
      body: 14,
      speed: 60,
      bulletSpeed: 200,
      bulletSpeedPowered: 260,
      maxBullets: 1,
      maxBulletsPowered: 2,
      cooldown: 0.25,
      cooldownPowered: 0.2,
      spawnInvincible: 2.0,
      respawnDelay: 0.6,
      respawnRetry: 0.25,
      respawnMaxWait: 3.0,
      bulletDamage: 1
    },

    BULLET: { size: 4, maxSubstep: 1 },

    ENEMY: {
      maxOnScreen: 4,
      decisionInterval: 0.4,
      spawnWarning: 0.5,
      spawnRetry: 0.5,
      alignTolerance: 8,
      maxShootTiles: 10,
      randomFireChance: 0.4
    },

    ITEM: { ttl: 10, blinkFrom: 3, pickupNotice: 1.2 },
    EFFECT: { helmet: 8, shovel: 15, clock: 8 },
    FX: { explosion: 0.3, muzzle: 0.08, deathFreeze: 0.6, levelClear: 2.0, endDelay: 0.6 },
    SCORE: { levelClear: 1000, max: 99999999 },

    BASE: { col: 5, row: 11, cols: 2, rows: 2 },
    PROTECTION: [
      { col: 4, row: 10 }, { col: 5, row: 10 }, { col: 6, row: 10 }, { col: 7, row: 10 },
      { col: 4, row: 11 }, { col: 7, row: 11 },
      { col: 4, row: 12 }, { col: 7, row: 12 }
    ],
    PLAYER_SPAWN: { col: 3, row: 12 },
    ENEMY_SPAWNS: [
      { col: 0, row: 0 },
      { col: 6, row: 0 },
      { col: 12, row: 0 }
    ],

    STORAGE: {
      highScore: 'tankGame.v1.highScore',
      muted: 'tankGame.v1.muted'
    },

    LEVELS: LEVELS,
    MAPS: MAPS,
    ENEMY_TYPES: ENEMY_TYPES,
    ITEMS: ITEMS
  };

  root.TankConfig = CONFIG;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = CONFIG;
  }
})(typeof window !== 'undefined' ? window : globalThis);
