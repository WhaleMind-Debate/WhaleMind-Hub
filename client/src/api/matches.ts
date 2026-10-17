/**
 * 比赛数据 HTTP API 封装
 *
 * 赛后查询走 HTTP（只读、不广播）；成绩导出走直链下载
 * （后端带 Content-Disposition + BOM，Excel 中文不乱码）。
 */
import type { MatchConfig, PublishedScores, StageBreakdownRow, StageConfig, GameStatus } from '@/types/debate';

/** 场次摘要（与 server/src/db/repository.ts 的 MatchSummary 对齐） */
export interface MatchSummary {
  matchId: string;
  name: string;
  topic: string;
  status: GameStatus;
  createdAt: number;
  updatedAt: number;
  endedAt: number | null;
  judgeCount: number;
  scoreCount: number;
}

/** 单场明细（与 server/src/index.ts buildMatchDetail 对齐） */
export interface MatchDetail {
  match: MatchSummary | null;
  config: MatchConfig;
  status: GameStatus;
  stages: StageConfig[];
  totals: PublishedScores;
  breakdown: StageBreakdownRow[];
  judges: { id: string; name: string }[];
}

interface ApiResult<T> {
  ok: boolean;
  error?: string;
  data?: T;
}

/** 场次列表（含已归档） */
export async function fetchMatches(): Promise<ApiResult<MatchSummary[]>> {
  try {
    const res = await fetch('/api/matches');
    const body = await res.json();
    if (!res.ok || !body.ok) return { ok: false, error: body?.error ?? `HTTP ${res.status}` };
    return { ok: true, data: body.matches as MatchSummary[] };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : '网络错误' };
  }
}

/** 单场明细：总分 + 分环节平均 + 评委名单（不含单个评委分数） */
export async function fetchMatchDetail(matchId: string): Promise<ApiResult<MatchDetail>> {
  try {
    const res = await fetch(`/api/matches/${encodeURIComponent(matchId)}`);
    const body = await res.json();
    if (!res.ok || !body.ok) return { ok: false, error: body?.error ?? `HTTP ${res.status}` };
    return {
      ok: true,
      data: {
        match: body.match ?? null,
        config: body.config,
        status: body.status,
        stages: body.stages,
        totals: body.totals,
        breakdown: body.breakdown,
        judges: body.judges,
      },
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : '网络错误' };
  }
}

/** 生成成绩 CSV 导出链接；调用方用锚点/窗口触发下载 */
export function exportMatchCsvUrl(matchId: string): string {
  return `/api/matches/${encodeURIComponent(matchId)}/export.csv`;
}
