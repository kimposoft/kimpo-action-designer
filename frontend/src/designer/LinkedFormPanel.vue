<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { NButton, NPopover, NSelect, NSwitch, NTooltip } from 'naive-ui';
import { KControlSize, type KControlSizeTiers } from '@kimposoft/ui-kit';
import {
  ConditionEditorDialog,
  ExpressionInput,
  REPORT_ALIAS_PREFIX,
  createV4ExpressionHost,
  hostScopeFromDocument,
  provideExpressionHost,
  provideRefSyntax,
  tableRoleOf,
  useExpressionContext,
  type AliceV4Host,
  type ConditionConfirmPayload,
  type ExpressionHost,
  type ExpressionModel,
  type SourceTable,
  type TextSource,
  type V4Diagnostic,
  type V4ExpressionDocument,
  type V4ModelAdapterContext,
  type ValueRef
} from '@kimposoft/expression-editor';
import type { ActionDesignerHostApi } from './hostApi';
import type { TemplateField } from './hostTypes';
import { t as $t } from '../i18n';
import { useActionDesignerPopover } from './useActionDesignerPopover';
// 联动表单节点参数由 linked_form_v4 承载，旧键 query 不再写、不再读，见本文件头注释；模型形状翻译收在本适配层，不在本组件内重复实现。
import {
  emptyLinkedFormDocumentV4,
  expressionModelToLinkedFormQueryAndPrefill,
  isLinkedFormNodeDocumentV4,
  linkedFormV4DocToExpressionModel,
  singleFieldFillOutput,
  type LinkedFormNodeDocumentV4
} from './linkedFormV4Adapter';

/**
 * 标题行里「设置 / + 添加填充 / + 添加写回」描边小按钮与「查看 / 编辑」分段器的尺寸钉定。
 * 目标尺寸：描边按钮 24 高、字号 12、左右内边距 12、1px 描边；
 * 分段片 24 高、字号 12、宽 40（外壳 padding 2、片间距 4 → 整体 88×28，片宽由 scoped 样式钉回）。
 * 故 small 档：height 24 / fontSize 12 / paddingX 13（原内边距 12 + 描边 1；2d 修复循环按量测宽度校正）；描边按钮与分段片（均为 NButton small）共用，
 * includeButton 让 NButton 吃到钉定。容器只包标题行（及其设置气泡），不波及下方 size="small" 的 NSelect。
 */
const LF_TITLE_ROW_TIERS: KControlSizeTiers = { small: { height: 24, fontSize: 12, paddingX: 13 } };

/**
 * 联动表单（ui.linked_form）专用配置面板——Kimpo 设计层动作设计器 NodeConfigDialog 的
 * x-editor:linked-form 特化渲染。
 *
 * 步骤流：①选目标模板 → ②联动方式（新建/打开卡片）→ ③打开条件（仅打开模式；整段 WHERE
 * 表达式 + 设置气泡：打开模式查看/编辑、找不到时新建）→ ④新建后的字段传递（新建模式或
 * 「找不到时新建」开启时；目标字段 ← 表达式填充，与提取数据同一表达式能力）。
 *
 * 产物落 draft.params（经 patch 事件由 NodeConfigDialog 合并）：
 *   link_mode / template_id / open_mode / create_when_missing / linked_form_v4（联动表单节点
 *   文档，V4 形态，取代旧键 query）。面板内部仍用 3.4 ExpressionModel 驱动
 *   `ExpressionInput`/`reconcileContext`（bt0 本表单主表常驻、触发明细表等既有规则不变）——
 *   `./linkedFormV4Adapter.ts` 负责 `linked_form_v4` ⇄ ExpressionModel 的双向翻译，读写 draft.params
 *   之前/之后各过一道；`preview`（打开模式预览列）不经此模型，见该适配层 `singleFieldFillOutput`
 *   头注释。bt* 上下文表由本面板的 mini-reconcile 物化（与 ExpressionEditor.reconcile 同语义：
 *   用到才纳入 + 主表锚点常驻 + 主明细 record_id 自动关联）。
 */
const props = defineProps<{
  appId: string;
  /** 当前模板（本表单）——bt* 上下文与填充表达式的字段来源。 */
  templateId: string;
  params: Record<string, unknown>;
  /** 宿主能力注入面，目标模板/表/字段目录经此拉取。 */
  hostApi: ActionDesignerHostApi;
  /** V4 生产桥（与条件节点 ConditionV4Editor.vue 同款注入方式）：联动表单的
   *  查询/填充表达式 tokenize 要落 V4 token 形态，经它接到 expr-only 表达式输入框。与
   *  expressionHost 成对——宿主未升级（无 createAliceV4Host）或 job 模式（无模板上下文）时两者
   *  皆缺席，面板降级沿用父级（NodeConfigDialog）已 provide 的 3.4 桥（不产出合法 V4 文档，
   *  是已知的历史兜底路径，不阻断面板渲染）。 */
  v4Host?: AliceV4Host;
  /** 3.4 表达式域桥（宿主注入的原桥）：V4 桥只接管 lowerText 一处，其余方法（目录/表/字段等）仍
   *  委派给它，见 createV4ExpressionHost 头注释。 */
  expressionHost?: ExpressionHost;
}>();

const emit = defineEmits<{
  patch: [partial: Record<string, unknown>];
}>();

// V4 宿主桥覆盖：v4Host/expressionHost 均在场时，把本面板子树的表达式 lowerText
// 接到 V4 tokenize——whereExpr（打开条件）与 fillRows（字段传递）两处 expr-only 输入框走的
// 是同一个 ExpressionInput→AdvancedExpressionDialog→host.lowerText 通道，覆盖一次即两处同时生效。
// 必须在 setup 顶层同步调用（Vue 注入约束），与 ConditionV4Editor.vue 同款写法；wherePurpose 固定
// 'filter'——打开条件与取数节点的筛选条件同一用途档，不是动作条件分支的 'condition' 档。
if (props.v4Host && props.expressionHost) {
  provideExpressionHost(createV4ExpressionHost(props.expressionHost, props.v4Host, { wherePurpose: 'filter' }));
}
// 字段引用语法：本面板写的是 V4 表达式，字段引用一律
// `[表].[字段]`——与取数配置面 ActionConfigSurface.vue / 条件节点 ConditionV4Editor.vue 同款、
// 无条件调用（不依赖 v4Host/expressionHost 是否就绪：声明的是「语法」而非「宿主桥」，3.4 兜底
// 路径下即便不产出合法 V4 文档，字段树点选出的引用形态也不该退回花括号）。缺省 braces 时字段树
// 点选插入的是 3.4 的 `{字段}`，V4 分词报 ALICE_SYNTAX_LEX_INVALID（另一处相关处理见下方
// readableTexts/refreshReadableTexts）。
provideRefSyntax('brackets');

// ── 参数读取（params 为权威，面板无独立草稿） ────────────────────────────────
const linkMode = computed<'create' | 'open'>(() => (props.params.link_mode === 'open' ? 'open' : 'create'));
const targetTemplateId = computed<string>(() => (typeof props.params.template_id === 'string' ? props.params.template_id : ''));
const openMode = computed<'view' | 'edit'>(() => (props.params.open_mode === 'edit' ? 'edit' : 'view'));
const createWhenMissing = computed<boolean>(() => props.params.create_when_missing === true);

// linked_form_v4（联动表单节点文档，权威）：形状不命中（新建节点/仍带旧 query 键的已判废夹具）时
// 按空白文档打开，不崩溃。
const linkedFormDoc = computed<LinkedFormNodeDocumentV4>(() => {
  const raw = props.params.linked_form_v4;
  return isLinkedFormNodeDocumentV4(raw) ? raw : emptyLinkedFormDocumentV4();
});
const model = computed<ExpressionModel>(() => linkedFormV4DocToExpressionModel(linkedFormDoc.value, v4Ctx()));

const whereExpr = computed<ValueRef | null>(() => model.value.where_expr ?? null);
const fillRows = computed(() => model.value.target.outputs ?? []);
/** 字段传递/写回区显隐：新建模式恒显示；打开模式仅「找不到时新建」开启才显示。 */
const showFill = computed(() => linkMode.value === 'create' || createWhenMissing.value);

/** 保存后写回配置（params.writeback，沿用宿主表单写回端点的参数形状）。 */
interface WritebackMapping {
  source_field_id: string;
  target_field_id: string;
  target_data_table_id?: string;
}
interface WritebackConfig {
  enabled: boolean;
  mappings: WritebackMapping[];
}
const writeback = computed<WritebackConfig>(() => {
  const raw = props.params.writeback as Partial<WritebackConfig> | undefined;
  return { enabled: raw?.enabled === true, mappings: Array.isArray(raw?.mappings) ? raw.mappings : [] };
});

// ── 本表单上下文（bt* 物化数据源 + 表达式输入的「本表单」字段目录） ─────────────
const ctx = useExpressionContext({ templateId: props.templateId });
onMounted(() => {
  void ctx.load();
});
/** 表达式输入的「本表单」目录：与 ExpressionEditor.formTablesForInput 同构（bt<i> 按表序）。 */
const formTablesForInput = computed(() => ctx.tableFields.value.map((tf, i) => ({ ...tf, alias: `${REPORT_ALIAS_PREFIX}${i}` })));
/** 本表单主表在 ctx.tableFields 里的下标（bt 锚点别名 = bt<mainIdx>）。 */
const contextMainIndex = computed(() => {
  const tables = ctx.tableFields.value.map(tf => tf.table);
  return ctx.tableFields.value.findIndex(tf => tableRoleOf(tf.table, tables) === 'main');
});

// ── 作用域信封 + 表达式可读文本缓存（仿取数配置面 ActionConfigSurface.vue 同名机制） ─────────────
// 🔴 v4Host.restore/tokenize 依赖当前作用域（目录来源 + 本报表来源）解析 `[目标单主表].[...]`/
// `[本表单主表].[...]` 这类引用——照抄 ActionConfigSurface.vue 的 hostScopeFromDocument 手法，按
// linked_form_v4.query.sources 分拣 catalog/report 两段喂给 host.setScope；第二参数传本表单目录
// 全部表做「本报表」兜底（即便某张本表单表尚未被任何表达式引用，也该能被解析，
// 不依赖是否已被引用过）。本面板无暂存表概念，第三参数（stagingSource）留空。
function syncScope(): void {
  const tables = ctx.tableFields.value.map(tf => tf.table);
  const reportCatalogTables = ctx.tableFields.value.map(tf => ({
    table_id: tf.table.data_table_id,
    label: tf.table.table_name,
    role: (tableRoleOf(tf.table, tables) === 'main' ? 'main' : 'detail') as 'main' | 'detail'
  }));
  props.v4Host?.setScope?.(hostScopeFromDocument(linkedFormDoc.value, reportCatalogTables));
}
/** expression_id → 可读原文。linked_form_v4 文档存的是 token 化源码（`[标签]#{rN}`），
 *  v4ExpressionToValueRef（linkedFormV4Adapter.ts→共享包）直接显示它就是带内部标记的乱码——
 *  AdvancedExpressionPanel.confirm() 的花括号扫描会把 `{r1}` 当解析不到的字段占位符拦下、不产出。
 *  必须经 v4Host.restore 按当前目录换算成可读文本，才能显示进编辑框
 *  /参与「未编辑」判据。挂载与文档变化时重建；restore 未返回前退回 token 化源码本身（可接受的
 *  过渡态，与取数配置面同口径）。 */
const readableTexts = ref<Record<string, string>>({});

/** 并发 restore「打开条件」（query.filter）与每条「字段传递」（prefill[i]）的表达式，填进可读
 *  文本缓存。单条失败 / host 未就绪时回退 token 化源码本身（宁可显示原样，也不显示空白）。 */
async function refreshReadableTexts(doc: LinkedFormNodeDocumentV4): Promise<void> {
  if (!props.v4Host?.restore) return;
  const jobs: Array<{ id: string; text: string; refs: LinkedFormNodeDocumentV4['prefill'][number]['expression']['refs']; purpose: 'filter' | 'output' }> = [];
  if (doc.query.filter) {
    jobs.push({ id: doc.query.filter.expression_id, text: doc.query.filter.source_text, refs: doc.query.filter.refs, purpose: 'filter' });
  }
  for (const o of doc.prefill) {
    jobs.push({ id: o.expression.expression_id, text: o.expression.source_text, refs: o.expression.refs, purpose: 'output' });
  }
  const settled = await Promise.all(
    jobs.map(async j => {
      if (!j.text) return [j.id, ''] as const;
      try {
        const r = await props.v4Host!.restore!({ source_text: j.text, refs: j.refs, purpose: j.purpose });
        // 可读文本取 readable_text（去标记、完整显示路径）：r.text 仍是 token 化形态，直接显示是
        // 乱码；老服务端不带 readable_text 时退回 text。
        return [j.id, r.ok ? (r.readable_text ?? r.text) : j.text] as const;
      } catch {
        return [j.id, j.text] as const;
      }
    })
  );
  readableTexts.value = Object.fromEntries(settled);
}

// 文档变化（含挂载首次）或本表单目录变化（ctx.tableFields，影响 syncScope 的「本报表」兜底段）时，
// 按序先同步作用域、再刷新可读文本——合并成一个 watch 而非两个独立 watch，是为了让两者共享同一份
// 触发依赖：ctx.tableFields 异步到位（挂载时 bt* 目录尚未加载完，见下方 ctx.load()）本身也须重新
// setScope（新增本报表兜底表）**并**重新 restore（此前因缺目标/本报表来源而失败的还原要重试），
// 否则会永久停在「作用域未就绪」那一次失败结果上、不再自愈。watch 的是原始文档 linkedFormDoc
// （非 model）——model 经 v4Ctx().readableTextOf 读 readableTexts.value，若改watch model 会形成
// 「读取触发自身重算」的循环依赖，与取数配置面 watch(() => model.value, …)（那里的 model 是原始
// V4 文档，非本文件同名的翻译后 ExpressionModel）同一原则，只是这里原始文档另有其名。
watch(
  () => [linkedFormDoc.value, ctx.tableFields.value] as const,
  ([doc]) => {
    syncScope(); // 🔴 必须先于 refreshReadableTexts：restore 请求体在调用当下就读作用域信封。
    void refreshReadableTexts(doc);
  },
  { immediate: true, deep: false }
);

// ── 目标模板目录（步骤①下拉 + 目标主表字段） ──────────────────────────────────
const templateOptions = ref<{ label: string; value: string }[]>([]);
onMounted(async () => {
  try {
    const { data } = await props.hostApi.listAppTemplates(props.appId);
    templateOptions.value = (data?.items ?? []).map(t => ({ label: t.template_name, value: t.template_id }));
  } catch {
    templateOptions.value = [];
  }
});

/** 目标模板主表信息 + 字段目录（打开条件的目标表字段来源 & 填充目标字段下拉）。 */
const targetMainTable = ref<{ dataTableId: string; name: string } | null>(null);
const targetMainFields = ref<TemplateField[]>([]);
watch(
  () => targetTemplateId.value,
  async tid => {
    if (!tid) {
      targetMainTable.value = null;
      targetMainFields.value = [];
      return;
    }
    try {
      const { data } = await props.hostApi.listTemplateTables(props.appId, tid);
      const tables = data?.items ?? [];
      const main = tables.find(t => tableRoleOf(t, tables) === 'main') ?? tables[0];
      if (!main) {
        targetMainTable.value = null;
        targetMainFields.value = [];
        return;
      }
      targetMainTable.value = { dataTableId: main.data_table_id, name: main.table_name };
      const { data: fieldsData } = await props.hostApi.listTemplateFields(props.appId, tid, undefined, main.data_table_id);
      targetMainFields.value = fieldsData?.items ?? [];
    } catch {
      targetMainTable.value = null;
      targetMainFields.value = [];
    }
  },
  { immediate: true }
);
const targetFieldOptions = computed(() => targetMainFields.value.map(f => ({ label: f.field_name, value: f.field_id })));

/** 给共享包 V4 适配函数用的上下文：模板 ID + 表名查询口，同时覆盖本表单表（bt*，
 *  查 ctx.tableFields）与目标模板主表（t1，查 targetMainTable/templateOptions）两种归属——
 *  reportSourceBinding/catalogSourceAlias 按 template_id 命中哪一档决定查哪份目录，见
 *  ./linkedFormV4Adapter.ts 与共享包 expressionModelAdapter.ts 的 tableLabelOf 头注释。 */
function v4Ctx(): V4ModelAdapterContext {
  return {
    templateId: props.templateId,
    appId: props.appId,
    // 可读文本查询口（本坑修复，见上方 readableTexts/refreshReadableTexts 头注释）：
    // v4ExpressionToValueRef 靠它把 token 化源码渲染成可读文本喂给 ExpressionInput；
    // valueRefToV4Expression 的「未编辑」判据也靠它识别「文本等于可读渲染」这一态，
    // 否则会把没动过的表达式误判成已编辑（见共享包 isUneditedAgainstPrev 头注释）。
    readableTextOf: (id, tokenized) => readableTexts.value[id] ?? tokenized,
    tableLabelOf: source => {
      if (source.template_id === props.templateId) {
        return ctx.tableFields.value.find(tf => tf.table.data_table_id === source.data_table_id)?.table.table_name;
      }
      if (source.template_id === targetTemplateId.value) {
        // 🔴 目标模板主表（联动目标）的目录来源显示别名——不能像取数节点那样每次按表名重算。
        // 共享包 catalogSourceAlias（modelToV4Query 内部）用本函数的返回值**每次保存都重新覆盖**
        // query.sources 里该来源的 alias 字段；若这里恒返回表名，任何一次编辑都会把文档里已持久化的
        // 别名（可能是任意人工命名）悄悄改写成表名，之后 tokenize 时服务端按当前作用域解析不到旧名，
        // 报「找不到来源实例」。故优先复用文档里已持久化的别名，只有从未持久化过
        // （新建节点/首次选定目标模板）才退回表名占位。
        const existing = linkedFormDoc.value.query.sources.find(
          (s): s is Extract<typeof s, { kind: 'catalog' }> =>
            s.kind === 'catalog' && s.template_id === source.template_id && s.data_table_id === source.data_table_id
        );
        return existing?.alias || targetMainTable.value?.name || undefined;
      }
      return templateOptions.value.find(o => o.value === source.template_id)?.label;
    }
  };
}

// 预览列自动同步（不手选）：按目标模板主表字段的隐藏设置（is_list_visible）
// 生成 linked_form_v4.preview 输出映射（落在 V4 文档内，不是顶层 params.preview），
// 运行期 N 命中选择弹窗即按此展示。字段目录每次加载后比对重写，使隐藏设置变更在下次编辑保存本
// 节点时自动跟进。每条都是确定性单字段引用，不经 ExpressionModel（见 singleFieldFillOutput 注释）。
watch(
  () => targetMainFields.value,
  fields => {
    if (!targetTemplateId.value) return;
    const visible = fields.filter(f => f.is_list_visible);
    const next = visible.map(f => singleFieldFillOutput({ targetFieldId: f.field_id, label: f.field_name, sourceAlias: 't1' }));
    const doc = linkedFormDoc.value;
    if (JSON.stringify(doc.preview) === JSON.stringify(next)) return;
    // preview 顶层旧位（3.4 时代 params.preview）一并清空，避免存量夹具/半迁移中间态留双份数据。
    patch({ linked_form_v4: { ...doc, preview: next }, preview: undefined });
  }
);
/** 表达式输入的「数据源」目录：打开条件可引用目标模板主表；填充表达式不给（仅本表单）。
 *  🔴 `alias`/`name` 都必须与「面板表达式上下文里 model.source.tables 的别名」同一套——不能另按
 *  模板显示名拼名字：ConditionEditorDialog 打开条件时用户看到、编辑、再送回 tokenize 的整段文本
 *  引用的正是这份目录里的名字，一旦跟服务端作用域（syncScope 按文档 query.sources 装配，见其头
 *  注释）对不上，连用户没碰过的那一侧也会被服务端判「找不到来源实例」。`model.value.source.tables`
 *  是本面板当前正在用的、唯一权威的目标来源翻译结果（经 v4Ctx().tableLabelOf 产出，已与上方
 *  `tableLabelOf` 目标分支同一口径——优先复用文档里持久化的别名），直接取它的 alias/data_table_id，
 *  不再自己另算。 */
const conditionSourceTables = computed(() => {
  const info = targetMainTable.value;
  if (!info) return [];
  // model.value.source.tables 里目录来源的 .alias 字段被 3.4↔V4 适配层复用成 instance_id（不是
  // 显示名，见共享包 sourceBindingToTable 对 kind='catalog' 的翻译），显示名必须另经
  // v4Ctx().tableLabelOf 取——与上方 tableLabelOf 目标分支同一口径（优先复用文档里已持久化的
  // 别名），本函数不重复实现一遍解析逻辑。
  const t1 = model.value.source.tables.find(t => !t.is_context);
  if (!t1) return [];
  const label = v4Ctx().tableLabelOf?.({ template_id: targetTemplateId.value, data_table_id: info.dataTableId }) ?? info.name;
  return [{ alias: t1.alias, dataTableId: t1.data_table_id, name: label, fields: targetMainFields.value }];
});

// ── 模型更新（深拷贝 + mini-reconcile 后整体写回） ────────────────────────────
function patch(partial: Record<string, unknown>): void {
  emit('patch', partial);
}

function updateModel(mut: (m: ExpressionModel) => void): void {
  const doc = linkedFormDoc.value;
  const next: ExpressionModel = JSON.parse(JSON.stringify(model.value));
  mut(next);
  reconcileContext(next);
  const { query, prefill } = expressionModelToLinkedFormQueryAndPrefill(next, doc, v4Ctx());
  // 旧键 query 显式清空（NodeConfigDialog.patchPanelParams 是浅合并 {...draft.params, ...partial}，
  // 显式写 undefined 才能让旧键从「读到陈旧值」的风险里退出；与本面板既有 patch 惯例一致）。
  patch({ linked_form_v4: { ...doc, query, prefill }, query: undefined });
}

/** 递归收集 ValueRef 里引用的 source_field 别名（含 raw.refs / 函数 args / 开窗 / CASE）。 */
function collectAliases(v: ValueRef | null | undefined, used: Set<string>): void {
  if (!v) return;
  if (v.kind === 'source_field' && v.alias) used.add(v.alias);
  (v.args ?? []).forEach(a => collectAliases(a, used));
  (v.refs ?? []).forEach(r => collectAliases(r, used));
  (v.partition_by ?? []).forEach(p => collectAliases(p, used));
  (v.win_order_by ?? []).forEach(k => collectAliases(k.value, used));
  (v.cases ?? []).forEach(b => collectAliases(b.then, used));
  collectAliases(v.else, used);
}

/**
 * mini-reconcile（ExpressionEditor.reconcile 的联动表单子集）：
 * ① 被引用的 bt* 上下文表纳入 source.tables，未引用的剔除；
 * ② 本表单主表锚点（bt<mainIdx>）**常驻**——填充求值模型（后端 buildFillEvalModel 剥离非 bt*
 *    表后）恒有 FROM 单行快照，且明细上下文有 record_id 关联锚点；
 * ③ bt 主表 ↔ bt 明细自动 record_id 左关联（与编辑器 auto_record_id join 同形状）。
 *
 * 🔴 去重按 `data_table_id` 而非别名：文档一旦已声明过本报表来源（面板首次
 * 保存后即会带上），`linkedFormV4DocToExpressionModel`（经共享包 `sourceBindingToTable`）把它译回
 * 一张 `is_context:true` 上下文表，别名是文档回填的 `rpt-<table_id>-<6hex>`（**不是** `bt<i>`）——
 * 下面①的"纳入"判据若只按**别名**去重（`t.alias === alias`），会认定"还没有 `bt0` 这张表"从而
 * **再插一张**同一 `data_table_id` 的锚点（别名 `bt0`）。两张表看似不同（别名不同），但共享包
 * `modelToV4Query` 反译回 V4 文档时，`reportInstanceId` 按 **`data_table_id`** 派生确定性实例 ID
 * （`rpt-<table_id>-<6hex>`，与别名是 `bt0` 还是已是 `rpt-…` 形态无关，已是该形态则原样沿用）——
 * 两张"不同别名"的表因此落出**同一个** `instance_id`，被服务端保存闸判「source 重复」拒绝
 * （`EXPR_LINKED_FORM_V4_SHAPE_INVALID`）。故去重判据是"**同一 `data_table_id`
 * 的上下文表已存在**"（不论其别名是 `bt<i>` 索引形态还是 `rpt-…` 回填形态），已存在则复用、不再
 * 追加——下方 btMain/btDetails 关联装配按 `is_context && role` 查找，不依赖具体别名字符串，天然
 * 兼容两种别名形态。
 */
function reconcileContext(m: ExpressionModel): void {
  const used = new Set<string>();
  collectAliases(m.where_expr ?? null, used);
  m.target.outputs.forEach(o => collectAliases(o.expression, used));

  const mainIdx = contextMainIndex.value;
  const contextTables = ctx.tableFields.value;
  const tablesMeta = contextTables.map(tf => tf.table);
  if (mainIdx >= 0) used.add(`${REPORT_ALIAS_PREFIX}${mainIdx}`); // 主表锚点常驻

  // 纳入被引用的 bt* 表：去重判据是 data_table_id（同一张本表单表只留一份上下文表，不论其别名是
  // bt<i> 索引形态还是文档回填的 rpt-… 形态——见上方函数头注释「根治」）。
  for (const alias of used) {
    if (!alias.startsWith(REPORT_ALIAS_PREFIX)) continue;
    const idx = Number(alias.slice(REPORT_ALIAS_PREFIX.length));
    const tf = contextTables[idx];
    if (!tf) continue;
    if (m.source.tables.some(t => t.is_context && t.data_table_id === tf.table.data_table_id)) continue;
    const entry: SourceTable = {
      alias,
      source_type: 'template',
      template_id: props.templateId,
      data_table_id: tf.table.data_table_id,
      is_context: true,
      role: tableRoleOf(tf.table, tablesMeta)
    };
    m.source.tables.push(entry);
  }
  // 剔除未引用的 bt* 表（主表锚点已在 used 里，不会被剔；rpt-… 回填形态的上下文表不受本行约束，
  // 上面的去重判据已保证它不会被重复追加，其去留仍由「文档本就带着它」这一事实决定）。
  m.source.tables = m.source.tables.filter(t => !(t.is_context && t.alias.startsWith(REPORT_ALIAS_PREFIX)) || used.has(t.alias));

  // bt 主表 ↔ bt 明细：自动 record_id 左关联（与编辑器 reconcile 同形状）。
  const btMain = m.source.tables.find(t => t.is_context && t.role === 'main');
  const btDetails = m.source.tables.filter(t => t.is_context && t.role === 'detail');
  if (btMain) {
    for (const d of btDetails) {
      const exists = m.source.joins.some(
        j => j.auto_record_id && ((j.left_alias === btMain.alias && j.right_alias === d.alias) || (j.left_alias === d.alias && j.right_alias === btMain.alias))
      );
      if (!exists) m.source.joins.push({ left_alias: btMain.alias, right_alias: d.alias, join_type: 'left', auto_record_id: true, on: [] });
    }
  }
  // 剔除端点已失效的自动关联（手动 join 不受影响——本面板不产手动 join）。
  m.source.joins = m.source.joins.filter(j => {
    if (!j.auto_record_id) return true;
    const l = m.source.tables.find(t => t.alias === j.left_alias);
    const r = m.source.tables.find(t => t.alias === j.right_alias);
    return !!l && !!r;
  });
}

// 本表单目录加载完成后重调和一次：主表锚点依赖 ctx.tableFields，首次打开时目录是异步到达的。
// 判据看 linked_form_v4 是否已落过（isLinkedFormNodeDocumentV4，取代旧 query 判据）——节点只带旧
// query 键（已判废夹具）或全新节点时形状不命中，不必重调和。
watch(
  () => ctx.tableFields.value.length,
  n => {
    if (n > 0 && targetTemplateId.value && isLinkedFormNodeDocumentV4(props.params.linked_form_v4)) updateModel(() => {});
  }
);

// ── 步骤①：选目标模板 ─────────────────────────────────────────────────────────
function onSelectTemplate(tid: string | null): void {
  if (!tid || tid === targetTemplateId.value) return;
  // 换目标模板：条件/填充/预览/写回来源引用的均是旧模板字段，整体重建（保留联动方式等标量选项；
  // 写回保留开关状态、清空映射行）。target 段先落新模板 ID、data_table_id 留空——目标主表信息
  // 异步到达后由下方 targetMainTable watch 补齐（与 t1 来源同一时机种入）。
  const next = emptyLinkedFormDocumentV4();
  next.target = { template_id: tid, data_table_id: '' };
  patch({
    template_id: tid,
    linked_form_v4: next,
    query: undefined,
    preview: undefined,
    writeback: { enabled: writeback.value.enabled, mappings: [] }
  });
}

// 目标主表加载后把 t1 来源 + doc.target 段种进文档（onSelectTemplate 时主表信息尚未拉到，须在
// watch 里补）。doc.target 是联动表单节点文档专属字段（目标模板主表），不经 ExpressionModel——
// 与 t1 来源合并进同一次 patch（NodeConfigDialog.patchPanelParams 浅合并，linked_form_v4 整键
// 覆盖，两次 emit 之间若不合并会因 props 异步刷新而互相踩踏，见本文件适配层头注释）。
watch(
  () => targetMainTable.value?.dataTableId,
  dt => {
    if (!dt || !targetTemplateId.value) return;
    const doc = linkedFormDoc.value;
    const t1 = doc.query.sources.find((s): s is Extract<typeof s, { kind: 'catalog' }> => s.kind === 'catalog' && s.instance_id === 't1');
    const t1Unchanged = t1 && t1.template_id === targetTemplateId.value && t1.data_table_id === dt;
    const targetUnchanged = doc.target.template_id === targetTemplateId.value && doc.target.data_table_id === dt;
    if (t1Unchanged && targetUnchanged) return;

    const next: ExpressionModel = JSON.parse(JSON.stringify(model.value));
    next.source.tables = next.source.tables.filter(t => t.alias.startsWith(REPORT_ALIAS_PREFIX));
    next.source.tables.unshift({
      alias: 't1',
      source_type: 'template',
      template_id: targetTemplateId.value,
      data_table_id: dt,
      is_context: false,
      role: 'main'
    });
    reconcileContext(next);
    const { query, prefill } = expressionModelToLinkedFormQueryAndPrefill(next, doc, v4Ctx());
    patch({
      linked_form_v4: { ...doc, query, prefill, target: { template_id: targetTemplateId.value, data_table_id: dt } },
      query: undefined
    });
  }
);

// ── 步骤②：联动方式 ──────────────────────────────────────────────────────────
function setLinkMode(mode: 'create' | 'open'): void {
  if (mode === linkMode.value) return;
  patch({ link_mode: mode });
}

// ── 步骤③：打开条件 + 设置气泡 ────────────────────────────────────────────────
// 🔴 打开条件本质是谓词（`A = B`），必须按「条件/过滤」用途编辑与
// tokenize，不能走 ExpressionInput→AdvancedExpressionDialog——该弹窗内部把 3.4 侧 purpose 硬编码为
// 'value'（AdvancedExpressionDialog.vue 转调 ExpressionDialogShell 时 `purpose="value"` 写死，
// 见该文件）；共享包 v4ExpressionHostAdapter.ts `lowerTextViaV4` 的 `toV4Purpose(req.purpose,
// wherePurpose)` 只在 `req.purpose==='where'` 时才会用上 `createV4ExpressionHost(..., {wherePurpose:
// 'filter'})` 这个选项，3.4 侧 purpose 恒为 'value' 时永远落 V4 的 'output' 用途——服务端按「输出
// 用途根必须是值表达式」校验一条比较谓词，自然报「根必须是值表达式，不能是比较/逻辑运算谓词」，
// 确定按钮据此常驻禁用、弹窗不关。故用共享包专门编辑条件的模态 `ConditionEditorDialog`
// （内嵌面板 purpose='where'，取数配置面②筛选条件弹窗、共享包 ExpressionEditor 的
// `showConditionDialog` 走的是同一个组件/同一条用法）：
// 本面板恒表达式模式（无引导式条件树，与取数②筛选条件同一惯例），`mode` 固定 `'expr'`；`group` 只是
// 占位——V4 链路的真实内容全在 `whereTextSource`，`mode='expr'` 时面板从不读 `group`。
const conditionDialogVisible = ref(false);
/** 弹窗展示用 sidecar：从 `whereExpr` 的 `text_source` 取（与 ExpressionEditor.vue
 *  `model.where_text_source` 同一形状/同一来源角色）。 */
const whereTextSource = computed<TextSource | null>(() => whereExpr.value?.text_source ?? null);
/** 恒表达式模式占位 group：ConditionEditorDialog `mode='expr'` 时不读它，本面板从未产出/消费过
 *  结构化条件树。 */
const EMPTY_CONDITION_GROUP = { logic: 'and' as const, items: [] };
/** ConditionEditorDialog 确定：mode 恒 'expr'（本面板无引导式），`unchanged` 时文本未改不重写
 *  （与 ExpressionEditor.vue `onConditionConfirm` 同一判据）；空文本按「清除条件」处理，同
 *  `setWhereExpr` 原有语义。 */
function onConditionConfirm(payload: ConditionConfirmPayload): void {
  if (payload.mode !== 'expr' || payload.unchanged) return;
  const textSource = payload.whereTextSource ?? null;
  updateModel(m => {
    if (textSource && textSource.text) m.where_expr = { kind: 'raw', text: textSource.text, text_source: textSource };
    else delete m.where_expr;
  });
}
const settingsVisible = useActionDesignerPopover();

// ── 步骤④：字段传递（填充映射） ───────────────────────────────────────────────
function addFillRow(): void {
  updateModel(m => {
    m.target.outputs.push({ target_field_id: '', fill_strategy: 'overwrite', expression: { kind: 'const', value: '' } });
  });
}
function removeFillRow(idx: number): void {
  updateModel(m => {
    m.target.outputs.splice(idx, 1);
  });
}
function setFillField(idx: number, fieldId: string): void {
  updateModel(m => {
    if (m.target.outputs[idx]) m.target.outputs[idx].target_field_id = fieldId;
  });
}
function setFillExpr(idx: number, v: ValueRef | null): void {
  updateModel(m => {
    if (m.target.outputs[idx]) m.target.outputs[idx].expression = v ?? { kind: 'const', value: '' };
  });
}
/** 已被其他填充行占用的目标字段禁用（一个字段一条填充）。 */
function fillFieldOptions(currentIdx: number) {
  const used = new Set(fillRows.value.filter((_, i) => i !== currentIdx).map(o => o.target_field_id));
  return targetFieldOptions.value.map(o => ({ ...o, disabled: used.has(o.value) }));
}

// ── 步骤⑤：保存后写回（新表单字段 → 当前表单字段，受宿主写回端点白名单约束） ──────
/** 当前表单主表信息（写回目标字段目录 + mappings.target_data_table_id）。 */
const currentMainTable = computed(() => {
  const idx = contextMainIndex.value;
  return idx >= 0 ? ctx.tableFields.value[idx] : undefined;
});
const currentMainFieldOptions = computed(() =>
  (currentMainTable.value?.fields ?? []).map(f => ({ label: f.field_name, value: f.field_id }))
);
function patchWriteback(next: WritebackConfig): void {
  patch({ writeback: next });
}
function setWritebackEnabled(enabled: boolean): void {
  patchWriteback({ ...writeback.value, enabled });
}
function addWritebackRow(): void {
  patchWriteback({
    ...writeback.value,
    enabled: true,
    mappings: [...writeback.value.mappings, { source_field_id: '', target_field_id: '', target_data_table_id: currentMainTable.value?.table.data_table_id ?? '' }]
  });
}
function removeWritebackRow(idx: number): void {
  patchWriteback({ ...writeback.value, mappings: writeback.value.mappings.filter((_, i) => i !== idx) });
}
function setWritebackSource(idx: number, fieldId: string): void {
  patchWriteback({
    ...writeback.value,
    mappings: writeback.value.mappings.map((m, i) => (i === idx ? { ...m, source_field_id: fieldId } : m))
  });
}
function setWritebackTarget(idx: number, fieldId: string): void {
  patchWriteback({
    ...writeback.value,
    mappings: writeback.value.mappings.map((m, i) =>
      i === idx ? { ...m, target_field_id: fieldId, target_data_table_id: currentMainTable.value?.table.data_table_id ?? m.target_data_table_id } : m
    )
  });
}
/** 已被其他写回行占用的当前表单目标字段禁用（一个字段一条写回）。 */
function writebackTargetOptions(currentIdx: number) {
  const used = new Set(writeback.value.mappings.filter((_, i) => i !== currentIdx).map(m => m.target_field_id));
  return currentMainFieldOptions.value.map(o => ({ ...o, disabled: used.has(o.value) }));
}

// ── 步骤条（完成/当前=品牌蓝，未到=灰） ───────────────────────────────
interface StepItem {
  key: string;
  done: boolean;
}
const steps = computed<StepItem[]>(() => {
  const list: StepItem[] = [
    { key: 'template', done: !!targetTemplateId.value },
    { key: 'mode', done: !!targetTemplateId.value }
  ];
  if (linkMode.value === 'open') list.push({ key: 'condition', done: !!whereExpr.value });
  if (showFill.value) {
    list.push({ key: 'fill', done: fillRows.value.length > 0 });
    // 写回是可选步骤：未启用视为「已确认不用」，启用后须至少配一条映射才算完成。
    list.push({ key: 'writeback', done: !writeback.value.enabled || writeback.value.mappings.length > 0 });
  }
  return list;
});
/** 步骤圆点着色：已完成或「首个未完成（当前步）」= 蓝。 */
function stepActive(idx: number): boolean {
  const firstPending = steps.value.findIndex(s => !s.done);
  return steps.value[idx].done || idx === firstPending || firstPending === -1;
}

// ── 保存前收口（finalize） ──────────────────────────────
// 面板展示给用户、写进 patch 的表达式默认是「可读文本 + refs:[]」（v4Ctx().readableTextOf 喂给
// ExpressionInput 的形态，见上方 readableTexts 头注释）。服务端 bind 对 refs 为空的纯文本按
// **显示标签**在当前作用域里查找来源表/字段（纯文本路径解析）——面板展示用的表名来自
// ctx.tableFields（前端「本表单」目录），与服务端目录里的名字在部分场景下对不上，报「本报表下找不到数据表」。取数/写节点
// 没这个问题，是因为它们保存前都会经 ActionConfigSurface.vue 的 finalizeExtractV4/finalizeWriteV4
// 收口——把可读文本经宿主 tokenize 成 token 化源码 + 带稳定 source_instance_id 的 refs，服务端按
// refs 反查绑定、不依赖标签文本匹配。本函数是同一收口手法在本面板的落地，供 NodeConfigDialog 的
// onSave() 在真正提交保存前调用（见该文件 defineExpose 消费处）。
/** 一条收口诊断及其来源槽位（与 ActionConfigSurface.vue 的 V4NodeDocumentDiagnosticItem 同构，本
 *  面板文档形状不是 V4ExtractNodeDocument，不能直接复用该共享包类型，故本地声明同形状）。 */
export interface LinkedFormFinalizeDiagnosticItem {
  source: string;
  diagnostic: V4Diagnostic;
}
/** finalize() 结果：与共享包 SurfaceFinalizeResult 同形状（ok/doc/diagnostics 三字段），供
 *  NodeConfigDialog.onSave() 按同一套 `'ok' in result` 探测口径消费。 */
export interface LinkedFormFinalizeResult {
  ok: boolean;
  doc: LinkedFormNodeDocumentV4;
  diagnostics: LinkedFormFinalizeDiagnosticItem[];
}

/** 对单条表达式做「已 tokenize 则跳过、否则调 host.tokenize 重绑」的收口：
 *  - refs 非空（未经编辑的存档态表达式，见 ActionConfigSurface.vue 同名注释「文档里的表达式不恒是
 *    可读文本」）：已带稳定绑定，跳过——不重新 tokenize，避免无谓改写 normalized_digest；
 *  - source_text 为空（未配置）：不下发绑定请求，空即未配置，不是错误；
 *  - 其余（refs 为空、source_text 非空——即本面板展示态默认产出的可读文本）：调 host.tokenize
 *    换成 token 化源码 + 稳定 refs，失败则把诊断收进 diagnostics、保留原文不覆盖（同 finalizeExtractV4
 *    「绑定失败：保留用户原文不覆盖」口径）。 */
async function tokenizeInPlace(expr: V4ExpressionDocument, where: string, diagnostics: LinkedFormFinalizeDiagnosticItem[]): Promise<void> {
  if (!expr.source_text || expr.refs.length > 0) return;
  const r = await props.v4Host!.tokenize!({ text: expr.source_text, purpose: expr.purpose, refs: [] });
  for (const d of r.diagnostics ?? []) diagnostics.push({ source: where, diagnostic: d });
  if (!r.ok) return;
  expr.source_text = r.source_text;
  expr.refs = r.refs;
}

/**
 * 收口后按表达式实际引用的 report_field refs，补齐 `query.sources` 里缺失的 kind=report 来源
 * （+ 必要时补一条从目录目标来源出发、ON 恒真 `1 = 1` 的锚定关联，形状与宿主后端联动表单打开文档
 * 的主表匹配用法一致）——tokenize 请求体里的作用域
 * 正确带着本报表来源（`syncScope` 的「本报表」兜底恒把 ctx.tableFields 全部表塞进作用域，与
 * `query.sources` 是否已声明无关，见该函数头注释），所以 tokenize 能正确解析出 `report_field` 引用
 * 并回填 refs；但 `tokenizeInPlace` 只改表达式自身的 `source_text`/`refs`，从不触碰 `query.sources`
 * ——若这张本报表表此前从未被 `reconcileContext` 常驻过（例如编辑发生在 `ctx.tableFields` 尚未
 * 加载完成的窗口期），最终写出的文档就会出现「表达式引用着某个 report 实例，`query.sources` 里却
 * 找不到它」——服务端展开阶段按声明的来源清单重新校验，报「本报表下找不到数据表」。这里在收口阶段
 * 兜底补齐，保证只要 tokenize 出的引用指向了某个本报表实例，`query.sources`/`query.joins` 就一定有
 * 与之对应的条目，不依赖编辑过程中 reconcileContext 是否已经加过。
 */
function ensureReportSourcesForRefs(doc: LinkedFormNodeDocumentV4): void {
  const refs = [...(doc.query.filter?.refs ?? []), ...doc.prefill.flatMap(o => o.expression.refs)];
  const rootId = doc.query.sources.find(s => s.kind === 'catalog')?.instance_id;
  const existingSourceIds = new Set(doc.query.sources.map(s => s.instance_id));
  const existingJoinRightIds = new Set(doc.query.joins.map(j => j.right_instance_id));
  const tablesMeta = ctx.tableFields.value.map(tf => tf.table);
  let nextSeq = doc.query.joins.length;
  for (const ref of refs) {
    if (ref.kind !== 'report_field' || !ref.source_instance_id || !ref.table_id) continue;
    if (existingSourceIds.has(ref.source_instance_id)) continue;
    // 按 table_id 查本表单目录取表名/角色——查不到（理论不可达：report_field 恒指向本模板自己的表）
    // 时不猜测，跳过（交给下游保存闸按缺失来源报错，比猜错表名/角色更安全）。
    const tf = ctx.tableFields.value.find(t => t.table.data_table_id === ref.table_id);
    if (!tf) continue;
    const role = tableRoleOf(tf.table, tablesMeta) === 'detail' ? 'detail' : 'main';
    doc.query.sources.push({ kind: 'report', instance_id: ref.source_instance_id, alias: tf.table.table_name, table_id: ref.table_id, table_role: role });
    existingSourceIds.add(ref.source_instance_id);
    // 锚定关联：从目录目标来源（t1）出发、ON 恒真——只在确有目标来源、且该 report 实例尚未被任何
    // 关联引入时才补（已被引入——如主/明细自动 record_id 关联的一端——不重复补，避免非根来源被
    // 两条关联同时引入，服务端 Join 图对此同样具名拒绝）。
    if (rootId && rootId !== ref.source_instance_id && !existingJoinRightIds.has(ref.source_instance_id)) {
      nextSeq += 1;
      doc.query.joins.push({
        join_id: `j_report_anchor_${ref.source_instance_id}`,
        sequence: nextSeq,
        left_instance_id: rootId,
        right_instance_id: ref.source_instance_id,
        join_type: 'left',
        on: { expression_id: `join:${rootId}:${ref.source_instance_id}`, purpose: 'join_on', source_text: '1 = 1', refs: [] }
      });
      existingJoinRightIds.add(ref.source_instance_id);
    }
  }
}

async function finalize(): Promise<LinkedFormFinalizeResult> {
  const doc: LinkedFormNodeDocumentV4 = JSON.parse(JSON.stringify(linkedFormDoc.value));
  const diagnostics: LinkedFormFinalizeDiagnosticItem[] = [];
  // 宿主未升级（无 tokenize）时不下发半成品：直接判失败，让保存中止并提示，而不是带着未绑定的
  // 可读文本去撞后端（同 finalizeExtractV4 的 HOST_TOKENIZE_MISSING 分支同一原则）。
  if (typeof props.v4Host?.tokenize !== 'function') {
    return {
      ok: false,
      doc,
      diagnostics: [
        { source: 'host', diagnostic: { code: 'HOST_TOKENIZE_MISSING', phase: 'host', severity: 'error', message: 'host.tokenize unavailable' } }
      ]
    };
  }
  if (doc.query.filter) await tokenizeInPlace(doc.query.filter, $t('actionDesigner.dialog.linkedForm.conditionTitle'), diagnostics);
  for (const o of doc.prefill) await tokenizeInPlace(o.expression, $t('actionDesigner.dialog.linkedForm.fillTitle'), diagnostics);
  ensureReportSourcesForRefs(doc);
  const ok = !diagnostics.some(d => d.diagnostic.severity === 'error');
  if (ok) patch({ linked_form_v4: doc }); // 收口成功才回写：失败时不用半绑定的文档覆盖用户输入。
  return { ok, doc, diagnostics };
}

defineExpose({ finalize });
</script>

<template>
  <div class="lf-panel">
    <div class="lf-steps">
      <template v-for="(step, idx) in steps" :key="step.key">
        <div class="lf-step-row" :class="{ 'lf-step-last': idx === steps.length - 1 }">
          <div class="lf-rail">
            <span class="lf-dot" :class="{ active: stepActive(idx) }">{{ idx + 1 }}</span>
            <span v-if="idx < steps.length - 1" class="lf-line" :class="{ active: stepActive(idx) && stepActive(idx + 1) }" />
          </div>
          <div class="lf-section">
            <!-- ① 选择需要联动的模板 -->
            <template v-if="step.key === 'template'">
              <div class="lf-title">{{ $t('actionDesigner.dialog.linkedForm.templateTitle') }}</div>
              <div class="lf-hint">{{ $t('actionDesigner.dialog.linkedForm.templateHint') }}</div>
              <NSelect
                class="lf-template-select"
                size="small"
                filterable
                :value="targetTemplateId || null"
                :options="templateOptions"
                :placeholder="$t('actionDesigner.dialog.linkedForm.templatePlaceholder')"
                @update:value="onSelectTemplate"
              />
            </template>

            <!-- ② 设置联动方式 -->
            <template v-else-if="step.key === 'mode'">
              <div class="lf-title">{{ $t('actionDesigner.dialog.linkedForm.modeTitle') }}</div>
              <div class="lf-mode-cards">
                <button
                  type="button"
                  class="lf-mode-card"
                  :class="{ selected: linkMode === 'create' }"
                  :aria-pressed="linkMode === 'create'"
                  data-testid="linked-mode-create"
                  @click="setLinkMode('create')"
                >
                  <strong>{{ $t('actionDesigner.dialog.linkedForm.createCard') }}</strong>
                  <small>{{ $t('actionDesigner.dialog.linkedForm.createCardDesc') }}</small>
                  <span v-if="linkMode === 'create'" class="lf-card-check">✓</span>
                </button>
                <button
                  type="button"
                  class="lf-mode-card"
                  :class="{ selected: linkMode === 'open' }"
                  :aria-pressed="linkMode === 'open'"
                  data-testid="linked-mode-open"
                  @click="setLinkMode('open')"
                >
                  <strong>{{ $t('actionDesigner.dialog.linkedForm.openCard') }}</strong>
                  <small>{{ $t('actionDesigner.dialog.linkedForm.openCardDesc') }}</small>
                  <span v-if="linkMode === 'open'" class="lf-card-check">✓</span>
                </button>
              </div>
            </template>

            <!-- ③ 设置打开条件（仅打开模式） -->
            <template v-else-if="step.key === 'condition'">
              <KControlSize include-button :tiers="LF_TITLE_ROW_TIERS">
                <div class="lf-title-row">
                  <span class="lf-title">{{ $t('actionDesigner.dialog.linkedForm.conditionTitle') }}</span>
                  <NPopover v-model:show="settingsVisible" trigger="click" placement="bottom-start" :show-arrow="false">
                    <template #trigger>
                      <NButton size="small" type="primary" ghost data-testid="linked-open-settings">
                        {{ $t('actionDesigner.dialog.linkedForm.settings') }}
                      </NButton>
                    </template>
                    <div class="lf-settings-pop">
                      <div class="lf-settings-head">
                        <span>{{ $t('actionDesigner.dialog.linkedForm.settings') }}</span>
                        <button type="button" class="lf-pop-close" @click="settingsVisible = false">✕</button>
                      </div>
                      <div class="lf-setting-line">
                        <span class="lf-setting-label">
                          {{ $t('actionDesigner.dialog.linkedForm.openModeLabel') }}
                          <NTooltip trigger="hover">
                            <template #trigger><span class="lf-info">ⓘ</span></template>
                            {{ $t('actionDesigner.dialog.linkedForm.openModeTip') }}
                          </NTooltip>
                        </span>
                        <!-- 两枚 NButton 组成分段（「分开的两片」形态：外壳 padding 2、片 40×24、间距 4）。
                             选中片 type=primary + secondary 高亮，未选片 quaternary；互斥语义以 aria-pressed 表达
                             （不加 role / 方向键，避免引入自绘 radiogroup） -->
                        <div class="lf-seg">
                          <NButton
                            size="small"
                            :type="openMode === 'view' ? 'primary' : 'default'"
                            :secondary="openMode === 'view'"
                            :quaternary="openMode !== 'view'"
                            :aria-pressed="openMode === 'view'"
                            data-testid="linked-open-view"
                            @click="patch({ open_mode: 'view' })"
                          >
                            {{ $t('actionDesigner.dialog.linkedForm.openModeView') }}
                          </NButton>
                          <NButton
                            size="small"
                            :type="openMode === 'edit' ? 'primary' : 'default'"
                            :secondary="openMode === 'edit'"
                            :quaternary="openMode !== 'edit'"
                            :aria-pressed="openMode === 'edit'"
                            data-testid="linked-open-edit"
                            @click="patch({ open_mode: 'edit' })"
                          >
                            {{ $t('actionDesigner.dialog.linkedForm.openModeEdit') }}
                          </NButton>
                        </div>
                      </div>
                      <div class="lf-setting-line">
                        <span class="lf-setting-label">
                          {{ $t('actionDesigner.dialog.linkedForm.createWhenMissing') }}
                          <NTooltip trigger="hover">
                            <template #trigger><span class="lf-info">ⓘ</span></template>
                            {{ $t('actionDesigner.dialog.linkedForm.createWhenMissingTip') }}
                          </NTooltip>
                        </span>
                        <NSwitch
                          size="small"
                          :value="createWhenMissing"
                          data-testid="create-when-missing"
                          @update:value="v => patch({ create_when_missing: v })"
                        />
                      </div>
                    </div>
                  </NPopover>
                </div>
              </KControlSize>
              <div
                class="lf-condition-input lf-condition-trigger"
                role="button"
                tabindex="0"
                data-testid="linked-open-condition"
                @click="conditionDialogVisible = true"
                @keydown.enter="conditionDialogVisible = true"
              >
                <span v-if="whereTextSource?.text" class="lf-condition-text">{{ whereTextSource.text }}</span>
                <span v-else class="lf-condition-placeholder">{{ $t('actionDesigner.dialog.linkedForm.conditionPlaceholder') }}</span>
              </div>
              <ConditionEditorDialog
                :show="conditionDialogVisible"
                mode="expr"
                :group="EMPTY_CONDITION_GROUP"
                :where-text-source="whereTextSource"
                :source-tables="conditionSourceTables"
                :form-tables="formTablesForInput"
                @update:show="v => (conditionDialogVisible = v)"
                @confirm="onConditionConfirm"
              />
            </template>

            <!-- ④ 新建后的字段传递 -->
            <template v-else-if="step.key === 'fill'">
              <KControlSize include-button :tiers="LF_TITLE_ROW_TIERS">
                <div class="lf-title-row">
                  <span class="lf-title">{{ $t('actionDesigner.dialog.linkedForm.fillTitle') }}</span>
                  <NButton size="small" type="primary" ghost data-testid="add-linked-fill" @click="addFillRow">
                    + {{ $t('actionDesigner.dialog.linkedForm.addFill') }}
                  </NButton>
                </div>
              </KControlSize>
              <div class="lf-fill-list">
                <div v-for="(row, idx) in fillRows" :key="idx" class="lf-fill-row" :data-testid="`linked-fill-${idx}`">
                  <NSelect
                    class="lf-fill-field"
                    size="small"
                    filterable
                    :value="row.target_field_id || null"
                    :options="fillFieldOptions(idx)"
                    :placeholder="$t('actionDesigner.dialog.linkedForm.fillFieldPlaceholder')"
                    @update:value="v => setFillField(idx, v)"
                  />
                  <ExpressionInput
                    class="lf-fill-expr"
                    :model-value="row.expression?.kind === 'const' && row.expression.value === '' ? null : row.expression"
                    :source-tables="[]"
                    :form-tables="formTablesForInput"
                    :slot-key="`linked-form-fill-${idx}`"
                    expr-only
                    :placeholder="$t('actionDesigner.dialog.linkedForm.fillExprPlaceholder')"
                    @update:model-value="v => setFillExpr(idx, v)"
                  />
                  <NButton size="tiny" quaternary class="lf-fill-remove" :aria-label="$t('actionDesigner.dialog.linkedForm.removeFill')" @click="removeFillRow(idx)">
                    ✕
                  </NButton>
                </div>
                <div v-if="fillRows.length === 0" class="lf-hint">{{ $t('actionDesigner.dialog.linkedForm.fillEmpty') }}</div>
              </div>
            </template>

            <!-- ⑤ 保存后写回：新表单字段 → 当前表单字段（受宿主写回端点白名单约束） -->
            <template v-else>
              <KControlSize include-button :tiers="LF_TITLE_ROW_TIERS">
                <div class="lf-title-row">
                  <span class="lf-title">{{ $t('actionDesigner.dialog.linkedForm.writebackTitle') }}</span>
                  <NSwitch size="small" :value="writeback.enabled" data-testid="writeback-enabled" @update:value="setWritebackEnabled" />
                  <NButton v-if="writeback.enabled" size="small" type="primary" ghost data-testid="add-writeback" @click="addWritebackRow">
                    + {{ $t('actionDesigner.dialog.linkedForm.addWriteback') }}
                  </NButton>
                </div>
              </KControlSize>
              <template v-if="writeback.enabled">
                <div class="lf-fill-list">
                  <div v-for="(m, idx) in writeback.mappings" :key="idx" class="lf-fill-row" :data-testid="`writeback-${idx}`">
                    <NSelect
                      class="lf-fill-field"
                      size="small"
                      filterable
                      :value="m.source_field_id || null"
                      :options="targetFieldOptions"
                      :placeholder="$t('actionDesigner.dialog.linkedForm.writebackSourcePlaceholder')"
                      @update:value="v => setWritebackSource(idx, v)"
                    />
                    <span class="lf-wb-arrow">→</span>
                    <NSelect
                      class="lf-wb-target"
                      size="small"
                      filterable
                      :value="m.target_field_id || null"
                      :options="writebackTargetOptions(idx)"
                      :placeholder="$t('actionDesigner.dialog.linkedForm.writebackTargetPlaceholder')"
                      @update:value="v => setWritebackTarget(idx, v)"
                    />
                    <NButton
                      size="tiny"
                      quaternary
                      class="lf-fill-remove"
                      :aria-label="$t('actionDesigner.dialog.linkedForm.removeWriteback')"
                      @click="removeWritebackRow(idx)"
                    >
                      ✕
                    </NButton>
                  </div>
                  <div v-if="writeback.mappings.length === 0" class="lf-hint">{{ $t('actionDesigner.dialog.linkedForm.writebackEmpty') }}</div>
                </div>
              </template>
              <div v-else class="lf-hint">{{ $t('actionDesigner.dialog.linkedForm.writebackDisabledHint') }}</div>
            </template>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.lf-panel {
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 4px 4px 16px;
}
/* 步骤行：左轨（圆点+连线）+ 右内容（步骤条） */
.lf-step-row {
  display: flex;
  gap: 12px;
}
.lf-rail {
  flex: 0 0 28px;
  display: flex;
  flex-direction: column;
  align-items: center;
}
.lf-dot {
  flex: 0 0 28px;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background-color: rgb(var(--border-deep-color, 205 208 214));
  color: #fff;
  font-size: 14px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.lf-dot.active {
  background-color: rgb(var(--primary-color));
  font-weight: 500;
}
.lf-line {
  flex: 1 1 auto;
  width: 2px;
  min-height: 24px;
  margin: 8px 0;
  background-color: rgb(var(--border-deep-color, 205 208 214));
}
.lf-line.active {
  background-color: rgb(var(--primary-color));
}
.lf-section {
  flex: 1 1 auto;
  min-width: 0;
  padding-bottom: 28px;
}
.lf-step-last .lf-section {
  padding-bottom: 8px;
}

.lf-title {
  font-size: 14px;
  font-weight: 500;
  line-height: 22px;
  color: rgb(var(--base-text-color));
}
.lf-title-row {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
}
.lf-title-row .lf-title {
  margin-bottom: 0;
}
.lf-hint {
  font-size: 12px;
  color: rgb(var(--text-hint-color));
  margin: 6px 0 10px;
}
.lf-template-select {
  max-width: 367px;
}

/* ② 联动方式卡片（选中=浅蓝底+品牌描边+右上角勾角标） */
.lf-mode-cards {
  display: flex;
  gap: 24px;
  margin-top: 12px;
}
.lf-mode-card {
  position: relative;
  width: 300px;
  max-width: 48%;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  padding: 8px 12px;
  border: 1px solid rgb(var(--border-color));
  border-radius: 8px;
  background: transparent;
  cursor: pointer;
  text-align: left;
  overflow: hidden;
}
.lf-mode-card strong {
  font-size: 14px;
  font-weight: 500;
  color: rgb(var(--base-text-color));
}
.lf-mode-card small {
  font-size: 12px;
  color: rgb(var(--text-secondary-color));
}
.lf-mode-card.selected {
  border-color: rgb(var(--primary-color));
  background-color: rgb(var(--primary-50-color) / 0.5);
}
/* 右上角勾选角标：品牌色三角 + 白勾 */
.lf-card-check {
  position: absolute;
  top: 0;
  right: 0;
  width: 24px;
  height: 24px;
  background: linear-gradient(225deg, rgb(var(--primary-color)) 50%, transparent 50%);
  color: #fff;
  font-size: 11px;
  line-height: 1;
  display: flex;
  align-items: flex-start;
  justify-content: flex-end;
  padding: 3px 4px 0 0;
  box-sizing: border-box;
}

/* ③ 打开条件：整段 WHERE 表达式输入（点击进表达式编辑器） */
.lf-condition-input {
  max-width: 546px;
}
/* 打开条件触发区：视觉沿用共享包 ExpressionInput 值框同一套 h32/圆角4/
   1px 描边（该组件 .expr-input 同款数值），点击打开 ConditionEditorDialog——不复用 ExpressionInput
   本体是因为它的弹窗恒按 'value' 用途，条件必须走 'where' 用途，见上方 script 同名注释。 */
.lf-condition-trigger {
  display: flex;
  align-items: center;
  min-height: 32px;
  padding: 3px 8px;
  border: 1px solid rgb(var(--border-color));
  border-radius: 4px;
  background: #fff;
  cursor: pointer;
}
.lf-condition-text {
  font-size: 13px;
  color: rgb(var(--base-text-color));
  word-break: break-all;
}
.lf-condition-placeholder {
  font-size: 13px;
  color: rgb(var(--text-hint-color));
}

/* 设置气泡 */
.lf-settings-pop {
  width: 238px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.lf-settings-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 14px;
  color: rgb(var(--text-secondary-color));
}
.lf-pop-close {
  border: none;
  background: transparent;
  cursor: pointer;
  color: rgb(var(--text-secondary-color));
  font-size: 12px;
  padding: 2px;
}
.lf-setting-line {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 4px 0;
}
.lf-setting-label {
  font-size: 14px;
  color: rgb(var(--base-text-color));
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.lf-info {
  color: rgb(var(--text-hint-color));
  font-size: 12px;
  cursor: help;
}
/* 查看/编辑 分段器（浅灰槽，两片分开）。NButton（24 高 / 12px 经 LF_TITLE_ROW_TIERS 钉定），
   外壳保持原形：padding 2、片间距 4、圆角 6、浅灰底；片宽 40，内边距清零（tiers 的 paddingX 12 只用于描边小按钮）。 */
.lf-seg {
  display: flex;
  gap: 4px;
  padding: 2px;
  border-radius: 6px;
  background-color: rgb(var(--fill-light-color, 245 247 250));
}
.lf-seg :deep(.n-button) {
  width: 40px;
  padding: 0;
}

/* ④ 字段传递：行 = 目标字段(190px) + 表达式 + 删除 */
.lf-fill-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-width: 546px;
}
.lf-fill-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border: 1px solid rgb(var(--border-color));
  border-radius: 8px;
}
.lf-fill-field {
  flex: 0 0 190px;
}
.lf-fill-expr {
  flex: 1 1 auto;
  min-width: 0;
  background-color: #fff;
}
.lf-fill-remove {
  flex: 0 0 auto;
}
/* ⑤ 写回：新表单字段 → 当前表单字段（箭头分隔，行样式与填充行一致） */
.lf-wb-arrow {
  flex: 0 0 auto;
  color: rgb(var(--text-hint-color));
  font-size: 12px;
}
.lf-wb-target {
  flex: 1 1 auto;
  min-width: 0;
}
</style>
