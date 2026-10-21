/**
 * 通用参数表单纯逻辑（第三方插件动作）：字段目标数组按 SDK biz.Targets 实际产出的形状识别、
 * required / default / 约束提取、default 只补缺失项、下拉值与参数值互转。
 */
import { describe, expect, it } from 'vitest';
import {
  constraintHints,
  dataActionExtraParamFields,
  deriveGenericParamFields,
  fieldTargetKey,
  fieldTargetsToKeys,
  isFieldTargetsSchema,
  keysToFieldTargets,
  missingDefaults,
  parseFieldTargetKey
} from './genericParamForm';

/** 与 SDK direction/biz/params.go Targets(1, 1) 的 JSON 产出逐键一致。 */
const bizTargets11 = {
  type: 'array',
  items: {
    type: 'object',
    properties: { data_table_id: { type: 'string', minLength: 1 }, field_id: { type: 'string', minLength: 1 } },
    required: ['data_table_id', 'field_id'],
    additionalProperties: false
  },
  minItems: 1,
  maxItems: 1,
  title: '目标字段'
};

const schema = {
  type: 'object',
  properties: {
    targets: bizTargets11,
    value: { type: 'string', maxLength: 500, default: 'tp10-default', title: '写入值' },
    picks: { ...bizTargets11, minItems: undefined, maxItems: 3 },
    level: { type: 'string', enum: ['info', 'warn'], default: 'info' },
    count: { type: 'integer', minimum: 1, maximum: 9 },
    extra: { type: 'array', items: { type: 'object', properties: { data_table_id: { type: 'string' }, field_id: { type: 'string' }, note: { type: 'string' } } } },
    flag: { type: 'boolean', default: false }
  },
  required: ['targets', 'value'],
  additionalProperties: false
};

describe('isFieldTargetsSchema', () => {
  it('认 biz.Targets 形状，不看属性名', () => {
    expect(isFieldTargetsSchema(bizTargets11)).toBe(true);
    expect(isFieldTargetsSchema({ type: 'array', items: bizTargets11.items })).toBe(true);
  });
  it('多一个属性、类型不符、不是数组都回落', () => {
    expect(isFieldTargetsSchema(schema.properties.extra)).toBe(false);
    expect(isFieldTargetsSchema({ type: 'array', items: { type: 'object', properties: { data_table_id: { type: 'string' }, field_id: { type: 'number' } } } })).toBe(false);
    expect(isFieldTargetsSchema({ type: 'object', properties: bizTargets11.items.properties })).toBe(false);
    expect(isFieldTargetsSchema(undefined)).toBe(false);
  });
});

describe('deriveGenericParamFields', () => {
  const fields = deriveGenericParamFields(schema);
  const byKey = Object.fromEntries(fields.map(f => [f.key, f]));
  it('种类：字段目标数组 / 字符串 / 枚举 / 数字 / 布尔 / 其余 JSON', () => {
    expect(byKey.targets.kind).toBe('fieldTargets');
    expect(byKey.picks.kind).toBe('fieldTargets');
    expect(byKey.value.kind).toBe('string');
    expect(byKey.level.kind).toBe('enum');
    expect(byKey.count.kind).toBe('number');
    expect(byKey.flag.kind).toBe('boolean');
    expect(byKey.extra.kind).toBe('json');
  });
  it('required / default / 约束 / 标签', () => {
    expect(byKey.targets.required).toBe(true);
    expect(byKey.level.required).toBe(false);
    expect(byKey.value.defaultValue).toBe('tp10-default');
    expect(byKey.value.label).toBe('写入值');
    expect(byKey.count.label).toBe('count');
    expect(byKey.targets.maxItems).toBe(1);
    expect(byKey.count.minimum).toBe(1);
  });
  it('没有 properties 返回空', () => {
    expect(deriveGenericParamFields({ type: 'object' })).toEqual([]);
    expect(deriveGenericParamFields(undefined)).toEqual([]);
  });
});

describe('missingDefaults', () => {
  const fields = deriveGenericParamFields(schema);
  it('只补缺失项，已有值（含 false）不覆盖', () => {
    expect(missingDefaults(fields, {})).toEqual({ value: 'tp10-default', level: 'info', flag: false });
    expect(missingDefaults(fields, { value: '', flag: true, level: 'warn' })).toEqual({});
  });
});

describe('constraintHints', () => {
  const byKey = Object.fromEntries(deriveGenericParamFields(schema).map(f => [f.key, f]));
  it('长度 / 范围 / 条数', () => {
    expect(constraintHints(byKey.value)).toEqual([{ key: 'maxLength', params: { max: 500 } }]);
    expect(constraintHints(byKey.count)).toEqual([{ key: 'range', params: { min: 1, max: 9 } }]);
    expect(constraintHints(byKey.targets)).toEqual([{ key: 'exactItems', params: { n: 1 } }]);
    expect(constraintHints(byKey.picks)).toEqual([{ key: 'maxItems', params: { max: 3 } }]);
    expect(constraintHints(byKey.flag)).toEqual([]);
  });
});

describe('字段目标值互转', () => {
  it('下拉值往返', () => {
    const key = fieldTargetKey('tbl_main', 'fld_a');
    expect(parseFieldTargetKey(key)).toEqual({ data_table_id: 'tbl_main', field_id: 'fld_a' });
    expect(parseFieldTargetKey('broken')).toBeNull();
    expect(fieldTargetsToKeys([{ data_table_id: 'tbl_main', field_id: 'fld_a' }, { field_id: 'x' }, 'junk'])).toEqual([key]);
    expect(fieldTargetsToKeys('not-array')).toEqual([]);
  });
  it('按 maxItems 保留最后选的，空列表删除参数', () => {
    const a = fieldTargetKey('t', 'a');
    const b = fieldTargetKey('t', 'b');
    expect(keysToFieldTargets([a, b], 1)).toEqual([{ data_table_id: 't', field_id: 'b' }]);
    expect(keysToFieldTargets([a, b])).toHaveLength(2);
    expect(keysToFieldTargets([])).toBeUndefined();
  });
});

describe('数据动作附加参数（第三方插件）', () => {
  it('只留引擎键以外的参数：审计备注 / 否决开关 / 枚举探针，引擎文档与写行数上限不进通用表单', () => {
    const schema = {
      type: 'object',
      'x-editor': 'write-v4',
      properties: {
        write_v4: { type: 'object' },
        max_affected_rows: { type: 'integer', minimum: 1 },
        audit_note: { type: 'string', maxLength: 200, title: '审计备注' },
        veto: { type: 'boolean', title: '否决写入' },
        ticket_probe: { type: 'string', enum: ['forged', 'replay_previous'] }
      },
      required: ['write_v4']
    };
    const extra = dataActionExtraParamFields(deriveGenericParamFields(schema));
    expect(extra.map(f => [f.key, f.kind])).toEqual([
      ['audit_note', 'string'],
      ['veto', 'boolean'],
      ['ticket_probe', 'enum']
    ]);
  });
  it('官方取数 schema（只有 extract_v4 / extract_v4_plans）没有附加参数', () => {
    const fields = deriveGenericParamFields({ type: 'object', properties: { extract_v4: { type: 'object' }, extract_v4_plans: { type: 'array' } } });
    expect(dataActionExtraParamFields(fields)).toEqual([]);
  });
});
