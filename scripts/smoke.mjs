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
  SCORE_PREVIEW: 'score:preview',
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

// 5. 评委入场 + 多评委打分全链路
function join(name, entryCode) {
  return new Promise((r) => judgeA.emit(EVENTS.JUDGE_JOIN, { name, entryCode }, r));
}
function submit(socket, judgeId, stageId, side, value) {
  return new Promise((r) => socket.emit(EVENTS.SCORE_SUBMIT, { judgeId, stageId, side, value }, r));
}
function preview(socket) {
  return new Promise((r) => socket.emit(EVENTS.SCORE_PREVIEW, {}, r));
}

const judgeA = connect('judgeA');
const judgeB = connect('judgeB');
const joinA = await join('评委甲', s5.config.entryCode);
check('评委甲凭入场码加入', joinA.ok === true);
const wrongCode = await join('x', '000000');
check('错误入场码被拒绝', wrongCode.ok === false);
const joinB = await join('评委乙', s5.config.entryCode);
check('评委乙凭入场码加入', joinB.ok === true);

const stages = s5.stages;
const submitResults = [];
// 两位评委 × 3 个环节 × 正反双方（含 upsert：甲改一次分）
submitResults.push(await submit(judgeA, joinA.judge.id, stages[0].id, 'aff', 80));
submitResults.push(await submit(judgeA, joinA.judge.id, stages[0].id, 'neg', 75));
submitResults.push(await submit(judgeA, joinA.judge.id, stages[1].id, 'aff', 85));
submitResults.push(await submit(judgeB, joinB.judge.id, stages[0].id, 'aff', 90));
submitResults.push(await submit(judgeB, joinB.judge.id, stages[1].id, 'neg', 88));
submitResults.push(await submit(judgeA, joinA.judge.id, stages[0].id, 'aff', 88)); // upsert 改分
check('全部评分提交成功', submitResults.every((r) => r?.ok === true));

const s6 = await waitState(
  screen,
  getLatest,
  (s) => s.scoreProgress.includes(joinA.judge.id) && s.scoreProgress.includes(joinB.judge.id),
  '打分进度广播',
);
check('打分进度实时广播（两位评委）', s6.scoreProgress.length === 2);
check('分数内容对大屏不外泄', s6.scores === undefined && s6.published == null);

// 总分预览：按加权公式现场算期望值（weighted = Σ 环节均分×权重），顺带验证公式与 upsert
const prev = await preview(judgeA);
check('总分预览可查（含加权总分）', prev.ok === true && typeof prev.scores?.aff?.weighted === 'number');
const w = (i) => stages[i].weight ?? 1;
// aff: 环节0 均分 (88+90)/2=89（甲改分后 88 生效即 upsert）、环节1 仅甲 85
const expectAff = ((88 + 90) / 2) * w(0) + 85 * w(1);
// neg: 环节0 仅甲 75、环节1 仅乙 88
const expectNeg = 75 * w(0) + 88 * w(1);
check('upsert 生效 + 加权公式正确（aff）', Math.abs(prev.scores.aff.weighted - expectAff) < 0.01);
check('加权公式正确（neg）', Math.abs(prev.scores.neg.weighted - expectNeg) < 0.01);
check('胜负判定正确', prev.scores.winner === (expectAff > expectNeg ? 'aff' : 'neg'));
check('评委数统计正确', prev.scores.judgeCount === 2);

// 6. 公布比分 → 大屏收到 published 总分与胜负
res = await run({ type: 'publishScores' }, '公布比分');
check('公布比分指令成功', res.ok);
const s7 = await waitState(screen, getLatest, (s) => s.published != null, '比分公布');
check('大屏收到 published 总分与胜负', typeof s7.published?.aff?.weighted === 'number');
check('scoreVisibility 同步为 published', s7.config.scoreVisibility === 'published');

// 7. CSV 导出（走后端 HTTP 路由，与前端按钮同链路）
const csvRes = await fetch(`http://localhost:3000/api/matches/${s7.config.matchId}/export.csv`);
const csvBuf = new Uint8Array(await csvRes.arrayBuffer());
// 注意：Response.text() 会按规范剥掉 BOM，BOM 必须验原始字节
const hasBom = csvBuf[0] === 0xef && csvBuf[1] === 0xbb && csvBuf[2] === 0xbf;
const csvText = new TextDecoder().decode(csvBuf);
check('CSV 导出 HTTP 200', csvRes.ok);
check('CSV 含 BOM（Excel 中文不乱码）', hasBom);
check('CSV 含两位评委的评分行', csvText.includes('评委甲') && csvText.includes('评委乙'));
check('CSV 无被覆盖的 80 分（upsert 铁证）', !csvText.includes(',80,'));
check('CSV 含 upsert 后的 88 分', csvText.includes(',88,'));

// 汇总
const failed = results.filter((r) => !r.ok);
console.log(`\n验收结果：${results.length - failed.length}/${results.length} 通过`);
admin.close();
screen.close();
judgeA.close();
judgeB.close();
process.exit(failed.length ? 1 : 0);
