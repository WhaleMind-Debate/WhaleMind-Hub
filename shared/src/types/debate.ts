/**
 * 辩论赛全流程系统 — 共享类型契约（单一事实源）
 *
 * 约束：
 * 1. 所有 Socket / HTTP Payload 一律复用本文件的接口，前后端不得私自定义重复结构。
 * 2. 权威时间只体现在 targetEndTime（目标结束时间戳，服务端墙钟），
 *    任何端都不得存储“剩余秒数累加值”；
 *    各端必须用 targetEndTime - (Date.now() + clockOffset) 反推剩余时间——
 *    裸用 Date.now() 会让系统时钟不准的设备整体错位，
 *    clockOffset 由 time:sync 往返测量、取最小 RTT 样本得出（见 clock.ts）。
 * 3. 状态机单向流转：GameStatus 只允许 idle → configured → running ⇄ paused → finished，
 *    环节索引只增不减。
 */

// ========================= 基础枚举 =========================

/** 比赛全局状态 */
export type GameStatus = 'idle' | 'configured' | 'running' | 'paused' | 'finished';

/** 环节计时类型：
 * - single：单向计时，仅针对归属方（如正方一辩立论）
 * - dual_alternating：自由辩双向交替计时，同一时刻仅一方消耗时间
 */
export type StageType = 'single' | 'dual_alternating';

/** 计时方式：
 * - countdown：倒计时，归零自动结束环节
 * - countUp：正计时，不自动结束，由主席手动推进
 */
export type TimerKind = 'countdown' | 'countUp';

/** 辩方（正/反） */
export type Side = 'aff' | 'neg';

/** 计时器个体状态 */
export type TimerStatus = 'idle' | 'running' | 'paused' | 'expired';

// ========================= 时间 =========================

/**
 * 计时器状态（权威时间模型）
 * - remainingMs：仅在 paused / idle / expired 时有意义（固化值）；
 *   running 时必须用 targetEndTime - now 重算，不得读取该字段。
 * - targetEndTime：仅在 running 时有意义，为服务端墙钟毫秒时间戳。
 */
export interface TimerState {
  status: TimerStatus;
  /** 本计时器的总时长（毫秒），countUp 模式下为显示上限参考 */
  totalMs: number;
  /**
   * 固化值（paused/idle/expired 时有效），语义随 timerKind 而异：
   * - countdown：剩余毫秒；
   * - countUp：**已耗毫秒**——正计时没有“剩余”概念，暂停/恢复靠它续上，
   *   因此运行中读它也拿不到实时值，必须用 startedAt 反推。
   */
  remainingMs: number;
  /** 目标结束时间戳（running 时有效，服务端墙钟），countUp 模式为 null */
  targetEndTime: number | null;
  /** countUp 模式：开始累加的时刻（服务端墙钟） */
  startedAt: number | null;
}

// ========================= 环节配置 =========================

/**
 * 单个环节配置（StageConfig）
 * warnThresholds / protectedSide / weight / soundId 等字段今晚先定义，
 * 界面编辑器在后续迭代接入，但类型一次到位。
 */
export interface StageConfig {
  id: string;
  /** 显示序号（1 开始） */
  order: number;
  /** 环节名称，如“正方一辩立论” */
  name: string;
  type: StageType;
  timerKind: TimerKind;
  /** 归属方：single 环节的计时方；dual_alternating 环节为 null（双方各有计时器） */
  side: Side | null;
  /**
   * 保护时间：受保护方计时器锁定不消耗（如质询中被质询方）。
   * dual_alternating 环节下：切换到受保护方时其计时器不启动（发言不计时）；
   * single 环节忽略（归属方单独计时，天然保护对方）。
   */
  protectedSide: Side | null;
  /** 环节时长（毫秒） */
  durationMs: number;
  /** 倒计时预警阈值（剩余秒数），如 [30, 10] */
  warnThresholds: number[];
  /** 环节权重（加权总分判胜负用） */
  weight: number;
  /** 提示音 ID（内置音效表，如 'bell' | 'electronic' | 'chime'） */
  soundId: string | null;
  /** 环节说明文字（大屏展示用） */
  description: string | null;
}

/**
 * 环节编辑输入（setStages 与自定义模板共用）
 *
 * 与 StageConfig 的两点差异：
 * - 没有 order：顺序由数组下标决定，服务端按位置重排；
 * - id 可缺省：缺省表示新增环节（服务端分配新 id），
 *   带 id 表示编辑既有环节——**必须保留原 id**，否则已提交的评分会与环节脱钩。
 */
export interface StageInput {
  id?: string;
  name: string;
  type: StageType;
  timerKind: TimerKind;
  side: Side | null;
  protectedSide: Side | null;
  durationMs: number;
  warnThresholds: number[];
  weight: number;
  soundId: string | null;
  description: string | null;
}

/** 自定义赛制模板（存 SQLite，可跨场次复用） */
export interface SavedTemplate {
  id: string;
  name: string;
  description: string;
  /** 模板内的环节（无 id，载入时由服务端分配） */
  stages: StageInput[];
  createdAt: number;
  updatedAt: number;
}

/** 内置赛制模板 */
export interface StageTemplate {
  id: string;
  name: string;
  description: string;
  stages: Omit<StageConfig, 'id'>[];
}

// ========================= 比赛与角色 =========================

/** 双方展示配置 */
export interface SideDisplay {
  /** 队名，如“正方：北京大学” */
  teamName: string;
  /** 称谓自定义，如“辩手” / “控方” / “原告” */
  title: string;
  /** 主色（CSS 颜色值） */
  color: string;
  /** 队徽 URL（assets 上传后填入，可空） */
  logoUrl: string | null;
}

/** 评分刻度（每场可配置） */
export interface ScoreScale {
  min: number;
  max: number;
  step: number;
}

/** 比赛配置（整场元数据） */
export interface MatchConfig {
  matchId: string;
  /** 比赛名称 */
  name: string;
  /** 辩题（大屏展示） */
  topic: string;
  aff: SideDisplay;
  neg: SideDisplay;
  scoreScale: ScoreScale;
  /** 大屏比分可见性：主席控制公布 */
  scoreVisibility: 'hidden' | 'published';
  /** 评委入场码（6 位数字） */
  entryCode: string;
}

/** 评委 */
export interface Judge {
  id: string;
  matchId: string;
  name: string;
}

/** 单条评分（judge × stage × side 唯一，可反复修改，以最后一次为准） */
export interface Score {
  judgeId: string;
  stageId: string;
  side: Side;
  value: number;
  updatedAt: number;
}

/** 单方成绩汇总 */
export interface SideTotals {
  /** 加权总分 = Σ(环节平均分 × 环节权重) */
  weighted: number;
  /** 已计入评分的环节数（未评分的环节不计入，也不惩罚） */
  scoredStages: number;
}

/**
 * 成绩汇总（对外可见的那部分）。
 *
 * 关键约束：**绝不包含单个评委的分数**。
 * 口径为「每环节先对所有评委取平均，再乘环节权重求和」；
 * 未公布时 `GameState.published` 为 null，分数内容不会随广播外泄。
 */
export interface PublishedScores {
  aff: SideTotals;
  neg: SideTotals;
  /** 参与打分的评委数 */
  judgeCount: number;
  /** 当前胜方；平局或数据不足时为 null */
  winner: Side | null;
  /** 判胜依据，便于将来替换算法而不改协议 */
  basis: 'weighted';
}

/** 整场比赛的完整状态快照（服务端 → 客户端 game:state 的 body） */
export interface GameState {
  config: MatchConfig;
  status: GameStatus;
  stages: StageConfig[];
  /** 当前环节索引（-1 表示尚未开始） */
  currentStageIndex: number;
  /**
   * 计时器字典：
   * - single 环节：key 为归属方，仅一个计时器
   * - dual_alternating 环节：aff / neg 各一个，同一时刻至多一个 running
   */
  timers: Partial<Record<Side, TimerState>>;
  /** dual_alternating 当前发言方（active 且消耗时间的一方） */
  activeSpeaker: Side | null;
  /** 已提交评分的 judgeId 集合（进度监控用，不含分数内容） */
  scoreProgress: string[];
  /**
   * 已公布的成绩汇总。仅当 config.scoreVisibility === 'published' 时才有值；
   * 未公布一律为 null——这是“分数内容不外泄”的硬约束。
   */
  published: PublishedScores | null;
  /** 服务端墙钟（每次广播附带，客户端据此校正时钟偏移） */
  serverTime: number;
}

// ========================= Socket 事件契约 =========================

/**
 * C→S：所有主席指令统一入口。
 * 服务端 engine 校验合法流转后才落地并广播，非法指令回执 { ok:false, error }。
 */
export type MatchCommand =
  | { type: 'loadTemplate'; templateId: string }
  | { type: 'setConfig'; config: Partial<MatchConfig> }
  /** 整段替换环节序列（仅 idle / configured 可用，开赛后赛制冻结） */
  | { type: 'setStages'; stages: StageInput[] }
  | { type: 'start' }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'nextStage' }
  | { type: 'switchSpeaker' }
  | { type: 'publishScores' }
  | { type: 'finish' }
  /** 重置为全新比赛（新开 matchId/入场码，回到 idle），任意状态可用 */
  | { type: 'reset' };

export interface MatchCommandPayload {
  command: MatchCommand;
  serverTime?: number;
}

export interface CommandResult {
  ok: boolean;
  error?: string;
}

/** S→C：全量状态快照（新连接 / 重连时下发） */
export interface GameStatePayload extends GameState {}

/** S→C：增量补丁（简版——今晚直接广播全量，patch 留作后续优化） */
export interface GamePatchPayload {
  state: GameState;
}

/** S→C：计时预警（剩余秒数到达阈值） */
export interface TimerWarnPayload {
  side: Side;
  /** 触发的阈值（剩余秒数） */
  thresholdSec: number;
  serverTime: number;
}

/** C→S：评委加入 */
export interface JudgeJoinPayload {
  entryCode: string;
  name: string;
}

/** C→S：评委会话续期（页面刷新 / 断线重连后凭 judgeId 找回身份） */
export interface JudgeResumePayload {
  judgeId: string;
}

/**
 * 评委入场与续期的统一回执。
 * myScores 只回传给该评委本人（刷新后回填自己已提交的分数），
 * 绝不出现在任何广播里——分数内容对其它端始终不可见。
 */
export interface JudgeSessionResult {
  ok: boolean;
  error?: string;
  judge?: Judge;
  /** 加入/续期成功后一并回传当前比赛状态 */
  state?: GameState;
  /** 该评委本人已提交的评分 */
  myScores?: Score[];
}

export type JudgeJoinResult = JudgeSessionResult;
export type JudgeResumeResult = JudgeSessionResult;

/** C→S：评分提交（upsert） */
export interface ScoreSubmitPayload {
  judgeId: string;
  stageId: string;
  side: Side;
  value: number;
}

/**
 * C→S：请求成绩预览（主席端监控用）。
 * 结果只回传给发起请求的那一个 socket，绝不进入广播——同样不含单个评委分数。
 */
export interface ScorePreviewResult {
  ok: boolean;
  error?: string;
  scores?: PublishedScores;
}

/** S→C：打分进度（仅 judgeId 列表，不含分数内容） */
export interface ScoreProgressPayload {
  scoreProgress: string[];
  serverTime: number;
}

/**
 * C→S：时钟同步请求。
 * 客户端带上自己的发送时刻，服务端原样回带，客户端据此计算往返时延与偏移：
 * offset = serverTime - (t0 + t1) / 2，并优先采信 RTT 最小的样本。
 */
export interface TimeSyncPayload {
  clientTime: number;
}

/** S→C：时钟同步回执 */
export interface TimeSyncResult {
  clientTime: number;
  serverTime: number;
}

/** Socket 事件名常量（前后端共用，避免字符串漂移） */
export const SOCKET_EVENTS = {
  /** C→S */
  MATCH_COMMAND: 'match:command',
  JUDGE_JOIN: 'judge:join',
  JUDGE_RESUME: 'judge:resume',
  SCORE_SUBMIT: 'score:submit',
  SCORE_PREVIEW: 'score:preview',
  TIME_SYNC: 'time:sync',
  /** S→C */
  GAME_STATE: 'game:state',
  GAME_PATCH: 'game:patch',
  TIMER_WARN: 'timer:warn',
  SCORE_PROGRESS: 'score:progress',
  COMMAND_RESULT: 'command:result',
} as const;
