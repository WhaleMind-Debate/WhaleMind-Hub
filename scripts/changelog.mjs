/**
 * 生成 Release 更新日志（Markdown）
 *
 * 从上一个 tag（首次则从仓库起点）到当前的 commit，按 conventional type 分组，
 * 保留提交风格里的中文模块分点正文。输出到 stdout，供 workflow 喂给 Release 说明。
 *
 * 用法：node scripts/changelog.mjs [当前tag]
 */
import { execSync } from 'node:child_process';

const EXCLUDE_TYPES = new Set(['chore', 'ci', 'test', 'build', 'style', 'bump']);

/** conventional type → 展示顺序与标题 */
const TYPE_ORDER = [
  ['feat', '✨ 新增功能'],
  ['fix', '🐛 修复'],
  ['perf', '⚡ 性能优化'],
  ['refactor', '♻️ 重构'],
  ['docs', '📝 文档'],
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
const range = isInitial ? '' : `${prevTag}..HEAD`;

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

// 3. 解析 type（feat(debate): xxx → type=feat）
function parseType(subject) {
  const m = subject.match(/^(\w+)(?:\([^)]*\))?:\s*(.+)$/);
  if (!m) return { type: null, title: subject };
  return { type: m[1].toLowerCase(), title: m[2] };
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

// 5. 按既定顺序输出
let out = '';
if (isInitial) out += '**首次发布** —— 辩论赛全流程系统。\n\n';
for (const [type, heading] of TYPE_ORDER) {
  const items = groups.get(type);
  if (!items || items.length === 0) continue;
  out += `### ${heading}\n`;
  for (const it of items) {
    out += `- ${it.title}\n`;
    for (const b of it.bodyLines) out += `  ${b}\n`;
  }
  out += '\n';
}
// 未归类（非 conventional 的裸提交）兜底
const others = groups.get('other');
if (others && others.length) {
  out += '### 其他改动\n';
  for (const it of others) out += `- ${it.title}\n`;
  out += '\n';
}

const rel = isInitial
  ? ''
  : `\n**完整对比**: [${prevTag} → ${currentTag || 'HEAD'}](https://github.com/WhaleMind-Debate/WhaleMind-Hub/compare/${prevTag}...${currentTag || 'HEAD'})\n`;
process.stdout.write(out.trimEnd() + rel);
