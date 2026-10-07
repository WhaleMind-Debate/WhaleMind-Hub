/**
 * 服务端 HTTP 接口封装（浏览器同源访问，开发期由 Vite 代理 /api → :3000）
 *
 * 与 Socket 的分工：
 * - 实时比赛状态与控制指令走 Socket（debateStore / useSocket）；
 * - 赛制模板 CRUD、赛后查询这类“资源型”接口走 HTTP，天然可缓存、可重试。
 *
 * 所有错误统一转成 { ok:false, error }，调用方不必逐层 catch。
 */
import type { SavedTemplate, StageInput } from '@/types/debate';

interface ApiResult<T> {
  ok: boolean;
  error?: string;
  data?: T;
}

async function request<T>(path: string, init?: RequestInit): Promise<ApiResult<T>> {
  try {
    const res = await fetch(path, {
      headers: { 'Content-Type': 'application/json' },
      ...init,
    });
    const body = (await res.json().catch(() => null)) as (T & { ok?: boolean; error?: string }) | null;
    if (!res.ok || !body) {
      return { ok: false, error: body?.error ?? `请求失败（HTTP ${res.status}）` };
    }
    return { ok: true, data: body as T };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : '网络异常' };
  }
}

/** 模板列表（自定义模板，内置模板在 shared/src/templates.ts 里） */
export async function fetchTemplates(): Promise<ApiResult<{ templates: SavedTemplate[] }>> {
  return request<{ templates: SavedTemplate[] }>('/api/templates');
}

/** 新建模板 */
export async function createTemplate(input: {
  name: string;
  description: string;
  stages: StageInput[];
}): Promise<ApiResult<{ template: SavedTemplate }>> {
  return request<{ template: SavedTemplate }>('/api/templates', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

/** 覆盖已有模板 */
export async function updateTemplate(
  id: string,
  input: { name: string; description: string; stages: StageInput[] },
): Promise<ApiResult<{ template: SavedTemplate }>> {
  return request<{ template: SavedTemplate }>(`/api/templates/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify(input),
  });
}

/** 删除模板 */
export async function deleteTemplate(id: string): Promise<ApiResult<unknown>> {
  return request<unknown>(`/api/templates/${encodeURIComponent(id)}`, { method: 'DELETE' });
}
