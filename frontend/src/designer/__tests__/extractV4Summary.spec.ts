/**
 * 取数节点「指向详情」摘要（labels.extractV4Summary 及其判定/文本辅助）的纯函数用例。
 *
 * 画布右上角 ⓘ 指向详情对取数节点给出「来源表 / 筛选条件 / 按目标表分 tab 的填充信息」三段结构化摘要：
 * 本报表来源不列、目标级设置不展示；V4 源码 token 是 `[字段]#{rN}`，表名要按 refs 反查来源实例
 * 拼回 `[表].[字段]`。
 * 文案经 $t 取值，装配 installTestZhCn() 查表桩。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ActionDefinition } from '../hostTypes';
import { actionCardDigest, extractV4DocumentOf, extractV4Summary, isExtractV4Node, readableExpressionSegments, readableExpressionText, tableColorIndexOf } from '../labels';
import { createActionNode, type MindNode } from '../model';
import { installTestZhCn } from './testZhCnFixture';

let restoreI18n: () => void;
beforeEach(() => {
  restoreI18n = installTestZhCn();
});
afterEach(() => {
  restoreI18n();
});

const definition: ActionDefinition = {
  name: 'data.extract_record',
  title: '提取数据',
  source: 'builtin',
  capabilities: { asyncable: true, side_effecting: true, expression_based: true },
  params_schema: { 'x-editor': 'extract-v4' }
};

/** 真实形态的引用绑定：source_field 挂来源实例；report_field 带 table_id（多副本时也带实例）；staging_field 挂暂存实例。 */
const REF = {
  src: (id: string, field: string) => ({ ref_id: id, kind: 'source_field', source_instance_id: 'cat-1', field_id: field, last_label: `[入库流水].[${field}]` }),
  rpt: (id: string, field: string) => ({ ref_id: id, kind: 'report_field', source_instance_id: 'rpt-dt-main-abc123', table_id: 'dt-main', field_id: field, last_label: `[${field}]` }),
  stg: (id: string, col: string) => ({ ref_id: id, kind: 'staging_field', source_instance_id: 'stg-1', staging_column_id: col, last_label: `[${col}]` })
};

/** 表达式文档：token 化源码（`[字段]#{rN}`，标签只有字段名）+ refs。 */
function expr(id: string, text: string, refs: unknown[] = []) {
  return { expression_id: id, purpose: 'filter' as const, source_text: text, refs };
}

/** 一份覆盖三种来源 / 带筛选 / 两张目标表 / 暂存目标的 V4 文档。 */
const DOC = {
  schema_version: 'kimpo.extract-node/v4',
  syntax_profile: 'kimposql.mssql/v1',
  query: {
    sources: [
      { kind: 'catalog', instance_id: 'cat-1', alias: '入库流水', app_id: 'app', template_id: 'tpl-2', data_table_id: 'dt-src' },
      { kind: 'report', instance_id: 'rpt-dt-main-abc123', alias: '采购订单', table_id: 'dt-main', table_role: 'main' },
      { kind: 'staging', instance_id: 'stg-1', alias: '上一步暂存区', producer_node_id: 'n0', output_schema_revision: 'v1' }
    ],
    joins: [],
    filter: expr('f', '[单号]#{r1} = [单号]#{r2}   AND [数量]#{r3} > 0', [REF.src('r1', 'no'), REF.rpt('r2', 'no'), REF.src('r3', 'qty')]),
    options: { distinct: false, business_timezone: 'UTC' }
  },
  targets: [
    {
      target_id: 't-detail',
      target_data_table_id: 'dt-detail',
      table_role: 'detail',
      clear: { mode: 'mapped', timing: 'before' },
      auto_row_match: false,
      trim_empty_rows_after_fill: true,
      outputs: [
        { target_field_id: 'fld_qty', expression: expr('o1', '[数量]#{r1}', [REF.src('r1', 'qty')]), fill_strategy: 'overwrite' },
        { target_field_id: 'fld_note', label: '备注列', expression: expr('o2', '[备注]#{r1}', [REF.src('r1', 'note')]), fill_strategy: 'merge', separator: ',' },
        { target_field_id: 'fld_code', expression: expr('o3', ''), fill_strategy: 'row_match' }
      ]
    },
    { target_id: 't-main', target_data_table_id: 'dt-main', table_role: 'main', outputs: [] }
  ],
  // column_id 与 name 分离——column_id 是稳定键（引用 id），name 是可自由改的
  // 显示名（可含中文），二者不必相同。
  staging_target: { columns: [{ column_id: 'col_1a2b3c4d', name: '合计金额', expression: expr('s1', 'SUM([金额]#{r1}) + [total]#{r2}', [REF.src('r1', 'amount'), REF.stg('r2', 'total')]) }] }
};

const tableName = (id: string) => ({ 'dt-main': '采购订单', 'dt-detail': '采购明细' })[id] ?? id;
const fieldName = (id: string) => ({ fld_qty: '数量' })[id] ?? id;
const ctx = { sources: DOC.query.sources as never, tableName };

describe('readableExpressionText（token 化源码 → 可读文本）', () => {
  it('按 refs 反查来源实例拼回 [表].[字段]，折叠空白', () => {
    expect(readableExpressionText(DOC.query.filter as never, ctx)).toBe('[入库流水].[单号] = [采购订单].[单号] AND [入库流水].[数量] > 0');
  });

  it('report_field 未带实例时按 table_id 走 tableName；解析口缺席时退同表的本报表来源 alias', () => {
    const noInstance = expr('x', '[单号]#{r1}', [{ ref_id: 'r1', kind: 'report_field', table_id: 'dt-main', field_id: 'no', last_label: '[单号]' }]);
    expect(readableExpressionText(noInstance as never, { tableName })).toBe('[采购订单].[单号]');
    expect(readableExpressionText(noInstance as never, { sources: DOC.query.sources as never })).toBe('[采购订单].[单号]');
  });

  it('暂存引用退「暂存区」；系统变量原样留标签；来源查不到时退 last_label 完整快照，快照不完整则只留 [字段]', () => {
    const stg = expr('x', '[total]#{r1}', [REF.stg('r1', 'total')]);
    expect(readableExpressionText(stg as never, {})).toBe('[暂存区].[total]');
    const sysVar = expr('x', '[当前用户]#{r1} = 1', [{ ref_id: 'r1', kind: 'system_var', last_label: '[当前用户]' }]);
    expect(readableExpressionText(sysVar as never, ctx)).toBe('[当前用户] = 1');
    const orphanFull = expr('x', '[单号]#{r1}', [{ ref_id: 'r1', kind: 'source_field', source_instance_id: 'gone', field_id: 'no', last_label: '[外部表].[单号]' }]);
    expect(readableExpressionText(orphanFull as never, ctx)).toBe('[外部表].[单号]');
    const orphanShort = expr('x', '[单号]#{r1}', [{ ref_id: 'r1', kind: 'source_field', source_instance_id: 'gone', field_id: 'no', last_label: '[单号]' }]);
    expect(readableExpressionText(orphanShort as never, ctx)).toBe('[单号]');
  });

  it('无 refs 时只摘占位；空文档/空文本返回空串', () => {
    expect(readableExpressionText({ source_text: '[a]#{r1} + #{r2}' })).toBe('[a] +');
    expect(readableExpressionText(undefined)).toBe('');
    expect(readableExpressionText({ source_text: '   ' })).toBe('');
  });
});

describe('isExtractV4Node / extractV4DocumentOf（取数节点判定与文档读取）', () => {
  it('定义顶层 x-editor=extract-v4 命中；无定义时按 params.extract_v4 是对象兜底；条件节点/普通动作不命中', () => {
    const withDef = createActionNode({ actionName: 'data.extract_record', params: {} });
    expect(isExtractV4Node(withDef, definition)).toBe(true);
    const byParams = createActionNode({ actionName: 'data.extract_record', params: { extract_v4: DOC } });
    expect(isExtractV4Node(byParams, null)).toBe(true);
    expect(isExtractV4Node(createActionNode({ actionName: 'system.probe', params: { extract_v4: 'x' } }), null)).toBe(false);
    const condition: MindNode = { id: 'c1', kind: 'condition', condition: { fieldId: 'fld_qty', op: '>', value: 0 } };
    expect(isExtractV4Node(condition, definition)).toBe(false);
    expect(extractV4DocumentOf(byParams)).toBe(DOC);
    expect(extractV4DocumentOf(withDef)).toBeUndefined();
  });
});

describe('extractV4Summary（来源表 / 筛选条件 / 填充 tab）', () => {
  it('来源表：目录来源显示 alias 无标签；暂存来源标「暂存区」；本报表来源不列', () => {
    const { sources } = extractV4Summary(DOC as never, { tableName, fieldName });
    // 表主题色序号按 query.sources 里非本报表来源的出现顺序：cat-1=0、stg-1=1（rpt 不占号）
    // kind 字段：供渲染层挑图标（catalog / staging 等）。
    expect(sources).toEqual([
      { key: 'cat-1', name: '入库流水', tag: undefined, colorIndex: 0, kind: 'catalog' },
      { key: 'stg-1', name: '上一步暂存区', tag: '暂存区', colorIndex: 1, kind: 'staging' }
    ]);
  });

  it('筛选条件：整段 WHERE 的可读文本，本报表来源虽不列进来源表、字段引用仍拼回其表名', () => {
    expect(extractV4Summary(DOC as never, { tableName }).filter).toBe('[入库流水].[单号] = [采购订单].[单号] AND [入库流水].[数量] > 0');
  });

  it('填充：每张目标表一个 tab（表名+角色+逐字段输出，不带目标级设置），暂存目标追加「暂存区」tab', () => {
    const { tabs } = extractV4Summary(DOC as never, { tableName, fieldName });
    expect(tabs.map(t => [t.key, t.label, t.role, t.staging])).toEqual([
      ['t-detail', '采购明细', '扩展表', undefined],
      ['t-main', '采购订单', '主表', undefined],
      ['staging', '暂存区', undefined, true]
    ]);
    // 目标级设置（清空 / 自动按行列匹配 / 清理空行）不进摘要
    expect(tabs[0]).not.toHaveProperty('settings');
    // 输出：字段名优先 fieldName 解析，其次输出 label，最后 id；表达式拼回表名；填充方式三档标签
    expect(tabs[0].outputs.map(o => [o.field, o.expression, o.strategy])).toEqual([
      ['数量', '[入库流水].[数量]', '覆盖'],
      ['备注列', '[入库流水].[备注]', '合并'],
      ['fld_code', '', '按行列匹配']
    ]);
    // 输出行同时带着色分段：表段带主题色序号、字段段带引用种类
    expect(tabs[0].outputs[0].segments).toEqual([
      {
        text: '[入库流水].[数量]',
        kind: 'ref',
        colorIndex: 0,
        report: false,
        parts: [
          { text: '[', role: 'punc' },
          { text: '入库流水', role: 'table' },
          { text: '].[', role: 'punc' },
          { text: '数量', role: 'field' },
          { text: ']', role: 'punc' }
        ]
      }
    ]);
    expect(tabs[0].outputs[2].segments).toEqual([]);
    expect(tabs[1].outputs).toEqual([]);
    // 暂存 tab：显示字段名用 name（与 column_id 分离、可自由改的显示名）/ 表达式（暂存引用
    // 拼「暂存区」，可读文本按引用的 last_label 不变，不受本列改名影响）/ 无填充方式；行 key 用 column_id。
    expect(tabs[2].outputs.map(o => [o.field, o.key, o.expression, o.strategy])).toEqual([
      ['合计金额', 'col_1a2b3c4d', 'SUM([入库流水].[金额]) + [上一步暂存区].[total]', '']
    ]);
  });

  it('暂存列 column_id 与 name 分离：存量文档缺 column_id 时行 key 回落 name', () => {
    const doc = {
      query: { sources: [] },
      staging_target: {
        columns: [
          { column_id: 'col_9f8e7d6c', name: '物料编号', expression: expr('s2', '1') },
          // 存量列：没有 column_id（未经历过本次分离前落的旧文档）。
          { name: 'legacy_col', expression: expr('s3', '2') }
        ]
      }
    };
    const { tabs } = extractV4Summary(doc as never);
    expect(tabs[0].outputs.map(o => [o.field, o.key])).toEqual([
      ['物料编号', 'col_9f8e7d6c'],
      ['legacy_col', 'legacy_col']
    ]);
  });

  it('无解析口时表名/字段名回退 id', () => {
    const doc = {
      query: { sources: [], joins: [] },
      targets: [{ target_id: 't1', target_data_table_id: 'dt-x', table_role: 'detail', outputs: [{ target_field_id: 'fld_a', expression: expr('o', '1'), fill_strategy: 'overwrite' }] }]
    };
    const { tabs } = extractV4Summary(doc as never);
    expect(tabs[0].label).toBe('dt-x');
    expect(tabs[0].outputs[0].field).toBe('fld_a');
  });

  it('文档缺席 / 缺段 / 暂存无列 / 只有本报表来源时一律按空处理，不抛错', () => {
    expect(extractV4Summary(undefined)).toEqual({ sources: [], filter: '', filterSegments: [], tabs: [] });
    expect(extractV4Summary({ query: {} } as never)).toEqual({ sources: [], filter: '', filterSegments: [], tabs: [] });
    expect(extractV4Summary({ staging_target: { columns: [] } } as never).tabs).toEqual([]);
    const onlyReport = { query: { sources: [{ kind: 'report', instance_id: 'rpt-1', alias: '采购订单', table_id: 'dt-main', table_role: 'main' }] } };
    expect(extractV4Summary(onlyReport as never).sources).toEqual([]);
  });
});

describe('readableExpressionSegments / tableColorIndexOf（整条引用按表主题色着色，方案 A）', () => {
  const P = (table: string, field: string) => [
    { text: '[', role: 'punc' },
    { text: table, role: 'table' },
    { text: '].[', role: 'punc' },
    { text: field, role: 'field' },
    { text: ']', role: 'punc' }
  ];

  it('筛选整段：整条引用一段（来源按顺序取色、本报表独立色）、关键字 / 数字 / 运算符各归其类', () => {
    expect(readableExpressionSegments(DOC.query.filter as never, ctx)).toEqual([
      { text: '[入库流水].[单号]', kind: 'ref', colorIndex: 0, report: false, parts: P('入库流水', '单号') },
      { text: ' = ', kind: 'text' },
      { text: '[采购订单].[单号]', kind: 'ref', colorIndex: -1, report: true, parts: P('采购订单', '单号') },
      { text: ' ', kind: 'text' },
      { text: 'AND', kind: 'keyword' },
      { text: ' ', kind: 'text' },
      { text: '[入库流水].[数量]', kind: 'ref', colorIndex: 0, report: false, parts: P('入库流水', '数量') },
      { text: ' > ', kind: 'text' },
      { text: '0', kind: 'number' }
    ]);
  });

  it('函数名（后接括号）/ 字符串字面量 / 中文关键字 / 暂存引用（来源顺序取色）', () => {
    const e = expr('x', "SUM([金额]#{r1}) + [total]#{r2} 且 [备注]#{r3} = 'a''b'", [REF.src('r1', 'amount'), REF.stg('r2', 'total'), REF.src('r3', 'note')]);
    expect(readableExpressionSegments(e as never, ctx)).toEqual([
      { text: 'SUM', kind: 'func' },
      { text: '(', kind: 'text' },
      { text: '[入库流水].[金额]', kind: 'ref', colorIndex: 0, report: false, parts: P('入库流水', '金额') },
      { text: ') + ', kind: 'text' },
      { text: '[上一步暂存区].[total]', kind: 'ref', colorIndex: 1, report: false, parts: P('上一步暂存区', 'total') },
      { text: ' ', kind: 'text' },
      { text: '且', kind: 'keyword' },
      { text: ' ', kind: 'text' },
      { text: '[入库流水].[备注]', kind: 'ref', colorIndex: 0, report: false, parts: P('入库流水', '备注') },
      { text: ' = ', kind: 'text' },
      { text: "'a''b'", kind: 'string' }
    ]);
  });

  it('系统变量留标签按 system_var；refs 缺失的占位留标签、种类为空；last_label 完整快照整条无主题色', () => {
    const sysVar = expr('x', '[当前用户]#{r1}', [{ ref_id: 'r1', kind: 'system_var', last_label: '[当前用户]' }]);
    expect(readableExpressionSegments(sysVar as never, ctx)).toEqual([{ text: '[当前用户]', kind: 'field', refKind: 'system_var' }]);
    expect(readableExpressionSegments({ source_text: '[a]#{r1}' }, ctx)).toEqual([{ text: '[a]', kind: 'field', refKind: undefined }]);
    const orphan = expr('x', '[单号]#{r1}', [{ ref_id: 'r1', kind: 'source_field', source_instance_id: 'gone', field_id: 'no', last_label: '[外部表].[单号]' }]);
    expect(readableExpressionSegments(orphan as never, ctx)).toEqual([
      { text: '[外部表].[单号]', kind: 'ref', colorIndex: -1, report: false, parts: P('外部表', '单号') }
    ]);
  });

  it('tableColorIndexOf：别名 tN 沿用编辑器 (N-1)%8；否则按非本报表来源顺序 %8；本报表 / 查不到 -1', () => {
    const sources = [
      { kind: 'catalog', instance_id: 't3', alias: '甲', app_id: 'a', template_id: 't', data_table_id: 'd1' },
      { kind: 'catalog', instance_id: 'cat-x', alias: '乙', app_id: 'a', template_id: 't', data_table_id: 'd2' },
      { kind: 'report', instance_id: 'rpt-1', alias: '丙', table_id: 'd3', table_role: 'main' }
    ] as never[];
    const c = { sources: sources as never };
    expect(tableColorIndexOf(sources[0], c)).toBe(2);
    expect(tableColorIndexOf(sources[1], c)).toBe(1);
    expect(tableColorIndexOf(sources[2], c)).toBe(-1);
    expect(tableColorIndexOf({ kind: 'catalog', instance_id: 'nope', alias: '', app_id: '', template_id: '', data_table_id: '' }, c)).toBe(-1);
    expect(tableColorIndexOf(undefined, c)).toBe(-1);
  });
});

// 画布动作卡片第二行「关键配置一句话」与指向详情摘要同源（来源表 + 填充字段数）。
describe('actionCardDigest（卡片摘要）', () => {
  it('取数节点：来源表（≤2 张，余者「等」）+ 填充字段总数，与 extractV4Summary 同源', () => {
    const node = createActionNode({ actionName: 'data.extract_record', params: { extract_v4: DOC } });
    const summary = extractV4Summary(DOC as never);
    const names = summary.sources.map(s => s.name);
    const count = summary.tabs.reduce((n, t) => n + t.outputs.length, 0);
    const sourceText = names.length > 2 ? `${names.slice(0, 2).join('、')} 等` : names.join('、');
    expect(actionCardDigest(node, definition)).toBe(`${sourceText} → ${count} 个字段`);
  });

  it('未配置的取数节点与非取数/写数动作：返回空串（卡片只显示动作类型）', () => {
    expect(actionCardDigest(createActionNode({ actionName: 'data.extract_record', params: {} }), definition)).toBe('');
    expect(actionCardDigest(createActionNode({ actionName: 'ui.message', params: { text: 'x' } }), null)).toBe('');
  });
});
