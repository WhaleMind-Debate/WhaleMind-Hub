/**
 * 自定义赛制模板仓库
 *
 * 与比赛状态分开存放：模板是长期资产（跨场次复用），不参与实时广播，
 * 也不受比赛状态机约束——比赛开着也能保存模板。
 *
 * 模板内的环节一律**不带 id**：载入到比赛时才由 engine 分配新 id，
 * 避免同一份模板在不同场次之间共享 stageId 造成评分串场。
 */
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type { SavedTemplate, StageInput } from '@debate/shared';

export interface TemplateUpsertInput {
  id?: string;
  name: string;
  description: string;
  stages: StageInput[];
}

type Row = Record<string, unknown>;

export class TemplateRepository {
  private db: DatabaseSync;
  private seq = 0;
  private selectAll: StatementSync;
  private selectOne: StatementSync;
  private upsertStmt: StatementSync;
  private deleteStmt: StatementSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    this.selectAll = db.prepare('SELECT * FROM templates ORDER BY updated_at DESC, rowid DESC');
    this.selectOne = db.prepare('SELECT * FROM templates WHERE template_id = ?');
    this.upsertStmt = db.prepare(`
      INSERT INTO templates (template_id, name, description, stages, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(template_id) DO UPDATE SET
        name = excluded.name,
        description = excluded.description,
        stages = excluded.stages,
        updated_at = excluded.updated_at
    `);
    this.deleteStmt = db.prepare('DELETE FROM templates WHERE template_id = ?');
  }

  list(): SavedTemplate[] {
    return (this.selectAll.all() as Row[]).map((row) => this.toTemplate(row));
  }

  get(id: string): SavedTemplate | null {
    const row = this.selectOne.get(id) as Row | undefined;
    return row ? this.toTemplate(row) : null;
  }

  /** 新建或更新；返回落库后的完整模板 */
  upsert(input: TemplateUpsertInput, now: number): SavedTemplate {
    const id = input.id ?? `tpl-${now.toString(36)}-${(this.seq++).toString(36)}`;
    const created = input.id ? Number((this.selectOne.get(id) as Row | undefined)?.created_at ?? now) : now;
    // 模板不携带环节 id：id 只在具体场次里有意义
    const stages = input.stages.map((stage) => ({ ...stage, id: undefined }));
    this.upsertStmt.run(id, input.name, input.description, JSON.stringify(stages), created, now);
    return this.get(id)!;
  }

  /** 删除；返回是否真的删掉了 */
  remove(id: string): boolean {
    const result = this.deleteStmt.run(id);
    return Number(result.changes ?? 0) > 0;
  }

  /** 是否已存在（PUT 前判断 404） */
  has(id: string): boolean {
    return this.selectOne.get(id) != null;
  }

  private toTemplate(row: Row): SavedTemplate {
    return {
      id: String(row.template_id),
      name: String(row.name),
      description: String(row.description),
      stages: parseStages(row.stages),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }
}

/** 防御式解析：库里出现脏数据时降级为空模板，而不是让接口 500 */
function parseStages(text: unknown): StageInput[] {
  if (typeof text !== 'string') return [];
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? (parsed as StageInput[]) : [];
  } catch {
    return [];
  }
}
