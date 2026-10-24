# 坦克大战 · HTML 网页游戏

零构建、零第三方依赖、无后端的经典单人守基地坦克大战。使用原生 HTML + CSS + JavaScript + Canvas 2D 实现，打开 `index.html` 即可游玩。

## 运行

- 直接双击 `index.html`（`file://` 可用），或在仓库根目录启动任意静态文件服务器。
- 兼容 GitHub Pages 等静态托管子路径，所有资源均为相对路径。
- 支持最近两个大版本的 Chrome / Edge / Firefox / Safari，不支持 IE。
- 移动端可打开页面，但仅展示「建议使用电脑键盘游玩」提示，不提供触控操作。

## 操作

| 按键 | 功能 |
| --- | --- |
| 方向键 / WASD | 移动（按住持续移动） |
| 空格 / J | 射击（按下边沿触发，不按住连发） |
| P | 暂停 / 继续 |
| M | 静音 / 恢复 |
| Enter | 开始 / 继续 / 重新开始 |

## 玩法

- 3 关，每关 20 辆敌方坦克，同屏最多 4 辆；第 3 关完成后胜利。
- 玩家初始 3 条命，被击毁后于出生点复活并获得 2 秒无敌；生命耗尽或基地被任意子弹击毁即失败。
- 共有普通、快速、装甲、精英 4 类敌人，固定刷新队列保证同关卡可复现。
- 6 种道具：手雷、头盔、铲子、星星、坦克、时钟；击毁闪光敌人后掉落。
- 砖墙可被任意子弹摧毁；钢墙仅火力 2 的玩家子弹可摧毁；水面阻挡坦克不阻挡子弹；树林遮挡视线；冰面产生惯性。
- 得分：普通 100 / 快速 200 / 装甲 300 / 精英 400，每关通关额外 1000 分。
- 最高分与静音状态保存在 `localStorage`；不可用时静默降级为本次会话内生效。

## 只读调试接口

页面初始化成功后暴露冻结的 `window.__tankGame`，仅包含 `getState()`：

```js
window.__tankGame.getState();
// {
//   status, level, lives, enemiesRemaining, enemiesOnScreen,
//   score, highScore, baseAlive, muted,
//   playerX, playerY, playerDirection
// }
```

- `status` 取值：`idle` / `playing` / `paused` / `levelClear` / `gameOver` / `victory`。
- 返回对象被冻结，修改返回值不会影响游戏内部状态；调用无副作用。
- 不提供跳关、加命、改分等写接口。

## 目录结构

```text
index.html            页面骨架、HUD、开始 / 暂停 / 结算遮罩
css/style.css         像素街机风样式、响应式布局、移动端提示
js/config.js          地图、关卡、敌人队列、数值基线（纯数据）
js/storage.js         localStorage 安全读写与内存降级
js/audio.js           WebAudio 程序化音效合成
js/game.js            固定步长模拟、碰撞、AI、道具、关卡、渲染
js/main.js            启动、只读状态契约、异常兜底
tools/validate-data.js 零依赖静态数据校验
```

## 验证

```bash
node tools/validate-data.js
node tools/logic-test.js
node tools/e2e-browser-test.js
node --check js/config.js
node --check js/storage.js
node --check js/audio.js
node --check js/game.js
node --check js/main.js
```

- `validate-data.js` 校验三张地图的 13×13 尺寸、基地 2×2、出生点、基地保护圈、可达性、每关 20 个敌人的类型配比与道具合法性。
- `logic-test.js` 使用零依赖 Node 测试桩覆盖只读快照、关卡推进、胜利/失败、复活与无敌、道具、子弹对撞、砖墙/钢墙、敌人刷新上限与重开重置。
- `e2e-browser-test.js` 通过 Node 内置 WebSocket 驱动系统 Chromium 的 DevTools Protocol，在真实浏览器验证启动、暂停、移动、射击、基地失败、重开、持久化、降级、响应式、`file://` 与子路径部署；需本机安装 Chrome/Chromium，缺失时输出 `BLOCKED`，报告写入 `test-reports/e2e-report.html`。
- 以上脚本均不引入 npm 依赖、构建步骤或测试框架，也不参与浏览器运行时。

## 技术约定

- 游戏逻辑以 1/60 秒固定步长推进，渲染独立于逻辑步。
- Canvas 逻辑分辨率为 208×208（13×13 格 × 16 逻辑像素），按整数倍优先等比缩放。
- 未引入构建工具、包管理器、测试框架或任何外部运行时资源。
- 全流程可仅用键盘完成，按钮可聚焦，画布与状态区域提供可读文本。
