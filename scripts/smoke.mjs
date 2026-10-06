/**
 * 三端联动冒烟脚本（验收用，非业务代码）
 * 模拟：控制台指令 → 状态广播 → 自由辩切换发言方 → 暂停/恢复时间一致。
 * 运行：node scripts/smoke.mjs
 */
import { io } from 'socket.io-client';

const URL = 'http://localhost:3000';
const EVENTS = {
  MATCH_COMMAND: 'match:command',
  JUDGE_JOIN: 'judge:join',
  SCORE_SUBMIT: 'score:submit',
  GAME_STATE: 'game:state',
};

function connect(name) {
  const s = io(URL, { transports: ['websocket'] });
  s.on('connect', () => console.log(`[${name}] connected`));
  return s;
}

function command(s, cmd) {
  return new Promise((res) => s.emit(EVENTS.MATCH_COMMAND, { command: cmd }, res));
}

/** 竞态安全的状态等待：先查最新快照，再挂监听（广播先到也不丢） */
function waitState(s, getLatest, pred, label, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const tryResolve = (state) => {
      if (state && pred(state)) {
        cleanup();
        resolve(state);
        return true;
      }
      return false;
    };
    const handler = (state) => tryResolve(state);
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`等待超时: ${label}`));
    }, timeoutMs);
    function cleanup() {
      clearTimeout(timer);
      s.off(EVENTS.GAME_STATE, handler);
    }
    s.on(EVENTS.GAME_STATE, handler);
    tryResolve(getLatest());
  });
}

const results = [];
function check(label, ok) {
  results.push({ label, ok });
  console.log(`${ok ? '✅' : '❌'} ${label}`);
}

const admin = connect('admin');
const screen = connect('screen'); // 大屏只读镜像

let latest = null;
screen.on(EVENTS.GAME_STATE, (s) => (latest = s));
const getLatest = () => latest;

async function run(cmd, label) {
  const res = await command(admin, cmd);
  if (!res.ok) console.log(`   ⚠ 指令失败 [${label}]: ${res.error}`);
  return res;
}

await new Promise((r) => admin.on('connect', r));

// 0. 重置为全新比赛（隔离上一轮脏状态）
await run({ type: 'reset' }, '重置');

// 1. 载入快速测试模板 → 开赛
let res = await run({ type: 'loadTemplate', templateId: 'quick-test' }, '载入模板');
check('载入模板', res.ok);
res = await run({ type: 'start' }, '开始计时');
check('开始计时', res.ok);

const s1 = await waitState(screen, getLatest, (s) => s.status === 'running' && s.currentStageIndex === 0, '开赛广播');
check('大屏收到状态广播', true);
check('服务端下发权威时间戳 serverTime', typeof s1.serverTime === 'number');

// 2. 权威时间：targetEndTime 广播到各端
const affTimer = s1.timers.aff;
check('single 环节 targetEndTime 已生成', affTimer?.targetEndTime != null);
check('targetEndTime ≈ serverTime + 30s', Math.abs(affTimer.targetEndTime - s1.serverTime - 30000) < 1500);

// 3. 推进到自由辩论（每方 60s），验证切换发言方一停一走
await run({ type: 'nextStage' }, '环节1');
await run({ type: 'nextStage' }, '环节2');
const s2 = await waitState(screen, getLatest, (s) => s.currentStageIndex === 2 && s.activeSpeaker === 'aff', '进入自由辩论');
check('自由辩论正方先发言', s2.activeSpeaker === 'aff' && s2.timers.aff.status === 'running');

await new Promise((r) => setTimeout(r, 1500)); // 正方消耗 1.5s
await run({ type: 'switchSpeaker' }, '切换发言方');
const s3 = await waitState(screen, getLatest, (s) => s.activeSpeaker === 'neg', '切换到反方');
check('切换后反方 running', s3.timers.neg.status === 'running');
check('切换后正方 paused', s3.timers.aff.status === 'paused');
check('正方固化剩余 ≈58.5s（60s - 1.5s）', s3.timers.aff.remainingMs > 57000 && s3.timers.aff.remainingMs <= 58900);
check('正方 paused 后 targetEndTime 清空', s3.timers.aff.targetEndTime == null);

// 4. 暂停/恢复：暂停期间不消耗
res = await run({ type: 'pause' }, '暂停');
check('暂停指令成功', res.ok);
const s4 = await waitState(screen, getLatest, (s) => s.status === 'paused', '暂停');
const negRemainingAtPause = s4.timers.neg.remainingMs;
await new Promise((r) => setTimeout(r, 2000)); // 墙钟走 2s
res = await run({ type: 'resume' }, '恢复');
check('恢复指令成功', res.ok);
const s5 = await waitState(screen, getLatest, (s) => s.status === 'running', '恢复');
check('暂停 2s 后恢复，反方剩余不漂移', Math.abs(s5.timers.neg.remainingMs - negRemainingAtPause) < 300);
check('恢复后 targetEndTime 重新生成', s5.timers.neg.targetEndTime != null);

// 5. 评委入场 + 打分进度
const judge = connect('judge');
const joinRes = await new Promise((r) =>
  judge.emit(EVENTS.JUDGE_JOIN, { name: '测试评委', entryCode: s5.config.entryCode }, r),
);
check('评委凭入场码加入', joinRes.ok === true);
const wrongCode = await new Promise((r) =>
  judge.emit(EVENTS.JUDGE_JOIN, { name: 'x', entryCode: '000000' }, r),
);
check('错误入场码被拒绝', wrongCode.ok === false);

judge.emit(EVENTS.SCORE_SUBMIT, { judgeId: joinRes.judge.id, stageId: s5.stages[0].id, side: 'aff', value: 88 });
const s6 = await waitState(screen, getLatest, (s) => s.scoreProgress.includes(joinRes.judge.id), '打分进度广播');
check('打分进度实时广播（分数内容不外泄）', s6.scoreProgress.length === 1 && s6.scores === undefined);

// 6. 公布比分
res = await run({ type: 'publishScores' }, '公布比分');
check('公布比分指令成功', res.ok);
const s7 = await waitState(screen, getLatest, (s) => s.config.scoreVisibility === 'published', '比分公布');
check('大屏比分可见性切换为 published', s7.config.scoreVisibility === 'published');

// 汇总
const failed = results.filter((r) => !r.ok);
console.log(`\n验收结果：${results.length - failed.length}/${results.length} 通过`);
admin.close();
screen.close();
judge.close();
process.exit(failed.length ? 1 : 0);
