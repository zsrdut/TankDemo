#!/usr/bin/env node
/*
 * 零依赖静态数据校验：地图尺寸、基地、出生点、基地保护圈、可达性与敌人队列。
 * 运行：node tools/validate-data.js
 */
'use strict';

var path = require('path');
var C = require(path.join(__dirname, '..', 'js', 'config.js'));

var ALLOWED = { '.': true, B: true, S: true, W: true, T: true, I: true, E: true, P: true, X: true };
var EXPECTED_COUNTS = {
  L1: { normal: 12, fast: 4, armor: 3, elite: 1 },
  L2: { normal: 8, fast: 6, armor: 4, elite: 2 },
  L3: { normal: 4, fast: 5, armor: 6, elite: 5 }
};

var failures = [];
var checks = 0;

function ok(condition, label) {
  checks += 1;
  if (!condition) failures.push(label);
}

function at(map, row, col) {
  var line = map[row];
  return line ? line.charAt(col) : '';
}

function checkMap(level) {
  var map = level.map;
  var label = level.id;

  ok(map.length === C.ROWS, label + ': 行数必须为 13，实际 ' + map.length);
  map.forEach(function (line, index) {
    ok(line.length === C.COLS, label + ': 第 ' + index + ' 行必须为 13 列，实际 ' + line.length);
    for (var i = 0; i < line.length; i += 1) {
      ok(!!ALLOWED[line.charAt(i)], label + ': 第 ' + index + ' 行第 ' + i + ' 列含非法字符 ' + line.charAt(i));
    }
  });

  var counts = { E: 0, P: 0, X: 0 };
  for (var r = 0; r < C.ROWS; r += 1) {
    for (var c = 0; c < C.COLS; c += 1) {
      var ch = at(map, r, c);
      if (counts[ch] !== undefined) counts[ch] += 1;
    }
  }
  ok(counts.E === 4, label + ': 基地 E 必须为 4 格，实际 ' + counts.E);
  ok(counts.P === 1, label + ': 玩家出生点 P 必须为 1 格，实际 ' + counts.P);
  ok(counts.X === 3, label + ': 敌人出生点 X 必须为 3 格，实际 ' + counts.X);

  for (var baseRow = 11; baseRow <= 12; baseRow += 1) {
    for (var baseCol = 5; baseCol <= 6; baseCol += 1) {
      ok(at(map, baseRow, baseCol) === 'E', label + ': 基地格 (' + baseRow + ',' + baseCol + ') 必须为 E');
    }
  }

  ok(at(map, 12, 3) === 'P', label + ': 玩家出生点必须位于 (12,3)');
  [0, 6, 12].forEach(function (col) {
    ok(at(map, 0, col) === 'X', label + ': 敌人出生点必须包含 (0,' + col + ')');
    var below = at(map, 1, col);
    ok(below !== 'B' && below !== 'S' && below !== 'W' && below !== 'E', label + ': 敌人出生点 (0,' + col + ') 下方必须可通行');
  });

  C.PROTECTION.forEach(function (cell) {
    ok(at(map, cell.row, cell.col) === 'B', label + ': 基地保护圈 (' + cell.row + ',' + cell.col + ') 必须为 B');
  });

  var queue = level.queue;
  ok(queue.length === 20, label + ': 敌人队列必须为 20，实际 ' + queue.length);
  var typeCounts = { normal: 0, fast: 0, armor: 0, elite: 0 };
  var itemCounts = {};
  queue.forEach(function (entry, index) {
    ok(!!C.ENEMY_TYPES[entry.type], label + ': 第 ' + (index + 1) + ' 个敌人类型非法 ' + entry.type);
    if (typeCounts[entry.type] !== undefined) typeCounts[entry.type] += 1;
    if (entry.item) {
      ok(!!C.ITEMS[entry.item], label + ': 第 ' + (index + 1) + ' 个敌人道具非法 ' + entry.item);
      itemCounts[entry.item] = (itemCounts[entry.item] || 0) + 1;
    }
  });
  var expected = EXPECTED_COUNTS[label];
  Object.keys(expected).forEach(function (type) {
    ok(typeCounts[type] === expected[type], label + ': ' + type + ' 数量应为 ' + expected[type] + '，实际 ' + typeCounts[type]);
  });
  var flashTotal = queue.filter(function (entry) { return !!entry.item; }).length;
  ok(flashTotal === Object.keys(itemCounts).length, label + ': 闪光敌人数量应与掉落道具种类数一致');

  var start = { row: 12, col: 3 };
  var blocked = { S: true, W: true, E: true };
  var seen = {};
  var queueCells = [start];
  seen[start.row + ',' + start.col] = true;
  while (queueCells.length) {
    var current = queueCells.shift();
    [[1, 0], [-1, 0], [0, 1], [0, -1]].forEach(function (delta) {
      var nr = current.row + delta[0];
      var nc = current.col + delta[1];
      var key = nr + ',' + nc;
      if (nr < 0 || nr >= C.ROWS || nc < 0 || nc >= C.COLS || seen[key]) return;
      var ch = at(map, nr, nc);
      if (blocked[ch]) return;
      seen[key] = true;
      queueCells.push({ row: nr, col: nc });
    });
  }
  for (var rr = 0; rr < C.ROWS; rr += 1) {
    for (var cc = 0; cc < C.COLS; cc += 1) {
      var tile = at(map, rr, cc);
      if (blocked[tile]) continue;
      ok(!!seen[rr + ',' + cc], label + ': 可通行格 (' + rr + ',' + cc + ') 从玩家出生点不可达');
    }
  }
}

C.LEVELS.forEach(checkMap);

var ids = C.LEVELS.map(function (level) { return level.id; }).join(',');
ok(ids === 'L1,L2,L3', '关卡必须依次为 L1,L2,L3，实际 ' + ids);
ok(C.LEVELS[0].spawnInterval > C.LEVELS[1].spawnInterval && C.LEVELS[1].spawnInterval > C.LEVELS[2].spawnInterval,
  '三关刷新间隔必须逐关缩短');
ok(C.LEVELS[0].speedMultiplier <= C.LEVELS[1].speedMultiplier && C.LEVELS[1].speedMultiplier <= C.LEVELS[2].speedMultiplier,
  '三关敌人速度倍率必须逐关不降');

if (failures.length) {
  console.error('FAIL (' + failures.length + ' / ' + checks + ' checks)');
  failures.forEach(function (message) { console.error(' - ' + message); });
  process.exit(1);
}

console.log('PASS: ' + checks + ' checks');
C.LEVELS.forEach(function (level) {
  console.log(' - ' + level.id + ' ' + level.name + ': 13x13, 20 enemies, queue OK');
});
