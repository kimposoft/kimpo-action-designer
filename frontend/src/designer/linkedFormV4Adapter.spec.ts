/**
 * linkedFormV4Adapter 往返单测：联动表单节点文档（linked_form_v4）⇄ ExpressionModel
 * 双向翻译不丢字节——覆盖三种场景：打开 + 预览列、新建 + 预填、打开 + 找不到时新建
 * （即同一份文档 preview/prefill 同时非空）。预览列（singleFieldFillOutput）不经 ExpressionModel，
 * 单独测其确定性产出与幂等性。
 */
import { describe, expect, it } from 'vitest';
import { reportInstanceId, type V4ModelAdapterContext, type V4QueryDefinition } from '@kimposoft/expression-editor';
import {
  LinkedFormDuplicateSourceError,
  emptyLinkedFormDocumentV4,
  expressionModelToLinkedFormQueryAndPrefill,
  isLinkedFormNodeDocumentV4,
  linkedFormV4DocToExpressionModel,
  singleFieldFillOutput,
  type LinkedFormNodeDocumentV4
} from './linkedFormV4Adapter';

/** 最小可用上下文：模板 ID 固定 + 表名查询口按 data_table_id 直接回显（单测无需真实目录）。 */
const ctx: V4ModelAdapterContext = {
  templateId: 'tpl-main',
  appId: 'app-1',
  tableLabelOf: source => (source.data_table_id === 'dt-target' ? '目标单主表' : source.data_table_id === 'dt-self-main' ? '本表单主表' : undefined)
};

/** t1（目标模板主表）+ bt0（本表单主表锚点）两张来源，联动表单节点的典型来源集合。 */
const baseQuery: V4QueryDefinition = {
  sources: [
    { kind: 'catalog', instance_id: 't1', alias: '目标单主表', app_id: 'app-1', template_id: 'tpl-target', data_table_id: 'dt-target' },
    { kind: 'report', instance_id: 'rpt-dt-self-main-000000', alias: '本表单主表', table_id: 'dt-self-main', table_role: 'main' }
  ],
  joins: [
    {
      join_id: 't1:rpt-dt-self-main-000000',
      sequence: 1,
      left_instance_id: 't1',
      right_instance_id: 'rpt-dt-self-main-000000',
      join_type: 'inner',
      on: { expression_id: 'join:t1:rpt', purpose: 'join_on', source_text: '1 = 1', refs: [] }
    }
  ],
  options: { distinct: false, business_timezone: 'UTC' }
};

function baseDoc(overrides: Partial<LinkedFormNodeDocumentV4> = {}): LinkedFormNodeDocumentV4 {
  return {
    ...emptyLinkedFormDocumentV4(),
    query: baseQuery,
    target: { template_id: 'tpl-target', data_table_id: 'dt-target' },
    ...overrides
  };
}

describe('emptyLinkedFormDocumentV4 / isLinkedFormNodeDocumentV4', () => {
  it('空白文档形状齐全（query/target/preview/prefill 均非 undefined）', () => {
    const doc = emptyLinkedFormDocumentV4();
    expect(doc.schema_version).toBe('kimpo.linked-form-node/v4');
    expect(doc.query.sources).toEqual([]);
    expect(doc.preview).toEqual([]);
    expect(doc.prefill).toEqual([]);
  });

  it('形状守卫只认 schema_version 命中；旧 query 键（3.4 ExpressionModel）与 undefined 均不命中', () => {
    expect(isLinkedFormNodeDocumentV4(emptyLinkedFormDocumentV4())).toBe(true);
    expect(isLinkedFormNodeDocumentV4({ schema_version: 2, source: {}, target: {} })).toBe(false);
    expect(isLinkedFormNodeDocumentV4(undefined)).toBe(false);
    expect(isLinkedFormNodeDocumentV4(null)).toBe(false);
  });
});

describe('打开模式：打开条件 + 预览列', () => {
  it('query.filter 往返（打开条件）：doc → model → doc 保持 source_text 不变（未编辑判据命中）', () => {
    const doc = baseDoc({
      query: {
        ...baseQuery,
        filter: {
          expression_id: 'filter',
          purpose: 'filter',
          source_text: '[目标单主表].[单号]#{r1} = [本表单主表].[关联单号]#{r2}',
          refs: [
            { ref_id: 'r1', kind: 'source_field', source_instance_id: 't1', field_id: 'f_no', last_label: '[目标单主表].[单号]' },
            { ref_id: 'r2', kind: 'report_field', source_instance_id: 'rpt-dt-self-main-000000', table_id: 'dt-self-main', field_id: 'f_ref_no', last_label: '[本表单主表].[关联单号]' }
          ]
        }
      }
    });

    const model = linkedFormV4DocToExpressionModel(doc, ctx);
    expect(model.where_expr?.kind).toBe('raw');
    expect(model.source.tables).toHaveLength(2);
    expect(model.target.outputs).toEqual([]); // 打开模式无字段传递

    const { query } = expressionModelToLinkedFormQueryAndPrefill(model, doc, ctx);
    expect(query.filter?.source_text).toBe(doc.query.filter!.source_text);
    expect(query.filter?.refs).toEqual(doc.query.filter!.refs);
  });

  it('预览列（singleFieldFillOutput）确定性产出：同输入恒同输出，且不依赖 ExpressionModel', () => {
    const a = singleFieldFillOutput({ targetFieldId: 'f_amount', label: '金额', sourceAlias: 't1' });
    const b = singleFieldFillOutput({ targetFieldId: 'f_amount', label: '金额', sourceAlias: 't1' });
    expect(a).toEqual(b);
    expect(a.fill_strategy).toBe('overwrite');
    expect(a.expression.source_text).toBe('[金额]#{r1}');
    expect(a.expression.refs).toEqual([{ ref_id: 'r1', kind: 'source_field', source_instance_id: 't1', field_id: 'f_amount', last_label: '金额' }]);
  });
});

describe('新建模式：新建后的字段传递（prefill，只引用本报表字段）', () => {
  it('prefill 往返：doc → model.target.outputs → doc 保持字段与表达式一致', () => {
    const doc = baseDoc({
      prefill: [
        {
          target_field_id: 'f_customer',
          fill_strategy: 'overwrite',
          expression: {
            expression_id: 'pf_f_customer',
            purpose: 'output',
            source_text: '[本表单主表].[客户名称]#{r1}',
            refs: [{ ref_id: 'r1', kind: 'report_field', source_instance_id: 'rpt-dt-self-main-000000', table_id: 'dt-self-main', field_id: 'f_cust_name', last_label: '[本表单主表].[客户名称]' }]
          }
        }
      ]
    });

    const model = linkedFormV4DocToExpressionModel(doc, ctx);
    expect(model.target.outputs).toHaveLength(1);
    expect(model.target.outputs[0].target_field_id).toBe('f_customer');
    expect(model.target.outputs[0].expression.kind).toBe('raw');

    const { prefill } = expressionModelToLinkedFormQueryAndPrefill(model, doc, ctx);
    expect(prefill).toHaveLength(1);
    expect(prefill[0].target_field_id).toBe('f_customer');
    expect(prefill[0].expression.source_text).toBe(doc.prefill[0].expression.source_text);
    expect(prefill[0].expression.refs).toEqual(doc.prefill[0].expression.refs);
    expect(prefill[0].fill_strategy).toBe('overwrite');
  });

  it('新增一行字段传递（model 侧新增、prev 无对应项）：产出新的 expression_id，来源置空表达式', () => {
    const doc = baseDoc();
    const model = linkedFormV4DocToExpressionModel(doc, ctx);
    model.target.outputs.push({
      target_field_id: 'f_new',
      fill_strategy: 'overwrite',
      expression: { kind: 'raw', text: '[本表单主表].[备注]', text_source: { text: '[本表单主表].[备注]', pack_revision: 'alice-v4', digest: '', refs: [] } }
    });
    const { prefill } = expressionModelToLinkedFormQueryAndPrefill(model, doc, ctx);
    expect(prefill).toHaveLength(1);
    expect(prefill[0].expression.expression_id).toBe('pf_f_new');
    expect(prefill[0].expression.source_text).toBe('[本表单主表].[备注]');
  });
});

describe('readableTextOf 直传（回归，见 LinkedFormPanel.vue readableTexts 头注释）', () => {
  /** 打开条件 + 一条字段传递均带 `#{rN}` 内部标记的 token 化源码；ctx 带 readableTextOf，
   *  模拟 LinkedFormPanel.vue 经 v4Host.restore 还原后填入 readableTexts 缓存的场景。 */
  const TOKENIZED_FILTER = '[目标单主表].[单号]#{r1} = [本表单主表].[关联单号]#{r2}';
  const READABLE_FILTER = '[目标单主表].[单号] = [本表单主表].[关联单号]';
  const TOKENIZED_PREFILL = '[本表单主表].[备注]#{r1}';
  const READABLE_PREFILL = '[本表单主表].[备注]';

  function docWithTokenizedExpressions(): LinkedFormNodeDocumentV4 {
    return baseDoc({
      query: {
        ...baseQuery,
        filter: {
          expression_id: 'filter',
          purpose: 'filter',
          source_text: TOKENIZED_FILTER,
          refs: [
            { ref_id: 'r1', kind: 'source_field', source_instance_id: 't1', field_id: 'f_no', last_label: '[目标单主表].[单号]' },
            { ref_id: 'r2', kind: 'report_field', source_instance_id: 'rpt-dt-self-main-000000', table_id: 'dt-self-main', field_id: 'f_ref_no', last_label: '[本表单主表].[关联单号]' }
          ]
        }
      },
      prefill: [
        {
          target_field_id: 'f_remark',
          fill_strategy: 'overwrite',
          expression: {
            expression_id: 'pf_f_remark',
            purpose: 'output',
            source_text: TOKENIZED_PREFILL,
            refs: [{ ref_id: 'r1', kind: 'report_field', source_instance_id: 'rpt-dt-self-main-000000', table_id: 'dt-self-main', field_id: 'f_remark_src', last_label: '[本表单主表].[备注]' }]
          }
        }
      ]
    });
  }

  /** 带 readableTextOf 的上下文：按 expression_id 回显预置的可读文本（与 v4Host.restore 还原结果同口径）。 */
  const READABLE: Record<string, string> = { filter: READABLE_FILTER, pf_f_remark: READABLE_PREFILL };
  const ctxReadable: V4ModelAdapterContext = { ...ctx, readableTextOf: (id, tokenized) => READABLE[id] ?? tokenized };

  it('doc → model：where_expr / prefill 输出的显示文本是可读文本，不含内部标记 `#{r`', () => {
    const doc = docWithTokenizedExpressions();
    const model = linkedFormV4DocToExpressionModel(doc, ctxReadable);

    expect(model.where_expr?.text_source?.text).toBe(READABLE_FILTER);
    expect(model.where_expr?.text_source?.text).not.toContain('#{r');

    expect(model.target.outputs).toHaveLength(1);
    expect(model.target.outputs[0].expression.text_source?.text).toBe(READABLE_PREFILL);
    expect(model.target.outputs[0].expression.text_source?.text).not.toContain('#{r');
  });

  it('可读文本被改动后：expressionModelToLinkedFormQueryAndPrefill 落新文本、refs 清空（等保存前 tokenize 重绑）', () => {
    const doc = docWithTokenizedExpressions();
    const model = linkedFormV4DocToExpressionModel(doc, ctxReadable);

    // 模拟用户在高级表达式编辑器里把可读文本改成了新内容（打开条件加一段、字段传递换一个来源）。
    const NEW_FILTER_TEXT = '[目标单主表].[单号] = [本表单主表].[关联单号] AND 1 = 1';
    const NEW_PREFILL_TEXT = '[本表单主表].[摘要]';
    model.where_expr = { kind: 'raw', text: NEW_FILTER_TEXT, text_source: { text: NEW_FILTER_TEXT, pack_revision: 'alice-v4', digest: '', refs: [] } };
    model.target.outputs[0].expression = { kind: 'raw', text: NEW_PREFILL_TEXT, text_source: { text: NEW_PREFILL_TEXT, pack_revision: 'alice-v4', digest: '', refs: [] } };

    const { query, prefill } = expressionModelToLinkedFormQueryAndPrefill(model, doc, ctxReadable);
    expect(query.filter?.source_text).toBe(NEW_FILTER_TEXT);
    expect(query.filter?.refs).toEqual([]);
    expect(prefill[0].expression.source_text).toBe(NEW_PREFILL_TEXT);
    expect(prefill[0].expression.refs).toEqual([]);
  });

  it('未改动（文本仍等于可读渲染）：整份沿用 prev 的 token 形态源码 + refs（不误判成已编辑）', () => {
    const doc = docWithTokenizedExpressions();
    const model = linkedFormV4DocToExpressionModel(doc, ctxReadable);
    // model 未经任何用户改动，where_expr/outputs[0].expression 仍是正向翻译给出的可读文本原样。

    const { query, prefill } = expressionModelToLinkedFormQueryAndPrefill(model, doc, ctxReadable);
    expect(query.filter?.source_text).toBe(TOKENIZED_FILTER);
    expect(query.filter?.refs).toEqual(doc.query.filter!.refs);
    expect(prefill[0].expression.source_text).toBe(TOKENIZED_PREFILL);
    expect(prefill[0].expression.refs).toEqual(doc.prefill[0].expression.refs);
  });
});

describe('打开 + 找不到时新建：preview/prefill 同时非空', () => {
  it('同一份文档 preview 与 prefill 各自独立往返，互不覆盖', () => {
    const doc = baseDoc({
      preview: [singleFieldFillOutput({ targetFieldId: 'f_amount', label: '金额', sourceAlias: 't1' })],
      prefill: [
        {
          target_field_id: 'f_customer',
          fill_strategy: 'overwrite',
          expression: {
            expression_id: 'pf_f_customer',
            purpose: 'output',
            source_text: '[本表单主表].[客户名称]#{r1}',
            refs: [{ ref_id: 'r1', kind: 'report_field', source_instance_id: 'rpt-dt-self-main-000000', table_id: 'dt-self-main', field_id: 'f_cust_name', last_label: '[本表单主表].[客户名称]' }]
          }
        }
      ]
    });

    const model = linkedFormV4DocToExpressionModel(doc, ctx);
    const { prefill } = expressionModelToLinkedFormQueryAndPrefill(model, doc, ctx);
    expect(prefill).toHaveLength(1);
    expect(prefill[0].target_field_id).toBe('f_customer');
    // preview 不受 model 往返影响，调用方原样保留 doc.preview。
    expect(doc.preview).toHaveLength(1);
    expect(doc.preview[0].target_field_id).toBe('f_amount');
  });
});

describe('本报表来源去重（LinkedFormPanel.vue reconcileContext 去重 + 本文件出口断言）', () => {
  it('文档已声明本报表主表来源：读→改一条预填→写，query.sources 里本报表来源恰好 1 条、instance_id 与原来一致，预填引用仍指向它', () => {
    // baseQuery 已带一条本报表来源（rpt-dt-self-main-000000，见文件头 baseQuery 定义）——这正是
    // "面板首次保存后文档已声明本报表来源"的存档态，第二次打开时 model.source.tables 只会含这一张
    // （已根治的 reconcileContext 不会在它之外再插一张同 data_table_id 的 bt0）。
    const doc = baseDoc({
      prefill: [
        {
          target_field_id: 'f_remark',
          fill_strategy: 'overwrite',
          expression: {
            expression_id: 'pf_f_remark',
            purpose: 'output',
            source_text: '[本表单主表].[备注]#{r1}',
            refs: [{ ref_id: 'r1', kind: 'report_field', source_instance_id: 'rpt-dt-self-main-000000', table_id: 'dt-self-main', field_id: 'f_remark_src', last_label: '[本表单主表].[备注]' }]
          }
        }
      ]
    });
    const model = linkedFormV4DocToExpressionModel(doc, ctx);
    expect(model.source.tables.filter(t => t.is_context)).toHaveLength(1); // 往返读入阶段就应只有一张。

    // 改这一条预填表达式（模拟用户在高级表达式编辑器里改字面量），不触碰 model.source.tables。
    const NEW_TEXT = '[本表单主表].[摘要]';
    model.target.outputs[0].expression = { kind: 'raw', text: NEW_TEXT, text_source: { text: NEW_TEXT, pack_revision: 'alice-v4', digest: '', refs: [] } };

    const { query, prefill } = expressionModelToLinkedFormQueryAndPrefill(model, doc, ctx);
    const reportSources = query.sources.filter(s => s.kind === 'report');
    expect(reportSources).toHaveLength(1);
    expect(reportSources[0].instance_id).toBe('rpt-dt-self-main-000000');
    expect(prefill[0].expression.source_text).toBe(NEW_TEXT);
  });

  it('文档未声明本报表来源：模型新增一张主表锚点上下文表（模拟 reconcileContext 首次添加）后写出，query.sources 恰好补出 1 条本报表来源', () => {
    // baseDoc 默认无 overrides 时 query 就是 baseQuery（含 t1 + 既有 rpt- 主表）——这里手工改造成
    // "从未声明过本报表来源"的起点：只留 t1，去掉 report 来源与那条锚定关联。
    const doc = baseDoc({
      query: {
        sources: baseQuery.sources.filter(s => s.kind !== 'report'),
        joins: [],
        options: baseQuery.options
      }
    });
    const model = linkedFormV4DocToExpressionModel(doc, ctx);
    expect(model.source.tables.filter(t => t.is_context)).toHaveLength(0); // 起点确实没有任何本报表上下文表。

    // 模拟 reconcileContext 首次添加主表锚点（bt0，未声明过时唯一会新增的那一张）。
    model.source.tables.push({
      alias: 'bt0',
      source_type: 'template',
      template_id: ctx.templateId,
      data_table_id: 'dt-self-main',
      is_context: true,
      role: 'main'
    });

    const { query } = expressionModelToLinkedFormQueryAndPrefill(model, doc, ctx);
    const reportSources = query.sources.filter(s => s.kind === 'report');
    expect(reportSources).toHaveLength(1);
    expect(reportSources[0].instance_id).toBe(reportInstanceId({ alias: 'bt0', data_table_id: 'dt-self-main' }));
  });

  it('反证：同一 data_table_id 出现两张上下文表（重现 reconcileContext 曾有的 bug：rpt-… 回填态 + 新插的 bt0 并存）——出口断言拒绝，抛 LinkedFormDuplicateSourceError，不静默产出重复 sources', () => {
    // 🔴 已声明来源的 instance_id 必须是 reportInstanceId 的真实派生值（不能沿用 baseQuery 里
    // 图方便手写的占位 '000000'）——真实 bug 正是「同一张表两次派生出同一个 instance_id」，用假占位
    // 值测不出这个碰撞，新插的 bt0 表会派生出真实 hash、与占位值不等，测试就测不出问题（曾在本地
    // 复现过一次假红：占位值下 expect(...).toThrow() 失败，因为两个 instance_id 本就不相等）。
    const realInstanceId = reportInstanceId({ alias: '', data_table_id: 'dt-self-main' });
    const doc = baseDoc({
      query: {
        sources: [
          { kind: 'catalog', instance_id: 't1', alias: '目标单主表', app_id: 'app-1', template_id: 'tpl-target', data_table_id: 'dt-target' },
          { kind: 'report', instance_id: realInstanceId, alias: '本表单主表', table_id: 'dt-self-main', table_role: 'main' }
        ],
        joins: [],
        options: { distinct: false, business_timezone: 'UTC' }
      }
    });
    const model = linkedFormV4DocToExpressionModel(doc, ctx);
    // 手工复现根治前的缺陷：reconcileContext 曾经按别名（而非 data_table_id）去重，会在已有
    // rpt-dt-self-main-000000 之外再插一张别名 bt0、同 data_table_id 的表。
    model.source.tables.push({
      alias: 'bt0',
      source_type: 'template',
      template_id: ctx.templateId,
      data_table_id: 'dt-self-main',
      is_context: true,
      role: 'main'
    });

    expect(() => expressionModelToLinkedFormQueryAndPrefill(model, doc, ctx)).toThrow(LinkedFormDuplicateSourceError);
  });

  it('反证：同一对端点出现两条方向相反的默认锚定关联（1=1）——出口去重只留 1 条，不重复引入同一来源', () => {
    const doc = baseDoc(); // t1 + rpt-dt-self-main-000000（主表）。
    const model = linkedFormV4DocToExpressionModel(doc, ctx);
    const mainAlias = model.source.tables.find(t => t.is_context && t.role === 'main')!.alias;
    // 新增一张明细上下文表（模拟 reconcileContext 的主+明细自动关联场景）。
    model.source.tables.push({
      alias: 'bt1',
      source_type: 'template',
      template_id: ctx.templateId,
      data_table_id: 'dt-self-detail',
      is_context: true,
      role: 'detail'
    });
    // 人为塞入两条方向相反、语义等价的默认锚定关联（正常 reconcileContext 只会产出一条；这里直接
    // 构造模型层面的重复，钉住出口去重本身，不依赖能否从 UI 操作复现这一确切时序）。
    model.source.joins.push(
      { left_alias: mainAlias, right_alias: 'bt1', join_type: 'left', auto_record_id: true, on: [] },
      { left_alias: 'bt1', right_alias: mainAlias, join_type: 'left', auto_record_id: true, on: [] }
    );

    const { query } = expressionModelToLinkedFormQueryAndPrefill(model, doc, ctx);
    const detailInstanceId = reportInstanceId({ alias: 'bt1', data_table_id: 'dt-self-detail' });
    const anchorJoins = query.joins.filter(
      j => (j.left_instance_id === detailInstanceId || j.right_instance_id === detailInstanceId) && j.on.source_text.replace(/\s+/g, '') === '1=1'
    );
    expect(anchorJoins).toHaveLength(1);
  });
});
