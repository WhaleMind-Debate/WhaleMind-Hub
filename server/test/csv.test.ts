/**
 * CSV 生成用例（赛后导出的正确性直接关系到存档可信度）
 */
import { describe, expect, it } from 'vitest';
import { CSV_BOM, csvEscape, toCsv } from '../src/report/csv.js';

describe('csvEscape', () => {
  it('普通字段原样输出', () => {
    expect(csvEscape('正方一辩立论')).toBe('正方一辩立论');
    expect(csvEscape(88)).toBe('88');
  });

  it('含逗号 / 引号 / 换行的字段按 RFC 4180 转义', () => {
    expect(csvEscape('张三,李四')).toBe('"张三,李四"');
    expect(csvEscape('他说"好"')).toBe('"他说""好"""');
    expect(csvEscape('第一行\n第二行')).toBe('"第一行\n第二行"');
  });

  it('null / undefined 输出空字符串', () => {
    expect(csvEscape(null)).toBe('');
    expect(csvEscape(undefined)).toBe('');
  });
});

describe('toCsv', () => {
  it('使用 CRLF 换行并以换行符结尾', () => {
    const csv = toCsv(['a', 'b'], [[1, 2]]);
    expect(csv).toBe('a,b\r\n1,2\r\n');
  });

  it('只有表头时也合法', () => {
    expect(toCsv(['a', 'b'], [])).toBe('a,b\r\n');
  });

  it('提供 BOM 常量（Excel 打开中文不乱码）', () => {
    expect(CSV_BOM).toBe('\uFEFF');
    expect(CSV_BOM + toCsv(['环节'], [['正方立论']])).toContain('正方立论');
  });
});
