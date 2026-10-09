/**
 * 比赛配置补丁校验用例
 * 关键点：matchId 与 entryCode 必须被白名单挡在门外。
 */
import { describe, expect, it } from 'vitest';
import { CONFIG_LIMITS, validateConfigPatch } from '@debate/shared';

const side = { teamName: '北京大学', title: '辩手', color: '#e5484d', logoUrl: null, speakers: [] };

describe('validateConfigPatch', () => {
  it('合法补丁通过', () => {
    const result = validateConfigPatch({ name: '决赛', topic: '人工智能是否利大于害', aff: side, scoreScale: { min: 0, max: 100, step: 1 } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.patch.name).toBe('决赛');
    expect(result.patch.aff).toEqual(side);
  });

  it('matchId 与 entryCode 不在白名单，被静默忽略', () => {
    const result = validateConfigPatch({ matchId: 'hacked', entryCode: '000000', name: 'x' } as unknown);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.patch).toEqual({ name: 'x' });
    expect('matchId' in result.patch).toBe(false);
    expect('entryCode' in result.patch).toBe(false);
  });

  it('只改出现的字段', () => {
    const result = validateConfigPatch({ topic: '新辩题' });
    expect(result.ok && Object.keys(result.patch)).toEqual(['topic']);
  });

  it('名称/辩题不能为空或超长', () => {
    expect(validateConfigPatch({ name: '   ' }).ok).toBe(false);
    expect(validateConfigPatch({ topic: '' }).ok).toBe(false);
    expect(validateConfigPatch({ topic: 'x'.repeat(CONFIG_LIMITS.maxTopicLength + 1) }).ok).toBe(false);
  });

  it('队名字段缺一不可', () => {
    expect(validateConfigPatch({ aff: { title: '辩手', color: '#fff' } }).ok).toBe(false);
    expect(validateConfigPatch({ aff: { teamName: '', title: '辩手', color: '#fff' } }).ok).toBe(false);
    expect(validateConfigPatch({ neg: { teamName: 'A', title: '', color: '#fff' } }).ok).toBe(false);
  });

  it('评分刻度必须 min < max、step > 0 且最高分有上限', () => {
    expect(validateConfigPatch({ scoreScale: { min: 100, max: 100, step: 1 } }).ok).toBe(false);
    expect(validateConfigPatch({ scoreScale: { min: 0, max: 100, step: 0 } }).ok).toBe(false);
    expect(validateConfigPatch({ scoreScale: { min: 0, max: CONFIG_LIMITS.maxScore + 1, step: 1 } }).ok).toBe(false);
    expect(validateConfigPatch({ scoreScale: { min: 0, max: 100, step: 1 } }).ok).toBe(true);
  });

  it('比分可见性只接受两个取值', () => {
    expect(validateConfigPatch({ scoreVisibility: 'published' }).ok).toBe(true);
    expect(validateConfigPatch({ scoreVisibility: 'hidden' }).ok).toBe(true);
    expect(validateConfigPatch({ scoreVisibility: 'yes' }).ok).toBe(false);
  });

  it('非对象输入被拒', () => {
    expect(validateConfigPatch(null).ok).toBe(false);
    expect(validateConfigPatch([]).ok).toBe(false);
    expect(validateConfigPatch('x').ok).toBe(false);
  });

  it('辩手名单：合法「辩位+姓名」通过，姓名空/超长/超员被拒', () => {
    const good = validateConfigPatch({
      aff: { ...side, speakers: [{ position: '一辩', name: '张三' }, { position: '', name: '李四' }] },
    });
    expect(good.ok).toBe(true);
    if (good.ok) expect(good.patch.aff?.speakers).toEqual([{ position: '一辩', name: '张三' }, { position: '', name: '李四' }]);

    // 姓名为空
    expect(validateConfigPatch({ aff: { ...side, speakers: [{ position: '一辩', name: '   ' }] } }).ok).toBe(false);
    // 姓名超长
    expect(
      validateConfigPatch({ aff: { ...side, speakers: [{ position: '', name: 'x'.repeat(CONFIG_LIMITS.maxSpeakerNameLength + 1) }] } }).ok,
    ).toBe(false);
    // 辩位超长
    expect(
      validateConfigPatch({ aff: { ...side, speakers: [{ position: 'x'.repeat(CONFIG_LIMITS.maxSpeakerPositionLength + 1), name: 'a' }] } }).ok,
    ).toBe(false);
    // 超员
    const many = Array.from({ length: CONFIG_LIMITS.maxSpeakers + 1 }, (_, i) => ({ position: '', name: `s${i}` }));
    expect(validateConfigPatch({ aff: { ...side, speakers: many } }).ok).toBe(false);
    // 非数组
    expect(validateConfigPatch({ aff: { ...side, speakers: 'x' } }).ok).toBe(false);
  });

  it('辩手名单缺省/为空数组时归一为 []', () => {
    const r = validateConfigPatch({ aff: side });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.patch.aff?.speakers).toEqual([]);
  });

  it('两方观点：可为空（回退辩题），超长被拒', () => {
    expect(validateConfigPatch({ affStance: '短剧的发展有利于行业' }).ok).toBe(true);
    expect(validateConfigPatch({ negStance: '' }).ok).toBe(true);
    expect(validateConfigPatch({ affStance: '   ' }).ok).toBe(true);
    expect(validateConfigPatch({ affStance: 'x'.repeat(CONFIG_LIMITS.maxStanceLength + 1) }).ok).toBe(false);
    expect(validateConfigPatch({ negStance: 123 as unknown }).ok).toBe(false);
  });
});
