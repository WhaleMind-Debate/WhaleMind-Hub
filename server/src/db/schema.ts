/**
 * SQLite 落盘 —— 库文件定位与表结构
 *
 * 设计要点：
 * 1. 使用 Node 内置 `node:sqlite`（Node ≥ 22.5，本机 v24 稳定可用），
 *    不引入任何 native 依赖——避免 node-gyp/prebuild 在不同机器上的构建风险；
 * 2. 比赛状态整体以 JSON 存行：恢复必须逐字段精确，
 *    环节 id 与 targetEndTime 都是运行时生成物，无法从配置重建推导；
 * 3. 评委与评分规格化建表：便于后续做加权总分、历史查询与导出；
 * 4. `ended_at IS NULL` 即“当前活跃场次”，启动恢复只认这一行，历史场次全部留档。
 */
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * node:sqlite 是 Node 的「仅前缀可用」内置模块——builtinModules 里只有 'node:sqlite'，
 * 没有裸名 'sqlite'（node:test / node:sea 同理）。而 Vite 5 的 SSR 外部化判定会先剥掉
 * node: 前缀、再拿裸名去查内置表，于是解析失败（vitest 2.1.9 + vite 5.4.21 实测）。
 * 这里改用 createRequire 直接取内置模块，绕开打包器的静态解析，
 * 使服务端运行与测试运行行为一致。
 */
type DatabaseSync = import('node:sqlite').DatabaseSync;

const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync: DatabaseSyncCtor } = nodeRequire('node:sqlite') as typeof import('node:sqlite');

/** 默认库文件：server/data/debate.db（可用环境变量 DB_PATH 覆盖） */
export const DEFAULT_DB_PATH = fileURLToPath(new URL('../../data/debate.db', import.meta.url));

/**
 * matches.status 存的是“写入瞬间的真实状态”：
 * 若为 running，则同行 timers 已经是固化后的剩余量（见 repository.freezeTimers），
 * 恢复时由 engine 按「冻结待主席确认」策略降级为 paused。
 */
const DDL = `
CREATE TABLE IF NOT EXISTS matches (
  match_id            TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  topic               TEXT NOT NULL,
  status              TEXT NOT NULL,
  current_stage_index INTEGER NOT NULL,
  config              TEXT NOT NULL,
  stages              TEXT NOT NULL,
  timers              TEXT NOT NULL,
  active_speaker      TEXT,
  fired_warns         TEXT NOT NULL,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  ended_at            INTEGER
) STRICT;

CREATE TABLE IF NOT EXISTS judges (
  judge_id  TEXT PRIMARY KEY,
  match_id  TEXT NOT NULL REFERENCES matches(match_id),
  name      TEXT NOT NULL,
  joined_at INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS scores (
  judge_id   TEXT NOT NULL REFERENCES judges(judge_id),
  match_id   TEXT NOT NULL REFERENCES matches(match_id),
  stage_id   TEXT NOT NULL,
  side       TEXT NOT NULL,
  value      REAL NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (judge_id, stage_id, side)
) STRICT;

-- 自定义赛制模板：长期资产，跨场次复用，不参与实时广播
CREATE TABLE IF NOT EXISTS templates (
  template_id TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT NOT NULL,
  stages      TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_judges_match ON judges(match_id);
CREATE INDEX IF NOT EXISTS idx_scores_match ON scores(match_id);
`;

/**
 * 打开（必要时创建）数据库并建表。
 * WAL 模式下 synchronous=NORMAL 已足够安全，且写入无需等 fsync，适合 1s 一次的心跳。
 */
export function openDatabase(dbPath: string = process.env.DB_PATH ?? DEFAULT_DB_PATH): DatabaseSync {
  if (dbPath !== ':memory:') {
    mkdirSync(dirname(resolve(dbPath)), { recursive: true });
  }
  const db = new DatabaseSyncCtor(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(DDL);
  return db;
}
