/**
 * CSV 生成（纯函数，便于单测）
 *
 * 约定：
 * - 一律使用 CRLF，Excel 兼容性最好；
 * - 需要转义的字段（含逗号/引号/换行）按 RFC 4180 用双引号包裹并把内部引号翻倍；
 * - 导出时请自行加上 BOM（见 CSV_BOM），否则 Excel 打开中文会乱码。
 */
export const CSV_BOM = '\uFEFF';

export function csvEscape(value: string | number | null | undefined): string {
  const text = value == null ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(header: string[], rows: Array<Array<string | number | null>>): string {
  const lines = [header, ...rows].map((row) => row.map(csvEscape).join(','));
  return `${lines.join('\r\n')}\r\n`;
}
