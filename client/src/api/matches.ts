/**
 * 比赛数据 HTTP API 封装
 * 成绩导出走 HTTP 直链下载（后端带 Content-Disposition + BOM，Excel 中文不乱码），
 * 不经 Socket——下载是浏览器原生行为，window.open 即可。
 */

/** 生成成绩 CSV 导出链接；调用方用 window.open 触发下载 */
export function exportMatchCsvUrl(matchId: string): string {
  return `/api/matches/${encodeURIComponent(matchId)}/export.csv`;
}
