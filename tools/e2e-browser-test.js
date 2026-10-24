#!/usr/bin/env node
/*
 * 零依赖浏览器 E2E 验收测试。
 *
 * 使用 Node 内置 http / child_process / WebSocket 驱动系统 Chromium 的 DevTools Protocol，
 * 不引入 Playwright、Puppeteer 或任何 npm 依赖，也不写入 package.json。
 *
 * 覆盖：启动页与 HUD、只读快照契约、开始/暂停/继续、移动与砖墙阻挡、射击与基地失败、
 * 重新开始、失焦/隐藏自动暂停、静音持久化、localStorage / AudioContext / Canvas 降级、
 * 响应式缩放、移动端提示、file:// 与子路径部署。
 *
 * 运行：node tools/e2e-browser-test.js [--chrome <path>]
 * 环境变量：CHROME_BIN、E2E_REPORT_DIR
 */
'use strict';

var http = require('http');
var fs = require('fs');
var path = require('path');
var os = require('os');
var spawn = require('child_process').spawn;
var spawnSync = require('child_process').spawnSync;

var REPO = path.join(__dirname, '..');
var REPORT_DIR = process.env.E2E_REPORT_DIR || path.join(REPO, 'test-reports');
var SCREENSHOT_DIR = path.join(REPORT_DIR, 'screenshots');
var VIEWPORT = { width: 1280, height: 900 };

var MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png'
};

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertEqual(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(label + '：期望 ' + JSON.stringify(expected) + '，实际 ' + JSON.stringify(actual));
  }
}

function assertRange(value, min, max, label) {
  if (typeof value !== 'number' || value < min || value > max) {
    throw new Error(label + '：期望范围 [' + min + ',' + max + ']，实际 ' + JSON.stringify(value));
  }
}

function escapeHtml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function findChrome(explicit) {
  var candidates = [explicit, process.env.CHROME_BIN,
    '/usr/bin/google-chrome-stable', '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser', '/usr/bin/chromium'];
  for (var i = 0; i < candidates.length; i += 1) {
    if (candidates[i] && fs.existsSync(candidates[i])) return candidates[i];
  }
  var commands = ['google-chrome-stable', 'google-chrome', 'chromium-browser', 'chromium'];
  for (var j = 0; j < commands.length; j += 1) {
    var found = spawnSync('/bin/sh', ['-c', 'command -v ' + commands[j]], { encoding: 'utf8' });
    var bin = (found.stdout || '').trim();
    if (found.status === 0 && bin) return bin;
  }
  return null;
}

function startServer(root) {
  return new Promise(function (resolve, reject) {
    var server = http.createServer(function (req, res) {
      var pathname;
      try { pathname = decodeURIComponent(req.url.split('?')[0]); } catch (e) { pathname = '/'; }
      if (pathname === '/') pathname = '/index.html';
      var file = path.normalize(path.join(root, pathname));
      if (file.indexOf(root) !== 0) {
        res.writeHead(403); res.end('forbidden'); return;
      }
      fs.readFile(file, function (err, data) {
        if (err) { res.writeHead(404); res.end('not found'); return; }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
        res.end(data);
      });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', function () {
      resolve({ server: server, port: server.address().port });
    });
  });
}

function launchChrome(bin) {
  var userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tank-e2e-'));
  var child = spawn(bin, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage',
    '--hide-scrollbars', '--mute-audio', '--allow-file-access-from-files',
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--window-size=' + VIEWPORT.width + ',' + VIEWPORT.height,
    '--remote-debugging-port=0', '--user-data-dir=' + userDataDir, 'about:blank'
  ], { stdio: ['ignore', 'ignore', 'pipe'] });

  return new Promise(function (resolve, reject) {
    var buffer = '';
    var timer = setTimeout(function () {
      reject(new Error('Chromium DevTools 启动超时（15s）'));
    }, 15000);
    child.stderr.on('data', function (chunk) {
      buffer += chunk.toString();
      var match = buffer.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) {
        clearTimeout(timer);
        resolve({ child: child, wsUrl: match[1], userDataDir: userDataDir, version: buffer });
      }
    });
    child.on('exit', function (code) {
      clearTimeout(timer);
      reject(new Error('Chromium 提前退出，code=' + code));
    });
  });
}

function CDP(url) {
  this.url = url;
  this.id = 0;
  this.pending = new Map();
  this.waiters = [];
  this.listeners = [];
}

CDP.prototype.connect = async function () {
  var self = this;
  this.ws = new WebSocket(this.url);
  await new Promise(function (resolve, reject) {
    self.ws.addEventListener('open', resolve, { once: true });
    self.ws.addEventListener('error', function (event) { reject(new Error('CDP WebSocket 连接失败')); }, { once: true });
  });
  this.ws.addEventListener('message', function (event) {
    var text = typeof event.data === 'string' ? event.data : Buffer.from(event.data).toString('utf8');
    self.onMessage(JSON.parse(text));
  });
};

CDP.prototype.onMessage = function (msg) {
  if (msg.id) {
    var pending = this.pending.get(msg.id);
    if (!pending) return;
    this.pending.delete(msg.id);
    if (msg.error) pending.reject(new Error(msg.error.message));
    else pending.resolve(msg.result);
    return;
  }
  for (var i = 0; i < this.listeners.length; i += 1) {
    try { this.listeners[i](msg); } catch (e) { /* 事件监听不阻塞 */ }
  }
  for (var j = this.waiters.length - 1; j >= 0; j -= 1) {
    var waiter = this.waiters[j];
    if (waiter.method === msg.method && (!waiter.sessionId || waiter.sessionId === msg.sessionId)) {
      this.waiters.splice(j, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(msg.params);
    }
  }
};

CDP.prototype.send = function (method, params, sessionId) {
  var self = this;
  var id = ++this.id;
  return new Promise(function (resolve, reject) {
    self.pending.set(id, { resolve: resolve, reject: reject });
    var payload = { id: id, method: method, params: params || {} };
    if (sessionId) payload.sessionId = sessionId;
    self.ws.send(JSON.stringify(payload));
  });
};

CDP.prototype.waitEvent = function (method, sessionId, timeout) {
  var self = this;
  return new Promise(function (resolve, reject) {
    var waiter = { method: method, sessionId: sessionId, resolve: resolve };
    waiter.timer = setTimeout(function () {
      var index = self.waiters.indexOf(waiter);
      if (index >= 0) self.waiters.splice(index, 1);
      reject(new Error('等待事件 ' + method + ' 超时'));
    }, timeout || 15000);
    self.waiters.push(waiter);
  });
};

CDP.prototype.onEvent = function (fn) {
  this.listeners.push(fn);
};

CDP.prototype.close = function () {
  try { this.ws.close(); } catch (e) { /* ignore */ }
};

function Page(cdp, sessionId, baseUrl) {
  this.cdp = cdp;
  this.sessionId = sessionId;
  this.baseUrl = baseUrl;
  this.requests = [];
  this.responses = [];
  this.failures = [];
  this.exceptions = [];
  this.consoleErrors = [];
  this.initScripts = [];
  this.shotIndex = 0;
}

Page.prototype.send = function (method, params) {
  return this.cdp.send(method, params, this.sessionId);
};

Page.prototype.listen = function () {
  var self = this;
  this.cdp.onEvent(function (msg) {
    if (msg.sessionId !== self.sessionId) return;
    var p = msg.params || {};
    if (msg.method === 'Network.requestWillBeSent') self.requests.push(p.request.url);
    else if (msg.method === 'Network.responseReceived') self.responses.push({ url: p.response.url, status: p.response.status });
    else if (msg.method === 'Network.loadingFailed') self.failures.push({ url: p.url || '', error: p.errorText });
    else if (msg.method === 'Runtime.exceptionThrown') {
      var detail = p.exceptionDetails || {};
      self.exceptions.push((detail.exception && detail.exception.description) || detail.text || 'unknown exception');
    } else if (msg.method === 'Runtime.consoleAPICalled' && p.type === 'error') {
      self.consoleErrors.push((p.args || []).map(function (arg) { return arg.value || arg.description || ''; }).join(' '));
    }
  });
};

Page.prototype.enable = async function () {
  await this.send('Page.enable');
  await this.send('Runtime.enable');
  await this.send('Network.enable');
  await this.send('Log.enable');
  this.listen();
};

Page.prototype.resetDiagnostics = function () {
  this.requests = [];
  this.responses = [];
  this.failures = [];
  this.exceptions = [];
  this.consoleErrors = [];
};

Page.prototype.eval = async function (expressionOrFn) {
  var expression = typeof expressionOrFn === 'function'
    ? '(' + expressionOrFn.toString() + ')()'
    : expressionOrFn;
  var result = await this.send('Runtime.evaluate', {
    expression: expression, returnByValue: true, awaitPromise: true, userGesture: true
  });
  if (result.exceptionDetails) {
    var detail = result.exceptionDetails;
    throw new Error('页面脚本异常：' + ((detail.exception && detail.exception.description) || detail.text));
  }
  return result.result ? result.result.value : undefined;
};

Page.prototype.navigate = async function (url, waitMs) {
  this.resetDiagnostics();
  var loaded = this.cdp.waitEvent('Page.loadEventFired', this.sessionId, 20000);
  try { await this.send('Page.bringToFront'); } catch (e) { /* ignore */ }
  await this.send('Page.navigate', { url: url });
  await loaded;
  await sleep(waitMs === undefined ? 400 : waitMs);
};

Page.prototype.addInitScript = async function (source) {
  var result = await this.send('Page.addScriptToEvaluateOnNewDocument', { source: source });
  this.initScripts.push(result.identifier);
  return result.identifier;
};

Page.prototype.removeInitScript = async function (identifier) {
  await this.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: identifier });
  this.initScripts = this.initScripts.filter(function (id) { return id !== identifier; });
};

Page.prototype.key = async function (type, code, key) {
  var params = { type: type, code: code, key: key, windowsVirtualKeyCode: 0, nativeVirtualKeyCode: 0 };
  if (code === 'Enter') { params.windowsVirtualKeyCode = 13; params.nativeVirtualKeyCode = 13; }
  else if (code === 'Space') { params.windowsVirtualKeyCode = 32; params.nativeVirtualKeyCode = 32; }
  else if (code === 'ArrowLeft') { params.windowsVirtualKeyCode = 37; params.nativeVirtualKeyCode = 37; }
  else if (code === 'ArrowUp') { params.windowsVirtualKeyCode = 38; params.nativeVirtualKeyCode = 38; }
  else if (code === 'ArrowRight') { params.windowsVirtualKeyCode = 39; params.nativeVirtualKeyCode = 39; }
  else if (code === 'ArrowDown') { params.windowsVirtualKeyCode = 40; params.nativeVirtualKeyCode = 40; }
  else { params.windowsVirtualKeyCode = key.toUpperCase().charCodeAt(0); params.nativeVirtualKeyCode = params.windowsVirtualKeyCode; }
  if (type === 'keyDown') {
    if (code === 'Enter') params.text = '\r';
    else if (code === 'Space') params.text = ' ';
    else if (/^Key[A-Z]$/.test(code)) params.text = key;
  }
  await this.send('Input.dispatchKeyEvent', params);
};

Page.prototype.tap = async function (code, key, holdMs) {
  await this.key('keyDown', code, key);
  await sleep(holdMs || 60);
  await this.key('keyUp', code, key);
  await sleep(80);
};

Page.prototype.hold = async function (code, key, holdMs) {
  await this.key('keyDown', code, key);
  await sleep(holdMs);
  await this.key('keyUp', code, key);
  await sleep(120);
};

Page.prototype.click = async function (selector) {
  var expression = '(() => { var el = document.querySelector(' + JSON.stringify(selector) +
    '); if (!el) return null; var r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()';
  var rect = await this.eval(expression);
  if (!rect) throw new Error('找不到元素 ' + selector);
  await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y });
  await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
  await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
  await sleep(150);
};

Page.prototype.setViewport = async function (width, height, mobile) {
  await this.send('Emulation.setDeviceMetricsOverride', {
    width: width, height: height, deviceScaleFactor: 1, mobile: !!mobile
  });
  await this.send('Emulation.setTouchEmulationEnabled', { enabled: !!mobile, maxTouchPoints: mobile ? 5 : 1 });
  await sleep(450);
};

Page.prototype.screenshot = async function (name) {
  var shot = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  var file = path.join(SCREENSHOT_DIR, name + '.png');
  fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
  return file;
};

Page.prototype.state = function () {
  return this.eval(function () { return window.__tankGame.getState(); });
};

Page.prototype.hud = function () {
  return this.eval(function () {
    return {
      level: document.getElementById('hudLevel').textContent,
      lives: document.getElementById('hudLives').textContent,
      enemies: document.getElementById('hudEnemies').textContent,
      score: document.getElementById('hudScore').textContent,
      highScore: document.getElementById('hudHighScore').textContent,
      effects: document.getElementById('hudEffects').textContent
    };
  });
};

function hudMatches(state, hud) {
  return String(state.level) === hud.level && String(state.lives) === hud.lives &&
    String(state.enemiesRemaining) === hud.enemies && String(state.score) === hud.score &&
    String(state.highScore) === hud.highScore;
}

async function run() {
  var chromeBin = findChrome(process.env.CHROME_BIN || findArg('--chrome'));
  if (!chromeBin) {
    console.log('STATUS=BLOCKED');
    console.log('SUMMARY=未找到 Chrome/Chromium，可执行浏览器 E2E 无法启动（可用 CHROME_BIN 或 --chrome 指定路径）');
    process.exit(2);
  }

  fs.rmSync(SCREENSHOT_DIR, { recursive: true, force: true });
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

  var repoServer = await startServer(REPO);
  var parentServer = await startServer(path.dirname(REPO));
  var baseUrl = 'http://127.0.0.1:' + repoServer.port + '/index.html';
  var subpathUrl = 'http://127.0.0.1:' + parentServer.port + '/' + path.basename(REPO) + '/index.html';

  var chrome = null;
  var cdp = null;
  var cleanups = [];
  var results = [];
  var startedAt = Date.now();
  var lastFps = 0;

  try {
    chrome = await launchChrome(chromeBin);
    cleanups.push(function () { try { chrome.child.kill('SIGKILL'); } catch (e) { /* ignore */ } });
    cleanups.push(function () { try { fs.rmSync(chrome.userDataDir, { recursive: true, force: true }); } catch (e) { /* ignore */ } });

    cdp = new CDP(chrome.wsUrl);
    await cdp.connect();
    cleanups.push(function () { cdp.close(); });

    var browserInfo = await cdp.send('Browser.getVersion');
    var target = await cdp.send('Target.createTarget', { url: 'about:blank' });
    var attached = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
    var page = new Page(cdp, attached.sessionId, baseUrl);
    await page.enable();
    await page.setViewport(VIEWPORT.width, VIEWPORT.height, false);

    async function test(name, fn, shotName) {
      var start = Date.now();
      var record = { name: name, status: 'PASS', duration: 0, error: '', screenshot: '' };
      try {
        await fn();
      } catch (error) {
        record.status = 'FAIL';
        record.error = (error && (error.stack || error.message)) || String(error);
        try {
          record.screenshot = await page.screenshot('fail-' + String(results.length + 1).padStart(2, '0') + '-' + (shotName || 'case'));
        } catch (e) { /* 截图失败不影响用例结论 */ }
      }
      record.duration = Date.now() - start;
      results.push(record);
      console.log((record.status === 'PASS' ? 'PASS ' : 'FAIL ') + name + ' (' + record.duration + 'ms)');
      if (record.status === 'FAIL') console.log(record.error.split('\n')[0]);
    }

    /* ---------------- 启动与契约 ---------------- */

    await test('启动页：标题、HUD 初值、操作说明、开始入口', async function () {
      await page.navigate(baseUrl);
      var info = await page.eval(function () {
        return {
          title: document.title,
          h1: document.querySelector('h1').textContent,
          primary: document.getElementById('primaryBtn').textContent,
          help: document.querySelector('.help').textContent.replace(/\s+/g, ' ').trim(),
          hud: {
            level: document.getElementById('hudLevel').textContent,
            lives: document.getElementById('hudLives').textContent,
            enemies: document.getElementById('hudEnemies').textContent,
            score: document.getElementById('hudScore').textContent,
            highScore: document.getElementById('hudHighScore').textContent
          },
          overlayVisible: !document.getElementById('overlay').hidden,
          hintDisplay: getComputedStyle(document.getElementById('mobileHint')).display
        };
      });
      assertEqual(info.title, '坦克大战', '页面标题');
      assertEqual(info.h1, '坦克大战', '主标题');
      assertEqual(info.primary, '开始游戏', '开始按钮');
      assert(info.help.indexOf('方向键') >= 0 && info.help.indexOf('WASD') >= 0 && info.help.indexOf('空格') >= 0, '操作说明缺失');
      assertEqual(info.hud, { level: '1', lives: '3', enemies: '20', score: '0', highScore: '0' }, 'HUD 初值');
      assert(info.overlayVisible, '开始遮罩未显示');
      assertEqual(info.hintDisplay, 'none', '桌面端移动提示应隐藏');
      var state = await page.state();
      assertEqual(state.status, 'idle', '初始状态');
      assertEqual(state.baseAlive, true, '初始基地状态');
      await page.screenshot('01-idle');
    });

    await test('只读调试契约：字段齐全、对象冻结、快照修改无副作用', async function () {
      var contract = await page.eval(function () {
        var api = window.__tankGame;
        var fields = ['status', 'level', 'lives', 'enemiesRemaining', 'enemiesOnScreen', 'score',
          'highScore', 'baseAlive', 'muted', 'playerX', 'playerY', 'playerDirection'];
        var snapshot = api.getState();
        var before = JSON.stringify(snapshot);
        var missing = fields.filter(function (key) { return !(key in snapshot); });
        var typesOk = fields.every(function (key) {
          if (key === 'status' || key === 'playerDirection') return typeof snapshot[key] === 'string';
          if (key === 'baseAlive' || key === 'muted') return typeof snapshot[key] === 'boolean';
          return typeof snapshot[key] === 'number';
        });
        try { snapshot.score = 999999; snapshot.lives = 99; snapshot.status = 'victory'; } catch (e) { /* 冻结对象在严格模式可能抛错 */ }
        return {
          apiFrozen: Object.isFrozen(api),
          apiKeys: Object.keys(api),
          snapshotFrozen: Object.isFrozen(snapshot),
          missing: missing,
          typesOk: typesOk,
          mutationSafe: before === JSON.stringify(api.getState()),
          direction: snapshot.playerDirection,
          x: snapshot.playerX,
          y: snapshot.playerY
        };
      });
      assert(contract.apiFrozen, 'window.__tankGame 未冻结');
      assertEqual(contract.apiKeys, ['getState'], '只读接口暴露的方法');
      assert(contract.snapshotFrozen, 'getState() 返回值未冻结');
      assertEqual(contract.missing, [], '快照缺少字段');
      assert(contract.typesOk, '快照字段类型不符合契约');
      assert(contract.mutationSafe, '修改快照影响了游戏状态');
      assertEqual(contract.direction, 'up', 'idle 朝向');
      assertRange(contract.x, 7, 201, 'playerX');
      assertRange(contract.y, 7, 201, 'playerY');
    });

    await test('静态加载：无外部网络请求、无 4xx/5xx、画布为 1:1', async function () {
      var external = page.requests.filter(function (url) {
        return !/^(http:\/\/127\.0\.0\.1:\d+\/|data:|file:|about:)/.test(url);
      });
      assertEqual(external, [], '存在外部网络请求');
      var bad = page.responses.filter(function (r) { return r.status >= 400; });
      assertEqual(bad, [], '存在 4xx/5xx 响应');
      assertEqual(page.failures, [], '存在资源加载失败');
      var rect = await page.eval(function () {
        var r = document.getElementById('gameCanvas').getBoundingClientRect();
        return { w: r.width, h: r.height };
      });
      assert(rect.w > 0 && Math.abs(rect.w - rect.h) < 0.5, '画布非正方形：' + JSON.stringify(rect));
    });

    /* ---------------- 主流程 ---------------- */

    await test('按 Enter 开始游戏进入第 1 关，HUD 与快照一致', async function () {
      await page.tap('Enter', 'Enter');
      await sleep(350);
      var state = await page.state();
      var hud = await page.hud();
      assertEqual(state.status, 'playing', '开始后状态');
      assertEqual(state.level, 1, '关卡');
      assertEqual(state.lives, 3, '生命');
      assertEqual(state.enemiesRemaining, 20, '剩余敌人');
      assertEqual(state.score, 0, '得分');
      assert(hudMatches(state, hud), 'HUD 与快照不一致：' + JSON.stringify({ state: state, hud: hud }));
      assert(await page.eval('document.getElementById("overlay").hidden'), '开始后遮罩未隐藏');
      assertEqual(await page.eval('document.getElementById("pauseBtn").disabled'), false, '暂停按钮应可用');
      await page.screenshot('02-playing');
    });

    await test('暂停冻结画面与状态，继续后恢复', async function () {
      var before = await page.state();
      var frameBefore = await page.eval('document.getElementById("gameCanvas").toDataURL()');
      await page.tap('KeyP', 'p');
      await sleep(250);
      var paused = await page.state();
      assertEqual(paused.status, 'paused', '按 P 后状态');
      var overlay = await page.eval(function () {
        return {
          visible: !document.getElementById('overlay').hidden,
          title: document.getElementById('overlayTitle').textContent,
          primary: document.getElementById('primaryBtn').textContent,
          secondaryHidden: document.getElementById('secondaryBtn').hidden,
          pauseBtn: document.getElementById('pauseBtn').textContent
        };
      });
      assert(overlay.visible, '暂停遮罩未显示');
      assertEqual(overlay.title, '游戏已暂停', '暂停标题');
      assertEqual(overlay.primary, '继续游戏', '继续按钮');
      assertEqual(overlay.secondaryHidden, false, '暂停时应提供重新开始');
      assertEqual(overlay.pauseBtn, '继续', '顶部暂停按钮文案');
      await page.screenshot('03-paused');
      await sleep(900);
      var pausedLater = await page.state();
      var frameLater = await page.eval('document.getElementById("gameCanvas").toDataURL()');
      assertEqual(pausedLater.playerX, paused.playerX, '暂停期间玩家 X 变化');
      assertEqual(pausedLater.playerY, paused.playerY, '暂停期间玩家 Y 变化');
      assertEqual(pausedLater.enemiesRemaining, paused.enemiesRemaining, '暂停期间敌人数量变化');
      assertEqual(pausedLater.score, paused.score, '暂停期间得分变化');
      assertEqual(frameLater, frameBefore, '暂停期间画布仍在变化（未冻结）');
      assertEqual(before.status, 'playing', '暂停前状态');
      await page.tap('KeyP', 'p');
      await sleep(300);
      var resumed = await page.state();
      assertEqual(resumed.status, 'playing', '再次按 P 后状态');
      assert(await page.eval('document.getElementById("overlay").hidden'), '继续后遮罩未隐藏');
    });

    await test('方向键移动：砖墙阻挡、无障碍方向可持续移动', async function () {
      var start = await page.state();
      await page.hold('ArrowRight', 'ArrowRight', 600);
      var blocked = await page.state();
      assertEqual(blocked.playerDirection, 'right', '朝向应为 right');
      assertRange(blocked.playerX, start.playerX, start.playerX + 2, '砖墙前 X 应几乎不变');
      await page.hold('ArrowLeft', 'ArrowLeft', 500);
      var moved = await page.state();
      assertEqual(moved.playerDirection, 'left', '朝向应为 left');
      assert(moved.playerX < blocked.playerX - 15, '向左移动距离不足：' + blocked.playerX + ' -> ' + moved.playerX);
      var hud = await page.hud();
      assert(hudMatches(moved, hud), '移动后 HUD 与快照不一致');
    });

    await test('射击摧毁砖墙，玩家可进入被摧毁格', async function () {
      var before = await page.state();
      await page.hold('ArrowRight', 'ArrowRight', 700);
      var atWall = await page.state();
      assertRange(atWall.playerX, 55, 58, '应回到出生点砖墙前');
      await page.tap('ArrowRight', 'ArrowRight', 40);
      await page.tap('Space', ' ');
      await sleep(600);
      var shot = await page.state();
      assertEqual(shot.status, 'playing', '射击后应仍在游戏中');
      await page.hold('ArrowRight', 'ArrowRight', 700);
      var through = await page.state();
      assert(through.playerX > atWall.playerX + 10, '砖墙未被摧毁，无法进入：' + atWall.playerX + ' -> ' + through.playerX);
      assertRange(through.playerX, 65, 75, '砖墙后位置异常');
      assert(before.playerX !== through.playerX, '玩家位置未变化');
    });

    await test('玩家子弹击中基地立即失败（即使仍有生命与敌人）', async function () {
      await page.tap('ArrowRight', 'ArrowRight', 40);
      await page.tap('Space', ' ');
      await sleep(1400);
      var state = await page.state();
      assertEqual(state.status, 'gameOver', '基地被击中后状态');
      assertEqual(state.baseAlive, false, '基地存活标记');
      assertEqual(state.lives, 3, '失败时不应扣命');
      var overlay = await page.eval(function () {
        return {
          title: document.getElementById('overlayTitle').textContent,
          text: document.getElementById('overlayText').textContent,
          stats: document.getElementById('overlayStats').textContent,
          primary: document.getElementById('primaryBtn').textContent
        };
      });
      assertEqual(overlay.text, '基地被摧毁', '失败原因文案');
      assertEqual(overlay.primary, '重新开始', '失败结算操作');
      assert(overlay.stats.indexOf('本局得分') >= 0 && overlay.stats.indexOf('最高分') >= 0, '结算缺少得分信息');
      await page.screenshot('04-gameover');
    });

    await test('点击重新开始回到第 1 关初始态，无残留状态', async function () {
      await page.click('#primaryBtn');
      await sleep(400);
      var state = await page.state();
      var hud = await page.hud();
      assertEqual(state.status, 'playing', '重开后状态');
      assertEqual(state.level, 1, '重开关卡');
      assertEqual(state.lives, 3, '重开生命');
      assertEqual(state.score, 0, '重开得分');
      assertEqual(state.baseAlive, true, '重开基地');
      assertEqual(state.enemiesOnScreen, 0, '重开后场上敌人');
      assertEqual(state.enemiesRemaining, 20, '重开后剩余敌人');
      assertEqual(state.playerX, 56, '重开后玩家 X');
      assertEqual(state.playerY, 200, '重开后玩家 Y');
      assertEqual(state.playerDirection, 'up', '重开朝向');
      assert(hudMatches(state, hud), '重开后 HUD 与快照不一致');
      assert(await page.eval('document.getElementById("overlay").hidden'), '重开后遮罩未隐藏');
    });

    await test('窗口失焦与页面隐藏自动暂停且不自动恢复', async function () {
      await page.eval('window.dispatchEvent(new Event("blur"))');
      await sleep(250);
      var blurred = await page.state();
      assertEqual(blurred.status, 'paused', '失焦后状态');
      await page.tap('KeyP', 'p');
      await sleep(250);
      assertEqual((await page.state()).status, 'playing', '继续后状态');
      await page.eval(function () {
        Object.defineProperty(document, 'hidden', { configurable: true, get: function () { return true; } });
        document.dispatchEvent(new Event('visibilitychange'));
        Object.defineProperty(document, 'hidden', { configurable: true, get: function () { return false; } });
      });
      await sleep(300);
      var hidden = await page.state();
      assertEqual(hidden.status, 'paused', '页面隐藏后状态');
      await page.tap('Enter', 'Enter');
      await sleep(300);
      assertEqual((await page.state()).status, 'playing', '按 Enter 应从暂停恢复');
    });

    /* ---------------- 偏好与降级 ---------------- */

    await test('静音切换即时生效并刷新后持久化', async function () {
      await page.tap('KeyM', 'm');
      await sleep(200);
      var muted = await page.state();
      assertEqual(muted.muted, true, '静音状态');
      var ui = await page.eval(function () {
        return {
          text: document.getElementById('muteBtn').textContent,
          pressed: document.getElementById('muteBtn').getAttribute('aria-pressed'),
          stored: localStorage.getItem('tankGame.v1.muted'),
          keys: Object.keys(localStorage).sort()
        };
      });
      assertEqual(ui.text, '音效：关', '静音按钮文案');
      assertEqual(ui.pressed, 'true', '静音按钮 aria-pressed');
      assertEqual(ui.stored, '1', 'localStorage 静音值');
      var unexpected = ui.keys.filter(function (key) { return key !== 'tankGame.v1.highScore' && key !== 'tankGame.v1.muted'; });
      assertEqual(unexpected, [], '存在契约外的 localStorage Key');
      await page.navigate(baseUrl);
      var reloaded = await page.eval(function () {
        return { state: window.__tankGame.getState(), text: document.getElementById('muteBtn').textContent };
      });
      assertEqual(reloaded.state.status, 'idle', '刷新后应回到开始页');
      assertEqual(reloaded.state.muted, true, '刷新后静音应保留');
      assertEqual(reloaded.text, '音效：关', '刷新后静音按钮文案');
      await page.tap('KeyM', 'm');
      await sleep(150);
      assertEqual((await page.state()).muted, false, '再次静音切换');
    });

    await test('最高分从 localStorage 读取并拒绝非法值', async function () {
      var seed = await page.addInitScript(
        'try { localStorage.setItem("tankGame.v1.highScore", "1234"); } catch (e) {}');
      try {
        await page.navigate(baseUrl);
        var stored = await page.state();
        var hud = await page.hud();
        assertEqual(stored.highScore, 1234, '最高分未从 localStorage 恢复');
        assertEqual(hud.highScore, '1234', 'HUD 最高分未同步');
      } finally {
        await page.removeInitScript(seed);
      }
      var invalid = await page.addInitScript(
        'try { localStorage.setItem("tankGame.v1.highScore", "not-a-number"); } catch (e) {}');
      try {
        await page.navigate(baseUrl);
        assertEqual((await page.state()).highScore, 0, '非法最高分未降级为 0');
      } finally {
        await page.removeInitScript(invalid);
      }
      await page.navigate(baseUrl);
      await page.eval('try { localStorage.setItem("tankGame.v1.highScore", "0"); localStorage.setItem("tankGame.v1.muted", "0"); } catch (e) {}');
    });

    await test('localStorage 不可用时游戏正常运行且无未捕获异常', async function () {
      var scriptId = await page.addInitScript([
        'try {',
        '  Object.defineProperty(window, "localStorage", { configurable: true, get: function () { throw new Error("localStorage blocked"); } });',
        '} catch (e) {}'
      ].join('\n'));
      try {
        await page.navigate(baseUrl);
        assert(await page.eval('!!window.__tankGame'), 'localStorage 不可用时未暴露只读接口');
        await page.tap('Enter', 'Enter');
        await sleep(300);
        await page.tap('KeyM', 'm');
        await sleep(200);
        var state = await page.state();
        assertEqual(state.status, 'playing', 'localStorage 不可用时无法开始游戏');
        assertEqual(state.muted, true, 'localStorage 不可用时静音应仅本会话生效');
        assertEqual(page.exceptions, [], 'localStorage 不可用时出现未捕获异常');
      } finally {
        await page.removeInitScript(scriptId);
      }
      await page.navigate(baseUrl);
    });

    await test('AudioContext 不可用时游戏正常运行且无未捕获异常', async function () {
      var scriptId = await page.addInitScript([
        'try {',
        '  Object.defineProperty(window, "AudioContext", { configurable: true, value: undefined });',
        '  Object.defineProperty(window, "webkitAudioContext", { configurable: true, value: undefined });',
        '} catch (e) {}'
      ].join('\n'));
      try {
        await page.navigate(baseUrl);
        await page.tap('Enter', 'Enter');
        await sleep(300);
        await page.tap('Space', ' ');
        await sleep(600);
        var state = await page.state();
        assertEqual(state.status, 'playing', 'AudioContext 不可用时无法游玩');
        assertEqual(page.exceptions, [], 'AudioContext 不可用时出现未捕获异常');
      } finally {
        await page.removeInitScript(scriptId);
      }
      await page.navigate(baseUrl);
    });

    await test('Canvas 2D 不可用时展示可读错误而非白屏', async function () {
      var scriptId = await page.addInitScript([
        'try { HTMLCanvasElement.prototype.getContext = function () { return null; }; } catch (e) {}'
      ].join('\n'));
      try {
        await page.navigate(baseUrl);
        var info = await page.eval(function () {
          return {
            title: document.getElementById('overlayTitle').textContent,
            text: document.getElementById('overlayText').textContent,
            overlayVisible: !document.getElementById('overlay').hidden,
            primaryHidden: document.getElementById('primaryBtn').hidden,
            bodyText: document.body.innerText
          };
        });
        assertEqual(info.title, '游戏加载失败', 'Canvas 不可用标题');
        assertEqual(info.text, '游戏加载失败，请刷新页面重试', 'Canvas 不可用文案');
        assert(info.overlayVisible && info.primaryHidden, 'Canvas 不可用时应展示错误遮罩');
        assert(info.bodyText.indexOf('坦克大战') >= 0, '页面白屏');
        await page.screenshot('05-canvas-error');
      } finally {
        await page.removeInitScript(scriptId);
      }
      await page.navigate(baseUrl);
    });

    /* ---------------- 响应式与部署 ---------------- */

    await test('窗口缩放画布等比、无裁切、无横向滚动', async function () {
      var sizes = [[1440, 900], [1000, 700], [520, 760]];
      for (var i = 0; i < sizes.length; i += 1) {
        await page.setViewport(sizes[i][0], sizes[i][1], false);
        var rect = await page.eval(function () {
          var r = document.getElementById('gameCanvas').getBoundingClientRect();
          return {
            w: r.width, h: r.height, left: r.left, right: r.right,
            scrollWidth: document.documentElement.scrollWidth,
            clientWidth: document.documentElement.clientWidth
          };
        });
        assert(Math.abs(rect.w - rect.h) < 0.5, '视口 ' + sizes[i][0] + ' 下画布非正方形：' + JSON.stringify(rect));
        assert(rect.left >= 0 && rect.right <= sizes[i][0], '视口 ' + sizes[i][0] + ' 下画布被裁切');
        assert(rect.scrollWidth <= rect.clientWidth, '视口 ' + sizes[i][0] + ' 下出现横向滚动');
      }
      await page.setViewport(VIEWPORT.width, VIEWPORT.height, false);
    });

    await test('移动端/触屏提示展示且 320px 无横向滚动', async function () {
      await page.setViewport(390, 844, true);
      var info = await page.eval(function () {
        var hint = document.getElementById('mobileHint');
        var rect = document.getElementById('gameCanvas').getBoundingClientRect();
        return {
          display: getComputedStyle(hint).display,
          text: hint.textContent.trim(),
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
          canvasSquare: Math.abs(rect.width - rect.height) < 0.5,
          startVisible: document.getElementById('primaryBtn').getBoundingClientRect().width > 0
        };
      });
      assert(info.display !== 'none', '移动端未展示提示');
      assertEqual(info.text, '建议使用电脑键盘游玩', '移动端提示文案');
      assert(info.scrollWidth <= info.clientWidth, '移动端出现横向滚动');
      assert(info.canvasSquare, '移动端画布非正方形');
      assert(info.startVisible, '移动端开始按钮不可见');
      await page.screenshot('06-mobile');
      await page.setViewport(320, 700, true);
      var narrow = await page.eval(function () {
        return { scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth };
      });
      assert(narrow.scrollWidth <= narrow.clientWidth, '320px 视口出现横向滚动');
      await page.setViewport(VIEWPORT.width, VIEWPORT.height, false);
    });

    await test('首屏可交互时间 ≤3 秒', async function () {
      await page.navigate(baseUrl);
      var timing = await page.eval(function () {
        var nav = performance.getEntriesByType('navigation')[0];
        return {
          hasApi: !!window.__tankGame,
          domContentLoaded: nav ? nav.domContentLoadedEventEnd : -1,
          load: nav ? nav.loadEventEnd : -1,
          resourceHosts: performance.getEntriesByType('resource').map(function (entry) { return entry.name; })
        };
      });
      assert(timing.hasApi, '页面加载后未暴露只读调试接口');
      assert(timing.domContentLoaded >= 0 && timing.domContentLoaded < 3000,
        'DOMContentLoaded 超出 3s：' + timing.domContentLoaded + 'ms');
      assert(timing.load >= 0 && timing.load < 3000, 'load 事件超出 3s：' + timing.load + 'ms');
      var external = timing.resourceHosts.filter(function (url) {
        return !/^(http:\/\/127\.0\.0\.1:\d+\/|data:)/.test(url);
      });
      assertEqual(external, [], '首屏存在外部资源');
    });

    await test('游戏运行帧率不低于低端设备 30fps 基线', async function () {
      await page.tap('Enter', 'Enter');
      await sleep(400);
      var fps = await page.eval(function () {
        return new Promise(function (resolve) {
          var frames = 0;
          var start = performance.now();
          function loop(now) {
            frames += 1;
            if (now - start >= 2000) {
              resolve(frames / ((now - start) / 1000));
              return;
            }
            requestAnimationFrame(loop);
          }
          requestAnimationFrame(loop);
        });
      });
      assert(fps >= 30, '实测帧率 ' + fps.toFixed(1) + 'fps，低于 30fps 基线');
      lastFps = fps;
    });

    await test('file:// 直接打开可运行', async function () {
      await page.navigate('file://' + path.join(REPO, 'index.html'), 600);
      var state = await page.state();
      assertEqual(state.status, 'idle', 'file:// 初始状态');
      var rendered = await page.eval(function () {
        var canvas = document.getElementById('gameCanvas');
        var data = canvas.toDataURL();
        return { hasApi: !!window.__tankGame, dataLength: data.length };
      });
      assert(rendered.hasApi, 'file:// 下未暴露只读接口');
      assert(rendered.dataLength > 1000, 'file:// 下画布未渲染');
    });

    await test('静态子路径部署可运行且无 404', async function () {
      await page.navigate(subpathUrl);
      var state = await page.state();
      assertEqual(state.status, 'idle', '子路径初始状态');
      var bad = page.responses.filter(function (r) { return r.status >= 400; });
      assertEqual(bad, [], '子路径部署存在 4xx/5xx');
      assertEqual(page.failures, [], '子路径部署存在加载失败');
      await page.tap('Enter', 'Enter');
      await sleep(350);
      assertEqual((await page.state()).status, 'playing', '子路径下无法开始游戏');
    });

  } finally {
    for (var i = cleanups.length - 1; i >= 0; i -= 1) {
      try { cleanups[i](); } catch (e) { /* ignore */ }
    }
    try { repoServer.server.close(); } catch (e) { /* ignore */ }
    try { parentServer.server.close(); } catch (e) { /* ignore */ }
  }

  var passed = results.filter(function (r) { return r.status === 'PASS'; }).length;
  var failed = results.length - passed;
  var duration = Date.now() - startedAt;
  var commit = spawnSync('git', ['-C', REPO, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
  var reportPath = path.join(REPORT_DIR, 'e2e-report.html');

  var rows = results.map(function (r, index) {
    var screenshot = r.screenshot ? path.relative(REPORT_DIR, r.screenshot).split(path.sep).join('/') : '';
    return '<tr class="' + r.status.toLowerCase() + '">' +
      '<td>' + (index + 1) + '</td>' +
      '<td>' + escapeHtml(r.name) + '</td>' +
      '<td><strong>' + r.status + '</strong></td>' +
      '<td>' + r.duration + ' ms</td>' +
      '<td>' + (r.error ? '<pre>' + escapeHtml(r.error) + '</pre>' : '—') + '</td>' +
      '<td>' + (screenshot ? '<a href="' + escapeHtml(screenshot) + '">截图</a>' : '—') + '</td>' +
      '</tr>';
  }).join('\n');

  var html = '<!DOCTYPE html>\n<html lang="zh-CN"><head><meta charset="utf-8">' +
    '<title>坦克大战 E2E 验收报告</title><style>' +
    'body{font-family:-apple-system,"Segoe UI","PingFang SC",sans-serif;margin:24px;color:#1f2328;background:#fff}' +
    'h1{font-size:22px;margin:0 0 8px}h2{font-size:16px;margin:24px 0 8px}' +
    '.meta{color:#57606a;font-size:13px;line-height:1.7}' +
    '.summary{display:flex;gap:16px;margin:16px 0}.card{border:1px solid #d0d7de;border-radius:8px;padding:10px 16px;min-width:100px}' +
    '.card b{display:block;font-size:22px}.pass b{color:#1a7f37}.fail b{color:#cf222e}' +
    'table{border-collapse:collapse;width:100%;font-size:13px}th,td{border:1px solid #d0d7de;padding:8px;text-align:left;vertical-align:top}' +
    'th{background:#f6f8fa}tr.fail td{background:#fff5f5}pre{margin:0;white-space:pre-wrap;word-break:break-word;font-size:11px;color:#cf222e}' +
    'a{color:#0969da}</style></head><body>' +
    '<h1>坦克大战 HTML 网页游戏 · 浏览器 E2E 验收报告</h1>' +
    '<div class="meta">执行时间：' + escapeHtml(new Date().toISOString()) + '<br>' +
    '仓库：zsrdut/TankDemo @ ' + escapeHtml(commit) + ' · 页面：' + escapeHtml(baseUrl) + '<br>' +
    '浏览器：' + escapeHtml(browserInfo.product || chromeBin) + ' · Node：' + escapeHtml(process.version) + '<br>' +
    '驱动：Node 内置 WebSocket + Chromium DevTools Protocol（零第三方依赖）' +
    (lastFps ? '<br>实测帧率：' + lastFps.toFixed(1) + ' fps（2s rAF 采样）' : '') + '</div>' +
    '<div class="summary">' +
    '<div class="card"><b>' + results.length + '</b>用例总数</div>' +
    '<div class="card pass"><b>' + passed + '</b>PASS</div>' +
    '<div class="card fail"><b>' + failed + '</b>FAIL</div>' +
    '<div class="card"><b>' + duration + ' ms</b>总耗时</div>' +
    '</div>' +
    '<h2>用例明细</h2><table><thead><tr><th>#</th><th>用例</th><th>结果</th><th>耗时</th><th>错误 / 堆栈</th><th>现场</th></tr></thead><tbody>' +
    rows + '</tbody></table>' +
    '<h2>说明</h2><p class="meta">本报告仅覆盖本轮变更的最小相关浏览器验收集合；游戏规则数值与地图数据由 tools/validate-data.js、tools/logic-test.js 覆盖。' +
    '未覆盖项：多浏览器矩阵（Firefox/Safari）、真实音频输出、长时间帧率与内存观测、人工手感与可玩性评估。</p>' +
    '</body></html>';

  fs.writeFileSync(reportPath, html);

  console.log('');
  console.log('STATUS=' + (failed === 0 ? 'PASS' : 'FAIL'));
  console.log('SUMMARY=共 ' + results.length + ' 个用例，PASS ' + passed + '，FAIL ' + failed + '，耗时 ' + duration + 'ms');
  console.log('REPORT_PATH=' + reportPath);
  console.log('REPORT_URL=');
  if (failed > 0) {
    console.log('FAILED_CASES=' + results.filter(function (r) { return r.status === 'FAIL'; }).map(function (r) { return r.name; }).join(' | '));
  }
  process.exit(failed === 0 ? 0 : 1);
}

function findArg(name) {
  var index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : '';
}

run().catch(function (error) {
  console.error('BLOCKED ' + (error && (error.stack || error.message)));
  console.log('STATUS=BLOCKED');
  console.log('SUMMARY=' + ((error && error.message) || error));
  console.log('REPORT_PATH=');
  console.log('REPORT_URL=');
  process.exit(2);
});
