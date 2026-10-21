/**
 * LinkedFormPanel.vue 面板级回归测试：
 *
 * 场景：联动表单节点「字段传递」/「打开条件」行打开高级表达式编辑器、改动文本、
 * 点「确定」——修改不生效（面板仍显示旧值、草稿不变脏、保存无动作文档写入）。根因是面板接 V4 宿主
 * 时漏了两件事：① 没声明 `provideRefSyntax('brackets')`；② 没把 V4 token 源码经 `v4Host.restore`
 * 还原成可读文本再喂给 `v4Ctx().readableTextOf`——用户编辑的实际是带内部标记 `#{rN}` 的 token 原文，
 * `AdvancedExpressionPanel.confirm()` 的花括号扫描（`buildLowerTextRefs`）把 `{r1}` 当成解析不到的
 * 字段占位符，报「未解析字段」并 `return`，从不 `emit('confirm', …)`。
 *
 * 本文件**真实挂载** LinkedFormPanel + 真实 ExpressionInput / AdvancedExpressionDialog /
 * ExpressionDialogShell / AdvancedExpressionPanel（confirm() 校验逻辑正是本坑现场，不能打桩）——
 * 只把最底层的 CodeMirror 编辑器 `ExpressionSqlEditor` 换成一个纯 `v-model` 直通桩（与共享包既有测试
 * 手法同款，见 expressionEditorWriteSelfAssignment.spec.ts 头注释「不打桩 ExpressionInput 与
 * ConditionEditorDialog」），因为 happy-dom 里驱动真实 CodeMirror 键入不现实；本坑的判定逻辑
 * （buildLowerTextRefs/confirm）完全在 AdvancedExpressionPanel 里，不依赖 CodeMirror 内部实现。
 *
 * 作用域约束：宿主的 V4 表达式服务实现中，restore/tokenize 依赖 `setScope` 装配的作用域信封
 * （目录来源 + 本报表来源）才能解析 `[目标单主表].[...]`/`[本表单主表].[...]` 这类引用，因此面板
 * 必须按 `linked_form_v4.query.sources` 调 `host.setScope`。本文件的 v4Host 替身同样**有作用域才能
 * restore/tokenize**（未 setScope 或作用域缺目标 catalog 来源/本报表来源时按失败形状返回 ok:false），
 * 并断言：setScope 被调用且入参含目标 catalog 来源（template_id=目标模板）与本报表主表来源。
 *
 * 做差自证：把 provideRefSyntax / readableTextOf 两处修复，或 LinkedFormPanel.vue 的
 * `syncScope`/`hostScopeFromDocument` 调用临时去掉，本文件相关用例均须红；修复后均须绿。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { defineComponent, h, nextTick, ref, type Component } from 'vue';
import { mount, DOMWrapper } from '@vue/test-utils';
import { NMessageProvider } from 'naive-ui';
import { ExpressionInput, provideExpressionHost, reportInstanceId, type AliceV4Host, type ExpressionHost, type V4HostScope } from '@kimposoft/expression-editor';
import LinkedFormPanel, { type LinkedFormFinalizeResult } from './LinkedFormPanel.vue';
import {
  LINKED_FORM_SCHEMA_VERSION,
  LINKED_FORM_SYNTAX_PROFILE,
  type LinkedFormNodeDocumentV4
} from './linkedFormV4Adapter';
import type { ActionDesignerHostApi } from './hostApi';
import type { TemplateDataTable, TemplateField } from './hostTypes';

const APP_ID = 'app-1';
const SELF_TEMPLATE_ID = 'tpl-self'; // 本表单
const TARGET_TEMPLATE_ID = 'tpl-target'; // 联动目标模板
const SELF_MAIN_DT = 'dt-self-main';
const TARGET_MAIN_DT = 'dt-target-main';

function field(fieldId: string, name: string, listVisible = false): TemplateField {
  return {
    field_id: fieldId,
    field_code: fieldId,
    field_name: name,
    data_type: 'text',
    display_style: 'text',
    sort_no: 0,
    is_searchable: true,
    is_filterable: true,
    is_sortable: true,
    is_list_visible: listVisible
  };
}
function table(dataTableId: string, name: string): TemplateDataTable {
  return {
    data_table_id: dataTableId,
    table_code: dataTableId,
    table_name: name,
    physical_table_name: dataTableId,
    table_role: 'main',
    sort_no: 0,
    field_count: 1,
    version_no: 1
  };
}

const SELF_FIELDS = [field('f_remark_src', '备注')];
const TARGET_FIELDS = [field('f_customer', '客户名称')];

/** hostApi 假实现：只填 LinkedFormPanel 真正调用的三个方法（listAppTemplates/listTemplateTables/
 *  listTemplateFields），其余整份接口按未使用短路成 `as unknown as ActionDesignerHostApi`。 */
function makeHostApi(): ActionDesignerHostApi {
  const impl = {
    listAppTemplates: async () => ({ data: { items: [{ template_id: TARGET_TEMPLATE_ID, template_name: '目标单' }] } }),
    listTemplateTables: async (_appId: string, tid: string) =>
      tid === TARGET_TEMPLATE_ID ? { data: { items: [table(TARGET_MAIN_DT, '目标单主表')] } } : { data: { items: [] } },
    listTemplateFields: async (_appId: string, tid: string, _versionNo: string | undefined, dataTableId: string) =>
      tid === TARGET_TEMPLATE_ID && dataTableId === TARGET_MAIN_DT ? { data: { items: TARGET_FIELDS } } : { data: { items: [] } }
  };
  return impl as unknown as ActionDesignerHostApi;
}

/** 本表单表达式域桥假实现（供 useExpressionContext 装配 bt0=本表单主表）。 */
function makeExpressionHost(): ExpressionHost {
  return {
    listTemplates: async () => [],
    listTables: async tid => (tid === SELF_TEMPLATE_ID ? [table(SELF_MAIN_DT, '本表单主表')] : []),
    listFields: async (_tid, dataTableId) => (dataTableId === SELF_MAIN_DT ? SELF_FIELDS : []),
    compilePreview: async () => ({ valid: true, arg_count: 0 }),
    loadCatalog: async () => ({ system_variables: [], functions: [], window_functions: [] }),
    lowerText: async req => ({ purpose: req.purpose, text_source: { text: req.text, pack_revision: 'test', digest: 'd' }, diagnostics: [] })
  };
}

/** ExpressionSqlEditor 桩：与共享包既有测试手法同款——只把 v-model 直通给外部，
 *  confirm() 的校验/tokenize 逻辑全在 AdvancedExpressionPanel 里，不依赖真实 CodeMirror。 */
const SqlEditorStub = defineComponent({
  inheritAttrs: false,
  props: ['modelValue'],
  emits: ['update:modelValue'],
  setup(_props, { expose }) {
    expose({ focus() {}, focusRange() {}, insertAtCursor() {} });
    return () => h('div', { 'data-testid': 'sql-editor-stub' });
  }
});
const SlotPassthrough = defineComponent({
  inheritAttrs: false,
  setup(_props, { slots }) {
    return () => h('div', [slots.trigger?.(), slots.default?.()]);
  }
});
const STUBS: Record<string, Component> = {
  NSelect: SlotPassthrough,
  NSwitch: SlotPassthrough,
  NPopover: SlotPassthrough,
  NTooltip: SlotPassthrough,
  FieldTreeDock: SlotPassthrough,
  OperatorFunctionBar: SlotPassthrough,
  ExpressionSqlEditor: SqlEditorStub
};

async function flushMounted(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0));
  for (let i = 0; i < 10; i += 1) await nextTick();
}

// 🔴 每个用例都用 attachTo: document.body 挂载（NModal 需要真实 body 才能 Teleport），若不清理，
// 前一个用例的弹窗 DOM（含页脚确定按钮 [data-kdlf="confirm"]
// 等跨用例同名选择器）会残留在 document.body 里，`document.body.querySelector(...)` 取到的可能是
// 前一个用例已关闭的旧节点而不是当前这次新开的对话框，表现为「点确定却看到的是上一条用例的旧文本」
// 这种诡异的假失败。统一用 afterEach 清空
// document.body，与 nodeConfigDialogFinalizeOnSave.spec.ts 同款纪律。
afterEach(() => {
  document.body.innerHTML = '';
});

/** 联动表单节点文档：打开条件 + 一条字段传递均带 `#{rN}` 内部标记的 token 化源码
 *  （与真实存档态一致）。 */
function tokenizedDoc(): LinkedFormNodeDocumentV4 {
  return {
    schema_version: LINKED_FORM_SCHEMA_VERSION,
    syntax_profile: LINKED_FORM_SYNTAX_PROFILE,
    query: {
      sources: [{ kind: 'catalog', instance_id: 't1', alias: '目标单主表', app_id: APP_ID, template_id: TARGET_TEMPLATE_ID, data_table_id: TARGET_MAIN_DT }],
      joins: [],
      options: { distinct: false, business_timezone: 'UTC' },
      filter: {
        expression_id: 'cond',
        purpose: 'filter',
        source_text: '[目标单主表].[单号]#{r1}',
        refs: [{ ref_id: 'r1', kind: 'source_field', source_instance_id: 't1', field_id: 'f_no', last_label: '[目标单主表].[单号]' }]
      }
    },
    target: { template_id: TARGET_TEMPLATE_ID, data_table_id: TARGET_MAIN_DT },
    preview: [],
    prefill: [
      {
        target_field_id: 'f_customer',
        fill_strategy: 'overwrite',
        expression: {
          expression_id: 'pf_f_customer',
          purpose: 'output',
          source_text: '[本表单主表].[备注]#{r1}',
          refs: [{ ref_id: 'r1', kind: 'report_field', source_instance_id: 'rpt-dt-self-main-000000', table_id: SELF_MAIN_DT, field_id: 'f_remark_src', last_label: '[本表单主表].[备注]' }]
        }
      }
    ]
  };
}

/** 已声明本报表来源的 instance_id：与 reconcileContext/共享包 reportInstanceId 的真实派生口径一致
 *  （按 data_table_id 的确定性 hash），不能用手写占位字符串——否则测不出「同一张表两次派生出同一
 *  instance_id」这个碰撞（见 linkedFormV4Adapter.spec.ts 同款注释）。 */
const SELF_MAIN_REPORT_INSTANCE_ID = reportInstanceId({ alias: '', data_table_id: SELF_MAIN_DT });

/** 联动表单节点文档：与 tokenizedDoc 同形，但 `query.sources` 已声明本报表主表来源——模拟「面板
 *  首次保存后」的存档态（文档一旦已声明过本报表来源，重开面板再编辑
 *  一次不应该再插出第二张同 data_table_id 的上下文表）。 */
function tokenizedDocWithReportSource(): LinkedFormNodeDocumentV4 {
  const doc = tokenizedDoc();
  return {
    ...doc,
    query: {
      ...doc.query,
      sources: [...doc.query.sources, { kind: 'report', instance_id: SELF_MAIN_REPORT_INSTANCE_ID, alias: '本表单主表', table_id: SELF_MAIN_DT, table_role: 'main' }]
    },
    prefill: doc.prefill.map(o => ({
      ...o,
      expression: { ...o.expression, refs: o.expression.refs.map(r => ({ ...r, source_instance_id: SELF_MAIN_REPORT_INSTANCE_ID })) }
    }))
  };
}

/** 目标目录来源的人工别名（alias 是「目标」，与目标模板/表的
 *  显示名「目标单主表」不同——任意人工命名，前端不能假设它等于模板名或表名）。 */
const TARGET_CATALOG_ALIAS = '目标';

/** 联动表单节点文档：`query.filter` 同时引用目标目录来源与本报表来源，且目录来源别名是人工命名
 *  「目标」（不等于 TARGET_MAIN_DT 的表名「目标单主表」）——用于验证
 *  ConditionEditorDialog 的来源目录与 tokenize 作用域是否用同一套别名。 */
function tokenizedDocWithMismatchedTargetAlias(): LinkedFormNodeDocumentV4 {
  const doc = tokenizedDoc();
  doc.query.sources = [{ kind: 'catalog', instance_id: 't1', alias: TARGET_CATALOG_ALIAS, app_id: APP_ID, template_id: TARGET_TEMPLATE_ID, data_table_id: TARGET_MAIN_DT }];
  doc.query.filter = {
    expression_id: 'cond',
    purpose: 'filter',
    source_text: `[${TARGET_CATALOG_ALIAS}].[单号]#{r1} = [本表单主表].[关联单号]#{r2}`,
    refs: [
      { ref_id: 'r1', kind: 'source_field', source_instance_id: 't1', field_id: 'f_no', last_label: `[${TARGET_CATALOG_ALIAS}].[单号]` },
      { ref_id: 'r2', kind: 'report_field', source_instance_id: SELF_MAIN_REPORT_INSTANCE_ID, table_id: SELF_MAIN_DT, field_id: 'f_ref_no', last_label: '[本表单主表].[关联单号]' }
    ]
  };
  return doc;
}

/** v4Host 替身的失败形状：照抄宿主真实场景下服务端「作用域里找不到来源实例」的
 *  诊断口径（code 为测试自定，服务端实际错误码不影响本文件断言——本文件只钉「未 emit」这一件事）。 */
function scopeMissingFailure(): { ok: false; diagnostics: Array<{ code: string; phase: string; severity: 'error'; message: string }> } {
  return { ok: false, diagnostics: [{ code: 'ALICE_SCOPE_SOURCE_NOT_FOUND', phase: 'bind', severity: 'error', message: '当前作用域找不到来源实例' }] };
}

/** 挂载 LinkedFormPanel：link_mode 由调用方指定（'create' 走字段传递用例，'open' 走打开条件用例）。
 *  v4Host 替身**有作用域才能 restore/tokenize**（与宿主真实实现同一约束——它按 setScope
 *  装配的作用域信封随请求体下发，服务端按信封解析 `[目标单主表].[...]`/`[本表单主表].[...]`；本桩
 *  用一个可变闭包变量模拟"当前作用域"，setScope 覆盖它，restore/tokenize 调用时检查它是否已含
 *  目标 catalog 来源 + 本报表主表来源，缺一则按失败形状返回，不看请求文本本身）。
 *  v4Host.restore 的可读文本按 `readable` 映射（key=expression_id）回显——真实宿主按 expression_id
 *  精确还原，这里用一个内部 Map 模拟，按 source_text 反查 key（测试夹具两处表达式源码互不相同，
 *  足以区分）。 */
/** v4Host.tokenize 替身的核心逻辑：按 `[表名].[字段]` 顺序扫描请求文本，
 *  把每个匹配换成同形态 + `#{rN}` 标记，并产出对应 refs 条目——`目标单主表` 落 kind=source_field
 *  （目录来源，source_instance_id='t1'），`本表单主表` 落 kind=report_field（本报表来源，
 *  source_instance_id=SELF_MAIN_REPORT_INSTANCE_ID），与宿主真实响应形状（source_text/
 *  refs 两者都变）同构。不认识的表名原样跳过（不产出 ref，模拟"作用域没有这张表"的真实后果——
 *  调用方若真引用了未在作用域里的表，refs 数组会缺这一条，后续断言据此可以钉住"解析不出"这件事）。 */
/** v4Host.tokenize 替身的核心解析逻辑：按 `[表名].[字段]` 顺序扫描请求文本，**严格按当前作用域
 *  （setScope 装配的别名，与宿主真实实现按 scope.sources[].alias / report_sources[].alias
 *  解析同一口径）**匹配表名——防的是：面板另起一份按模板名/表名拼的显示名喂给
 *  ConditionEditorDialog，与文档持久化的别名（可以是任意人工命名，如夹具的「目标」）不一致，一旦
 *  文档的目录来源别名被前端悄悄改写成别的字符串，用户仍在编辑框里看到/键入的旧标签就再也解析不出
 *  ——本替身据此严格复现：表名对不上 `scope` 当前任何一条来源的别名，就返回「找不到来源实例」，
 *  不按硬编码的字面量表名兜底放行。 */
function tokenizeBracketText(text: string, scope: V4HostScope): { ok: boolean; source_text: string; refs: Array<{ ref_id: string; kind: 'source_field' | 'report_field'; source_instance_id: string; table_id?: string; field_id: string; last_label: string }>; unresolvedAlias?: string } {
  const refs: ReturnType<typeof tokenizeBracketText>['refs'] = [];
  let n = 0;
  let unresolvedAlias: string | undefined;
  const source_text = text.replace(/\[([^\]]+)\]\.\[([^\]]+)\]/g, (whole, table: string, field: string) => {
    if (unresolvedAlias) return whole; // 已经报过一次找不到，后续匹配不再消耗（模拟服务端首错即停）。
    const catalogSrc = scope.sources.find(s => s.alias === table);
    if (catalogSrc) {
      n += 1;
      const refId = `r${n}`;
      refs.push({ ref_id: refId, kind: 'source_field', source_instance_id: catalogSrc.instance_id, field_id: field, last_label: whole });
      return `${whole}#{${refId}}`;
    }
    const reportSrc = scope.report_sources.find(s => s.alias === table);
    if (reportSrc) {
      n += 1;
      const refId = `r${n}`;
      refs.push({ ref_id: refId, kind: 'report_field', source_instance_id: reportSrc.instance_id, table_id: reportSrc.table_id, field_id: field, last_label: whole });
      return `${whole}#{${refId}}`;
    }
    unresolvedAlias = table; // 当前作用域里没有一条来源的别名等于这个表名——即「找不到来源实例」。
    return whole;
  });
  return { ok: !unresolvedAlias, source_text, refs, unresolvedAlias };
}

/** 「输出（output/value）用途根不得为谓词」诊断：与真实服务端一致——
 *  按 purpose 执行这条规则，output/value 用途下根节点是比较/逻辑谓词就拒；filter/condition/
 *  join_on 三个谓词类用途不受限。判据只做最小识别（顶层出现比较运算符），足以让「打开条件走错
 *  用途」这条路径在替身层面也报错、测得出（替身若不按用途执行这条规则就测不出该问题）。 */
const PREDICATE_PATTERN = /[=＝]|<>|[<>]=?|\bAND\b|\bOR\b/i;
function predicateRootDiagnostic(purpose: string, text: string): { code: string; phase: string; severity: 'error'; message: string } | null {
  if (purpose !== 'output' && purpose !== 'value') return null;
  if (!PREDICATE_PATTERN.test(text)) return null;
  return { code: 'ALICE_ROOT_MUST_BE_VALUE', phase: 'bind', severity: 'error', message: '输出表达式的根必须是值表达式，不能是比较/逻辑运算谓词' };
}

function mountPanel(linkMode: 'create' | 'open', readable: Record<string, string>, docBuilder: () => LinkedFormNodeDocumentV4 = tokenizedDoc) {
  let scope: V4HostScope = { sources: [], report_sources: [] };
  const scopeCalls: V4HostScope[] = [];
  /** 作用域是否已同时含「目标 catalog 来源」（template_id=目标模板）与「本报表主表来源」
   *  （table_id=本表单主表）——两者缺一，服务端就解析不出 `[目标单主表]`/`[本表单主表]` 这类引用。 */
  function scopeReady(): boolean {
    return (
      scope.sources.some(s => s.template_id === TARGET_TEMPLATE_ID && s.data_table_id === TARGET_MAIN_DT) &&
      scope.report_sources.some(s => s.table_id === SELF_MAIN_DT)
    );
  }
  const v4Host: AliceV4Host = {
    loadCatalog: async renamed => ({ renamed, sources: [], report: { tables: [] }, staging: { columns: [] }, functions: [], keywords: [] }),
    diagnose: async req => {
      const predicateDiag = predicateRootDiagnostic(req.purpose, req.text);
      if (predicateDiag) return { ok: false, tokens: [], ast: null, refs: [], envelope: null, digest: '', diagnostics: [predicateDiag] };
      return { ok: true, tokens: [], ast: null, refs: [], envelope: null, digest: '', diagnostics: [] };
    },
    tokenize: async req => {
      if (!scopeReady()) return { ...scopeMissingFailure(), source_text: '', refs: [], digest: '' };
      const predicateDiag = predicateRootDiagnostic(req.purpose, req.text);
      if (predicateDiag) return { ok: false, source_text: '', refs: [], digest: '', diagnostics: [predicateDiag] };
      const { ok, source_text, refs, unresolvedAlias } = tokenizeBracketText(req.text, scope);
      if (!ok) {
        return {
          ok: false,
          source_text: '',
          refs: [],
          digest: '',
          diagnostics: [{ code: 'ALICE_SOURCE_INSTANCE_NOT_FOUND', phase: 'bind', severity: 'error', message: `找不到来源实例 "${unresolvedAlias}"` }]
        };
      }
      return { ok: true, source_text, refs, digest: 'tok-digest', diagnostics: [] };
    },
    // restore 请求体不带 expression_id（见 V4RestoreRequest），本桩按 source_text 反查——测试夹具
    // 两处表达式源码互不相同，足以区分（真实宿主按 refs 语义解析，这里只需在测试里稳定复现）。
    restore: async req => {
      if (!scopeReady()) return { ...scopeMissingFailure(), text: req.source_text, digest: '' };
      // 按当前 docBuilder 产出的 filter 源码反查——不能写死对比 tokenizedDoc()：point-B 用例覆盖了
      // 一份跨来源的自定义 filter，与 tokenizedDoc() 默认夹具的 filter 文本不同，写死比较会误判成
      // 'prefill' 分支、回显错的可读文本（曾在本地复现过一次假绿/假红，即此坑）。
      const key = req.source_text === docBuilder().query.filter?.source_text ? 'filter' : 'prefill';
      return { ok: true, text: req.source_text, readable_text: readable[key] ?? req.source_text, digest: '', diagnostics: [] };
    },
    compile: async () => ({ ok: true, targets: [] }),
    setScope: s => {
      scope = s;
      scopeCalls.push(s);
    }
  };
  const patches: Array<Record<string, unknown>> = [];
  const Harness = defineComponent({
    setup() {
      // 模拟真实宿主页面（NodeConfigDialog）在挂载子面板之前已 provideExpressionHost 的既有事实：
      // Vue 的 inject() 只读父级的 provides，不读组件自身——LinkedFormPanel 内部
      // `if (v4Host && expressionHost) provideExpressionHost(createV4ExpressionHost(...))` 只对它
      // **自己的子树**（ExpressionInput 等）生效，它自己 `useExpressionContext()` 的 inject 命中的
      // 是这里、上一级祖先的 provide（与生产环境同一形状：ctx 用基础 3.4 桥即可，不需要 V4 包装，
      // 因为 ctx.load 只读 listTables/listFields，与 lowerText 的 V4 tokenize 接管无关）。
      provideExpressionHost(makeExpressionHost());
      return () =>
        h(NMessageProvider, null, {
          default: () =>
            h(LinkedFormPanel, {
              appId: APP_ID,
              templateId: SELF_TEMPLATE_ID,
              params: { link_mode: linkMode, template_id: TARGET_TEMPLATE_ID, linked_form_v4: docBuilder() },
              hostApi: makeHostApi(),
              v4Host,
              expressionHost: makeExpressionHost(),
              onPatch: (p: Record<string, unknown>) => patches.push(p)
            })
        });
    }
  });
  const wrapper = mount(Harness, { attachTo: document.body, global: { stubs: STUBS } });
  return { wrapper, patches, scopeCalls };
}

describe('LinkedFormPanel 高级表达式编辑器回归', () => {
  it('字段传递行：确定后面板 emit patch，新文本落 linked_form_v4.prefill[0].expression.source_text', async () => {
    const READABLE_PREFILL = '[本表单主表].[备注]';
    const { wrapper, patches, scopeCalls } = mountPanel('create', { prefill: READABLE_PREFILL });
    await flushMounted();

    // setScope 应已被调用，且最后一次入参同时含目标 catalog 来源（template_id=目标模板）与本报表
    // 主表来源——两者缺一，真实宿主 restore/tokenize 就解析不出 `[目标单主表]`/`[本表单主表]` 引用。
    expect(scopeCalls.length, 'v4Host.setScope 应至少被调用一次').toBeGreaterThan(0);
    const lastScope = scopeCalls[scopeCalls.length - 1];
    expect(lastScope.sources.some(s => s.template_id === TARGET_TEMPLATE_ID && s.data_table_id === TARGET_MAIN_DT), `作用域应含目标 catalog 来源；实际 ${JSON.stringify(lastScope.sources)}`).toBe(true);
    expect(lastScope.report_sources.some(s => s.table_id === SELF_MAIN_DT), `作用域应含本报表主表来源；实际 ${JSON.stringify(lastScope.report_sources)}`).toBe(true);

    const fillRow = wrapper.find('[data-testid="linked-fill-0"]');
    expect(fillRow.exists(), '字段传递行应已渲染').toBe(true);
    const exprInput = fillRow.findComponent(ExpressionInput as any);
    expect(exprInput.exists(), '字段传递行应挂载 ExpressionInput').toBe(true);

    await exprInput.find('[data-testid="expr-fx-entry"]').trigger('click');
    await flushMounted();

    // ① 显示文本必须是可读文本（不含内部标记 `#{r`）——本坑修复前，这里会是 token 原文。
    const sqlEditor = wrapper.findComponent(SqlEditorStub as any);
    expect(sqlEditor.exists(), '高级表达式面板应已渲染（NModal 传送到 body，findComponent 仍可从根 wrapper 找到）').toBe(true);
    expect(sqlEditor.props('modelValue')).toBe(READABLE_PREFILL);
    expect(sqlEditor.props('modelValue')).not.toContain('#{r');

    // ② 修改字面量（v4Host 替身按 purpose 执行「output 用途根不得为谓词」
    //    这条服务端规则——字段传递是 output 用途，编辑内容必须仍是值表达式，不能是比较/逻辑谓词，
    //    故这里换成函数包裹而非直接拼一段 `AND 1 = 1` 比较谓词）。
    const NEW_TEXT = `CONCAT(${READABLE_PREFILL}, '-x')`;
    sqlEditor.vm.$emit('update:modelValue', NEW_TEXT);
    await flushMounted();

    // ③ 点「确定」：修复前会被 buildLowerTextRefs 的未解析字段判据拦下（文本仍含 `#{r1}`）、
    //    不 emit；修复后面板应收到 patch。
    const confirmBtn = document.body.querySelector('.exd-footer [data-kdlf="confirm"]');
    expect(confirmBtn, '确定按钮应已渲染（KDialog 传送到 document.body）').not.toBeNull();
    await new DOMWrapper(confirmBtn as Element).trigger('click');
    await flushMounted();

    const patch = [...patches].reverse().find(p => 'linked_form_v4' in p); // 取最后一次含 linked_form_v4 的 patch：mini-reconcile/目标主表 watch 等既有逻辑在挂载期也可能先 patch 过一次（与本次确定无关），断言应对准「确定」这一次落的最终值。
    expect(patch, `面板应至少 emit 一次带 linked_form_v4 的 patch；实际收到 ${patches.length} 次 patch`).toBeTruthy();
    const doc = patch!.linked_form_v4 as LinkedFormNodeDocumentV4;
    expect(doc.prefill[0].expression.source_text).toBe(NEW_TEXT);
    expect(doc.prefill[0].expression.refs).toEqual([]);
  });

  it('打开条件行：确定后面板 emit patch，新文本落 linked_form_v4.query.filter.source_text', async () => {
    const READABLE_FILTER = '[目标单主表].[单号]';
    const { wrapper, patches } = mountPanel('open', { filter: READABLE_FILTER });
    await flushMounted();

    // 打开条件走 ConditionEditorDialog（purpose='where'→V4 'filter'——不是
    // ExpressionInput/expr-fx-entry，那条路径恒把 3.4 侧 purpose 钉死成 'value'→V4 'output'，见
    // LinkedFormPanel.vue 同名 script 注释）：整个触发区可点，不需要先找子入口。
    const trigger = wrapper.find('[data-testid="linked-open-condition"]');
    expect(trigger.exists(), '打开条件触发区应已渲染').toBe(true);
    await trigger.trigger('click');
    await flushMounted();

    const sqlEditor = wrapper.findComponent(SqlEditorStub as any);
    expect(sqlEditor.exists()).toBe(true);
    expect(sqlEditor.props('modelValue')).toBe(READABLE_FILTER);
    expect(sqlEditor.props('modelValue')).not.toContain('#{r');

    const NEW_TEXT = `${READABLE_FILTER} = 'X001'`;
    sqlEditor.vm.$emit('update:modelValue', NEW_TEXT);
    await flushMounted();

    const confirmBtn = document.body.querySelector('.exd-footer [data-kdlf="confirm"]');
    expect(confirmBtn).not.toBeNull();
    await new DOMWrapper(confirmBtn as Element).trigger('click');
    await flushMounted();

    const patch = [...patches].reverse().find(p => 'linked_form_v4' in p); // 取最后一次含 linked_form_v4 的 patch：mini-reconcile/目标主表 watch 等既有逻辑在挂载期也可能先 patch 过一次（与本次确定无关），断言应对准「确定」这一次落的最终值。
    expect(patch, `面板应至少 emit 一次带 linked_form_v4 的 patch；实际收到 ${patches.length} 次 patch`).toBeTruthy();
    const doc = patch!.linked_form_v4 as LinkedFormNodeDocumentV4;
    expect(doc.query.filter?.source_text).toBe(NEW_TEXT);
    expect(doc.query.filter?.refs).toEqual([]);
  });

  it('打开条件行：条件同时引用目标+本报表字段，用 CONCAT 包裹一侧后确定，对话框应关闭、面板应更新（不是「根必须是值表达式」报错卡死）', async () => {
    // 贴近实际使用的条件文本：`目标.[单号] = 本表单.[关联单号]`（跨目录+本报表两类来源），
    // 且编辑动作是右侧包一层 CONCAT(…, '')——问题现象是报错「✕ 输出表达式的根必须是值表达式，不能是
    // 比较/逻辑运算谓词」，本用例的 v4Host 替身用 predicateRootDiagnostic 按 purpose 复现同一条
    // 服务端规则：output/value 用途下根是谓词就拒，filter 用途不受限。
    const READABLE_FILTER = '[目标单主表].[单号] = [本表单主表].[关联单号]';
    const doc = tokenizedDoc();
    doc.query.filter = {
      expression_id: 'cond',
      purpose: 'filter',
      source_text: '[目标单主表].[单号]#{r1} = [本表单主表].[关联单号]#{r2}',
      refs: [
        { ref_id: 'r1', kind: 'source_field', source_instance_id: 't1', field_id: 'f_no', last_label: '[目标单主表].[单号]' },
        { ref_id: 'r2', kind: 'report_field', source_instance_id: SELF_MAIN_REPORT_INSTANCE_ID, table_id: SELF_MAIN_DT, field_id: 'f_ref_no', last_label: '[本表单主表].[关联单号]' }
      ]
    };
    const { wrapper, patches } = mountPanel('open', { filter: READABLE_FILTER }, () => doc);
    await flushMounted();

    const trigger = wrapper.find('[data-testid="linked-open-condition"]');
    expect(trigger.exists()).toBe(true);
    await trigger.trigger('click');
    await flushMounted();

    const sqlEditor = wrapper.findComponent(SqlEditorStub as any);
    expect(sqlEditor.exists()).toBe(true);
    expect(sqlEditor.props('modelValue'), '显示文本应是可读文本（跨来源同样不含内部标记）').toBe(READABLE_FILTER);

    // 右侧包一层 CONCAT(…, '')——触发该问题的具体编辑动作（合法、且改变了文本）。
    const NEW_TEXT = "[目标单主表].[单号] = CONCAT([本表单主表].[关联单号], '')";
    sqlEditor.vm.$emit('update:modelValue', NEW_TEXT);
    await flushMounted();

    const confirmBtn = document.body.querySelector('.exd-footer [data-kdlf="confirm"]');
    expect(confirmBtn, '确定按钮应已渲染').not.toBeNull();
    // 问题现象：确定按钮变禁用、对话框不关。这里不预判按钮 disabled 属性（jsdom 下 NButton
    // disabled 的具体渲染形态不是本用例要钉的点），直接点击、用「对话框是否关闭 + 是否 emit」
    // 兜底判定——按钮若真被禁用，click 不会触发 confirm()，下面两个断言会照样失败（红）。
    await new DOMWrapper(confirmBtn as Element).trigger('click');
    await flushMounted();

    // 「对话框不关」的对照断言：NModal 默认按 CSS display 切换显隐（不卸载 DOM），壳根
    // （data-testid="condition-editor-dialog"）关闭后 inline style 会带 display:none——不能按节点是否
    // 还在 DOM 里判断（一直都在，只是隐藏），必须看这个样式。
    const shellEl = document.body.querySelector<HTMLElement>('[data-testid="condition-editor-dialog"]');
    expect(shellEl?.style.display, '确定后对话框应已关闭（display:none）').toBe('none');

    const patch = [...patches].reverse().find(p => 'linked_form_v4' in p);
    expect(patch, `面板应至少 emit 一次带 linked_form_v4 的 patch（问题现象：零 PUT，即完全没有这次 patch）；实际收到 ${patches.length} 次 patch`).toBeTruthy();
    const savedDoc = patch!.linked_form_v4 as LinkedFormNodeDocumentV4;
    expect(savedDoc.query.filter?.source_text).toBe(NEW_TEXT);
  });

  it('初始文档已声明本报表来源：改预填→确定后，emit 的 patch 里 query.sources 无重复 instance_id 且含新文本', async () => {
    const READABLE_PREFILL = '[本表单主表].[备注]';
    const { wrapper, patches } = mountPanel('create', { prefill: READABLE_PREFILL }, tokenizedDocWithReportSource);
    await flushMounted();

    const fillRow = wrapper.find('[data-testid="linked-fill-0"]');
    expect(fillRow.exists(), '字段传递行应已渲染').toBe(true);
    const exprInput = fillRow.findComponent(ExpressionInput as any);
    expect(exprInput.exists()).toBe(true);

    await exprInput.find('[data-testid="expr-fx-entry"]').trigger('click');
    await flushMounted();

    const sqlEditor = wrapper.findComponent(SqlEditorStub as any);
    expect(sqlEditor.exists()).toBe(true);
    expect(sqlEditor.props('modelValue')).toBe(READABLE_PREFILL);

    const NEW_TEXT = '[本表单主表].[摘要]';
    sqlEditor.vm.$emit('update:modelValue', NEW_TEXT);
    await flushMounted();

    const confirmBtn = document.body.querySelector('.exd-footer [data-kdlf="confirm"]');
    expect(confirmBtn).not.toBeNull();
    await new DOMWrapper(confirmBtn as Element).trigger('click');
    await flushMounted();

    const patch = [...patches].reverse().find(p => 'linked_form_v4' in p);
    expect(patch, `面板应至少 emit 一次带 linked_form_v4 的 patch；实际收到 ${patches.length} 次 patch`).toBeTruthy();
    const doc = patch!.linked_form_v4 as LinkedFormNodeDocumentV4;

    // 核心断言：本报表来源（kind=report）恰好 1 条，instance_id 不重复——修复前 reconcileContext
    // 会在已声明的 rpt-… 表之外再插一张别名 bt0、同 data_table_id 的表，两者经 modelToV4Query 落出
    // 同一个 instance_id，被服务端保存闸判「source 重复」拒绝（EXPR_LINKED_FORM_V4_SHAPE_INVALID）。
    const reportSources = doc.query.sources.filter(s => s.kind === 'report');
    expect(reportSources, `本报表来源应恰好 1 条；实际 ${JSON.stringify(reportSources)}`).toHaveLength(1);
    expect(reportSources[0].instance_id).toBe(SELF_MAIN_REPORT_INSTANCE_ID);
    // sources 整体也不应有重复 instance_id（覆盖目录来源 + 本报表来源一起看）。
    const instanceIds = doc.query.sources.map(s => s.instance_id);
    expect(new Set(instanceIds).size, `query.sources 不应有重复 instance_id；实际 ${JSON.stringify(instanceIds)}`).toBe(instanceIds.length);

    expect(doc.prefill[0].expression.source_text).toBe(NEW_TEXT);
  });
});

/** 从挂载好的 wrapper 里取 LinkedFormPanel 实例暴露的 finalize（保存前收口）。 */
function finalizeOf(wrapper: ReturnType<typeof mountPanel>['wrapper']): () => Promise<LinkedFormFinalizeResult> {
  const panel = wrapper.findComponent(LinkedFormPanel as any);
  expect(panel.exists(), 'LinkedFormPanel 应已挂载').toBe(true);
  return (panel.vm as unknown as { finalize: () => Promise<LinkedFormFinalizeResult> }).finalize;
}

describe('LinkedFormPanel.finalize()（保存前收口）', () => {
  it('字段传递行：改预填→确定→调 finalize，prefill[0].expression 的 refs 非空、source_text 含 #{r1}', async () => {
    const READABLE_PREFILL = '[本表单主表].[备注]';
    const { wrapper } = mountPanel('create', { prefill: READABLE_PREFILL });
    await flushMounted();

    const fillRow = wrapper.find('[data-testid="linked-fill-0"]');
    const exprInput = fillRow.findComponent(ExpressionInput as any);
    await exprInput.find('[data-testid="expr-fx-entry"]').trigger('click');
    await flushMounted();
    const sqlEditor = wrapper.findComponent(SqlEditorStub as any);
    const NEW_TEXT = '[本表单主表].[摘要]';
    sqlEditor.vm.$emit('update:modelValue', NEW_TEXT);
    await flushMounted();
    const confirmBtn = document.body.querySelector('.exd-footer [data-kdlf="confirm"]');
    await new DOMWrapper(confirmBtn as Element).trigger('click');
    await flushMounted();

    // 此刻面板 patch 出的 prefill[0].expression 是「可读文本 + refs:[]」（confirm 走的是
    // lowerText，其产物有意不落 tokenize 的 refs，见 valueRefToV4Expression 头注释）——保存前必须
    // 再过一遍 finalize 才会真正 tokenize、把 refs 补齐。
    const result = await finalizeOf(wrapper)();
    expect(result.ok, `finalize 应成功；诊断：${JSON.stringify(result.diagnostics)}`).toBe(true);
    expect(result.doc.prefill[0].expression.source_text).toContain('#{r1}');
    expect(result.doc.prefill[0].expression.refs.length).toBeGreaterThan(0);
    expect(result.doc.prefill[0].expression.refs[0].kind).toBe('report_field');
  });

  it('tokenize 失败（作用域缺失）时 finalize 返回失败，不回写 patch', async () => {
    // 不调用 setScope 的等价场景不易在真实交互里触发（面板挂载即 syncScope），这里直接构造一份
    // v4Host.tokenize 恒失败的替身，钉住「tokenize 失败 → finalize ok:false → 不 patch」这条链路
    // 本身（作用域缺失只是 tokenize 失败的一种诱因，不是本用例要覆盖的点）。
    // 🔴 doc 必须带一条 refs:[] 的表达式（可读文本、未 tokenize 过）——tokenizeInPlace 对 refs 已
    // 非空的表达式（tokenizedDoc() 默认夹具那样，模拟已存档态）直接跳过、根本不会调 host.tokenize，
    // 下面覆盖的恒失败替身也就测不出东西（曾在本地复现过一次假绿：用默认 tokenizedDoc() 时 refs
    // 非空全被跳过，ok 恒 true）。
    const doc = tokenizedDoc();
    doc.prefill[0].expression.source_text = '[本表单主表].[备注]';
    doc.prefill[0].expression.refs = [];
    const { wrapper, patches } = mountPanel('create', {}, () => doc);
    await flushMounted();
    const panel = wrapper.findComponent(LinkedFormPanel as any);
    // 直接覆盖 props.v4Host.tokenize（v4Host 对象在 mountPanel 内部按引用传入，篡改其方法即可让
    // 后续 finalize() 调用的是这个恒失败版本，不影响本测试前面已经走过的 confirm 流程）。
    const v4Host = panel.props('v4Host') as AliceV4Host;
    v4Host.tokenize = async () => ({ ok: false, source_text: '', refs: [], digest: '', diagnostics: [{ code: 'BIND_FAILED', phase: 'bind', severity: 'error', message: '本报表下找不到数据表' }] });

    const patchCountBefore = patches.length;
    const result = await finalizeOf(wrapper)();
    expect(result.ok).toBe(false);
    expect(result.diagnostics.some(d => d.diagnostic.severity === 'error')).toBe(true);
    expect(patches.length, 'finalize 失败不应再 patch').toBe(patchCountBefore);
  });

  it('初始 sources 为空、预填已引用本报表字段：finalize 后 query.sources 恰好补出 1 条 kind=report 来源', async () => {
    // 起点：query.sources 只有 t1（目标目录来源），没有任何 kind=report 条目；prefill 表达式已是
    // 「可读文本 + refs:[]」（面板展示态默认形状，未经用户再编辑）。
    const doc = tokenizedDoc(); // sources=[t1]；prefill[0].expression.source_text 含 #{r1} 内部标记。
    // 把预填表达式改造成"未 tokenize 过的可读文本"（refs:[]，source_text 不含内部标记）——对应
    // finalize 场景②"未编辑但也不是标准存档态"，即 tokenizeInPlace 该出手绑定的那一档。
    doc.prefill[0].expression.source_text = '[本表单主表].[备注]';
    doc.prefill[0].expression.refs = [];
    const { wrapper } = mountPanel('create', {}, () => doc);
    await flushMounted();

    expect(doc.query.sources.some(s => s.kind === 'report')).toBe(false); // 复核起点确实为空。

    const result = await finalizeOf(wrapper)();
    expect(result.ok, `finalize 应成功；诊断：${JSON.stringify(result.diagnostics)}`).toBe(true);
    const reportSources = result.doc.query.sources.filter(s => s.kind === 'report');
    expect(reportSources, `query.sources 应恰好补出 1 条本报表来源；实际 ${JSON.stringify(result.doc.query.sources)}`).toHaveLength(1);
    expect(reportSources[0].table_id).toBe(SELF_MAIN_DT);
    expect(reportSources[0].instance_id).toBe(SELF_MAIN_REPORT_INSTANCE_ID);
    // 锚定关联：从目录来源 t1 出发、ON 恒真，引入这张新补的 report 来源（否则服务端 Join 图判它
    // 「从未被任何关联引入」）。
    const anchorJoin = result.doc.query.joins.find(j => j.right_instance_id === SELF_MAIN_REPORT_INSTANCE_ID);
    expect(anchorJoin, `应补一条锚定关联引入新 report 来源；实际 joins=${JSON.stringify(result.doc.query.joins)}`).toBeTruthy();
    expect(anchorJoin!.left_instance_id).toBe('t1');
    expect(anchorJoin!.on.source_text.replace(/\s+/g, '')).toBe('1=1');
  });
});

/** 打开条件确定的完整交互：点触发区 → 改右侧包 CONCAT → 点确定 → 断言对话框关闭 + patch 的
 *  query.filter.source_text 为新文本。下方两条别名一致性用例共用。 */
async function editConditionWithConcatAndConfirm(
  wrapper: ReturnType<typeof mountPanel>['wrapper'],
  readableFilter: string,
  // 新文本按调用方需要给（不在本函数内用正则从 readableFilter 派生）：用例②对"面板自己保存出来
  // 的文档"再编辑一次时，readableFilter 本身已经是第一次编辑包过 CONCAT 的结果，若仍按同一个正则
  // 再包一层会在断言侧产生"套娃 CONCAT"的自证陷阱（曾在本地复现过一次假红：断言按正则重算出双层
  // 包裹的期望值，但看不出这跟真正要测的"来源别名解析"其实无关，纯属测试自己的计算口径分裂）。
  newText: string = readableFilter.replace(/\[本表单主表\]\.\[[^\]]+\]/, m => `CONCAT(${m}, '')`)
): Promise<string> {
  const trigger = wrapper.find('[data-testid="linked-open-condition"]');
  expect(trigger.exists(), '打开条件触发区应已渲染').toBe(true);
  await trigger.trigger('click');
  await flushMounted();

  const sqlEditor = wrapper.findComponent(SqlEditorStub as any);
  expect(sqlEditor.exists()).toBe(true);
  expect(sqlEditor.props('modelValue'), '显示文本应是可读文本、且用文档里持久化的别名（不是另起的模板名/表名）').toBe(readableFilter);

  sqlEditor.vm.$emit('update:modelValue', newText);
  await flushMounted();

  const confirmBtn = document.body.querySelector('.exd-footer [data-kdlf="confirm"]');
  expect(confirmBtn, '确定按钮应已渲染').not.toBeNull();
  await new DOMWrapper(confirmBtn as Element).trigger('click');
  await flushMounted();

  const shellEl = document.body.querySelector<HTMLElement>('[data-testid="condition-editor-dialog"]');
  expect(shellEl?.style.display, '确定后对话框应已关闭（display:none）').toBe('none');

  return newText;
}

describe('LinkedFormPanel 打开条件的来源别名一致性（ConditionEditorDialog 的目录来源与 tokenize 作用域须同一套别名）', () => {
  it('①目标来源别名与模板/表名不同（alias="目标"）：打开条件→改右侧包 CONCAT→确定成功，finalize 后 refs 同时含目标 source_field 与本报表 report_field', async () => {
    const READABLE_FILTER = `[${TARGET_CATALOG_ALIAS}].[单号] = [本表单主表].[关联单号]`;
    const { wrapper, patches } = mountPanel('open', { filter: READABLE_FILTER }, tokenizedDocWithMismatchedTargetAlias);
    await flushMounted();

    const newText = await editConditionWithConcatAndConfirm(wrapper, READABLE_FILTER);

    const patch = [...patches].reverse().find(p => 'linked_form_v4' in p);
    expect(patch, `面板应至少 emit 一次带 linked_form_v4 的 patch；实际收到 ${patches.length} 次 patch`).toBeTruthy();
    const doc = patch!.linked_form_v4 as LinkedFormNodeDocumentV4;
    expect(doc.query.filter?.source_text).toBe(newText);

    // 关键核对：round-trip 不应把持久化的人工别名「目标」悄悄改写成表名/模板名——否则这一次能过，
    // 下一次编辑（面板自己保存出来的文档，见用例②）就会因为作用域已经变成新别名而解析不到旧文本
    // 里仍写着的「目标」。
    const catalogSource = doc.query.sources.find(s => s.kind === 'catalog');
    expect(catalogSource?.alias, 'round-trip 后目录来源别名应保持「目标」不变').toBe(TARGET_CATALOG_ALIAS);

    const panelVm = wrapper.findComponent(LinkedFormPanel as any).vm as unknown as { finalize: () => Promise<LinkedFormFinalizeResult> };
    const result = await panelVm.finalize();
    expect(result.ok, `finalize 应成功；诊断：${JSON.stringify(result.diagnostics)}`).toBe(true);
    expect(result.doc.query.filter?.source_text).toContain('#{r');
    const refKinds = result.doc.query.filter?.refs.map(r => r.kind) ?? [];
    expect(refKinds).toContain('source_field');
    expect(refKinds).toContain('report_field');
  });

  it('②面板自己保存出来的文档：先确认一次条件编辑（产出一份"已保存过"的文档），拿它当初始文档重新挂载，再次打开条件编辑并确定仍应成功', async () => {
    const READABLE_FILTER = `[${TARGET_CATALOG_ALIAS}].[单号] = [本表单主表].[关联单号]`;
    const first = mountPanel('open', { filter: READABLE_FILTER }, tokenizedDocWithMismatchedTargetAlias);
    await flushMounted();
    await editConditionWithConcatAndConfirm(first.wrapper, READABLE_FILTER);
    const savedDoc = [...first.patches].reverse().find(p => 'linked_form_v4' in p)!.linked_form_v4 as LinkedFormNodeDocumentV4;
    // 保存出来的这份文档，本身就是「面板自己产出的形状」——round-trip 后目录来源别名仍应是「目标」
    // （见用例①同一断言）；用它当第二次挂载的初始文档，模拟「先编辑一次、再编辑一次」的时序。
    expect(savedDoc.query.sources.find(s => s.kind === 'catalog')?.alias).toBe(TARGET_CATALOG_ALIAS);

    const savedReadableFilter = savedDoc.query.filter!.source_text; // finalize 前是可读文本本身（未 tokenize，refs 已被 confirm 清空）。
    first.wrapper.unmount(); // 挂载第二个面板前先卸载第一个——避免两个独立 mount() 实例同时挂在 document.body 下相互干扰。
    const second = mountPanel('open', { filter: savedReadableFilter }, () => savedDoc);
    await flushMounted();

    // 第二次编辑换成包左侧（目标来源那一侧）——不再对第一次已经包过 CONCAT 的右侧重复包一层，
    // 两次编辑的"新文本"互相独立、断言口径不叠加。
    const newText2Expected = savedReadableFilter.replace(new RegExp(`\\[${TARGET_CATALOG_ALIAS}\\]\\.\\[[^\\]]+\\]`), m => `CONCAT(${m}, '2')`);
    const newText2 = await editConditionWithConcatAndConfirm(second.wrapper, savedReadableFilter, newText2Expected);
    const patch2 = [...second.patches].reverse().find(p => 'linked_form_v4' in p);
    expect(patch2, `第二次编辑面板应至少 emit 一次带 linked_form_v4 的 patch；实际收到 ${second.patches.length} 次 patch`).toBeTruthy();
    const doc2 = patch2!.linked_form_v4 as LinkedFormNodeDocumentV4;
    expect(doc2.query.filter?.source_text).toBe(newText2);
  });
});
