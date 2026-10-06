# WhaleMind-Hub · 鲸思云辩

辩论赛现场三端协同系统：**主席控制台**（PC）指挥赛程、**评委打分端**（移动/平板）触控评分、**大屏展示端**（舞台投屏）实时呈现倒计时与正反方对比。服务端为唯一状态权威，三端通过 Socket.io 秒级同步。

## 三端职责

| 端 | 路由 | 形态 | 职责 |
|---|---|---|---|
| 主席控制台 | `/admin` | PC，Arco Design Vue | 载入赛制、环节推进、计时启停、自由辩切换发言方、监控打分进度、公布比分 |
| 评委打分端 | `/judge` | 移动/平板，Arco（触控友好） | 入场码加入、分环节给正反双方打分，可反复修改 |
| 大屏展示端 | `/screen` | 响应式大屏，纯 Flex/Grid | 辩题、当前环节、超大倒计时、正反对比、倒计时预警 |

## 快速开始

要求：Node.js ≥ 20，pnpm ≥ 9。

```bash
pnpm install             # 安装依赖
pnpm dev                 # 并行启动 server (:3000) + client (:5173)
pnpm test                # 服务端状态机 vitest 用例
node scripts/smoke.mjs   # 三端联动冒烟（需先启动 server）
```

打开三个窗口即可联调：

- 控制台 <http://localhost:5173/admin>
- 评委端 <http://localhost:5173/judge>（入场码显示在控制台右上角）
- 大屏端 <http://localhost:5173/screen>（建议 F11 全屏投出）

局域网多设备：client 已监听 `0.0.0.0`，评委手机连同一 WiFi 访问 `http://<主席机IP>:5173/judge`。

## 工程结构

```
├── shared/                       # 前后端共享契约（单一事实源）
│   └── src/types/debate.ts       # GameStatus / StageConfig / TimerState / Socket Payload
│   └── src/templates.ts          # 内置赛制模板（标准三人赛制 / 快速测试）
├── server/                       # Node + Express + Socket.io（状态机权威方）
│   └── src/game/engine.ts        # 比赛状态机（唯一可变状态所在地）
│   └── src/game/timer.ts         # 权威计时（targetEndTime 生成/固化/反推）
│   └── src/index.ts              # HTTP + Socket.io 接线、看门狗
├── client/                       # Vite + Vue3 + TS + Pinia，单应用三路由
│   └── src/stores/debateStore.ts # 比赛状态唯一收拢点（服务端镜像）
│   └── src/composables/useMasterClock.ts   # rAF 主帧时钟（权威时间反推）
│   └── src/composables/useSocket.ts        # Socket 连接与时钟偏移采样
└── scripts/smoke.mjs             # 三端联动冒烟脚本
```

## 核心设计

### 权威时间同步（Master Time Principle）

**禁止**在前端用 `setInterval` 累加/递减计时（切后台、性能受限即失准）。本系统的做法：

1. 服务端启动/恢复计时时生成 `targetEndTime = 服务端当前时刻 + 剩余毫秒`，随状态广播；
2. 各端每帧按 `targetEndTime - (Date.now() + clockOffset)` 反推剩余时间（`requestAnimationFrame` 驱动，全应用共用一个主帧循环）；
3. `clockOffset` 由每次广播携带的 `serverTime` 做滚动中位数采样校正，消除多机时钟偏差；
4. 暂停时按目标点固化剩余毫秒，恢复时重新生成 `targetEndTime`——任何时刻都不存“倒数数字”。

### 状态机单向流转

```
idle → configured → running ⇄ paused → finished
```

- 环节索引**只增不减**，无回退；唯一允许“回到起点”的是 `reset`（开一场新比赛）；
- 环节计时类型：`single`（单方单向计时）与 `dual_alternating`（自由辩双向交替，同一时刻仅一方消耗时间，切换发言方 = 上一方暂停、下一方立即启动）；
- `countdown` 归零自动推进到下一环节（新环节待主席启动）；`countUp` 不自动结束，由主席手动推进；
- 保护时间：环节可标记受保护方（如质询中被质询方），该方接麦但计时器不启动；
- 所有指令经服务端 `engine.ts` 校验合法流转后才落地，非法指令直接拒绝——客户端 `debateStore` 纯镜像，不做任何本地状态推导。

### Socket 事件契约

| 方向 | 事件 | 说明 |
|---|---|---|
| C→S | `match:command` | 主席指令统一封装（loadTemplate / start / pause / resume / nextStage / switchSpeaker / publishScores / finish / reset） |
| C→S | `judge:join` | 入场码加入（6 位数字，无账号体系） |
| C→S | `score:submit` | 评分提交（upsert，以最后一次为准） |
| S→C | `game:state` | 全量状态快照（连接/重连/每次变更下发） |
| S→C | `timer:warn` | 倒计时预警阈值触发 |
| S→C | `score:progress` | 打分进度（仅 judgeId 列表，分数内容不外泄） |

类型定义全部在 `shared/src/types/debate.ts`，前后端不得私自定义重复结构。

## 开发规范（红线）

1. **触控热区**：评委端按钮/Slider 热区高度 ≥ 48px，不得用原生微小 PC 控件。
2. **状态不碎片化**：比赛状态（剩余时间、当前环节、发言方）统一收拢在 Pinia `debateStore`，禁止视图组件私有维护。
3. **音频解锁**：大屏播提示音前必须先引导用户点击一次以解封 AudioContext，规避 Autoplay 策略。
4. **类型复用**：所有 Socket / 后端 Payload 复用 `@/types/debate.ts`（即 `@debate/shared`）。

## 常用命令

| 命令 | 说明 |
|---|---|
| `pnpm dev` | 并行启动 server + client（开发） |
| `pnpm dev:server` / `pnpm dev:client` | 单独启动一端 |
| `pnpm test` | 状态机 vitest（14 用例） |
| `pnpm typecheck` | 全仓 TypeScript 检查（server tsc + client vue-tsc） |
| `node scripts/smoke.mjs` | 三端联动冒烟（20 断言） |

## 已实现 / 规划中

**已实现（最小闭环）**：三端界面壳、赛制模板载入、环节推进、倒计时/正计时、自由辩交替计时、保护时间、暂停/恢复、倒计时预警阈值、评委入场码、分环节双方打分与进度广播、比分公布开关、比赛重置。

**规划中**：SQLite 落盘、加权总分判胜负、环节编辑器（拖拽/权重/阈值配置）、赛制存档复用、队徽/背景图上传、称谓与配色自定义、大屏 GSAP 预警动效与多款提示音、评委扫码入场、公网部署（ADMIN_PIN / 反代）。
