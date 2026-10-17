/**
 * 操作审计日志（JSONL，按天分文件，默认保留 30 天）
 *
 * 用途：赛后争议溯源——谁在什么时候执行了什么指令、谁给谁打了多少分。
 *
 * 设计要点：
 * 1. **注入式**：dir / now / enabled 全部由参数注入，模块顶层无副作用。
 *    测试传 enabled:false 或临时目录，绝不写真实 log/；生产由 index.ts 实例化。
 * 2. **按天分文件**：`<dir>/YYYY-MM-DD.jsonl`，日期取自注入的权威时钟（clock.now）。
 * 3. **同步追加**：每天数百条量级，appendFileSync 足够且进程退出不会截断。
 * 4. **保留清理**：每次写（跨天滚动时）顺带清理超期文件；只删严格匹配
 *    `YYYY-MM-DD.jsonl` 的文件，绝不误删其他内容。
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

export type AuditEntryType = 'command' | 'judge' | 'score' | 'system' | 'conn' | 'lifecycle';

/** 操作者：客户端连接（socket）或评委身份 */
export interface AuditActor {
  socketId?: string;
  ip?: string;
  judgeId?: string;
  name?: string;
}

export interface AuditEntry {
  /** 权威时间戳（毫秒） */
  ts: number;
  /** ISO 字符串（带时区偏移，便于人读） */
  iso: string;
  type: AuditEntryType;
  action: string;
  result?: 'ok' | 'fail';
  error?: string;
  actor?: AuditActor | null;
  matchId?: string;
  stageIndex?: number;
  stageName?: string;
  /** 事件特有信息（指令参数、分数新旧值等） */
  detail?: Record<string, unknown>;
}

export interface AuditLogOptions {
  dir: string;
  /** 权威时钟（毫秒） */
  now: () => number;
  retentionDays?: number;
  enabled?: boolean;
}

export interface AuditLog {
  write(entry: Omit<AuditEntry, 'ts' | 'iso'>): void;
  /** 当前日志文件路径（调试/测试用） */
  currentFile(): string;
  close(): void;
}

/** 严格匹配日志文件名（避免误删用户文件） */
const FILE_RE = /^(\d{4})-(\d{2})-(\d{2})\.jsonl$/;
const DEFAULT_RETENTION_DAYS = 30;

function dateKey(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function isoWithOffset(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number, w = 2) => String(Math.abs(n)).padStart(w, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}` +
    `${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`
  );
}

/** 删除超过 retentionDays 的日志文件（只认 YYYY-MM-DD.jsonl） */
export function pruneOldLogs(dir: string, nowMs: number, retentionDays: number): number {
  if (!existsSync(dir)) return 0;
  const cutoff = nowMs - retentionDays * 24 * 60 * 60 * 1000;
  const cutoffKey = dateKey(cutoff);
  let removed = 0;
  for (const name of readdirSync(dir)) {
    if (!FILE_RE.test(name)) continue; // 非本模块文件，一律不碰
    // 文件名即日期，字典序与时间序一致
    if (name.slice(0, 10) < cutoffKey) {
      try {
        rmSync(join(dir, name), { force: true });
        removed += 1;
      } catch {
        // 清理失败不影响主流程
      }
    }
  }
  return removed;
}

export function createAuditLog(opts: AuditLogOptions): AuditLog {
  const enabled = opts.enabled ?? true;
  const retentionDays = opts.retentionDays ?? DEFAULT_RETENTION_DAYS;
  const dir = opts.dir;
  let currentDay = '';
  let file = '';

  function close(): void {
    // 同步追加模式下无需 flush；保留接口以便将来换成流式写入
  }

  if (enabled) {
    try {
      mkdirSync(dir, { recursive: true });
      pruneOldLogs(dir, opts.now(), retentionDays);
    } catch (err) {
      // 日志目录不可用不应拖垮比赛服务
      console.error('[audit] 初始化日志目录失败：', err);
    }
  }

  function ensureFile(nowMs: number): string | null {
    const day = dateKey(nowMs);
    if (day !== currentDay) {
      currentDay = day;
      file = join(dir, `${day}.jsonl`);
      try {
        mkdirSync(dir, { recursive: true });
        pruneOldLogs(dir, nowMs, retentionDays);
      } catch {
        return null;
      }
    }
    return file;
  }

  return {
    write(entry) {
      if (!enabled) return;
      const ts = opts.now();
      const target = ensureFile(ts);
      if (!target) return;
      const record: AuditEntry = { ts, iso: isoWithOffset(ts), ...entry };
      try {
        appendFileSync(target, `${JSON.stringify(record)}\n`, 'utf8');
      } catch (err) {
        // 写日志失败不能影响比赛流程，只在控制台告警
        console.error('[audit] 写日志失败：', err);
      }
    },
    currentFile: () => file,
    close,
  };
}
