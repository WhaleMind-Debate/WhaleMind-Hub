/**
 * 比赛状态机引擎（服务端唯一状态权威）
 *
 * 不变量：
 * 1. GameStatus 单向流转：idle → configured → running ⇄ paused → finished；
 * 2. 环节索引只增不减（nextStage / 归零自动推进均只向前）；
 * 3. 计时的剩余时间一律由 timer 模块从 targetEndTime 反推，引擎不维护倒数数字；
 * 4. 所有命令经本引擎校验合法流转后才落地，非法命令返回错误、状态不变；
 * 5. 状态变更统一经 changed() 出口——广播与落盘共用同一触发点，
 *    不存在“只广播不落盘”或“只落盘不广播”的分支。
 */
import type {
  CommandResult,
  GameStatus,
  GameState,
  Judge,
  MatchCommand,
  MatchConfig,
  PublishedScores,
  Score,
  Side,
  StageConfig,
  TimerState,
} from '@debate/shared';
import { aggregateScores, findTemplate, validateConfigPatch, validateStages } from '@debate/shared';
import { createTimer, expireTimer, isDue, pauseTimer, remainingOf, startTimer } from './timer.js';

export type EngineEvent =
  | { type: 'stateChanged' }
  | { type: 'warn'; side: Side; thresholdSec: number }
  | { type: 'judgeJoined'; judge: Judge }
  | { type: 'scoreSubmitted'; score: Score; matchId: string };

/** 落盘载荷：线协议状态快照 + 不进入线协议的内部量 */
export interface EnginePersistPayload {
  state: GameState;
  /** 已触发的预警键（`stageIndex:side:threshold`），恢复后据此避免重复播报 */
  firedWarns: string[];
}

/** 从库中恢复一场比赛所需的全部数据 */
export interface EngineRestoreData {
  config: MatchConfig;
  status: GameStatus;
  stages: StageConfig[];
  currentStageIndex: number;
  timers: Partial<Record<Side, TimerState>>;
  activeSpeaker: Side | null;
  firedWarns: string[];
  judges: Judge[];
  scores: Score[];
}

interface EngineState {
  config: MatchConfig;
  status: GameStatus;
  stages: StageConfig[];
  currentStageIndex: number;
  timers: Partial<Record<Side, TimerState>>;
  activeSpeaker: Side | null;
  scoreProgress: string[];
}

const OTHER: Record<Side, Side> = { aff: 'neg', neg: 'aff' };
const SIDES: Side[] = ['aff', 'neg'];

export class GameEngine {
  private state: EngineState;
  private scores = new Map<string, Score>();
  private judges = new Map<string, Judge>();
  /** 已触发的预警：`${stageIndex}:${side}:${threshold}`，防止重复播报 */
  private firedWarns = new Set<string>();
  private onEvent: (e: EngineEvent) => void;
  private onPersist: (payload: EnginePersistPayload) => void;
  private now: () => number;
  private seq = 0;

  constructor(
    opts: {
      now?: () => number;
      onEvent?: (e: EngineEvent) => void;
      /** 落盘钩子：每次状态变更时调用，engine 是唯一写入触发点 */
      onPersist?: (payload: EnginePersistPayload) => void;
      /** 启动恢复：从库中读出的比赛（running 会被降级为 paused） */
      restore?: EngineRestoreData;
    } = {},
  ) {
    this.now = opts.now ?? (() => Date.now());
    this.onEvent = opts.onEvent ?? (() => {});
    this.onPersist = opts.onPersist ?? (() => {});
    this.state = {
      config: {
        matchId: `m-${this.nextId()}`,
        name: '辩论赛',
        topic: '辩题待定',
        aff: { teamName: '正方', title: '辩手', color: '#e5484d', logoUrl: null },
        neg: { teamName: '反方', title: '辩手', color: '#3b82f6', logoUrl: null },
        scoreScale: { min: 0, max: 100, step: 1 },
        scoreVisibility: 'hidden',
        entryCode: String(Math.floor(100000 + Math.random() * 900000)),
      },
      status: 'idle',
      stages: [],
      currentStageIndex: -1,
      timers: {},
      activeSpeaker: null,
      scoreProgress: [],
    };
    if (opts.restore) this.hydrate(opts.restore);
  }

  // ==================== 对外快照 ====================

  snapshot(): GameState {
    return {
      config: this.state.config,
      status: this.state.status,
      stages: this.state.stages,
      currentStageIndex: this.state.currentStageIndex,
      timers: { ...this.state.timers },
      activeSpeaker: this.state.activeSpeaker,
      scoreProgress: [...this.state.scoreProgress],
      // 未公布时恒为 null：分数内容绝不随广播外泄
      published: this.publishedScores(),
      serverTime: this.now(),
    };
  }

  // ==================== 落盘与恢复 ====================

  /** 落盘载荷：与广播给客户端的快照同源，外加不进入线协议的内部量 */
  persistPayload(): EnginePersistPayload {
    return { state: this.snapshot(), firedWarns: [...this.firedWarns] };
  }

  /** 立即落盘一次（启动时用，确保持久层里存在活跃场次行） */
  persistNow(): void {
    this.onPersist(this.persistPayload());
  }

  /**
   * 用库中数据恢复比赛。
   *
   * 关键策略：落盘时状态为 running 的场次，恢复后一律冻结为 paused——
   * 服务端中断期间墙钟照走，但比赛时间不该被停机吃掉，
   * 剩余量取“最后一次落盘”的固化值（误差 ≤ 心跳窗口），由主席确认后再「恢复」。
   */
  private hydrate(data: EngineRestoreData): void {
    this.state = {
      config: data.config,
      status: data.status === 'running' ? 'paused' : data.status,
      stages: data.stages,
      currentStageIndex: data.currentStageIndex,
      timers: { ...data.timers },
      activeSpeaker: data.activeSpeaker,
      scoreProgress: [],
    };
    this.firedWarns = new Set(data.firedWarns);
    this.judges.clear();
    this.scores.clear();
    for (const judge of data.judges) this.judges.set(judge.id, judge);
    for (const score of data.scores) {
      this.scores.set(`${score.judgeId}:${score.stageId}:${score.side}`, score);
      // scoreProgress 是纯派生量：谁提交过评分从评分表反推即可，不必单独落盘
      if (!this.state.scoreProgress.includes(score.judgeId)) this.state.scoreProgress.push(score.judgeId);
    }
  }

  // ==================== 指令入口 ====================

  command(cmd: MatchCommand): CommandResult {
    // 运行期兜底：Socket 传来的 JSON 不受类型约束，非法指令必须返回失败而不是抛异常
    if (cmd == null || typeof (cmd as { type?: unknown }).type !== 'string') {
      return this.fail('非法指令：缺少 type');
    }
    switch (cmd.type) {
      case 'loadTemplate':
        return this.loadTemplate(cmd.templateId);
      case 'setConfig':
        return this.setConfig(cmd.config);
      case 'setStages':
        return this.setStages(cmd.stages);
      case 'start':
        return this.start();
      case 'pause':
        return this.pause();
      case 'resume':
        return this.resume();
      case 'nextStage':
        return this.nextStage();
      case 'switchSpeaker':
        return this.switchSpeaker();
      case 'publishScores':
        return this.publishScores();
      case 'finish':
        return this.finish();
      case 'reset':
        return this.reset();
      default:
        return this.fail(`未知指令：${String((cmd as { type: unknown }).type)}`);
    }
  }

  // ==================== 状态机实现 ====================

  /** 载入赛制模板：仅 idle / configured 可载入（开赛后环节序列冻结） */
  private loadTemplate(templateId: string): CommandResult {
    if (this.state.status !== 'idle' && this.state.status !== 'configured') {
      return this.fail('比赛已开始，无法更换赛制模板');
    }
    const tpl = findTemplate(templateId);
    if (!tpl) return this.fail(`模板不存在：${templateId}`);
    this.state.stages = tpl.stages.map((s) => ({ ...s, id: `st-${this.nextId()}` }));
    this.state.currentStageIndex = -1;
    this.state.timers = {};
    this.state.activeSpeaker = null;
    this.state.status = 'configured';
    this.changed();
    return { ok: true };
  }

  /**
   * 整段替换环节序列：仅 idle / configured 可用（开赛后赛制冻结）。
   *
   * id 处理规则（关键）：带 id 且能在现有环节里找到的，**保留原 id**——
   * 已提交的评分按 stageId 关联，换 id 会让分数与环节脱钩；
   * 新增环节由服务端分配新 id；被删环节的评分自然失效
   * （aggregateScores 只统计仍在赛制内的环节）。
   */
  private setStages(input: unknown): CommandResult {
    if (this.state.status !== 'idle' && this.state.status !== 'configured') {
      return this.fail('比赛已开始，无法修改赛制环节');
    }
    const validated = validateStages(input);
    if (!validated.ok) return this.fail(validated.error);

    const existing = new Set(this.state.stages.map((s) => s.id));
    this.state.stages = validated.stages.map((stage, index) => ({
      ...stage,
      id: stage.id && existing.has(stage.id) ? stage.id : `st-${this.nextId()}`,
      order: index + 1,
    }));
    this.state.status = 'configured';
    this.state.currentStageIndex = -1;
    this.state.timers = {};
    this.state.activeSpeaker = null;
    this.changed();
    return { ok: true };
  }

  /**
   * 修改比赛配置：仅 idle / configured 可用。
   *
   * 必须走白名单校验：matchId / entryCode 不在白名单内——
   * 前者决定落盘行与恢复，后者是评委准入凭证，都不该被一条配置指令改掉。
   */
  private setConfig(input: unknown): CommandResult {
    if (this.state.status !== 'idle' && this.state.status !== 'configured') {
      return this.fail('比赛已开始，无法修改比赛配置');
    }
    const validated = validateConfigPatch(input);
    if (!validated.ok) return this.fail(validated.error);
    const patch = validated.patch;

    this.state.config = {
      ...this.state.config,
      ...patch,
      aff: { ...this.state.config.aff, ...patch.aff },
      neg: { ...this.state.config.neg, ...patch.neg },
      scoreScale: { ...this.state.config.scoreScale, ...patch.scoreScale },
    } as MatchConfig;
    this.changed();
    return { ok: true };
  }

  /**
   * 开始计时：
   * - configured：进入 running 并启动第 1 个环节；
   * - running 且当前环节计时器未启动（归零自动推进后）：启动当前环节。
   */
  private start(): CommandResult {
    if (this.state.status === 'configured') {
      if (this.state.stages.length === 0) return this.fail('赛制环节为空，请先载入模板或添加环节');
      this.state.status = 'running';
      this.state.currentStageIndex = 0;
      this.setupStage(this.state.stages[0]);
      this.startCurrentStage();
      this.changed();
      return { ok: true };
    }
    if (this.state.status === 'running') {
      const stage = this.currentStage();
      if (!stage) return this.fail('没有进行中的环节');
      if (this.anyTimerRunning()) return this.fail('计时已在进行中');
      this.startCurrentStage();
      this.changed();
      return { ok: true };
    }
    return this.fail(`当前状态（${this.state.status}）不能开始计时`);
  }

  /** 暂停：固化所有进行中的计时器 */
  private pause(): CommandResult {
    if (this.state.status !== 'running') return this.fail('仅比赛进行中可暂停');
    if (!this.anyTimerRunning()) return this.fail('当前没有进行中的计时');
    const now = this.now();
    for (const side of SIDES) {
      const t = this.state.timers[side];
      if (t && t.status === 'running') this.state.timers[side] = pauseTimer(t, now);
    }
    this.state.status = 'paused';
    this.changed();
    return { ok: true };
  }

  /** 恢复：以固化剩余时间重新生成目标结束点 */
  private resume(): CommandResult {
    if (this.state.status !== 'paused') return this.fail('仅暂停状态可恢复');
    const now = this.now();
    const stage = this.currentStage();
    if (!stage) return this.fail('没有进行中的环节');
    for (const side of SIDES) {
      const t = this.state.timers[side];
      if (t && t.status === 'paused') {
        this.state.timers[side] = startTimer(t, now, stage.timerKind);
      }
    }
    this.state.status = 'running';
    this.changed();
    return { ok: true };
  }

  /** 推进到下一环节并立即启动其计时（单向流转，不允许回退） */
  private nextStage(): CommandResult {
    if (this.state.status !== 'running') return this.fail('仅比赛进行中可切换环节');
    const next = this.state.currentStageIndex + 1;
    if (next >= this.state.stages.length) return this.fail('已是最后一个环节');
    this.state.currentStageIndex = next;
    this.setupStage(this.state.stages[next]);
    this.startCurrentStage();
    this.changed();
    return { ok: true };
  }

  /**
   * 切换发言方（仅 dual_alternating 环节）：
   * 上一方暂停、下一方立即启动；受保护方只接麦不计时。
   */
  private switchSpeaker(): CommandResult {
    if (this.state.status !== 'running') return this.fail('仅比赛进行中可切换发言方');
    const stage = this.currentStage();
    if (!stage || stage.type !== 'dual_alternating') return this.fail('当前环节不是自由辩论类环节');
    const now = this.now();

    let next: Side;
    if (this.state.activeSpeaker == null) {
      next = this.firstSpeaker(stage);
    } else {
      next = OTHER[this.state.activeSpeaker];
    }

    const nextTimer = this.state.timers[next];
    const protectedSide = stage.protectedSide;
    if (next !== protectedSide && nextTimer && nextTimer.status === 'expired') {
      return this.fail(`${sideLabel(next)}时间已用尽，无法获得发言权`);
    }

    // 上一方暂停（若在跑）
    const cur = this.state.activeSpeaker;
    if (cur != null) {
      const t = this.state.timers[cur];
      if (t && t.status === 'running') this.state.timers[cur] = pauseTimer(t, now);
    }

    this.state.activeSpeaker = next;
    // 受保护方：接麦但计时器不启动（发言不消耗时间）
    if (next !== protectedSide && nextTimer) {
      this.state.timers[next] = startTimer(nextTimer, now, stage.timerKind);
    }
    this.changed();
    return { ok: true };
  }

  /** 公布比分（主席控制大屏分数可见性） */
  private publishScores(): CommandResult {
    if (this.state.status === 'idle') return this.fail('比赛尚未配置');
    this.state.config.scoreVisibility = 'published';
    this.changed();
    return { ok: true };
  }

  /** 结束比赛（终态） */
  private finish(): CommandResult {
    if (this.state.status === 'idle' || this.state.status === 'finished') {
      return this.fail(`当前状态（${this.state.status}）不能结束比赛`);
    }
    const now = this.now();
    for (const side of SIDES) {
      const t = this.state.timers[side];
      if (t && t.status === 'running') this.state.timers[side] = pauseTimer(t, now);
    }
    this.state.status = 'finished';
    this.changed();
    return { ok: true };
  }

  /**
   * 重置为全新比赛：任意状态可用。
   * 新 matchId / 新入场码，环节、计时、评委与评分全部清空，回到 idle。
   * 这是唯一允许“回退”的入口——因为它开的是一场新比赛，不是状态机倒流。
   */
  private reset(): CommandResult {
    this.state.config = {
      ...this.state.config,
      matchId: `m-${this.nextId()}`,
      entryCode: String(Math.floor(100000 + Math.random() * 900000)),
      scoreVisibility: 'hidden',
    };
    this.state.status = 'idle';
    this.state.stages = [];
    this.state.currentStageIndex = -1;
    this.state.timers = {};
    this.state.activeSpeaker = null;
    this.state.scoreProgress = [];
    this.scores.clear();
    this.judges.clear();
    this.firedWarns.clear();
    this.changed();
    return { ok: true };
  }

  // ==================== 评委与评分（预留最小实现） ====================

  joinJudge(name: string, entryCode: string): { ok: boolean; error?: string; judge?: Judge } {
    if (entryCode !== this.state.config.entryCode) return { ok: false, error: '入场码错误' };
    if (!name.trim()) return { ok: false, error: '请填写姓名' };
    const judge: Judge = { id: `j-${this.nextId()}`, matchId: this.state.config.matchId, name: name.trim() };
    this.judges.set(judge.id, judge);
    // 评委入场不广播状态（其余端无需感知），但必须落盘——判分行依赖它的外键
    this.onEvent({ type: 'judgeJoined', judge });
    return { ok: true, judge };
  }

  /**
   * 评委续期：页面刷新 / 断线重连后凭 judgeId 找回自己的会话。
   * 仅当该评委属于当前活跃场次时有效——reset 之后旧 judgeId 一律失效。
   */
  resumeJudge(judgeId: string): { ok: boolean; error?: string; judge?: Judge; scores?: Score[] } {
    const judge = this.judges.get(judgeId);
    if (!judge) return { ok: false, error: '评委会话不存在，请重新入场' };
    if (judge.matchId !== this.state.config.matchId) return { ok: false, error: '比赛已重置，请重新入场' };
    return { ok: true, judge, scores: this.scoresOf(judgeId) };
  }

  /** 某评委已提交的全部评分（只回传给本人，绝不下发给其他端） */
  scoresOf(judgeId: string): Score[] {
    return [...this.scores.values()].filter((s) => s.judgeId === judgeId);
  }

  // ==================== 总分与胜负 ====================

  /**
   * 计算当前成绩汇总（与是否公布无关，供内部与主席端预览使用）。
   *
   * 口径：每个环节先对**所有评委**取平均，再乘该环节权重求和：
   *   weighted(side) = Σ_环节( avg_评委(分数) × 环节权重 )
   * - 只统计至少有一份评分的环节；未评分环节不计入，也不按 0 分惩罚；
   * - 返回的永远是汇总值，不含任何单个评委的分数。
   */
  computeTotals(): PublishedScores {
    // 口径实现在 shared/src/scoring.ts：引擎与赛后导出共用同一份，避免算出差值
    return aggregateScores(this.state.stages, [...this.scores.values()]);
  }

  /** 对外暴露的成绩：仅主席公布后才随快照下发 */
  publishedScores(): PublishedScores | null {
    return this.state.config.scoreVisibility === 'published' ? this.computeTotals() : null;
  }

  submitScore(judgeId: string, stageId: string, side: Side, value: number): CommandResult {
    const judge = this.judges.get(judgeId);
    if (!judge) return this.fail('评委不存在');
    const stage = this.state.stages.find((s) => s.id === stageId);
    if (!stage) return this.fail('环节不存在');
    const { min, max } = this.state.config.scoreScale;
    if (typeof value !== 'number' || Number.isNaN(value) || value < min || value > max) {
      return this.fail(`分数需在 ${min}~${max} 之间`);
    }
    const key = `${judgeId}:${stageId}:${side}`;
    const score: Score = { judgeId, stageId, side, value, updatedAt: this.now() };
    this.scores.set(key, score);
    if (!this.state.scoreProgress.includes(judgeId)) {
      this.state.scoreProgress.push(judgeId);
    }
    this.onEvent({ type: 'scoreSubmitted', score, matchId: this.state.config.matchId });
    this.changed();
    return { ok: true };
  }

  // ==================== 看门狗 tick ====================

  /**
   * 由服务端定时调用（如每 200ms）：
   * 预警判定 → 到期固化 → 环节完成自动推进。
   * 全部以 targetEndTime 反推，非累加。
   */
  tick(now: number = this.now()): void {
    if (this.state.status !== 'running') return;
    const stage = this.currentStage();
    if (!stage) return;

    let dirty = false;
    // 预警会改变 firedWarns（内部量）：需要落盘，但不改变广播语义（不额外广播 game:state）
    let warnsChanged = false;

    // 1. 预警 + 到期
    for (const side of SIDES) {
      const t = this.state.timers[side];
      if (!t || t.status !== 'running') continue;

      if (stage.timerKind === 'countdown') {
        const remainMs = remainingOf(t, now);
        for (const threshold of stage.warnThresholds) {
          const key = `${this.state.currentStageIndex}:${side}:${threshold}`;
          if (remainMs <= threshold * 1000 && !this.firedWarns.has(key)) {
            this.firedWarns.add(key);
            warnsChanged = true;
            this.onEvent({ type: 'warn', side, thresholdSec: threshold });
          }
        }
        if (isDue(t, now)) {
          this.state.timers[side] = expireTimer(t);
          dirty = true;
        }
      }
    }

    // 2. 环节完成判定
    if (this.isStageComplete(stage)) {
      if (this.state.activeSpeaker != null) {
        this.state.activeSpeaker = null;
        dirty = true;
      }
      const next = this.state.currentStageIndex + 1;
      if (next < this.state.stages.length) {
        // 归零自动推进：环节索引只增不减；新环节计时器就绪但不自动启动
        this.state.currentStageIndex = next;
        this.setupStage(this.state.stages[next]);
        dirty = true;
      }
      // 最后一个环节完成：保持现状，由主席执行 finish
    } else {
      // 3. dual_alternating：发言方用尽时间则自动把发言权交给对方
      const t = this.state.activeSpeaker != null ? this.state.timers[this.state.activeSpeaker] : null;
      if (stage.type === 'dual_alternating' && t && t.status === 'expired') {
        const other = OTHER[this.state.activeSpeaker!];
        const otherTimer = this.state.timers[other];
        if (otherTimer && otherTimer.status !== 'expired' && other !== stage.protectedSide) {
          this.state.activeSpeaker = other;
          this.state.timers[other] = startTimer(otherTimer, now, stage.timerKind);
          dirty = true;
        }
      }
    }

    if (dirty) {
      this.changed(); // 已含落盘
    } else if (warnsChanged) {
      // 只有预警状态变化：落盘但不广播（广播语义保持与原实现一致）
      this.persistNow();
    }
  }

  // ==================== 内部辅助 ====================

  private currentStage(): StageConfig | null {
    return this.state.stages[this.state.currentStageIndex] ?? null;
  }

  private anyTimerRunning(): boolean {
    return SIDES.some((s) => this.state.timers[s]?.status === 'running');
  }

  /** 按环节类型创建全新计时器 */
  private setupStage(stage: StageConfig): void {
    this.firedWarns.clear(); // 进入新环节重置预警
    this.state.activeSpeaker = null;
    if (stage.type === 'dual_alternating') {
      this.state.timers = {
        aff: createTimer(stage.durationMs, stage.timerKind),
        neg: createTimer(stage.durationMs, stage.timerKind),
      };
    } else {
      this.state.timers = { [stage.side!]: createTimer(stage.durationMs, stage.timerKind) };
    }
  }

  /** 启动当前环节计时：single 启动归属方；dual 启动首发言方（受保护方除外） */
  private startCurrentStage(): void {
    const stage = this.currentStage();
    if (!stage) return;
    const now = this.now();
    if (stage.type === 'dual_alternating') {
      const first = this.firstSpeaker(stage);
      this.state.activeSpeaker = first;
      const t = this.state.timers[first];
      if (t && first !== stage.protectedSide) {
        this.state.timers[first] = startTimer(t, now, stage.timerKind);
      }
    } else {
      const t = this.state.timers[stage.side!];
      if (t) this.state.timers[stage.side!] = startTimer(t, now, stage.timerKind);
    }
  }

  private firstSpeaker(stage: StageConfig): Side {
    return stage.protectedSide === 'aff' ? 'neg' : 'aff';
  }

  /** 环节是否完成：single=归属方到期；dual=所有非保护方到期 */
  private isStageComplete(stage: StageConfig): boolean {
    if (stage.type === 'dual_alternating') {
      const effective = SIDES.filter((s) => s !== stage.protectedSide);
      return effective.every((s) => this.state.timers[s]?.status === 'expired');
    }
    return this.state.timers[stage.side!]?.status === 'expired';
  }

  /** 状态变更唯一出口：广播与落盘共用，二者不可能不同步 */
  private changed(): void {
    this.onEvent({ type: 'stateChanged' });
    this.persistNow();
  }

  private fail(error: string): CommandResult {
    return { ok: false, error };
  }

  private nextId(): string {
    return `${Date.now().toString(36)}-${(this.seq++).toString(36)}`;
  }
}

function sideLabel(side: Side): string {
  return side === 'aff' ? '正方' : '反方';
}
