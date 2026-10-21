/**
 * linkedFormV4Adapter —— 联动表单节点文档（`linked_form_v4`，`kimpo.linked-form-node/v4`）⇄ 3.4
 * 查询模型（ExpressionModel）双向适配（本插件私有 · 设计态）。
 *
 * # 背景
 *
 * 联动表单动作（ui.linked_form）的查询由节点参数键 `linked_form_v4`（V4 文档）承载，旧键 `query`
 * （3.4 ExpressionModel）不再写、不再读。权威形状由宿主后端定义（`LinkedFormDocumentV4` 及其
 * JSON Schema `linked_form_node_document_v4.schema.json`）。
 *
 * # 做法：照抄取数节点配置面的换轨手法，不重写编辑器
 *
 * `LinkedFormPanel.vue` 继续挂载 3.4 本体 `ExpressionInput`，用户编辑的仍是结构化 ExpressionModel；
 * 本文件只做「模型形状翻译」，语义与 `@kimposoft/expression-editor` 共享包的 V4
 * expressionModelAdapter（取数节点的同角色适配器）对齐——不改共享包，故本文件是**本插件内的小适配层**，把联动
 * 表单文档包装成共享包函数能吃的形状再拆回来：
 *
 *   - 来源/关联段（`query.sources`/`query.joins`）与取数节点逐字同构（同为 `V4QueryDefinition`），
 *     直接复用共享包导出的 `v4QueryToModelSource`/`modelToV4Query`，不重复实现；
 *   - 「打开条件」（`query.filter`）与取数节点的筛选条件同型——一条表达式，走
 *     `v4ExpressionToValueRef`/`valueRefToV4Expression`，落 `ExpressionModel.where_expr`
 *     （本面板既有约定：`LinkedFormPanel.vue` 用 `exprOnly` 的 `ExpressionInput` 直接编辑整段表达式，
 *     不走引导式 WHERE 树，与取数节点「恒表达式模式」同一 UI 形态，见该文件适配层头注释）；
 *   - 「新建后的字段传递」（`prefill`）与取数节点的填充输出同型（`V4FillOutput[]`），同样走
 *     `v4ExpressionToValueRef`/`valueRefToV4Expression`，落 `ExpressionModel.target.outputs`
 *     （目标模板固定本表单模板——本面板「字段传递」表达式只允许引用本报表字段，与取数节点填充
 *     目标「目标模板恒为本模板」同一惯例）；
 *   - 「打开模式的预览列」（`preview`）**不经** ExpressionModel 往返：它由面板按目标表字段的可见性
 *     设置自动生成（`LinkedFormPanel.vue` 既有逻辑，不手选），每条都是确定性的
 *     单字段引用 `[目标表字段].[字段]`，本文件提供 `singleFieldFillOutput` 直接产出 V4 token 化
 *     文本 + 绑定表，不必经表达式输入框/host tokenize 一圈（对照共享包 `predicatesToJoinOn` 同款
 *     token 惯例手写，那个函数未导出，故本文件按同一形态自行产出）。
 *
 * 共享包只提供「取数节点文档」形状（`V4ExtractNodeDocument`，多目标数组 + 可选图表/暂存段），联动
 * 表单文档是更窄的四段式（query/target/preview/prefill）——本文件不把整份文档硬套进
 * `V4ExtractNodeDocument`，只在需要复用 query 段函数时按需取用其 query 子形状（两者的 `query` 字段
 * 逐字同型：`V4QueryDefinition`），避免为了复用而伪造一份取数节点特有的 targets/staging 字段。
 */
import {
  emptyExpressionModel,
  v4ExpressionToValueRef,
  valueRefToV4Expression,
  v4QueryToModelSource,
  modelToV4Query,
  type ExpressionModel,
  type V4ExpressionDocument,
  type V4FillOutput,
  type V4JoinDefinition,
  type V4ModelAdapterContext,
  type V4QueryDefinition
} from '@kimposoft/expression-editor';

/** `linked_form_v4` 文档 `schema_version`/`syntax_profile` 常量，与后端
 *  `linkedformdoc.SchemaVersionV4`/`SyntaxProfileMSSQL` 逐字对应。 */
export const LINKED_FORM_SCHEMA_VERSION = 'kimpo.linked-form-node/v4' as const;
export const LINKED_FORM_SYNTAX_PROFILE = 'kimposql.mssql/v1' as const;

/** 联动表单目标：目标模板主表。与后端 `linkedformdoc.LinkedFormTarget` 同形。 */
export interface LinkedFormTargetV4 {
  template_id: string;
  data_table_id: string;
}

/** 联动表单节点文档。与后端 `linkedformdoc.LinkedFormDocumentV4` / 同名 JSON Schema 逐字段对应
 *  ——`preview`/`prefill` 均为 required 数组（未提供 ≠ 空数组的语义区分见后端类型注释），本文件产出
 *  时恒显式给出空数组，不留 undefined。 */
export interface LinkedFormNodeDocumentV4 {
  schema_version: typeof LINKED_FORM_SCHEMA_VERSION;
  syntax_profile: typeof LINKED_FORM_SYNTAX_PROFILE;
  query: V4QueryDefinition;
  target: LinkedFormTargetV4;
  preview: V4FillOutput[];
  prefill: V4FillOutput[];
}

/** 空白联动表单节点文档：新建节点、或节点只带旧 `query` 键（未迁移的存量测试夹具）时的兜底起点。 */
export function emptyLinkedFormDocumentV4(): LinkedFormNodeDocumentV4 {
  return {
    schema_version: LINKED_FORM_SCHEMA_VERSION,
    syntax_profile: LINKED_FORM_SYNTAX_PROFILE,
    query: { sources: [], joins: [], options: { distinct: false, business_timezone: 'UTC' } },
    target: { template_id: '', data_table_id: '' },
    preview: [],
    prefill: []
  };
}

/** 形状守卫：`schema_version` 命中即认为是本文档形态。旧 `query` 键（ExpressionModel）/ 字段缺失
 *  （新建节点）均不命中，调用方按空白文档打开（不崩溃、不新增提示文案）。 */
export function isLinkedFormNodeDocumentV4(v: unknown): v is LinkedFormNodeDocumentV4 {
  return !!v && typeof v === 'object' && (v as { schema_version?: unknown }).schema_version === LINKED_FORM_SCHEMA_VERSION;
}

// ── 打开条件 / 字段传递：经 ExpressionModel 往返 ──────────────────────────────────────────────

/**
 * 联动表单节点文档 → ExpressionModel（面板读入，供现有 `ExpressionInput`/`reconcileContext` 消费）。
 *
 * - `source`：经 `v4QueryToModelSource` 翻译来源/关联（与取数节点同构，直接复用）；
 * - `where_expr`：`doc.query.filter` 经 `v4ExpressionToValueRef` 落成单条 raw ValueRef（本面板
 *   `whereExpr` 既有绑定形态）；
 * - `target.outputs`：`doc.prefill` 逐条经 `v4ExpressionToValueRef` 翻译（本面板「字段传递」
 *   `fillRows` 既有绑定形态）。
 *
 * `preview` 不落入本函数：它是面板自动生成的只读派生数据，不经 ExpressionModel 往返（见
 * `singleFieldFillOutput`），调用方（面板）另行直读 `doc.preview` 展示/比对。
 */
export function linkedFormV4DocToExpressionModel(doc: LinkedFormNodeDocumentV4, ctx: V4ModelAdapterContext): ExpressionModel {
  const { source } = v4QueryToModelSource(doc.query, ctx);
  const model: ExpressionModel = {
    ...emptyExpressionModel(ctx.templateId),
    source,
    target: {
      target_template_id: ctx.templateId,
      target_data_table_id: '',
      outputs: doc.prefill.map(o => v4FillOutputToOutputMapping(o, ctx))
    }
  };
  if (doc.query.filter) model.where_expr = v4ExpressionToValueRef(doc.query.filter, ctx);
  return model;
}

/** V4 填充输出 → 3.4 输出映射。与共享包 `expressionModelAdapter.ts` 内未导出的同名私有函数
 *  `fillOutputToMapping` 同一形状（该函数只在包内部可见，本文件按同一约定在插件侧重写一份）。 */
function v4FillOutputToOutputMapping(
  out: V4FillOutput,
  ctx: V4ModelAdapterContext
): { target_field_id: string; expression: ReturnType<typeof v4ExpressionToValueRef>; fill_strategy: V4FillOutput['fill_strategy']; separator?: string } {
  return {
    target_field_id: out.target_field_id,
    expression: v4ExpressionToValueRef(out.expression, ctx),
    fill_strategy: out.fill_strategy,
    separator: out.separator
  };
}

/**
 * ExpressionModel（面板编辑后）→ 联动表单节点文档的 query + prefill 两段。
 *
 * 以 `prev`（改动前文档）为底：V4 独有信息（来源种类/关联 ON 文本/未改变表达式的 token 形态）全部
 * 从 `prev.query` 按稳定标识回捞，只用模型里真正被编辑器改动的部分覆盖——与取数节点
 * `expressionModelToV4Doc` 同一原则（见其头注释「以 prev 为底」）。
 *
 * `model.where_expr` 承载的正是 `modelToV4Query` 期望的 `where_text_source`（两者同一
 * `TextSource` 形状：raw ValueRef 的 `text_source` 字段）——直接接到该参数位复用其「未编辑判据 /
 * prevQuery 回捞」全部既有逻辑，不重新实现一遍。
 *
 * `target`/`preview` 两段不在本函数：`target` 由面板选择目标模板时直接维护（见
 * `LinkedFormPanel.vue` `onSelectTemplate`/目标主表 watch），`preview` 由面板自动生成（见
 * `singleFieldFillOutput`）——两者均不经 ExpressionModel，调用方需在写回前自行合并这两段。
 */
export function expressionModelToLinkedFormQueryAndPrefill(
  model: ExpressionModel,
  prev: LinkedFormNodeDocumentV4,
  ctx: V4ModelAdapterContext
): { query: V4QueryDefinition; prefill: V4FillOutput[] } {
  const query = modelToV4Query({ source: model.source, where_text_source: model.where_expr?.text_source, distinct: model.distinct, limit: model.limit }, prev.query, ctx);
  dedupeImplicitReportJoins(query);
  assertUniqueSourceInstanceIds(query);
  const prevOutputByField = new Map(prev.prefill.map(o => [o.target_field_id, o]));
  const prefill: V4FillOutput[] = (model.target.outputs ?? []).map(o => {
    const prevOut = prevOutputByField.get(o.target_field_id);
    return {
      target_field_id: o.target_field_id,
      fill_strategy: (o.fill_strategy as V4FillOutput['fill_strategy'] | undefined) ?? prevOut?.fill_strategy ?? 'overwrite',
      expression: valueRefToV4Expression(o.expression, prevOut?.expression.expression_id ?? `pf_${o.target_field_id}`, 'output', prevOut?.expression, ctx)
    };
  });
  return { query, prefill };
}

/**
 * 联动表单 `query.sources` 出现重复 `instance_id` 时的具名错误：根治手法见 `LinkedFormPanel.vue` `reconcileContext` 头注释——本表单主表锚点按 `data_table_id`
 * 去重，不应再产出重复来源。本断言是**开发期尽早暴露**的兜底（不是掩盖手段，出口不做任何"悄悄去重"
 * 的隐式修正）：一旦重复，说明前面的去重逻辑有漏洞或有新调用路径未经过它，宁可在前端就地报错，也
 * 不要把半成品文档送去后端换一个更晚、更难定位的 400（`EXPR_LINKED_FORM_V4_SHAPE_INVALID`）。
 */
export class LinkedFormDuplicateSourceError extends Error {
  constructor(instanceId: string) {
    super(`linked_form_v4.query.sources 出现重复 instance_id "${instanceId}"（本表单主表/明细上下文表未按 data_table_id 去重，属编辑器内部缺陷，请上报）`);
    this.name = 'LinkedFormDuplicateSourceError';
  }
}

function assertUniqueSourceInstanceIds(query: V4QueryDefinition): void {
  const seen = new Set<string>();
  for (const s of query.sources) {
    if (seen.has(s.instance_id)) throw new LinkedFormDuplicateSourceError(s.instance_id);
    seen.add(s.instance_id);
  }
}

/**
 * 去掉两条等价的「本报表锚定关联」（恒真 `1 = 1`、无 refs 的默认占位 ON，见共享包
 * `isImplicitReportJoin`/`defaultJoinOn` 头注释）：`reconcileContext` 的主表↔明细自动 record_id
 * 关联按 `is_context && role` 查找端点、不依赖具体别名，正常情况下不会产出重复 join；这里仍加一道
 * 出口保险——同一对端点（不论方向）只保留一条默认恒真 ON，避免它随来源去重的边界情形被翻倍产出。
 * 非默认（用户手写/服务端回填过真实谓词）的 join 不受影响，原样保留、不去重（不同语义的两条关联
 * 允许共存，只有"两条都是占位默认"才判定为重复）。
 */
function dedupeImplicitReportJoins(query: V4QueryDefinition): void {
  const seenPairs = new Set<string>();
  const isDefaultOn = (j: V4JoinDefinition): boolean => j.on.source_text.replace(/\s+/g, '') === '1=1' && !(j.on.refs?.length);
  query.joins = query.joins.filter(j => {
    if (!isDefaultOn(j)) return true;
    const pairKey = [j.left_instance_id, j.right_instance_id].sort().join('|');
    if (seenPairs.has(pairKey)) return false;
    seenPairs.add(pairKey);
    return true;
  });
}

// ── 预览列：确定性单字段引用，不经 ExpressionModel 往返 ────────────────────────────────────────

/**
 * 产出「目标表单字段」预览列的 V4 填充输出：确定性单字段引用 token 化文本 `[label]#{r1}` + 对应
 * 绑定表。预览列由面板按目标表字段的可见性（`is_list_visible`）自动生成，用户不编辑，不需要也不
 * 应该经表达式输入框/host tokenize 一圈——直接按共享包内部 `predicatesToJoinOn` 同款 token 惯例
 * （`[标签]#{rN}` + `source_field` 引用）手写，语义与用户在 `ExpressionInput` 里手选同一字段完全
 * 一致，服务端按 `refs[0].source_instance_id`+`field_id` 解析，不读 `source_text` 里的标签文字
 * （标签只影响展示）。
 */
export function singleFieldFillOutput(params: { targetFieldId: string; label: string; sourceAlias: string }): V4FillOutput {
  const { targetFieldId, label, sourceAlias } = params;
  const expression: V4ExpressionDocument = {
    expression_id: `pv_${targetFieldId}`,
    purpose: 'output',
    source_text: `[${label}]#{r1}`,
    refs: [{ ref_id: 'r1', kind: 'source_field', source_instance_id: sourceAlias, field_id: targetFieldId, last_label: label }]
  };
  return { target_field_id: targetFieldId, fill_strategy: 'overwrite', expression };
}
