# WhaleMind-Hub · 鲸思云辩

辩论赛现场三端协同系统：**主席控制台**（PC）指挥赛程、**评委打分端**（移动/平板）触控评分、**大屏展示端**（舞台投屏）实时呈现倒计时与正反方对比。服务端为唯一状态权威，三端通过 Socket.io 秒级同步。

## 三端职责

| 端 | 路由 | 形态 | 职责 |
|---|---|---|---|
| 主席控制台 | `/admin` | PC，Arco Design Vue | 载入赛制、环节推进、计时启停、自由辩切换发言方、监控打分进度、公布比分 |
| 评委打分端 | `/judge` | 移动/平板，Arco（触控友好） | 入场码加入、分环节给正反双方打分，可反复修改 |
| 大屏展示端 | `/screen` | 响应式大屏，纯 Flex/Grid | 辩题、当前环节、超大倒计时、正反对比、倒计时预警 |

## 快速开始

要求：Node.js ≥ 22.5（`node:sqlite` 的最低版本，建议 24 LTS），pnpm ≥ 9。

```bash
pnpm install             # 安装依赖
pnpm dev                 # 并行启动 server (:3000) + client (:5173)
pnpm test                # 服务端状态机 vitest 用例
node scripts/smoke.mjs   # 三端联动冒烟（需先启动 server）
```

服务端状态会自动落盘到 `server/data/debate.db`（首次启动自动创建，已 gitignore）。想跑一场“干净”的比赛就删掉该文件；设 `DB_PATH=:memory:` 可完全不落盘。

打开三个窗口即可联调：

- 控制台 <http://localhost:5173/admin>
- 评委端 <http://localhost:5173/judge>（入场码显示在控制台右上角）
- 大屏端 <http://localhost:5173/screen>（建议 F11 全屏投出）

局域网多设备：client 已监听 `0.0.0.0`，评委手机连同一 WiFi 访问 `http://<主席机IP>:5173/judge`。

## 工程结构

```
├── shared/                       # 前后端共享契约（单一事实源）
│   └── src/types/debate.ts       # GameStatus / StageConfig / TimerState / Socket Payload
│   └── src/clock.ts              # 时钟样本挑选（最小 RTT 优先，前后端共用）
│   └── src/scoring.ts            # 成绩汇总口径（引擎与赛后导出共用同一份）
│   └── src/stages.ts             # 环节校验与归一化（服务端权威，前端只做体验）
│   └── src/config.ts             # 比赛配置补丁白名单（matchId/entryCode 不可改）
│   └── src/cues.ts               # 提示音音色定义（纯数据）
│   └── src/templates.ts          # 内置赛制模板（标准三人赛制 / 快速测试）
├── server/                       # Node + Express + Socket.io（状态机权威方）
│   └── src/game/engine.ts        # 比赛状态机（唯一可变状态所在地）
│   └── src/game/timer.ts         # 权威计时（targetEndTime 生成/固化/反推）
│   └── src/game/clock.ts         # 单调时钟基准（免疫系统时钟跳变）
│   └── src/time/ntp.ts           # 最小 SNTP 客户端 + 安全校时调度
│   └── src/db/schema.ts          # SQLite 打开与建表（node:sqlite，零 native 依赖）
│   └── src/db/repository.ts      # 落盘 / 恢复 / 心跳 / 换场归档 / 历史查询
│   └── src/db/templateRepository.ts  # 自定义赛制模板 CRUD
│   └── src/report/csv.ts         # 赛后导出（CSV 生成，纯函数）
│   └── src/index.ts              # HTTP + Socket.io 接线、看门狗、赛后接口
├── client/                       # Vite + Vue3 + TS + Pinia，单应用三路由
│   └── src/stores/debateStore.ts # 比赛状态唯一收拢点（服务端镜像）
│   └── src/composables/useMasterClock.ts   # rAF 主帧时钟（权威时间反推）
│   └── src/composables/useSocket.ts        # Socket 连接与时钟偏移采样
│   └── src/composables/useStageAudio.ts    # 大屏提示音（WebAudio 合成 + 交互解锁）
│   └── src/components/StageTable.vue       # 环节表格（Arco Table + Sortable 拖拽排序）
│   └── src/components/StageEditorDrawer.vue # 环节编辑抽屉（Arco Drawer + Form）
│   └── src/components/MatchInfoCard.vue    # 比赛信息表单（辩题 / 队名 / 配色 / 评分刻度）
│   └── src/stages/draft.ts       # 环节草稿模型（表单态与比赛状态分离）
│   └── src/api/templates.ts      # 模板 CRUD 的 HTTP 封装
└── scripts/smoke.mjs             # 三端联动冒烟脚本
```

## 核心设计

### 权威时间同步（Master Time Principle）

**禁止**在前端用 `setInterval` 累加/递减计时（切后台、性能受限即失准）。本系统的做法：

1. 服务端启动/恢复计时时生成 `targetEndTime = 服务端当前时刻 + 剩余毫秒`，随状态广播；
2. 各端每帧按 `targetEndTime - (Date.now() + clockOffset)` 反推剩余时间（`requestAnimationFrame` 驱动，全应用共用一个主帧循环）。**裸用 `Date.now()` 是不行的**——系统时钟不准的设备（廉价平板可能偏几分钟）倒计时会整体错位，所以必须带 `clockOffset` 校正；
3. `clockOffset` 由 **`time:sync` 往返测量**得出：`offset = serverTime - (t0 + t1) / 2`。连接后立即同步、每 5s 复测，样本窗口内取 **RTT 最小者**（NTP best-sample），样本 60s 过期、重连清空、偏移突变 >1s 视为时钟跳变并重建。往返测量消除了单程网络延迟造成的系统性偏差——单向的广播采样（`serverTime - Date.now()`）会把 RTT/2 算进偏移，让各端显示比真实更多的剩余时间；
4. 暂停时按目标点固化剩余毫秒，恢复时重新生成 `targetEndTime`——任何时刻都不存“倒数数字”；
5. **服务端自身使用单调时钟**（[`game/clock.ts`](server/src/game/clock.ts)，由 `process.hrtime` 推导）：系统时钟被 NTP 校时、用户手改或虚拟机快照回滚而跳变时，进行中的倒计时不会跟着跳。`targetEndTime` 是绝对墙钟戳，直接依赖 `Date.now()` 会出事故（时钟前跳 2 秒 = 全场凭空少 2 秒）。控制台右上角实时显示对时偏移与 RTT。

#### NTP 校时（默认开启）

默认向 `ntp.aliyun.com,pool.ntp.org` 校时；外网不通时只记一条告警，不影响比赛。用 `NTP_SERVER=off` 整体关闭，或指定自己的服务器列表。

- **浏览器端无法直连 NTP**（没有 UDP socket），客户端只能对我们的服务端做往返校时；
- **NTP 不影响倒计时精度**：倒计时是相对量，两端同源，服务端与真实 UTC 差多少都不影响走时；
- NTP 的价值是日志/导出时间戳与现实一致、多实例部署有共同基准；真实风险在反方向——**计时过程中平移时钟会让全场的倒计时瞬间跳变**，因此校时只在「没有任何计时器在运行」时应用，否则挂起等待安全时刻（`canAdjust`）；
- `GET /api/health` 会返回完整时钟状态：`shiftMs`（已应用的校时量）、`driftMs`（系统时钟相对单调基准的漂移）、NTP 的 `lastOffsetMs / appliedCount / pendingMs`。

### 状态机单向流转

```
idle → configured → running ⇄ paused → finished
```

- 环节索引**只增不减**，无回退；唯一允许“回到起点”的是 `reset`（开一场新比赛）；
- 环节计时类型：`single`（单方单向计时）与 `dual_alternating`（自由辩双向交替，同一时刻仅一方消耗时间，切换发言方 = 上一方暂停、下一方立即启动）；
- `countdown` 归零自动推进到下一环节（新环节待主席启动）；`countUp` 不自动结束，由主席手动推进；
- 保护时间：环节可标记受保护方（如质询中被质询方），该方接麦但计时器不启动；
- 所有指令经服务端 `engine.ts` 校验合法流转后才落地，非法指令直接拒绝——客户端 `debateStore` 纯镜像，不做任何本地状态推导。

### 落盘与崩溃恢复（SQLite）

服务端把比赛状态、评委与评分落盘到 `server/data/debate.db`（Node 内置 `node:sqlite`，无 native 依赖，因此不存在 node-gyp / prebuild 的构建风险）。

- **单一写入出口**：engine 的 `changed()` 同时触发广播与落盘，二者不可能不同步；比赛 `running` 时看门狗另有 **1s 心跳**，把“崩溃瞬间的剩余时间”精度锚定在心跳窗口内。
- **冻结落盘**：写入时若计时器正在跑，落盘的是**当前剩余量**而不是目标结束点（`freezeTimers`），因为崩溃时刻无法预知，只能靠心跳逼近。
- **恢复策略**：重启后自动恢复活跃场次；若中断时正在计时，一律**冻结为 paused 待主席确认**——停机时长不计入比赛时间（误差 ≤ 1s），主席点「恢复」即从冻结值重新生成 `targetEndTime`。
- **换场归档**：`reset` 生成新 matchId，旧场只写 `ended_at` 归档、评分全部留档；启动时只认 `ended_at IS NULL` 的活跃场次。
- **评委身份**：评委端把 judgeId 存 localStorage，刷新或断线后走 `judge:resume` 续期（服务端重启也不丢已交评分），并回填本人已提交的分数；比赛重置后旧 judgeId 自动失效并回到入场页。
- **预警不重播**：已触发的预警阈值随行落盘，重启后不会重复响铃。

### 成绩统计与公布

**口径**（实现在 [scoring.ts](shared/src/scoring.ts)，引擎与赛后导出共用同一份，避免两套算法算出差值）：

```
weighted(side) = Σ_环节( avg_该环节该方所有评委分数 × 环节权重 )
```

- 只统计至少有一份评分的环节；**未评分环节不计入，也不按 0 分惩罚**；
- 加权总分相等视为平局（`winner: null`）；
- **未公布时 `GameState.published` 恒为 null**——快照里连分数数字都不存在，这是“分数内容不外泄”的硬约束，有端到端用例守着；
- 主席点「公布比分」后，快照才带上汇总，且**永远不含单个评委分数**；
- 主席端另有 `score:preview`：结果**只回传给发起请求的那一个 socket**，用于赛中监控。注意系统目前没有鉴权，这条通道的意义是“不主动泄露”，而不是“无法被请求”。

### 大屏音效与预警动效

- **提示音由 WebAudio 实时合成**（[cues.ts](shared/src/cues.ts) 定义音色，客户端 [useStageAudio.ts](client/src/composables/useStageAudio.ts) 发声），不依赖任何音频文件：离线可用、零体积、无版权问题；音色取自环节的 `StageConfig.soundId`（`bell` / `electronic` / `chime`，未知值回退 `bell`）；
- **必须交互解锁**：浏览器 Autoplay 策略禁止无手势播放，因此大屏进入时有一层「点击进入大屏」遮罩，点击才创建/恢复 `AudioContext`；未解锁时 `play()` 静默跳过、**绝不硬播**；
- **预警动效**用 GSAP：`timer:warn` 到达时对触发方做一次缩放脉冲，只闪对应一方而非整屏抖动；
- 页面切后台会被浏览器挂起 `AudioContext`，回前台自动 `resume()`；右上角有静音开关。

### 赛后查询与导出

服务端提供三个只读接口（数据全部来自 SQLite，含已归档场次）：

| 接口 | 说明 |
|---|---|
| `GET /api/matches` | 场次列表（含归档），带评委数 / 评分数 / 归档时间 |
| `GET /api/matches/:matchId` | 单场明细：配置、环节、**汇总 + 分环节平均**、评委名单（不含单个评委分数） |
| `GET /api/matches/:matchId/export.csv` | 官方记录导出，**含单个评委分数**，带 UTF-8 BOM 便于 Excel 直接打开 |
| `GET/POST /api/templates` | 自定义赛制模板列表 / 新建 |
| `PUT/DELETE /api/templates/:id` | 更新 / 删除模板 |

> `reset` 会归档上一场（写 `ended_at`）并开新场；服务端启动时创建的场次若未被使用就被 reset，同样会留在历史列表里。

> 导出接口属于组织方工具：它与实时广播的“分数不外泄”约束不冲突，但**系统目前没有鉴权**，公网部署必须配合反代限制，或等 `ADMIN_PIN` 落地。

### 赛制编辑器（环节编排 + 比赛信息 + 模板库）

主席在开赛前可以完全自定义赛制，无需改代码：

- **环节编排**：Arco Table 列表 + Sortable 拖拽排序（也可用上移/下移按钮），配 Arco Drawer + Form 编辑单个环节的名称、类型、归属方、保护方、时长、计时方式、权重、预警阈值、音色、说明；音色可当场「试听」（按钮点击本身即用户手势，正好用来解锁 AudioContext）。
- **比赛信息**：辩题、比赛名称、双方队名/称谓/主色、评分刻度。
- **模板库**：把当前环节序列「另存为模板」存进 SQLite，下场直接载入复用；内置模板仍来自代码。
- **编辑边界**：仅 `idle` / `configured` 可编辑，开赛后赛制冻结（按钮禁用 + 服务端拒绝）。

两条关键实现约束：

1. **草稿与比赛状态分离**：编辑器持有的是**表单草稿**，点「保存赛制」才通过 `setStages` 交给服务端校验并广播回来——比赛状态始终只存在于 Pinia 的 `debateStore`（规范三.2）。
2. **编辑既有环节必须保留 id**：评分按 `stageId` 关联，若换 id 分数就会与环节脱钩。服务端只对**新增**环节分配新 id；删除环节后其评分自动不再计入总分（汇总只统计仍在赛制内的环节）。

另外，`setConfig` 走**白名单**：只放行辩题/队名/称谓/主色/评分刻度/比分可见性，`matchId`（决定落盘与恢复）与 `entryCode`（评委准入凭证）**不可被配置指令改动**。

### Socket 事件契约

| 方向 | 事件 | 说明 |
|---|---|---|
| C→S | `match:command` | 主席指令统一封装（loadTemplate / setConfig / setStages / start / pause / resume / nextStage / switchSpeaker / publishScores / finish / reset） |
| C→S | `judge:join` | 入场码加入（6 位数字，无账号体系） |
| C→S | `judge:resume` | 评委会话续期（刷新/重连后凭 judgeId 找回身份与本人评分） |
| C→S | `score:submit` | 评分提交（upsert，以最后一次为准） |
| C→S | `score:preview` | 主席端成绩预览（结果只回传请求者，不进广播） |
| C→S | `time:sync` | 时钟往返测量（原样回带 clientTime，客户端据此算 RTT 与偏移） |
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
| `pnpm test` | 状态机 + 落盘 + 时钟 + 总分 + 环节校验 + 模板 + 音色 + CSV vitest（99 用例） |
| `pnpm typecheck` | 全仓 TypeScript 检查（server tsc + client vue-tsc） |
| `node scripts/smoke.mjs` | 三端联动冒烟（20 断言） |

## 已实现 / 规划中

**已实现（最小闭环）**：三端界面壳、赛制模板载入、环节推进、倒计时/正计时、自由辩交替计时、保护时间、暂停/恢复、倒计时预警阈值、评委入场码、分环节双方打分与进度广播、比分公布开关、比赛重置、SQLite 落盘与崩溃恢复（中断后冻结待主席确认）、评委身份续期、时钟往返校时（最小 RTT）与单调时钟基准 + NTP 校时、加权总分与胜负判定、大屏提示音与 GSAP 预警动效、历史场次查询与赛后 CSV 导出、赛制编辑器（环节拖拽编排 / 比赛信息配置 / 模板库落库）。

**规划中**：历史场次查询的可视化页面（接口已就绪）、队徽/背景图上传、评委扫码入场、公网部署（ADMIN_PIN / 反代）。
