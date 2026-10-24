/**
 * 生成 Release 更新日志（Markdown）
 *
 * 从上一个 tag（首次则从仓库起点）到当前的 commit，按 conventional type 分组，
 * 保留提交风格里的中文模块分点正文。输出到 stdout，供 workflow 喂给 Release 说明。
 *
 * 用法：node scripts/changelog.mjs [当前tag]
 */
import { execSync } from 'node:child_process';

// docs 也排除：内部文档整理（Todo/README）对使用者无意义，只留功能变化
const EXCLUDE_TYPES = new Set(['chore', 'ci', 'test', 'build', 'style', 'bump', 'docs']);

/** conventional type → 展示顺序与标题 */
const TYPE_ORDER = [
  ['feat', '✨ 新增功能'],
  ['fix', '🐛 修复'],
  ['perf', '⚡ 性能优化'],
  ['refactor', '♻️ 重构'],
];

const git = (cmd) => execSync(`git ${cmd}`, { encoding: 'utf8' }).trim();

function tryGit(cmd) {
  try {
    return git(cmd);
  } catch {
    return '';
  }
}

// 1. 确定区间：上一个 tag（按创建时间倒序，排除当前 tag 自身）→ HEAD
const currentTag = process.argv[2] ?? '';
const tags = tryGit('tag --sort=-creatordate').split('\n').filter(Boolean);
let prevTag = '';
for (const t of tags) {
  if (t !== currentTag) {
    prevTag = t;
    break;
  }
}
const isInitial = !prevTag;
// CI 里 tag 已在当前 commit 上，用 ..HEAD 会永远为空；有当前 tag 时以它为区间终点
const endRef = currentTag || 'HEAD';
const range = isInitial ? '' : `${prevTag}..${endRef}`;

// 2. 取区间内 commit（主题 + 正文）
// 用 tab(%x09) 分隔 hash/subject/body，record 用 ---COMMIT--- 分隔：
// 避免不可见字符在传输/编辑中丢失导致 split 失效
const REC_SEP = '---COMMIT---';
const logArgs = ['log', '--no-merges', `--pretty=format:%H%x09%s%x09%b${REC_SEP}`, range]
  .filter(Boolean)
  .join(' ');
const raw = tryGit(logArgs);
if (!raw.trim()) {
  process.stdout.write(
    isInitial
      ? '首次发布：辩论赛全流程系统（主席控制台 / 评委打分端 / 大屏展示端）。'
      : '本次发布无新的常规提交。',
  );
  process.exit(0);
}

const commits = raw
  .split(REC_SEP)
  .map((c) => c.trim())
  .filter(Boolean)
  .map((c) => {
    const [hash, subject, body] = c.split('\t');
    return { hash: (hash ?? '').trim(), subject: (subject ?? '').trim(), body: (body ?? '').trim() };
  })
  .filter((c) => c.subject);

/** 标题上限：超出则截断。提交时若把正文塞进 subject（单行 -m 带转义失败），这里兜住 */
const MAX_TITLE = 60;

function clip(text) {
  // 单行提交有时会把 "正文要点 - xxx - yyy" 拼进标题，按第一个 " - " 截断
  const first = text.split(/\s+-\s+/)[0].trim();
  const base = first.length > 0 ? first : text.trim();
  return base.length > MAX_TITLE ? `${base.slice(0, MAX_TITLE)}…` : base;
}

// 3. 解析 type（feat(debate): xxx → type=feat）
function parseType(subject) {
  const m = subject.match(/^(\w+)(?:\([^)]*\))?:\s*(.+)$/);
  if (!m) return { type: null, title: clip(subject) };
  return { type: m[1].toLowerCase(), title: clip(m[2]) };
}

// 4. 分组（跳过杂务类）
const groups = new Map();
for (const c of commits) {
  const { type, title } = parseType(c.subject);
  const key = type ?? 'other';
  if (EXCLUDE_TYPES.has(key)) continue;
  if (!groups.has(key)) groups.set(key, []);
  const lines = c.body ? c.body.split('\n').map((l) => l.trim()).filter(Boolean) : [];
  groups.get(key).push({ title, bodyLines: lines });
}

if (groups.size === 0) {
  process.stdout.write('本次发布仅包含内部杂务更新。');
  process.exit(0);
}

// 5. 按既定顺序输出：每条只保留一行标题，不展开正文（发布说明要短）
let out = '';
if (isInitial) out += '**首次发布** —— 辩论赛全流程系统。\n\n';
for (const [type, heading] of TYPE_ORDER) {
  const items = groups.get(type);
  if (!items || items.length === 0) continue;
  out += `### ${heading}\n`;
  for (const it of items) {
    out += `- ${it.title}\n`;
  }
  out += '\n';
}
// 未归类（非 conventional 的裸提交）兜底；跳过仓库初始化这类无信息量的提交
const others = groups.get('other')?.filter((it) => !/^(initial commit|init|first commit)$/i.test(it.title.trim()));
if (others && others.length) {
  out += '### 其他改动\n';
  for (const it of others) out += `- ${it.title}\n`;
  out += '\n';
}

const rel = isInitial
  ? ''
  : `\n**完整对比**: [${prevTag} → ${currentTag || 'HEAD'}](https://github.com/WhaleMind-Debate/WhaleMind-Hub/compare/${prevTag}...${currentTag || 'HEAD'})\n`;
process.stdout.write(out.trimEnd() + rel);
