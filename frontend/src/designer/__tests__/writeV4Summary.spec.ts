/**
 * 写节点（新增/修改/删除数据）「指向详情」摘要（labels.writeV4Summary 及其判定/文本辅助）的纯函数用例。
 *
 * 背景：写模式配置面与取数动作（data.extract_record）外壳一致，指向详情摘要同样齐备（同
 * extractV4Summary.spec.ts）。「目标先行」：三个写动作（新增/修改/删除数据）统一按 target.data_table_id
 * 解析目标表，各一例覆盖目标表解析、定位条件（仅 update/delete）、赋值行、防重摘要。另有一例
 * 单独验证 update/delete 的读兼容折算（旧格式文档只落 target.instance_id 时反查来源身份）。
 * 文案经 $t 取值，装配 installTestZhCn() 查表桩（逐字摘自宿主前端 zh-cn 语言包
 * 的 actionDesigner.summary.write* 系列 key）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ActionDefinition } from '../hostTypes';
import { isWriteV4Node, writeV4DocumentOf, writeV4Summary } from '../labels';
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
  name: 'data.create_record',
  title: '新增数据',
  source: 'builtin',
  capabilities: { asyncable: true, side_effecting: true, expression_based: true },
  params_schema: { 'x-editor': 'write-v4' }
};

function expr(id: string, text: string, refs: unknown[] = []) {
  return { expression_id: id, purpose: 'output' as const, source_text: text, refs };
}
const REF = {
  src: (id: string, field: string) => ({ ref_id: id, kind: 'source_field', source_instance_id: 'cat-1', field_id: field, last_label: `[入库流水].[${field}]` }),
  rpt: (id: string, field: string) => ({ ref_id: id, kind: 'report_field', source_instance_id: 'rpt-main', table_id: 'dt-main', field_id: field, last_label: `[${field}]` })
};

const tableName = (id: string) => ({ 'dt-main': '采购订单', 'dt-detail': '采购明细' })[id] ?? id;
const fieldName = (id: string) => ({ fld_qty: '数量' })[id] ?? id;

describe('isWriteV4Node / writeV4DocumentOf（写节点判定与文档读取）', () => {
  it('定义顶层 x-editor=write-v4 命中；无定义时按 params.write_v4 是对象兜底；条件节点/普通动作不命中', () => {
    const withDef = createActionNode({ actionName: 'data.create_record', params: {} });
    expect(isWriteV4Node(withDef, definition)).toBe(true);
    const byParams = createActionNode({ actionName: 'data.create_record', params: { write_v4: { operation: 'insert' } } });
    expect(isWriteV4Node(byParams, null)).toBe(true);
    expect(isWriteV4Node(createActionNode({ actionName: 'system.probe', params: { write_v4: 'x' } }), null)).toBe(false);
    const condition: MindNode = { id: 'c1', kind: 'condition', condition: { fieldId: 'fld_qty', op: '>', value: 0 } };
    expect(isWriteV4Node(condition, definition)).toBe(false);
    expect(writeV4DocumentOf(byParams)).toEqual({ operation: 'insert' });
    expect(writeV4DocumentOf(withDef)).toBeUndefined();
  });
});

describe('writeV4Summary（三种写操作各一例，「目标先行」形状）', () => {
  it('新增（insert）：目标表按 target.data_table_id 解析、无定位条件、赋值行、防重摘要', () => {
    const doc = {
      operation: 'insert' as const,
      target: { data_table_id: 'dt-detail', template_id: 'tpl-1' },
      query: { sources: [{ kind: 'catalog', instance_id: 'cat-1', alias: '入库流水', app_id: 'app', template_id: 'tpl-2', data_table_id: 'dt-src' }], joins: [] },
      assignments: [{ target_field_id: 'fld_qty', expression: expr('a1', '[数量]#{r1}', [REF.src('r1', 'qty')]) }],
      dedupe: { field_ids: ['fld_qty'], scope: 'parent' as const }
      // 「目标先行」形状不写出 parent 字段：本例不携带，摘要也不再产出 parentText。
    };
    const summary = writeV4Summary(doc as never, { tableName, fieldName });
    expect(summary.operation).toBe('insert');
    expect(summary.operationLabel).toBe('新增');
    expect(summary.target).toBe('采购明细');
    // insert 无定位条件段：filter/filterSegments 恒 undefined（与 update/delete 的差异见下两例）。
    expect(summary.filter).toBeUndefined();
    expect(summary.filterSegments).toBeUndefined();
    expect(summary.assignments.map(a => [a.field, a.expression])).toEqual([['数量', '[入库流水].[数量]']]);
    expect(summary.dedupe).toEqual({ fields: '数量', scope: '同父内' });
  });

  it('修改（update）：目标表按 target.data_table_id 直接解析（不依赖来源别名）、定位条件可读文本+着色分段', () => {
    const doc = {
      operation: 'update' as const,
      target: { data_table_id: 'dt-detail', template_id: 'tpl-1' },
      query: {
        sources: [
          { kind: 'catalog', instance_id: 'cat-1', alias: '入库流水', app_id: 'app', template_id: 'tpl-2', data_table_id: 'dt-src' },
          { kind: 'report', instance_id: 'rpt-main', alias: '采购订单', table_id: 'dt-main', table_role: 'main' as const }
        ],
        joins: [],
        filter: expr('f', '[单号]#{r1} = [单号]#{r2}', [REF.src('r1', 'no'), REF.rpt('r2', 'no')])
      },
      assignments: [{ target_field_id: 'fld_qty', expression: expr('a1', '0') }]
    };
    const summary = writeV4Summary(doc as never, { tableName, fieldName });
    expect(summary.operationLabel).toBe('修改');
    // target.data_table_id='dt-detail' 直接经 tableName 解析，不再反查 query.sources 的来源别名。
    expect(summary.target).toBe('采购明细');
    expect(summary.filter).toBe('[入库流水].[单号] = [采购订单].[单号]');
    expect(summary.filterSegments?.length).toBeGreaterThan(0);
    // 未配置 dedupe：不产出该段。
    expect(summary.dedupe).toBeUndefined();
  });

  it('删除（delete）：目标表按 target.data_table_id 直接解析、无赋值行', () => {
    const doc = {
      operation: 'delete' as const,
      target: { data_table_id: 'dt-main', template_id: 'tpl-1' },
      query: {
        sources: [{ kind: 'report', instance_id: 'rpt-main', alias: '采购订单', table_id: 'dt-main', table_role: 'main' as const }],
        joins: [],
        filter: expr('f', '[数量]#{r1} = 0', [REF.rpt('r1', 'qty')])
      },
      assignments: []
    };
    const summary = writeV4Summary(doc as never, { tableName, fieldName });
    expect(summary.operationLabel).toBe('删除');
    expect(summary.target).toBe('采购订单'); // dt-main 经 tableName 直接解析显示名。
    expect(summary.filter).toBe('[采购订单].[数量] = 0');
    expect(summary.assignments).toEqual([]);
  });

  it('读兼容：旧格式 update/delete 文档只落 target.instance_id（未落 data_table_id）时反查来源身份', () => {
    // update：反查 catalog 来源，表 ID（dt-src）不在 tableName 映射里，回落来源 alias「入库流水」。
    const updateDoc = {
      operation: 'update' as const,
      target: { instance_id: 'cat-1' },
      query: {
        sources: [{ kind: 'catalog', instance_id: 'cat-1', alias: '入库流水', app_id: 'app', template_id: 'tpl-2', data_table_id: 'dt-src' }],
        joins: []
      },
      assignments: []
    };
    expect(writeV4Summary(updateDoc as never, { tableName, fieldName }).target).toBe('入库流水');

    // delete：反查 report 来源，表 ID（dt-main）在 tableName 映射里，直接解析显示名。
    const deleteDoc = {
      operation: 'delete' as const,
      target: { instance_id: 'rpt-main' },
      query: {
        sources: [{ kind: 'report', instance_id: 'rpt-main', alias: '采购订单', table_id: 'dt-main', table_role: 'main' as const }],
        joins: []
      },
      assignments: []
    };
    expect(writeV4Summary(deleteDoc as never, { tableName, fieldName }).target).toBe('采购订单');
  });

  it('文档缺席 / 缺段一律按空处理，不抛错', () => {
    const summary = writeV4Summary(undefined);
    expect(summary.operation).toBe('');
    expect(summary.target).toBe('未设置');
    expect(summary.assignments).toEqual([]);
    expect(summary.dedupe).toBeUndefined();
  });
});
