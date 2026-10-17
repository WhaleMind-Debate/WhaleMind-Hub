/**
 * 审计日志模块单测
 *
 * 关键点：文件写入全部走临时目录（mkdtemp），绝不碰真实 log/；
 * 跨天滚动与保留策略用假时钟驱动，不依赖真实日期。
 */
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAuditLog, pruneOldLogs } from '../src/log/audit.js';

const DAY = 24 * 60 * 60 * 1000;

/** 固定基准：2026-10-17 12:00 本地时间 */
function baseTime(): number {
  return new Date(2026, 9, 17, 12, 0, 0).getTime();
}

function makeDir(): string {
  return mkdtempSync(join(tmpdir(), 'audit-test-'));
}

const dirs: string[] = [];
function newDir(): string {
  const d = makeDir();
  dirs.push(d);
  return d;
}

afterEach(() => {
  // 临时目录交给系统清理即可；这里不主动删，避免误伤
});

describe('createAuditLog 写入', () => {
  it('写入格式合法：逐行 JSON、字段齐全、中文正常', () => {
    const dir = newDir();
    let now = baseTime();
    const log = createAuditLog({ dir, now: () => now });

    log.write({ type: 'command', action: 'start', result: 'ok', detail: { note: '开始比赛' } });
    log.write({ type: 'score', action: 'submit', actor: { judgeId: 'j-1', name: '评委甲' }, detail: { value: 88 } });

    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^\d{4}-\d{2}-\d{2}\.jsonl$/);

    const lines = readFileSync(join(dir, files[0]), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);

    const [first, second] = lines.map((l) => JSON.parse(l));
    expect(first.type).toBe('command');
    expect(first.action).toBe('start');
    expect(first.result).toBe('ok');
    expect(typeof first.ts).toBe('number');
    expect(first.ts).toBe(now);
    expect(first.iso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/);
    expect(first.detail.note).toBe('开始比赛');
    expect(second.actor.name).toBe('评委甲');
  });

  it('按天滚动：跨天后写到新文件', () => {
    const dir = newDir();
    let now = baseTime();
    const log = createAuditLog({ dir, now: () => now });

    log.write({ type: 'system', action: 'day1' });
    now += DAY;
    log.write({ type: 'system', action: 'day2' });

    const files = readdirSync(dir).sort();
    expect(files).toHaveLength(2);
    // 两个文件各一条
    for (const f of files) {
      expect(readFileSync(join(dir, f), 'utf8').trim().split('\n')).toHaveLength(1);
    }
  });

  it('enabled=false 完全不写文件', () => {
    const dir = newDir();
    const log = createAuditLog({ dir, now: baseTime, enabled: false });
    log.write({ type: 'command', action: 'start' });
    expect(readdirSync(dir)).toHaveLength(0);
  });
});

describe('pruneOldLogs 保留策略', () => {
  it('删除超期文件、保留期内文件与当日文件', () => {
    const dir = newDir();
    const now = baseTime();
    const today = new Date(now);
    const p = (n: number) => String(n).padStart(2, '0');
    const key = (offsetDays: number) => {
      const d = new Date(now - offsetDays * DAY);
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.jsonl`;
    };

    const oldFile = key(31); // 31 天前：超期
    const edgeFile = key(29); // 29 天前：保留
    const todayFile = key(0);

    for (const f of [oldFile, edgeFile, todayFile]) {
      writeFileSync(join(dir, f), '{}\n', 'utf8');
    }

    const removed = pruneOldLogs(dir, now, 30);
    expect(removed).toBe(1);
    const left = readdirSync(dir).sort();
    expect(left).not.toContain(oldFile);
    expect(left).toContain(edgeFile);
    expect(left).toContain(todayFile);
    expect(today.getFullYear()).toBeGreaterThan(2000); // 顺带确认基准日期合理
  });

  it('不误删非本格式文件（自定义名/子目录名/异常后缀）', () => {
    const dir = newDir();
    const now = baseTime();
    const keep = ['notes.txt', 'README.md', '2026-01-01.jsonl.bak', 'debug.log'];
    for (const f of keep) writeFileSync(join(dir, f), 'x', 'utf8');
    // 一个真正超期的合法文件
    const expired = '2020-01-01.jsonl';
    writeFileSync(join(dir, expired), '{}\n', 'utf8');

    const removed = pruneOldLogs(dir, now, 30);
    expect(removed).toBe(1);
    const left = readdirSync(dir);
    for (const f of keep) expect(left).toContain(f);
    expect(left).not.toContain(expired);
  });

  it('保留天数边界：恰好第 N 天不被删', () => {
    const dir = newDir();
    const now = baseTime();
    const p = (n: number) => String(n).padStart(2, '0');
    const d = new Date(now - 30 * DAY);
    const exact = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.jsonl`;
    writeFileSync(join(dir, exact), '{}\n', 'utf8');
    pruneOldLogs(dir, now, 30);
    expect(readdirSync(dir)).toContain(exact);
  });
});
