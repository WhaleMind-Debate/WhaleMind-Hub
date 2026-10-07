/**
 * 自定义赛制模板仓库用例
 * 模板是长期资产：跨场次复用，因此必须保证 id 稳定、createdAt 不被覆盖、脏数据不炸接口。
 */
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/schema.js';
import { TemplateRepository } from '../src/db/templateRepository.js';
import type { StageInput } from '@debate/shared';

const stages = (): StageInput[] => [
  {
    name: '正方一辩立论',
    type: 'single',
    timerKind: 'countdown',
    side: 'aff',
    protectedSide: null,
    durationMs: 180_000,
    warnThresholds: [30, 10],
    weight: 1,
    soundId: 'bell',
    description: null,
  },
];

function makeRepo() {
  const db = openDatabase(':memory:');
  return { repo: new TemplateRepository(db), db };
}

describe('TemplateRepository', () => {
  it('新建后可读回，字段完整', () => {
    const { repo } = makeRepo();
    const saved = repo.upsert({ name: '校级联赛', description: '四人制', stages: stages() }, 1_000);
    expect(saved.id).toMatch(/^tpl-/);
    expect(saved.createdAt).toBe(1_000);
    expect(saved.updatedAt).toBe(1_000);
    expect(repo.list()).toHaveLength(1);
    expect(repo.get(saved.id)?.stages[0].name).toBe('正方一辩立论');
  });

  it('列表按更新时间倒序', () => {
    const { repo } = makeRepo();
    const a = repo.upsert({ name: 'A', description: '', stages: stages() }, 1_000);
    repo.upsert({ name: 'B', description: '', stages: stages() }, 2_000);
    repo.upsert({ id: a.id, name: 'A2', description: '', stages: stages() }, 3_000);
    expect(repo.list().map((t) => t.name)).toEqual(['A2', 'B']);
  });

  it('更新时保留 createdAt、刷新 updatedAt', () => {
    const { repo } = makeRepo();
    const created = repo.upsert({ name: 'A', description: '', stages: stages() }, 1_000);
    const updated = repo.upsert({ id: created.id, name: 'A改', description: '说明', stages: stages() }, 5_000);
    expect(updated.createdAt).toBe(1_000);
    expect(updated.updatedAt).toBe(5_000);
    expect(updated.name).toBe('A改');
    expect(repo.list()).toHaveLength(1);
  });

  it('模板内的环节不携带 id（避免跨场次共享 stageId）', () => {
    const { repo } = makeRepo();
    const withId: StageInput[] = [{ ...stages()[0], id: 'st-should-be-stripped' }];
    const saved = repo.upsert({ name: 'A', description: '', stages: withId }, 1_000);
    expect(saved.stages[0].id).toBeUndefined();
  });

  it('删除存在与不存在的模板', () => {
    const { repo } = makeRepo();
    const saved = repo.upsert({ name: 'A', description: '', stages: stages() }, 1_000);
    expect(repo.remove(saved.id)).toBe(true);
    expect(repo.remove(saved.id)).toBe(false);
    expect(repo.list()).toHaveLength(0);
    expect(repo.has(saved.id)).toBe(false);
  });

  it('库中出现脏 JSON 时降级为空环节，而不是抛错', () => {
    const { repo, db } = makeRepo();
    const saved = repo.upsert({ name: 'A', description: '', stages: stages() }, 1_000);
    db.prepare('UPDATE templates SET stages = ? WHERE template_id = ?').run('{ 这不是 JSON', saved.id);
    expect(repo.get(saved.id)?.stages).toEqual([]);
  });
});
