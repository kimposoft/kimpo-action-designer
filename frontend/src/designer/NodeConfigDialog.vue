<script setup lang="ts">
import { computed, h, markRaw, nextTick, onBeforeUnmount, reactive, ref, shallowRef, watch, type Component } from 'vue';
import type { InteractiveSessionHandle } from '@kimposoft/plugin-sdk';
import { NAlert, NButton, NCheckbox, NEmpty, NFormItem, NInput, NInputNumber, NPopover, NRadio, NRadioGroup, NSelect, NSpin, NSwitch, NTabPane, NTabs, NTag } from 'naive-ui';
import type { SelectGroupOption, SelectOption, SelectRenderTag } from 'naive-ui';
// 页脚统一用组件库 KDialogFooter；运行时取宿主注入的 KimpoUi，构建时外部化
import { KControlSize, KDialogFooter, type KControlSizeTiers } from '@kimposoft/ui-kit';
// 宿主专属调用（动作/模板/表达式/插件加载/宿主 i18n 等）一律经 hostApi 注入；
// ActionDefinition/TemplateField/TemplateDataTable/SheetCatalogEntry 用 hostTypes 结构等价本地类型。
import type { ActionDefinition, SheetCatalogEntry, TemplateDataTable, TemplateField, TemplateFieldGroup, WorkflowStepCatalogDefinition } from './hostTypes';
import type { ActionDesignerHostApi } from './hostApi';
import { ACTION_TRIGGER_EVENT_KEYS, BLOCKABLE_EVENT_KEYS, RECORD_PAGE_EVENT_KEYS, newConditionId } from './model';
import type { ActionTriggerEventKey, ConditionNodeGuard, ConditionV4Spec, MindNode, WorkflowGateStep } from './model';
import { eventLabel } from './labels';
import { buildEventMenuEntries } from './eventMenu';
import { t as $t } from '../i18n';
import GenericParamsForm from './GenericParamsForm.vue';
import { dataActionExtraParamFields, deriveGenericParamFields, type GenericParamField } from './genericParamForm';
import { useActionDesignerPopover } from './useActionDesignerPopover';
import { resolveLocalized } from './localize';
import { resolveOperationKind } from './dataActionKind';
// 结构化表达式编辑器与历史 KimpoSQL 存在性检测统一由共享包提供。
import {
  // 条件分支用 V4 判断表达式，配置页本身就是表达式编辑界面，故条件页**内嵌**
  // ConditionV4Editor.vue（薄包装共享包的 AdvancedExpressionPanel，purpose='where'）。
  // 引导式条件树 ConditionTree 已退役，不做任何旧形态兼容 UI。
  provideExpressionHost,
  tableRoleOf,
  REPORT_ALIAS_PREFIX,
  readTargets,
  // 取数节点参数键为 extract_v4（取代 3.4 的 expression）——空文档兜底 + 形状守卫。
  emptyExtractNodeDocument,
  isExtractNodeDocument,
  // 写动作（新增/修改/删除数据）参数键为 V4 写节点文档 write_v4（取代 3.4 expression）
  // ——空文档兜底 + 形状守卫，与取数 extract_v4 同一套约定（见共享包 writeNodeDocument 说明）。
  emptyWriteNodeDocument,
  isWriteNodeDocument,
  // 条件节点作用域信封要按 `rpt-<table_id>-<6hex>` 给本报表来源实例 ID（服务端保存闸
  // 只认这个形态，编辑器侧的 bt* 别名只是索引），复用共享包的确定性派生函数，不在插件侧另造一套。
  reportInstanceId,
  type AliceV4Host,
  type ExpressionModel,
  type V4ExpressionDocument,
  type V4ExtractNodeDocument,
  type V4WriteNodeDocument
} from '@kimposoft/expression-editor';
import ActionDesignerDialog from './ActionDesignerDialog.vue';
import ConditionV4Editor from './ConditionV4Editor.vue';
import type { ConditionSyntaxState, FormTableLite } from './ConditionV4Editor.vue';
import LinkedFormPanel from './LinkedFormPanel.vue';
// 联动表单「测试」按钮的最低限度守卫判据改按 linked_form_v4 文档形状识别，取代旧的
// draft.params.query（ExpressionModel）判据，见下方 onTest 2a 分支注释。
import { isLinkedFormNodeDocumentV4 } from './linkedFormV4Adapter';
import FormControlPanel from './FormControlPanel.vue';
import MessagePanel from './MessagePanel.vue';
import SwitchSheetPanel from './SwitchSheetPanel.vue';
import DetailSortPanel from './DetailSortPanel.vue';
import PrintPanel from './PrintPanel.vue';
import { requireInheritedInteractiveSession } from '../interactiveSession';

/**
 * 节点属性配置 Dialog：双击节点打开。
 * - 多 Tab + 保存/取消/测试 三按钮，按钮可见性与 Tab/内容预留由插件提供。
 * - 草稿语义：打开时克隆节点可编辑部分到本地 draft；保存才提交，取消/关闭丢弃。
 * - 使用 ActionDesignerDialog 作外壳：拖拽/最大化/缩放与动作设计器主窗口行为完全一致。
 */
const props = defineProps<{
  show: boolean;
  node: MindNode | null;
  definition: ActionDefinition | null;
  fields: TemplateField[];
  /**
   * 条件分支（guard）专用字段候选：只含主表字段。
   *
   * **本组件不消费它**：条件分支用 V4 判断表达式，字段候选由
   * conditionTables（本模板全部表 × 各自字段，经 hostApi 拉取）承担，不限主表
   * （V4 由服务端求值，`本报表.[表].[字段]` 可跨主表/明细解析）。prop 保留只为不改动
   * ActionDesigner.vue / useActionDesigner.ts 的既有传参（那条链路另有消费方），本文件视其为无关项。
   */
  guardFields?: TemplateField[];
  /**
   * 触发字段（值变动/点击）多选的按数据表分组候选（下拉按数据表分组、只显示表名与
   * 字段名，不显示物理列名/字段 id）。来自 useActionDesigner.fieldGroups（tables × fieldsByTable，主表在前）。
   * 可选：未传（旧测试夹具/未接线场景）时回落 fields 平铺（同样只显示字段名）。
   */
  fieldGroups?: TemplateFieldGroup[];
  /** templateVersionNo/pluginId 供切换Sheet面板缩略图链路（设计文档按版本取、按插件解析 bundle），其余消费方不感知。 */
  scope?: { appId: string; templateId: string; templateVersionNo?: string; pluginId?: string };
  /** 动作暂存区：当前节点的暂存生产者（画布拓扑推导，见 useActionDesigner.stagingProducerOf）；
   *  null=无（顺序兄弟/根下节点/跨事件），供下方 stagingSource 派生「上一步暂存区」来源。 */
  stagingProducer?: MindNode | null;
  /** 当前动作文档引用了、但设计者无设计权限的跨应用来源应用 ID
   *  清单（来自 useActionDesigner.unauthorizedSourceApps，透传自 OpenActionDocument 响应）。
   *  此 prop 当前无消费方（V4 配置面 extract-v4/write-v4 不使用这把只读锁），数据仍由宿主经
   *  ActionDesigner.vue 透传，供将来为 V4 配置面补齐跨应用只读锁。 */
  unauthorizedSourceApps?: string[];
  /**
   * 本节点所属触发根（画布当前编辑的动作事件）的事件键集合，由 ActionDesigner.vue 按
   * ctrl.root（= activeEvent）派生传入。用于判定写动作节点是否落在 before-save 根下——before-save
   * 下的写动作必须同步执行（失败需阻断保存），异步开关须强制置灰，见下方 asyncBlockedByBeforeSave。
   * 缺省 []（未传时不阻断任何异步开关）。
   */
  bandEventKeys?: ActionTriggerEventKey[];
  /** 宿主能力注入面。 */
  hostApi: ActionDesignerHostApi;
  /**
   * 设计器模式（由 ActionDesigner 透传）：'template'（缺省）沿用既有行为；
   * 'job' 时——guard 编辑默认表达式模式且引导式选项置灰（无表单字段上下文）、依赖 props.fields
   * 的下拉改显示空态提示而非静默空列表。
   */
  designerMode?: 'template' | 'job';
  /** 父动作设计 surface 持有的唯一交互会话；嵌套 action-config 只能继承，不能关闭或重拿锁。 */
  interactiveSession: InteractiveSessionHandle;
  readonly?: boolean;
}>();

const emit = defineEmits<{
  'update:show': [value: boolean];
  saveAction: [patch: Partial<MindNode>];
  saveCondition: [guardSpec: ConditionNodeGuard];
  saveTrigger: [
    patch: {
      eventKey?: ActionTriggerEventKey;
      eventKeys?: ActionTriggerEventKey[];
      /** 触发字段分事件独立集合：value-change/field-click 各自一份，字段空=该事件不触发。 */
      eventFieldIds?: Partial<Record<ActionTriggerEventKey, string[]>>;
      blockable?: boolean;
      /** 流程步骤门：undefined = 不限（清空既有门）。 */
      workflowGate?: { notStarted: boolean; steps: WorkflowGateStep[] };
    }
  ];
  remove: [];
}>();

const visible = computed({
  get: () => props.show,
  set: v => emit('update:show', v)
});

// ── 草稿态：打开时从 node 克隆，保存才回写 ──
interface Draft {
  params: Record<string, unknown>;
  async: boolean;
  name: string;
  enabled: boolean;
  /**
   * 条件节点的唯一草稿载体——V4 判断表达式。null=尚未配置（保存时被
   * conditionMissing 拦下）。旧的 guardMode/guardLogic/guardItems/guardExpression/guardGroup/
   * guardTextSource 六个草稿字段随引导式与旧串式界面一并退役（旧条件必须重配）。
   */
  guardV4: ConditionV4Spec | null;
  /** 打开的是旧形态条件节点（有 guided/expression/group/condition 但无 v4）：只提示重配，不显示旧内容。 */
  guardLegacy: boolean;
  eventKey?: ActionTriggerEventKey;
  eventKeys: ActionTriggerEventKey[];
  scope: string;
  eventScopeFields: { 'value-change': string[]; 'field-click': string[] };
  blockable: boolean;
  /**
   * 流程步骤门草稿。undefined = 「不限」（gateMode 计算属性据此回落 'any'）；
   * 非 undefined 即「仅在所选步骤」，notStarted/steps 为门内容（steps 可为空——用户切到"仅所选步骤"
   * 但尚未勾选任何步骤，保存时 compile.ts buildWorkflowGate 会把这种空门写回 undefined，等效"无门"）。
   */
  workflowGate: { notStarted: boolean; steps: WorkflowGateStep[] } | undefined;
}
const draft = reactive<Draft>({
  params: {},
  async: false,
  name: '',
  enabled: true,
  guardV4: null,
  guardLegacy: false,
  eventKey: undefined,
  eventKeys: [],
  scope: 'form',
  eventScopeFields: { 'value-change': [], 'field-click': [] },
  blockable: false,
  workflowGate: undefined
});

// 触发根事件多选下拉数据源：template 模式排除 scheduled（与 ActionDesigner.vue
// addEventOptions 同一条规则——scheduled 事件已改由任务级动作文档持有，模板侧编辑触发根
// 时不应再能选中它）；job 模式保留全量（触发根固定为 scheduled，此下拉在 job 模式画布里现状不会
// 被用户用来切走该事件，但也不应把当前值排除在选项列表外）。
// 记录页事件（RECORD_PAGE_EVENT_KEYS = before-delete/after-delete）与上面 scheduled
// 的可见性刚好相反——只在 template 模式出现（job/定时任务没有"记录删除"语义），job 模式排除；
// 呼应 useActionDesigner.ts 的 supportedTriggers 默认值/交集同一条规则（见该文件注释）。
// 本下拉与画布「＋事件」下拉共用同一份分组（打开 / 保存 / 删除三组 + 平铺，见
// eventMenu.ts），NSelect 以 type:'group' 呈现（组头不可选，打开组子项用短名）；已选 tag 经 renderEventTag
// 仍显示事件全名（新建时/编辑时/查看时）。
const eventOptions = computed<Array<SelectOption | SelectGroupOption>>(() => {
  const allowed = new Set(
    ACTION_TRIGGER_EVENT_KEYS.filter(key => {
      if (key === 'scheduled') return props.designerMode === 'job';
      if (RECORD_PAGE_EVENT_KEYS.includes(key)) return props.designerMode !== 'job';
      return true;
    })
  );
  return buildEventMenuEntries(allowed).map(entry =>
    entry.kind === 'group'
      ? { type: 'group', label: entry.label, key: entry.key, children: entry.members.map(member => ({ label: member.label, value: member.key })) }
      : { label: entry.label, value: entry.key }
  );
});
// 触发事件下拉的展开态受控（点选一项后下拉直接关闭，不沿用 naive-ui 多选「选后保持展开」
// 的默认行为；再选下一项再点开即可）。移除 tag 也会走 update:value，此时下拉本就关闭，置 false 无副作用。
const eventMenuShow = ref(false);
function onEventKeysUpdate(keys: ActionTriggerEventKey[] | null): void {
  draft.eventKeys = keys ?? [];
  eventMenuShow.value = false;
}
/** 已选事件 tag：下拉里分组子项用短名（新建/编辑/查看），tag 上显示事件全名，避免脱离组头后语义不明。 */
const renderEventTag: SelectRenderTag = ({ option, handleClose }) =>
  h(
    NTag,
    {
      size: 'small',
      closable: !props.readonly,
      onClose: (e: MouseEvent) => {
        e.stopPropagation();
        handleClose();
      }
    },
    { default: () => eventLabel(option.value as ActionTriggerEventKey) }
  );
// 触发字段（值变动/点击）多选候选：按数据表分组（NSelect type:'group'，组头=表名，子项=字段名；
// 只显示表名与字段名，不显示物理列名/字段 id）。fieldGroups 未传时回落 fields 平铺。
// 条件分支（guard）由 V4 判断表达式承担、字段候选走 conditionTables，与本下拉互不相干。
const triggerFieldOptions = computed<Array<SelectOption | SelectGroupOption>>(() => {
  const groups = props.fieldGroups;
  if (groups && groups.length > 0) {
    return groups.map(group => ({
      type: 'group',
      label: group.table.table_name,
      key: group.table.data_table_id,
      children: group.fields.map(f => ({ label: f.field_name, value: f.field_id }))
    }));
  }
  return props.fields.map(f => ({ label: f.field_name, value: f.field_id }));
});
// job 模式：定时任务没有表单字段上下文，V4 判断表达式无从解析引用，
// 条件分支整体不可用——条件页只显示 conditionJobUnsupported 提示，不渲染「编辑条件」入口。
const conditionJobUnsupported = computed(() => props.designerMode === 'job' || !props.scope?.templateId);

const asyncable = computed(() => props.definition?.capabilities?.asyncable === true);

// 写模式：动作 params_schema 声明 x-write-operation（insert/update/delete）时，表达式编辑器④目标段
// 改为「写目标」段，并把 operation 种入中间模型（后端据此分流写模式编译/校验）。缺省 '' = 取数回填。
const writeOperation = computed<'' | 'insert' | 'update' | 'delete'>(() => {
  const op = (props.definition?.params_schema as { 'x-write-operation'?: string } | undefined)?.['x-write-operation'];
  return op === 'insert' || op === 'update' || op === 'delete' ? op : '';
});
const isWriteAction = computed(() => writeOperation.value !== '');
// before-save 事件根下的写动作（新增/修改/删除数据）必须同步执行（失败需阻断保存）——
// bandEventKeys 为本节点所属触发根的事件键集合（ActionDesigner.vue 传入），isWriteAction 复用上方
// 既有判定（按 params_schema 的 x-write-operation，与三写动作一一对应，见该 computed 注释）。
const asyncBlockedByBeforeSave = computed(() => (props.bandEventKeys ?? []).includes('before-save') && isWriteAction.value);
// 行数阈值（写动作，留空=不限）：落在 params.max_affected_rows 顶层（宿主 record grant 双保险同值）。
// 非正数/非数字一律写 undefined，即不设上限。
const maxAffectedRows = computed<number | null>(() => {
  const v = (draft.params as Record<string, unknown>)?.max_affected_rows;
  return typeof v === 'number' ? v : null;
});
function setMaxAffectedRows(v: number | null) {
  draft.params = { ...draft.params, max_affected_rows: typeof v === 'number' && v > 0 ? v : undefined };
}
// V4 配置面命中判定——顶层 x-editor 命中「取数 extract-v4」或「写动作 write-v4」时，
// 一律路由到插件 action-config surface。用一张常量表驱动，不为写动作另写一遍分支（新增第三种
// V4 配置面时也只需在此表追一行）。
const V4_SURFACE_PARAM_KEY: Record<string, string> = {
  'extract-v4': 'extract_v4',
  'write-v4': 'write_v4'
};
const v4SurfaceEditor = computed(() => {
  const editor = (props.definition?.params_schema as { 'x-editor'?: string } | undefined)?.['x-editor'];
  return !!editor && Object.prototype.hasOwnProperty.call(V4_SURFACE_PARAM_KEY, editor);
});

// 表达式编辑器挂载到 draft.params 的哪个 key：顶层 x-editor 命中 V4_SURFACE_PARAM_KEY
// （取数 'extract-v4' / 写动作 'write-v4'）时按表取值；否则回落 'expression'。
// 没有插件声明顶层/字段级 x-editor:'expression'（3.4 旧表达式编辑器判据），
// 回落分支只作防御性兜底，不代表仍有生产消费方。
const expressionParamKey = computed<string>(() => {
  const editor = (props.definition?.params_schema as { 'x-editor'?: string } | undefined)?.['x-editor'];
  if (editor && Object.prototype.hasOwnProperty.call(V4_SURFACE_PARAM_KEY, editor)) return V4_SURFACE_PARAM_KEY[editor];
  return 'expression';
});

// 标准化表达式编辑器：动作命中 V4 配置面（取数/写动作）且有 scope 时，挂载 action-config surface
// （深层编辑 UI 由插件 bundle 承载），产出统一中间模型写回 draft.params[expressionParamKey]。
const useExpressionEditor = computed(() => v4SurfaceEditor.value && !!props.scope);

// 上一步暂存区（供来源树渲染「上一步暂存区（<节点名>）」虚拟来源）：只认 V4 取数节点文档
// params.extract_v4.staging_target.columns。
//
// 🔴 不给 3.4 留回落：3.4 已退役，不做兼容（不读 params.expression 里 target_kind='staging' 的 3.4 形态）。
// 暂存列的两个键：column_id 是稳定键（唯一进临时表 DDL 的物理列名，也是下游
// staging_field.staging_column_id 的定位键），name 只是任意文本的显示名。此处 code 对应 column_id
// 语义（下方 code 即 field_id，供 getStagingSchema 与 3.4 预览 schema 消费——见其旁注）；
// 存量文档缺 column_id 时回落 name（存量列名受白名单约束，天然合法可当 code 用）。
const stagingSource = computed<{ producerNodeId: string; producerLabel: string; columns: Array<{ code: string; name: string; type?: string }> } | null>(() => {
  const producer = props.stagingProducer;
  if (!producer || producer.kind !== 'action') return null;
  const producerParams = (producer.params ?? {}) as Record<string, unknown>;
  const v4 = producerParams.extract_v4 as { staging_target?: { columns?: Array<{ column_id?: string; name?: string }> } } | undefined;
  if (!v4) return null;
  const columns = (v4.staging_target?.columns ?? [])
    .map(c => {
      const code = (c?.column_id ?? '').trim() || (c?.name ?? '').trim();
      const name = (c?.name ?? '').trim() || code;
      return { code, name };
    })
    .filter(c => c.code);
  // 上一步是 V4 取数节点但没配暂存输出（或列 code 均为空）⇒ 没有可读的暂存区，返回 null 让来源树不出现该节点。
  if (columns.length === 0) return null;
  // 前驱显示名：本组件只持有当前编辑节点的 ActionDefinition（props.definition），生产者节点的定义
  // 未随 stagingProducer 一并传入，故就地取生产者自身的自定义名 name，缺省回落其 actionName
  // （与画布节点标题的展示优先级一致）。
  const producerName = producer.name?.trim() || producer.actionName || '';
  return { producerNodeId: producer.id, producerLabel: $t('actionDesigner.dialog.stagingProducerLabel', { name: producerName }), columns };
});

/** 3.4 预览 schema 口径：把 stagingSource 的列摊平成 {name, field_id, kind}——name/field_id 都取
 *  column_id（物理列名/引用键），不是暂存列显示名；两处消费方（createExpressionHost 注入的
 *  编辑器内表达式预览、action-config surface 的 getStagingSchema）共用同一份口径，故抽出。 */
function toStagingPreviewSchema(source: typeof stagingSource.value): Array<{ name: string; field_id: string; kind: string }> | undefined {
  return source ? source.columns.map(c => ({ name: c.code, field_id: c.code, kind: 'string' })) : undefined;
}

// 向子树注入 ExpressionHost，结构化表达式编辑器通过 inject 获取。
// scope 可能为 undefined（非表达式动作），仅在有 scope 时注入；无 scope 时不挂载编辑器，无影响。
//
// 经 props.hostApi.createExpressionHost(getStagingSchema) 构造（appId 已在宿主侧构造期闭包绑定，
// 见 hostApi.ts createExpressionHost 注释）：按当前节点的
// stagingSource.columns 现场构造 getStagingSchema 闭包，注入 getStagingSchema getter
// （可选注入器，动作暂存区场景下由 ExpressionEditor 包内部发起的表达式预览据此携带
// staging_schema）。expressionHostInstance 保存本次挂载产出的实例，下方 onTest()「测试」
// 按钮的 compilePreview 复用同一实例，与注入编辑器共享同一份 staging_schema 语义。
let expressionHostInstance: ReturnType<ActionDesignerHostApi['createExpressionHost']> | undefined;
if (props.scope?.appId) {
  expressionHostInstance = props.hostApi.createExpressionHost(() => toStagingPreviewSchema(stagingSource.value));
  provideExpressionHost(expressionHostInstance);
}
// V4 生产桥：条件节点的判断表达式编辑器要用它
// 做 tokenize/restore/diagnose。与上方 3.4 桥同处一次性构造（setup 期，本弹窗一次挂载只服务一个
// scope），只在**模板上下文完整**时才造——job 模式 templateId 为空串，条件分支整体不可用。
// 宿主未升级（hostApi 无 createAliceV4Host）时恒 undefined，条件页降级为 conditionHostUnavailable
// 提示，不抛错。
const aliceV4Host: AliceV4Host | undefined =
  props.scope?.appId && props.scope?.templateId
    ? props.hostApi.createAliceV4Host?.({
        appId: props.scope.appId,
        templateId: props.scope.templateId,
        templateVersionNo: props.scope.templateVersionNo
      })
    : undefined;
// 联动表单专用 V4 宿主实例：
// 🔴 不能与上面的 aliceV4Host 共用——条件编辑器那侧的 setScope watch（见下方约 1350 行）恒把
// sources 置空、只装配 conditionTables 这一份"本报表来源"，两个消费方各自 setScope 会互相覆盖
// （最后一次 setScope 生效，条件页一 watch 就把联动表单刚装配好的目录来源冲掉）。联动表单节点
// 的查询作用域改由 LinkedFormPanel.vue 自己按 linked_form_v4.query.sources 装配（见该文件
// syncScope），两边必须是两个独立的宿主实例才不互踩——构造条件与 aliceV4Host 逐字同款。
const linkedFormV4Host: AliceV4Host | undefined =
  props.scope?.appId && props.scope?.templateId
    ? props.hostApi.createAliceV4Host?.({
        appId: props.scope.appId,
        templateId: props.scope.templateId,
        templateVersionNo: props.scope.templateVersionNo
      })
    : undefined;
// setExpressionModel 同时承载 3.4 ExpressionModel 与 V4 取数节点文档——写入哪个 draft.params
// 键完全由 expressionParamKey 决定（'expression' / 'extract_v4'），本函数自身不关心具体形状。
function setExpressionModel(v: ExpressionModel | V4ExtractNodeDocument | V4WriteNodeDocument) {
  if (props.readonly) return;
  draft.params = { ...draft.params, [expressionParamKey.value]: v };
}

// 确认（保存）时驱动表达式编辑器一次性收口（剔「不填充」输出行 + 剪零引用显式来源表）。
// 下方模板里的 action-config surface（如 extraction/write bundle）挂载点经 actionConfigSurfaceRef
// 暴露 finalize；SDK surface 契约未开确认钩子，走 ref + defineExpose 的 duck-typing——组件若未暴露
// finalize（旧 bundle）则可选链静默跳过，不改变现有行为。
// 类型带 Array 分支：挂载点嵌在下方 `v-for="pt in tabsWithoutOptions"` 之内——即便运行时同一时刻
// 只有一个 NTabPane 分支真正渲染出该元素，Vue 编译期只要见到 ref 处于 v-for 祖先之下，就统一按
// v-for ref 语义把它收集成数组，与是否真的循环出多份实例无关；读取处一律经 firstRefInstance 归一化。
//
// finalize() 的返回形状有两种协议并存——
// ①旧协议（3.4/历史 bundle）：直接同步返回收口后的模型（ExpressionModel），onSave 原样 setExpressionModel；
// ②新协议（V4，如记录控制器插件的 ActionConfigSurface.vue）：可异步返回 `{ ok, doc }`——ok=false 表示
//   V4 校验未通过，onSave 就地报错且不提交保存；ok=true 时 doc 为收口后的 V4ExtractNodeDocument
//   （取数）或 V4WriteNodeDocument（写动作）。
// 两种协议通过运行时 `'ok' in result` 探测区分，互不冲突（3.4 模型不含 ok 字段）。
type FinalizeOutcome = { ok: boolean; doc?: unknown };
type FinalizeResult = ExpressionModel | V4ExtractNodeDocument | V4WriteNodeDocument | FinalizeOutcome | undefined;
// test：V4 配置面自身暴露的两段式校验方法（finalize → host.compile），
// 「测试」按钮命中 v4SurfaceEditor 时改调它（见下方 onTest）；旧 bundle/3.4 面无此方法，可选链跳过。
type FinalizableInstance = {
  finalize?: () => FinalizeResult | Promise<FinalizeResult>;
  test?: () => Promise<{ ok: boolean; diagnostics: string[] }>;
};
const actionConfigSurfaceRef = ref<FinalizableInstance | FinalizableInstance[] | null>(null);
// 联动表单面板收口 ref：与 actionConfigSurfaceRef 是各自
// 独立的挂载点（互斥渲染——LinkedFormPanel 只在 isLinkedFormAction 时才出现），不复用它的 finalize
// 分发路径：那条路径成功后经 setExpressionModel 写进 draft.params[expressionParamKey]，而联动
// 表单的收口结果要写进 draft.params.linked_form_v4，键不同，不能共用同一段回写逻辑，见 onSave()
// 内单独的处理分支。
const linkedFormPanelRef = ref<FinalizableInstance | FinalizableInstance[] | null>(null);
/** 归一化上面两个 v-for 语义下的 ref：取数组首个非空实例，非数组则原样返回。 */
function firstRefInstance<T>(r: T | T[] | null): T | null {
  if (!r) return null;
  return Array.isArray(r) ? (r[0] ?? null) : r;
}

// V4 节点旧格式判定——V4 动作节点仍带 3.4 遗留 expression 键、但尚无本节点对应的
// V4 文档键（extract_v4/write_v4，取决于 x-editor，见 expressionParamKey）——V4 之前保存的
// 旧节点，或从别处拖拽/复制而来。顶部横幅提示用户该节点已停用，需重新配置后保存；不回显
// expression 内容（不猜测/不自动迁移）。仅 v4SurfaceEditor 场景生效。
const legacyExpressionPresent = computed(
  () => v4SurfaceEditor.value && draft.params.expression !== undefined && draft.params[expressionParamKey.value] === undefined
);
// 旧格式失效横幅文案键：取数/写动作各自的提示语内容不同（写动作强调「写入规则」），按顶层
// x-editor 二选一，不新增判定分支——与 legacyExpressionPresent 共用同一命中门槛。
const legacyV4ConfigBannerKey = computed(() =>
  (props.definition?.params_schema as { 'x-editor'?: string } | undefined)?.['x-editor'] === 'write-v4'
    ? 'actionDesigner.dialog.writeV4LegacyConfig'
    : 'actionDesigner.dialog.extractV4LegacyConfig'
);

// 传给编辑器的模型（V4，v4SurfaceEditor 恒真——本 computed 只在该分支消费）：
// draft.params[expressionParamKey] 形状合法（取数 isExtractNodeDocument / 写动作
// isWriteNodeDocument）则原样返回，否则（新节点/旧节点尚无该键/畸形值）兜底空文档（写动作的
// 空文档需要操作种类，取自 writeOperation 计算属性）——深层校验归宿主保存闸，本处只做浅层形状识别。
const expressionDraftModel = computed<V4ExtractNodeDocument | V4WriteNodeDocument>(() => {
  const existing = draft.params[expressionParamKey.value];
  if (isWriteAction.value) {
    // writeOperation 恒非空——三写动作的顶层 x-editor 声明与其操作种类声明由同一份 schema
    // 成对声明（见 kimpo-record-controllers 的三写动作声明），此处兜底 'insert' 只防御
    // 畸形 schema，不代表真实会走到。
    return isWriteNodeDocument(existing) ? existing : emptyWriteNodeDocument(writeOperation.value || 'insert');
  }
  return isExtractNodeDocument(existing) ? existing : emptyExtractNodeDocument();
});

// ── action-config surface 混合渲染 ──────────────────────────────────────────
// 对声明了 action-config surface 的插件（如 extraction）：在引导式区域用插件 bundle 渲染；
// 未找到 surface 或加载失败时静默回退到框架自带 ExpressionEditor。
const actionConfigSurfaceComponent = shallowRef<Component | null>(null);
// 当前挂载的是非 V4 动作的第三方配置面板（而非取数/写动作的 V4 表达式配置面）。
const genericActionConfigMounted = ref(false);
// hostApi.createActionConfigSurface 回传的 bridge（宿主已装配好 'domain:expression' + 'i18n'
// 两键，类型收窄为 Record<string, unknown>，插件侧不感知其内部结构）。
const actionConfigBridge = shallowRef<Record<string, unknown> | null>(null);
const surfaceLoading = ref(false);
// V4 配置面加载失败态——仅 v4SurfaceEditor 场景使用。旧格式节点已停用，回落会让用户误以为
// 还能用旧界面继续编辑，故必须显式报错，不得静默回落。
const surfaceError = ref<string | null>(null);
// V4 取数 / 写动作没有解析到任何配置面板（官方记录控制器
// 未安装 / 未启用，或尚未提供 `operation_kind:<kind>` 标准面板）时，显式提示而不是空态。
const standardPanelMissing = ref(false);
let actionConfigLoadGeneration = 0;
let sheetCatalogLoadGeneration = 0;
let workflowCatalogLoadGeneration = 0;
let sensitiveAuthorityGeneration = 0;
let sensitiveStateDisposed = false;

// log 能力适配器——转发到 console 并带插件来源标签，满足 manifest host_caps:log 声明。
// surface 可通过 hostBridge['log'] 上报关键位置（加载失败/调用失败）的日志。
const surfaceLogBridge = {
  debug: (msg: string, ...args: unknown[]) => console.debug('[action-surface]', msg, ...args),
  info:  (msg: string, ...args: unknown[]) => console.info('[action-surface]', msg, ...args),
  warn:  (msg: string, ...args: unknown[]) => console.warn('[action-surface]', msg, ...args),
  error: (msg: string, ...args: unknown[]) => console.error('[action-surface]', msg, ...args),
};

// 响应式 surface 输入：model 随 draft 实时更新，使 surface 组件在宿主选项更改后同步刷新。
const actionConfigSurfaceInput = computed(() => ({
  surfaceType: 'action-config',
  bind: props.definition?.name,
  // 'domain:alice-v4'：取数节点 V4 配置面（extract-v4）需要的能力键（V4 编译预览/目录拉取等由宿主桥注入）。
  hostCaps: ['request', 'message', 'domain:expression', 'domain:alice-v4', 'log', 'i18n', 'platform.interactiveSession'],
  hostContext: {
    appId: props.scope?.appId ?? '',
    templateId: props.scope?.templateId ?? '',
    actionName: props.definition?.name ?? '',
    // 本对象是挂载后以响应式 :input 覆盖官方标准面板入参的那一份，bind 是真实动作名；第三方写节点的
    // 名字不在官方兼容表里，面板只能靠这里的 operationKind 折算写模式（漏传会让第三方新增 / 修改 / 删除
    // 节点被当成取数打开）。官方动作与非数据动作分别得到兼容表种类 / undefined。
    operationKind: resolveOperationKind(props.definition?.name, props.definition),
    // 写动作 V4 配置面（write-v4）需要知道本节点所属触发根的事件键集合，用来提示
    // 「定时任务下本模板字段不可用」（scheduled 根无表单上下文）；透传自 props.bandEventKeys，
    // 与 asyncBlockedByBeforeSave 同一份数据来源，本文件只负责递到位，判断逻辑归 surface。
    bandEventKeys: props.bandEventKeys
  },
  runtime: undefined,
  props: {
    modelValue: expressionDraftModel.value,
    onUpdateModel: setExpressionModel,
    readonly: props.readonly === true,
    // 随 surface props 递交 stagingSource，供插件侧 action-config 组件判断是否展示「上一步暂存区」来源。
    stagingSource: stagingSource.value,
    // 取数节点 V4 配置面需要真实节点 ID（供 host.setNodeId → compile 请求体 node_id），
    // 节点 ID 即当前编辑节点的 MindNode.id（与 BehaviorActionNode.node_id 一致）。
    nodeId: props.node?.id ?? ''
  },
  // actionConfigBridge.value 已是宿主装配好的 { 'domain:expression', 'i18n' }
  // 桥对象（见 hostApi.createActionConfigSurface），原样展开、只追加插件本地的 'log' 键。
  hostBridge: actionConfigBridge.value
    ? { ...actionConfigBridge.value, interactiveSession: props.interactiveSession, log: surfaceLogBridge }
    : {}
}));

// 非 V4 动作的配置面板输入（SDK ActionConfigSurfaceProps 通用参数约定）：
// 面板直接读写动作参数对象 params，经 onUpdateParams 整体回写；readonly 时只读展示。
const genericActionConfigSurfaceInput = computed(() => ({
  surfaceType: 'action-config',
  bind: props.definition?.name,
  hostContext: {
    appId: props.scope?.appId ?? '',
    templateId: props.scope?.templateId ?? '',
    actionName: props.definition?.name ?? ''
  },
  runtime: undefined,
  props: {
    params: { ...(draft.params ?? {}) },
    onUpdateParams: (next: Record<string, unknown>) => {
      draft.params = { ...(next ?? {}) };
    },
    readonly: props.readonly === true,
    paramsSchema: props.definition?.params_schema
  },
  hostBridge: actionConfigBridge.value
    ? { ...actionConfigBridge.value, interactiveSession: props.interactiveSession, log: surfaceLogBridge }
    : {}
}));

// 每次对话框打开（或切换到新动作）时，异步解析 action-config surface 并加载 bundle。
watch(
  () => [props.show, props.definition?.name, props.readonly === true] as const,
  async ([show, actionName, readonly]) => {
    const generation = ++actionConfigLoadGeneration;
    const parentInteractiveSession = props.interactiveSession;
    surfaceError.value = null; // 每次新一轮加载都先清掉上一次的错误态，避免跨节点/跨重试残留。
    standardPanelMissing.value = false;
    if (!show || readonly) {
      actionConfigSurfaceComponent.value = null;
      actionConfigBridge.value = null;
      surfaceLoading.value = false;
      return;
    }
    // 第三方 SDK 验证 action B1：非 V4 动作也尝试按动作名解析 action-config surface——插件声明了就挂
    // 插件面板（参数读写走 genericActionConfigSurfaceInput 的 params/onUpdateParams 契约），没有就
    // 回落通用表单。V4（取数/写动作）仍走原表达式配置面路由，行为不变。
    genericActionConfigMounted.value = false;
    if (!actionName || !props.scope || !parentInteractiveSession) {
      actionConfigSurfaceComponent.value = null;
      actionConfigBridge.value = null;
      surfaceLoading.value = false;
      return;
    }

    surfaceLoading.value = true;
    actionConfigSurfaceComponent.value = null;
    try {
      // 解析插件 surface → 装配表达式桥 → 加载子插件前端 → 调子插件 createSurface 整段宿主逻辑
      // 由 hostApi.createActionConfigSurface 承担；getStagingSchema 原样透传（无降级，见 hostApi.ts 顶部注释）。
      const mounted = await props.hostApi.createActionConfigSurface({
        actionName,
        appId: props.scope.appId,
        templateId: props.scope.templateId,
        // 与 createExpressionHost 注入处同一口径（toStagingPreviewSchema）——
        // name/field_id 都取 c.code（=column_id 物理列名），不是显示名。
        getStagingSchema: () => toStagingPreviewSchema(stagingSource.value),
        // 数据动作带上种类，宿主按动作名找不到面板时回落官方
        // 标准面板（bind = operation_kind:<kind>）；非数据动作为 undefined，宿主行为不变。
        operationKind: resolveOperationKind(actionName, props.definition)
      });
      // V4 动作未解析到任何面板：给出「标准配置面板不可用」提示（模板里据此替代空态）。
      if (!mounted?.component && generation === actionConfigLoadGeneration && v4SurfaceEditor.value) {
        standardPanelMissing.value = true;
      }

      if (
        mounted?.component &&
        generation === actionConfigLoadGeneration &&
        props.show &&
        !props.readonly
      ) {
        // 子 surface 必须从 Host 挂载结果继承父 handle；对象不一致说明发生了第二会话/第二锁接线。
        requireInheritedInteractiveSession(parentInteractiveSession, mounted.bridge);
        // 先设 bridge，再设 component，保证 actionConfigSurfaceInput 中的 hostBridge 在挂载时已就绪。
        actionConfigBridge.value = mounted.bridge;
        genericActionConfigMounted.value = !useExpressionEditor.value;
        actionConfigSurfaceComponent.value = markRaw(mounted.component as Component);
      }
    } catch (e) {
      if (v4SurfaceEditor.value) {
        // V4：配置面加载失败必须显式报错态，不得静默回落 3.4 编辑器。
        surfaceError.value = e instanceof Error ? e.message : String(e);
      }
      // 非 V4：Surface 加载失败时静默回退到框架 ExpressionEditor（行为不变）。
    } finally {
      if (generation === actionConfigLoadGeneration) surfaceLoading.value = false;
    }
  }
);

// 插件声明的对话框 tab（params_schema['x-tabs']）：primary 承载取数编辑器、options 承载框架选项(异步)。
// 缺省回落 参数/选项（非声明 tab 的动作走通用渲染；六个专属面板动作也落这里）。
// 回落组显示名为「选项」，与已声明 x-tabs 的动作措辞统一；
// 专属面板不自带第二个「选项」入口，异步开关只在头部这一个浮层里。
interface PluginTab {
  key: string;
  label: string;
  primary?: boolean;
  options?: boolean;
}
const pluginTabs = computed<PluginTab[]>(() => {
  const declared = (props.definition?.params_schema as { 'x-tabs'?: PluginTab[] } | undefined)?.['x-tabs'];
  if (Array.isArray(declared) && declared.length > 0) return declared;
  return [
    { key: 'main', label: $t('actionDesigner.dialog.tabParams'), primary: true },
    { key: 'ext', label: $t('actionDesigner.dialog.tabOptions'), options: true }
  ];
});
const primaryTabKey = computed(() => pluginTabs.value.find(t => t.primary)?.key ?? pluginTabs.value[0]?.key ?? 'main');
const optionsTabKey = computed(() => pluginTabs.value.find(t => t.options)?.key ?? '');
// 浮层按钮/标题文案直接取 options 组自身的 label——extract/create/update/delete 等已声明 x-tabs 的
// 动作由插件硬编码「选项」（TODO(i18n-⑧) 待后端目录端点化统一本地化），回落默认组用 $t 出的
// actionDesigner.dialog.tabOptions（同为「选项」）。
const optionsTabLabel = computed(() => pluginTabs.value.find(t => t.options)?.label ?? '');
// 选项浮层——options 组不渲染成可点击 tab，改在主区右上角「选项」按钮+
// 浮层承载；按 x-tabs 特征分派，
// 不写死具体动作 key，故对所有声明/回落 options 组的动作节点通用生效。
// tabsWithoutOptions：实际渲染进 NTabs 的 tab 集合（options 组已摘除）。
const tabsWithoutOptions = computed<PluginTab[]>(() => pluginTabs.value.filter(t => !t.options));
// 动作节点摘除 options 后只剩 1 个 tab（现状 extract/create/update/delete/detail-sort/sheet-*
// 等绝大多数动作皆如此，仅 primary+options 两项）时，无 tab 可切换，隐藏 tab 头，直接进内容
// （顶部只保留「选项」按钮，不见外层「取数」tab）。
// 仅对动作节点生效，条件/触发根节点的单 tab 头样式不受影响。
const hideActionTabNav = computed(() => props.node?.kind === 'action' && tabsWithoutOptions.value.length <= 1);
// 选项浮层开关状态：NPopover 默认仅由 trigger 点击切换，浮层内的 × 关闭按钮需要程序化收起，
// 故显式受控（v-model:show），与 LinkedFormPanel 的 settingsVisible 同款约定。
const optionsPopVisible = useActionDesignerPopover();

const title = computed(() => {
  switch (props.node?.kind) {
    case 'action':
      return $t('actionDesigner.dialog.editAction');
    case 'condition':
      return $t('actionDesigner.dialog.editCondition');
    case 'trigger-root':
      return $t('actionDesigner.dialog.editTrigger');
    default:
      return $t('actionDesigner.dialog.editNode');
  }
});

// 当前激活 Tab。
const tab = ref('main');

/**
 * 头部两枚文字按钮的尺寸钉定。
 * 目标尺寸：
 * - 「重命名」浅底 chip（.ncd-rename-link）：12px 字、内边距 2px 8px、图标 + 文字，高度 = 行高 + 4，按行高 18 推算为 22；
 * - 「选项」描边钮（.ncd-options-btn）：24 高、12px、左右内边距 12、最小宽 64。
 * 二者都落在 Naive tiny 档（默认 22 高）：重命名钉 22 / 12 / 7（量测 67 宽，2d 修复循环由 8 改 7），选项钉 24 / 12 / 12；各用独立 KControlSize 容器，互不影响。
 * 「选项」容器包住整个 NPopover（Popover 内容无 tiny 按钮，浮层里的 NInputNumber small 档不受影响）。
 */
const RENAME_BTN_TIERS: KControlSizeTiers = { tiny: { height: 22, fontSize: 12, paddingX: 7 } };
const OPTIONS_BTN_TIERS: KControlSizeTiers = { tiny: { height: 24, fontSize: 12, paddingX: 12 } };

// ── 顶部节点名——粗体标题+「重命名」链接，点击原地切换为输入框 ──
// 展示名：draft.name 为空时回落到动作默认标题/动作名（相当于输入框的 placeholder 语义）。
const displayNodeName = computed(() => draft.name.trim() || resolveLocalized(props.definition?.title) || props.node?.actionName || '');
const renamingNode = ref(false);
// 重命名编辑态本地缓冲：不直接绑 draft.name，Esc 取消时天然不落任何改动（无需额外存"原值"）。
const renameDraft = ref('');
const renameInputRef = ref<InstanceType<typeof NInput> | null>(null);
function startRename(): void {
  renameDraft.value = displayNodeName.value;
  renamingNode.value = true;
  // 等输入框挂载后再聚焦+全选（点击「重命名」原地切换为输入框，自动聚焦全选）。
  nextTick(() => {
    renameInputRef.value?.focus();
    renameInputRef.value?.select();
  });
}
function confirmRename(): void {
  if (!renamingNode.value) return; // Esc 取消已退出编辑态，避免 Esc 后紧随的 blur 事件重复提交
  draft.name = renameDraft.value.trim();
  renamingNode.value = false;
}
function cancelRename(): void {
  renamingNode.value = false; // 不写回 renameDraft，等效恢复原名
}

/**
 * Esc 内层分流（KDialog escapeInterceptor，从局部到整体；返回 true = 已消费，本次 Esc 不再关窗）：
 *   1. 名称行重命名输入框处于编辑态 → 只取消重命名（弹层栈在 window 捕获阶段先于输入框自带的
 *      @keydown.esc 派发，所以必须在此处理，否则 Esc 会直接关掉整个节点配置、丢掉未保存的草稿）；
 *   2. 条件页内嵌表达式面板的树坞搜索框有内容 → 只清空搜索（同取数「筛选条件」弹窗的外壳口径）。
 * 其余情况返回 false，由 KDialog 走「还原最大化 → 关闭」。Naive 下拉 / 气泡由弹层栈在此之前让位，不经过这里。
 */
function onEscapeInner(): boolean {
  if (renamingNode.value) {
    cancelRename();
    return true;
  }
  const panel = props.node?.kind === 'condition' ? conditionPanelRef.value : null;
  if (panel?.isSearching?.()) {
    panel.clearSearch?.();
    return true;
  }
  return false;
}

function resetDraft(): void {
  const n = props.node;
  if (!n) return;
  renamingNode.value = false; // 打开/切换节点时重置重命名编辑态，避免跨节点残留
  draft.params = { ...n.params };
  // before-save 根下的写动作节点强制同步——即使节点自身曾携带 async:true（如从别的
  // 触发根拖拽/复制而来），打开编辑时也不回显为开，与下方模板的显示态/onSave 提交值保持一致。
  draft.async = asyncBlockedByBeforeSave.value ? false : (n.async ?? false);
  draft.name = n.name ?? '';
  draft.enabled = n.enabled ?? true;
  // 条件节点 guard 草稿只认 V4 判断表达式。深拷贝——「取消」必须不留痕（草稿语义）。
  // 旧形态（结构化 group / 旧 KimpoSQL 串 / 引导式 guided / 更旧的裸 condition）一律只置 legacy 旗，
  // 不回填任何可编辑内容：旧条件必须重配，展示旧内容会让用户以为它还在生效。
  const guard: ConditionNodeGuard | undefined = n.guardSpec;
  draft.guardV4 = guard?.v4 ? (JSON.parse(JSON.stringify(guard.v4)) as ConditionV4Spec) : null;
  draft.guardLegacy =
    !draft.guardV4 &&
    (!!guard?.group || (guard?.expression ?? '').trim() !== '' || (guard?.guided?.items?.length ?? 0) > 0 || !!n.condition);
  draft.eventKey = n.eventKey;
  // 多事件集合：优先节点 eventKeys，旧节点回落单值。
  draft.eventKeys = n.eventKeys && n.eventKeys.length > 0 ? [...n.eventKeys] : n.eventKey ? [n.eventKey] : [];
  draft.scope = n.scope ?? 'form';
  // 触发字段按事件独立初值：优先节点 eventFieldIds 分事件读取；旧节点（无 eventFieldIds，
  // 但 scopes 里有 field: 项）把同一份字段集合复制进两个事件（兼容原「共享 scopes」语义——
  // 两事件本就各得同份字段）。
  if (n.eventFieldIds) {
    draft.eventScopeFields = {
      'value-change': [...(n.eventFieldIds['value-change'] ?? [])],
      'field-click': [...(n.eventFieldIds['field-click'] ?? [])]
    };
  } else {
    const scopes = n.scopes && n.scopes.length > 0 ? n.scopes : n.scope ? [n.scope] : [];
    const legacyFields = scopes.filter(s => s.startsWith('field:')).map(s => s.slice('field:'.length));
    draft.eventScopeFields = { 'value-change': [...legacyFields], 'field-click': [...legacyFields] };
  }
  draft.blockable = n.blockable ?? false;
  // 流程步骤门草稿——深拷贝（草稿语义，「取消」不留痕）；无门时 undefined（「不限」）。
  draft.workflowGate = n.workflowGate
    ? { notStarted: n.workflowGate.notStarted, steps: n.workflowGate.steps.map(s => ({ ...s, arrivals: [...s.arrivals] })) }
    : undefined;
  tab.value = n.kind === 'action' ? primaryTabKey.value : 'main';
}

// 打开（或打开期间切换节点）时重建草稿。
watch(
  () => [props.show, props.node?.id] as const,
  ([open]) => {
    if (open) resetDraft();
  },
  { immediate: true }
);

// 🔴 声明必须在下方 conditionTables 的 watch（immediate:true）之前：那个 watch 的 getter 引用了本
// computed，immediate 会让它在 setup 阶段同步求值一次，声明若在其后会直接撞 TDZ
// （ReferenceError: Cannot access 'isConditionNode' before initialization）。本文件已有同款警告
// （见 AdvancedExpressionPanel.vue selectedFunction 的注释），此处是第二例，实测踩过。
/** 当前编辑的是不是条件节点（决定要不要为它拉本表单表目录、渲染内嵌条件编辑器）。 */
const isConditionNode = computed(() => props.node?.kind === 'condition');

// ── 动作参数（从 params_schema 推导） ──
// 推导逻辑收在 genericParamForm.ts（含 required / default / 约束 / 字段目标数组识别）；
// x-picker 扩展关键字（同 x-editor/x-tabs 一套「扩展关键字特化渲染」先例）：'sheet-switch' / 'sheet-print' 时整个
// 动作升级为专用面板（SwitchSheetPanel / PrintPanel）。label 取 schema title——宿主动作目录已按当前界面语言把
// 插件声明的四语注解 x-kimpo-title 选成 title；没有 title 时回落参数键名（旧插件零回归）。
const paramFields = computed<GenericParamField[]>(() => deriveGenericParamFields(props.definition?.params_schema));
// 数据动作（挂官方标准取数 / 写配置面板的动作）的插件附加业务参数（如第三方的「审计备注」）：标准面板只编辑
// 引擎文档，附加参数在头部「选项」浮层用通用参数表单渲染。官方动作没有附加参数，浮层不变。
const dataActionExtraFields = computed<GenericParamField[]>(() =>
  useExpressionEditor.value ? dataActionExtraParamFields(paramFields.value) : []
);
// ── Sheet 选择器（x-picker=sheet-switch/sheet-print，切换Sheet/打印两动作参数）──
// 数据来源：kimposheet.sheet-catalog 能力（经宿主 templates/sheet-catalog 端点透传），与既有
// conditionTables watch 同一取上下文方式（props.scope.appId/templateId）。仅当本节点
// 参数里存在带 x-picker 的属性时才拉取，避免无谓请求。
const sheetCatalog = ref<SheetCatalogEntry[]>([]);
const hasSheetPicker = computed(() => paramFields.value.some(f => f.picker === 'sheet-switch' || f.picker === 'sheet-print'));
watch(
  () => [props.scope?.appId, props.scope?.templateId, hasSheetPicker.value] as const,
  async ([appId, templateId, needPicker]) => {
    const generation = ++sheetCatalogLoadGeneration;
    const authorityGeneration = sensitiveAuthorityGeneration;
    const isCurrent = () =>
      !sensitiveStateDisposed &&
      generation === sheetCatalogLoadGeneration &&
      authorityGeneration === sensitiveAuthorityGeneration;
    if (!needPicker || !appId || !templateId) {
      sheetCatalog.value = [];
      return;
    }
    try {
      const { data } = await props.hostApi.listSheetCatalog(appId, templateId);
      if (isCurrent()) sheetCatalog.value = data?.sheets ?? [];
    } catch {
      if (isCurrent()) sheetCatalog.value = [];
    }
  },
  { immediate: true }
);
// ── 切换Sheet（x-picker=sheet-switch，ui.switch_sheet 动作）专用卡片面板 ──────────
// 单步骤 Sheet 卡片网格（可见过滤/选中角标），框架级「异步执行」由本弹窗
// 头部「选项」浮层承载（面板不再自带第二个入口）；可见性过滤（隐藏 sheet 不可切）
// 移入面板内实现，参数产物见 SwitchSheetPanel.vue 头注。
const isSheetSwitchAction = computed(() => paramFields.value.some(f => f.picker === 'sheet-switch'));
/** 承载 sheet-switch 选择器的参数属性名（现状即插件声明的 sheet_id，按 schema 解析防硬编码漂移）。 */
const sheetSwitchParamKey = computed(() => paramFields.value.find(f => f.picker === 'sheet-switch')?.key ?? 'sheet_id');

// ── 打印单据（x-picker=sheet-print，ui.print 动作）专用面板 ──────────────────────
// 双步骤（选打印目标 Sheet 下拉 + 打印方式两卡/允许调整开关行），框架级
// 「异步执行」由本弹窗头部「选项」浮层承载（面板不再自带第二个入口）；目标下拉列全部
// sheet、仅设了打印区域的可选，判定在面板内实现，参数产物见 PrintPanel.vue 头注。
const isPrintAction = computed(() => paramFields.value.some(f => f.picker === 'sheet-print'));

// ── 流程步骤门（触发根「流程步骤门」区）─────────────────────────────────
// 目录：null=尚未加载完成（含加载中），[]=已加载（可能确实为空——模板未绑定任何流程）。
// 与 useActionDesigner.ensureWorkflowStepCatalog 是两条独立取数路径（互不依赖，各自的 generation
// 只保护自己这条），本弹窗只在触发根打开时按需拉一次，不复用 controller 的那份缓存（controller
// 侧那份供画布徽标用，二者数据源相同但请求各自独立，任一份先到都不阻塞另一份）。
const workflowCatalog = ref<WorkflowStepCatalogDefinition[] | null>(null);
const workflowCatalogFailed = ref(false);
watch(
  () => [props.show, props.node?.kind, props.designerMode, props.scope?.appId, props.scope?.templateId] as const,
  ([show, kind, mode, appId, templateId]) => {
    if (!show || kind !== 'trigger-root' || mode === 'job' || !appId || !templateId) return;
    if (workflowCatalog.value !== null) return; // 已加载过（含失败已置空数组），惰性加载一次，不重复请求
    const generation = ++workflowCatalogLoadGeneration;
    const authorityGeneration = sensitiveAuthorityGeneration;
    const isCurrent = () =>
      !sensitiveStateDisposed &&
      generation === workflowCatalogLoadGeneration &&
      authorityGeneration === sensitiveAuthorityGeneration;
    void (async () => {
      try {
        const { data, error } = await props.hostApi.listTemplateWorkflows(appId, templateId);
        if (!isCurrent()) return;
        if (error || !data) {
          workflowCatalogFailed.value = true;
          workflowCatalog.value = [];
          return;
        }
        workflowCatalogFailed.value = false;
        workflowCatalog.value = data.definitions ?? [];
      } catch {
        if (!isCurrent()) return;
        workflowCatalogFailed.value = true;
        workflowCatalog.value = [];
      }
    })();
  },
  { immediate: true }
);

/** 门单选态：'any'=不限（draft.workflowGate 为 undefined）；'only'=仅在所选步骤。 */
const gateMode = computed<'any' | 'only'>({
  get: () => (draft.workflowGate ? 'only' : 'any'),
  set: mode => {
    if (mode === 'any') {
      draft.workflowGate = undefined;
    } else if (!draft.workflowGate) {
      draft.workflowGate = { notStarted: false, steps: [] };
    }
  }
});
const gateNotStarted = computed<boolean>({
  get: () => draft.workflowGate?.notStarted ?? false,
  set: v => {
    if (draft.workflowGate) draft.workflowGate.notStarted = v;
  }
});

/** 门区是否渲染：目录为空（模板未绑定任何流程）且门也为空时整区不渲染（无事可配、也无残留待清理）。 */
const gateSectionVisible = computed(
  () =>
    props.node?.kind === 'trigger-root' &&
    props.designerMode !== 'job' &&
    !((workflowCatalog.value?.length ?? 0) === 0 && !draft.workflowGate)
);

/** 节点类型短标签（发起/办理/审批/子流程）：无对应既有 i18n key，暂硬编码中文常量。 */
const GATE_NODE_KIND_LABEL: Record<string, string> = { START: '发起', HANDLE: '办理', APPROVE: '审批', SUBFLOW: '子流程' };
function gateNodeKindLabel(kind: string | undefined): string {
  return kind ? (GATE_NODE_KIND_LABEL[kind] ?? kind) : '';
}

interface GateStepRow {
  key: string;
  nodeId: string;
  nodeKind?: 'START' | 'HANDLE' | 'APPROVE' | 'SUBFLOW';
  nodeName: string;
  checked: boolean;
  dead: boolean;
  arrivals: ('submitted' | 'returned')[];
  /** 仅①「定义在、节点不在」时可能有值：该定义最新步骤里恰好一个同名节点，供一键换绑。 */
  replaceCandidate?: { nodeId: string; nodeName: string };
}
interface GateDefCard {
  definitionId: string;
  name: string;
  published: boolean;
  disabled: boolean;
  /** true=②该定义本身已不在目录（被删/改绑别的模板，目录只返回本模板定义，二者在此表现相同）。 */
  deadDefinition: boolean;
  latestVersionNo: number;
  rows: GateStepRow[];
  selectedCount: number;
  totalCount: number;
}
/** 门内卡片：目录内定义按目录顺序在前（含该定义下已选但节点已不在的失效步骤①），
 *  目录外定义（②整卡失效，只给移除）在后。 */
const gateCards = computed<GateDefCard[]>(() => {
  const catalog = workflowCatalog.value;
  if (catalog === null) return []; // 目录尚未加载完成：不展示任何卡片，避免把既有步骤误判为失效
  const remaining = new Map<string, WorkflowGateStep[]>();
  for (const step of draft.workflowGate?.steps ?? []) {
    const arr = remaining.get(step.definitionId) ?? [];
    arr.push(step);
    remaining.set(step.definitionId, arr);
  }
  const cards: GateDefCard[] = [];
  for (const def of catalog) {
    const selected = remaining.get(def.definition_id) ?? [];
    remaining.delete(def.definition_id);
    const selectedByNodeId = new Map(selected.map(s => [s.nodeId, s] as const));
    const rows: GateStepRow[] = def.steps.map(step => {
      const sel = selectedByNodeId.get(step.node_id);
      return {
        key: `${def.definition_id}::${step.node_id}`,
        nodeId: step.node_id,
        nodeKind: step.node_kind,
        nodeName: step.node_name,
        checked: !!sel,
        dead: false,
        arrivals: sel ? sel.arrivals : []
      };
    });
    const deadRows: GateStepRow[] = selected
      .filter(s => !def.steps.some(ds => ds.node_id === s.nodeId))
      .map(s => {
        const candidates = def.steps.filter(ds => ds.node_name === (s.nodeName ?? ''));
        return {
          key: `${def.definition_id}::${s.nodeId}`,
          nodeId: s.nodeId,
          nodeName: s.nodeName ?? s.nodeId,
          checked: true,
          dead: true,
          arrivals: s.arrivals,
          replaceCandidate: candidates.length === 1 ? { nodeId: candidates[0].node_id, nodeName: candidates[0].node_name } : undefined
        };
      });
    cards.push({
      definitionId: def.definition_id,
      name: def.name,
      published: def.latest_version_no > 0,
      disabled: def.status === 'disabled',
      deadDefinition: false,
      latestVersionNo: def.latest_version_no,
      rows: [...rows, ...deadRows],
      selectedCount: selected.length,
      totalCount: def.steps.length
    });
  }
  // ②目录外定义：整卡失效，只给移除（目录只返回本模板定义，「改绑别的模板」与「被删」在此表现相同）。
  for (const [definitionId, steps] of remaining) {
    cards.push({
      definitionId,
      name: steps[0]?.definitionName ?? definitionId,
      published: false,
      disabled: false,
      deadDefinition: true,
      latestVersionNo: 0,
      rows: steps.map(s => ({
        key: `${definitionId}::${s.nodeId}`,
        nodeId: s.nodeId,
        nodeName: s.nodeName ?? s.nodeId,
        checked: true,
        dead: true,
        arrivals: s.arrivals
      })),
      selectedCount: steps.length,
      totalCount: steps.length
    });
  }
  return cards;
});
const gateValidRows = computed(() =>
  gateCards.value.flatMap(card => card.rows.filter(row => row.checked && !row.dead).map(row => ({ ...row, definitionId: card.definitionId })))
);
const gateSummaryStepCount = computed(() => gateValidRows.value.length);
const gateSummaryDefCount = computed(() => new Set(gateValidRows.value.map(row => row.definitionId)).size);
const gateDeadStepCount = computed(() => gateCards.value.reduce((sum, card) => sum + card.rows.filter(row => row.dead).length, 0));
/** 只勾了办理时（eventKeys 全是 handle-time）且门为空：提示语义上这一档天生不太需要门控（灰字提示，非阻断）。 */
const gateNoGateHint = computed(
  () => draft.eventKeys.length > 0 && draft.eventKeys.every(k => k === 'handle-time') && !draft.workflowGate
);

function toggleGateStep(card: GateDefCard, row: GateStepRow, checked: boolean): void {
  if (!draft.workflowGate) draft.workflowGate = { notStarted: false, steps: [] };
  const steps = draft.workflowGate.steps;
  const idx = steps.findIndex(s => s.definitionId === card.definitionId && s.nodeId === row.nodeId);
  if (checked) {
    if (idx < 0) {
      steps.push({
        definitionId: card.definitionId,
        nodeId: row.nodeId,
        definitionName: card.name,
        nodeName: row.nodeName,
        arrivals: ['submitted', 'returned']
      });
    }
  } else if (idx >= 0) {
    steps.splice(idx, 1);
  }
}
/** 到达方式两枚不能全灭：第二枚被点灭时直接取消该步勾选（移除整条），而非留一条零到达方式的死配置。 */
function toggleGateArrival(definitionId: string, nodeId: string, arrival: 'submitted' | 'returned'): void {
  const steps = draft.workflowGate?.steps;
  if (!steps) return;
  const idx = steps.findIndex(s => s.definitionId === definitionId && s.nodeId === nodeId);
  if (idx < 0) return;
  const step = steps[idx];
  const has = step.arrivals.includes(arrival);
  if (has) {
    const next = step.arrivals.filter(a => a !== arrival);
    if (next.length === 0) {
      steps.splice(idx, 1);
      return;
    }
    step.arrivals = next;
  } else {
    step.arrivals = [...step.arrivals, arrival];
  }
}
function removeGateStep(definitionId: string, nodeId: string): void {
  const steps = draft.workflowGate?.steps;
  if (!steps) return;
  const idx = steps.findIndex(s => s.definitionId === definitionId && s.nodeId === nodeId);
  if (idx >= 0) steps.splice(idx, 1);
}
function replaceGateStep(definitionId: string, oldNodeId: string, replacement: { nodeId: string; nodeName: string }): void {
  const steps = draft.workflowGate?.steps;
  if (!steps) return;
  const step = steps.find(s => s.definitionId === definitionId && s.nodeId === oldNodeId);
  if (!step) return;
  step.nodeId = replacement.nodeId;
  step.nodeName = replacement.nodeName;
}

// ── 联动表单（x-editor=linked-form，ui.linked_form 动作）专用面板 ──────────────────
// 步骤条布局、无 tabs（框架级「异步执行」
// 由本弹窗头部「选项」浮层承载，面板不再自带第二个入口），参数产物见 LinkedFormPanel.vue 头注。
const isLinkedFormAction = computed(
  () => (props.definition?.params_schema as { 'x-editor'?: string } | undefined)?.['x-editor'] === 'linked-form'
);
/** 专用面板（联动表单/表单操作）参数合并回写：面板产物经 patch 事件落 draft.params。 */
function patchPanelParams(partial: Record<string, unknown>): void {
  draft.params = { ...draft.params, ...partial };
}

// ── 表单操作（x-editor=form-control，ui.form_control 动作）专用面板 ────────────────
// 单步骤三卡片（保存/关闭/进入编辑），框架级「异步执行」由本弹窗头部
// 「选项」浮层承载（面板不再自带第二个入口），参数产物见 FormControlPanel.vue 头注。
const isFormControlAction = computed(
  () => (props.definition?.params_schema as { 'x-editor'?: string } | undefined)?.['x-editor'] === 'form-control'
);

// ── 提示语（ui.message，kimpo-ui-controllers 插件动作）专用面板 ────────────────────
// 三步骤（类型/内容/持续时间）+ 右侧实时预览卡片（还原填报态真实观感），参数产物见 MessagePanel.vue
// 头注。插件 schema 尚未声明 x-editor（改 schema 需 redeploy 插件），故按动作名分派；
// 插件侧将来补上 x-editor:message 后可与联动表单/表单操作统一为 schema 分派。
const isMessageAction = computed(() => props.definition?.name === 'ui.message');

// ── 明细排序（x-editor=detail-sort，data.sort_detail 动作）专用面板 ────────────────
// 步骤条布局（选明细表 → 排序键行编辑），
// 目录拉取与参数产物均在 DetailSortPanel.vue（沿用网关旧形态 params.targets[]，数组序 =
// 排序优先级，详见面板头注与插件侧明细排序动作实现）。
const isDetailSortAction = computed(
  () => (props.definition?.params_schema as { 'x-editor'?: string } | undefined)?.['x-editor'] === 'detail-sort'
);
/** 明细排序面板参数回写：undefined 值语义为删除该参数（清空 targets 时不留空键）。 */
function patchDetailSortParams(partial: Record<string, unknown>): void {
  const next = { ...draft.params };
  for (const [k, v] of Object.entries(partial)) {
    if (v === undefined) Reflect.deleteProperty(next, k);
    else next[k] = v;
  }
  draft.params = next;
}

function paramValue(key: string): unknown {
  return draft.params[key];
}
function setParam(key: string, value: unknown): void {
  const next = { ...draft.params };
  if (value === undefined || value === '') Reflect.deleteProperty(next, key);
  else next[key] = value;
  draft.params = next;
}
/** 通用参数表单（GenericParamsForm）增量回写：undefined 值语义为删除该参数（与明细排序面板同一口径）。 */
function patchGenericParams(partial: Record<string, unknown>): void {
  patchDetailSortParams(partial);
}

// ── 条件节点：V4 判断表达式 ──────────

/**
 * 条件编辑器的「本表单表」上下文：**本模板全部表**（主表在前 + 各扩展表），每表带自己的字段。
 *
 * 不限主表是有意为之：V4 判断表达式由宿主查询服务在服务端求值（`本报表.[表].[字段]`
 * 可跨主表/明细表解析），不是只认主表单行坐标的旧 guard 求值器，故不必也不该在入口收窄。
 *
 * alias 用 REPORT_ALIAS_PREFIX + 序号（bt0..n）——它同时是**递给编辑器的表标签**与 setScope 信封里
 * 的 alias，两处必须逐字一致：编辑器的分词按 alias 匹配 `本报表.[表].[字段]`，对不上就解析不出引用。
 *
 * sourceTables 恒空数组：条件分支没有「取数来源表」概念，从入口上就不给用户选。
 */
const conditionTables = ref<FormTableLite[]>([]);
/** conditionTables 拉取的竞态代（同 sheetCatalog/workflowCatalog 等目录 watch 同款防护：只让最后一次发起的加载写回）。 */
let conditionTablesLoadGeneration = 0;

// 表目录 + 逐表字段按需拉取：只在「当前编辑条件节点 + scope 完整」时发起（普通动作节点不需要）。
// 字段必须按表逐个拉——props.fields 是拍平后的全表字段，分不出哪个字段属于哪张表。
watch(
  () => [props.scope?.appId, props.scope?.templateId, isConditionNode.value] as const,
  async ([appId, templateId, isCondition]) => {
    const generation = ++conditionTablesLoadGeneration;
    const authorityGeneration = sensitiveAuthorityGeneration;
    const isCurrent = () =>
      !sensitiveStateDisposed && generation === conditionTablesLoadGeneration && authorityGeneration === sensitiveAuthorityGeneration;
    if (!isCondition || !appId || !templateId) {
      conditionTables.value = [];
      return;
    }
    try {
      const { data } = await props.hostApi.listTemplateTables(appId, templateId);
      const items = data?.items ?? [];
      // 表顺序信任宿主表目录序：后端已按「主表优先 → 设计器拖动排序位」下发，
      // 与编辑器/取数配置面同一口径，前端不再自排；bt<i> 别名下标随之按接口序分配。
      const withFields = await Promise.all(
        items.map(async table => {
          try {
            const res = await props.hostApi.listTemplateFields(appId, templateId, props.scope?.templateVersionNo, table.data_table_id);
            return { table, fields: res.data?.items ?? [] };
          } catch {
            // 单表字段拉取失败不牵连其余表：该表在字段树里显示为空表，而不是整个编辑器没有字段可选。
            return { table, fields: [] as TemplateField[] };
          }
        })
      );
      if (isCurrent()) conditionTables.value = withFields.map((entry, index) => ({ ...entry, alias: `${REPORT_ALIAS_PREFIX}${index}` }));
    } catch {
      if (isCurrent()) conditionTables.value = [];
    }
  },
  { immediate: true }
);

// 作用域信封：把本模板各表登记为 V4 的「本报表来源」，diagnose/tokenize/restore 三端点
// 随请求体携带，`本报表.[表].[字段]` 才解析得出来。
// 🔴 alias 必须是**表显示名**（table_name）：服务端 ExtractV4DesignScope 把 report 来源的 alias 当 Label，
// 分词按 `本报表.[表显示名].[字段]` 的表段与之逐字比对（bind.resolveReportField）；编辑器插入文本时也用
// table_name（bracketText.reportBracketToken）。bt* 只是编辑器内部索引，送进信封会报「本报表下找不到数据表」。
// instance_id 走共享包 reportInstanceId 的确定性派生（`rpt-<table_id>-<6hex>`，服务端保存闸只认这个
// 形态，编辑器侧的 bt* 只是索引）。
watch(
  () => conditionTables.value,
  tables => {
    if (!aliceV4Host) return;
    aliceV4Host.setScope?.({
      sources: [],
      report_sources: tables.map(entry => ({
        instance_id: reportInstanceId({ alias: entry.alias, data_table_id: entry.table.data_table_id }),
        table_id: entry.table.data_table_id,
        table_role: tableRoleOf(entry.table, tables.map(t => t.table)) === 'main' ? ('main' as const) : ('detail' as const),
        alias: entry.table.table_name
      }))
    });
  },
  { immediate: true }
);

// 共享面板直接观察自身可用空间，插件不再复制壳体 chrome 或反推 shell-height。
/**
 * 内嵌条件面板实例：保存流程先驱动它 confirm()，回调里才真正提交（见 onSave 的条件分支）。
 * 还读它转出的语法状态四件套（条件页页脚状态条）与 confirmDisabled（保存闸）。
 */
const conditionPanelRef = ref<{
  confirm: () => Promise<void> | void;
  syntaxState?: ConditionSyntaxState;
  syntaxLabel?: string;
  syntaxDetail?: string;
  confirmDisabled?: boolean;
  focusIssue?: () => void;
  /** Esc 内层分流用：条件页树坞搜索。 */
  isSearching?: () => boolean;
  clearSearch?: () => void;
} | null>(null);
/** 保存流程是否正卡在「等面板 tokenize 完成」这一步（避免重复点保存重复触发）。 */
const conditionConfirming = ref(false);
/** 条件页是否具备渲染内嵌面板的条件：非 job 模式且宿主两座桥都在。 */
const conditionPanelReady = computed(() => !conditionJobUnsupported.value && !!aliceV4Host && !!expressionHostInstance);
/**
 * 递给编辑器的条件 ID：优先沿用节点上已有的（改表达式不换身份，guard.path 的引用才稳定），
 * 新节点/旧形态重配时现分配一个。
 */
const conditionIdForEditor = computed(() => draft.guardV4?.conditionId ?? props.node?.guardSpec?.v4?.conditionId ?? newConditionId());

/**
 * 面板确认：整份 V4 文档 + 用户可读原文写回草稿，随即提交并关窗——内嵌形态下「保存」这一次点击
 * 同时完成「确认表达式」与「提交节点」，用户不需要先确认弹窗再点保存。
 */
function onConditionConfirm(payload: { expression: V4ExpressionDocument; readableText: string }): void {
  conditionConfirming.value = false;
  if (props.readonly) return;
  const conditionId = conditionIdForEditor.value;
  draft.guardV4 = {
    // negate/plan 原样承接既有草稿：前者由 invertGuardSpec 在编译期按分支置位，后者是后端钉入的
    // 发布物身份，两者都不该被一次表达式编辑抹掉。
    ...(draft.guardV4 ?? {}),
    conditionId,
    expression: payload.expression,
    readableText: payload.readableText
  };
  // 重配成功即脱离旧形态：保存闸（saveDisabled）随之放行。
  draft.guardLegacy = false;
  commitConditionSave();
}

/**
 * 文本未改（digest 不变）：草稿保持原样直接提交。全新节点（草稿里根本没有 V4 条件）走到这里说明
 * 用户一个字都没写就点了保存——由 commitConditionSave 的兜底报 conditionMissing 且不关窗。
 */
function onConditionUnchanged(): void {
  conditionConfirming.value = false;
  if (props.readonly) return;
  commitConditionSave();
}

/** 点条件页状态条（仅 error 态可点）：让面板选中并聚焦出错片段，与取数弹窗页脚状态条同款交互。 */
function onConditionSyntaxJump(): void {
  if (conditionPanelRef.value?.syntaxState !== 'error') return;
  conditionPanelRef.value.focusIssue?.();
}

/** 无法产出 V4 文档（随身包缺席/文本被清空）：就地报错，不提交不关窗，草稿不动。 */
function onConditionEditorError(): void {
  conditionConfirming.value = false;
  const msg = typeof window !== 'undefined' ? window.$message : undefined;
  msg?.error?.($t('actionDesigner.dialog.conditionHostUnavailable'));
}

/**
 * 重开已有条件时补齐可读原文：文档里存的是 token 化源码（`[标签]#{rN}`），直接显示
 * 是乱码，必须经宿主 restore 按当前目录还原（字段改名后显示新名）——内嵌面板的初始文本正是取
 * 这份可读原文（ConditionV4Editor.whereTextSource）。失败静默回落 source_text——宁可显示原样，
 * 也不因一个纯展示性还原失败让条件页空白。
 * 🔴 声明在 setScope 的 watch **之后**：restore 请求体在调用当下就读作用域信封，信封没给到桥时
 * 首次还原会因「找不到来源实例」失败（取数配置面同款踩坑，见 record-controllers ActionConfigSurface）。
 */
/**
 * restore 进行中：内嵌面板**只在挂载/show 那一刻读一次** textSource（AdvancedExpressionPanel 的
 * initialTextOf 不响应后续 prop 变化），若面板先于 restore 挂载，用户看到的就是 token 化源码
 * `[联系人]#{r1}`（保存后重开显示错误、执行正常）。故 restore 未落定前不挂面板。
 */
const conditionRestorePending = ref(false);
watch(
  () => [props.show, draft.guardV4?.conditionId, conditionTables.value.length] as const,
  async ([open, , tableCount]) => {
    if (!open) {
      conditionRestorePending.value = false;
      return;
    }
    const v4 = draft.guardV4;
    const sourceText = v4?.expression?.source_text ?? '';
    if (!v4 || v4.readableText || !aliceV4Host?.restore || sourceText === '') {
      conditionRestorePending.value = false;
      return;
    }
    // 🔴 作用域信封还没交给桥（表目录仍在拉取）时先等：restore 按调用当下的信封解析 `本报表.[表].[字段]`，
    // 信封为空必然解析失败 ⇒ 静默回落 token 文本。表目录到位会再次触发本 watch（tableCount 变化）。
    if (tableCount === 0) {
      conditionRestorePending.value = true;
      return;
    }
    conditionRestorePending.value = true;
    try {
      const res = await aliceV4Host.restore({ source_text: sourceText, refs: v4.expression.refs, purpose: 'condition' });
      // 同一条件还在草稿里才写回（期间可能切了节点/关了弹窗）。readable_text 只要给了就用（个别引用失效
      // 也比 token 文本可读）；老服务端不带该字段时退回 ok 才可信的 text。
      if (draft.guardV4?.conditionId === v4.conditionId) {
        const readable = res.readable_text || (res.ok ? res.text : '');
        if (readable) draft.guardV4.readableText = readable;
      }
    } catch {
      // 静默：面板初始文本回落 token 化源码（见 ConditionV4Editor.whereTextSource）。
    } finally {
      if (!draft.guardV4 || draft.guardV4.conditionId === v4.conditionId) conditionRestorePending.value = false;
    }
  },
  { immediate: true }
);

// 旧 expression 模式（KimpoSQL 串）+ 非空 else：无 NOT 可用，无法生成取反 guard（宿主后端
// 该文法与求值器均无 NOT），保存后编译会报错——设计期前置拦截（禁用保存 + 就地提示），
// 呼应 validate.ts 同款校验。
// V4 判断表达式取反 = 路径步 negate 翻转，恒可用；故这道闸只对**旧形态**保留
// （与 validate.ts 的 `!node.guardSpec.v4` 同一口径），否则 V4 条件的不成立分支会被误拦。
const guardExpressionElseInvalid = computed(
  () =>
    props.node?.kind === 'condition' &&
    props.node.guardSpec?.mode === 'expression' &&
    !props.node.guardSpec.v4 &&
    (props.node.elseChildren?.length ?? 0) > 0
);
/**
 * 条件节点保存闸：内嵌形态下「有没有配出表达式」由面板的
 * 确认流程当场判定（空文本→error 提示、未改且无草稿→conditionMissing 提示，两者都不关窗），
 * 故这里只保留「结构上根本没法配」的两档——job 模式与宿主缺桥；旧形态节点照常可点保存，
 * 点下去就是走面板确认（面板从空文本起步，不写就提示，写了即完成重配）。
 */
const conditionSpecRequired = computed(
  () => props.node?.kind === 'condition' && (conditionJobUnsupported.value || !conditionPanelReady.value)
);

// ── 按钮可见性：默认 取消/保存 常显，测试仅动作。预留 definition.dialogButtons 供插件控制（待接线）。 ──
const visibleButtons = computed(() => ({
  cancel: true,
  save: true,
  test: props.node?.kind === 'action'
}));
/**
 * 条件节点专属保存闸（对齐取数「筛选条件」弹窗的确定按钮 `panelRef?.confirmDisabled`）：
 * 面板自身判定不可确认时（语法错、未解析标签、宿主缺 lowerText）保存按钮同步禁用——否则用户点了
 * 保存只会被面板静默拦下，看不出发生了什么。只对条件节点生效，其它节点形态不受影响。
 */
const conditionConfirmBlocked = computed(
  () => props.node?.kind === 'condition' && (conditionPanelRef.value?.confirmDisabled ?? false)
);
const saveDisabled = computed(
  () =>
    guardExpressionElseInvalid.value ||
    conditionSpecRequired.value ||
    conditionConfirmBlocked.value
);
const canRemove = computed(() => props.node && props.node.kind !== 'trigger-root');

function onCancel(): void {
  visible.value = false;
}

// 保存只产出结构化表达式，并显式移除旧 KimpoSQL 载荷。
// 非 V4 场景直接原样返回（3.4 引导式模型的 stampRole 收口已随 3.4 x-editor:'expression' 判据退役）。
function finalizeActionParams(): Record<string, unknown> {
  if (v4SurfaceEditor.value) {
    // V4 节点角色盖章（stampRole）与深层结构化校验一律归宿主后端保存闸——
    // 插件侧不重复实现。本函数只兜一件事：旧 expression 键（3.4，本动作已停用）绝不能随 V4
    // 节点一起落库残留，哪怕节点当前仍处于 legacyExpressionPresent 失效态、用户未触碰任何输入
    // 就直接点了保存。
    const next = { ...draft.params };
    delete next.expression;
    // 写动作硬切到 write_v4——3.4 写模式遗留的 kimpo_sql/param_bindings/targets
    // 三个键同样不得随 V4 节点落库残留（取数 V4 无此历史包袱，仅写动作需要这一步）。
    if (isWriteAction.value) {
      delete next.kimpo_sql;
      delete next.param_bindings;
      delete next.targets;
    }
    return next;
  }
  return draft.params;
}

// onSave 是 async——V4 的 finalize() 可能异步返回 `{ ok, doc }`（校验未通过时 ok=false，
// 需要在提交前拿到结果才能决定是否放行）；旧协议（同步直接返回模型）经
// `await` 原样透传（await 非 Promise 值即为该值本身）。
async function onSave(): Promise<void> {
  if (props.readonly) return;
  const n = props.node;
  if (!n) return;
  if (n.kind === 'action') {
    // 确认收口——finalize 内部已同步 emit update:modelValue → setExpressionModel 回写
    // draft，这里再显式取一次返回值兜底写入，不依赖事件时序。旧 bundle/旧包版本无 finalize 时
    // 可选链短路，finalized 为 undefined。
    const surfaceInstance = firstRefInstance(actionConfigSurfaceRef.value);
    const finalizeFn = surfaceInstance?.finalize;
    if (finalizeFn) {
      const result = await finalizeFn();
      if (result !== undefined && typeof result === 'object' && 'ok' in result) {
        // 新协议（V4）：{ ok, doc }。ok=false=校验未通过，就地报错、不提交保存、弹窗留在原地。
        if (result.ok === false) {
          const msg = typeof window !== 'undefined' ? window.$message : undefined;
          msg?.error?.($t('actionDesigner.dialog.testFailedWith', { msg: '' }));
          return;
        }
        if (result.doc !== undefined) setExpressionModel(result.doc as ExpressionModel | V4ExtractNodeDocument | V4WriteNodeDocument);
      } else if (result !== undefined) {
        // 旧协议：finalize() 直接返回收口后的模型。
        setExpressionModel(result as ExpressionModel | V4ExtractNodeDocument | V4WriteNodeDocument);
      }
    }
    // 联动表单面板收口：与上面的 surfaceInstance/editorInstance
    // 互斥挂载（isLinkedFormAction 节点才渲染 LinkedFormPanel），两条分支不会同时命中。结果只走新协议
    // （LinkedFormPanel.finalize 恒返回 `{ok, doc, diagnostics}`，不存在旧协议），成功也不经
    // setExpressionModel——那会写进 draft.params[expressionParamKey]（'expression'/'extract_v4' 等），
    // 联动表单的收口结果要落 draft.params.linked_form_v4，键不同，直接合并进 draft.params。
    const linkedFormInstance = firstRefInstance(linkedFormPanelRef.value);
    if (linkedFormInstance?.finalize) {
      const lfResult = await linkedFormInstance.finalize();
      if (lfResult !== undefined && typeof lfResult === 'object' && 'ok' in lfResult) {
        if (lfResult.ok === false) {
          const msg = typeof window !== 'undefined' ? window.$message : undefined;
          // 把 tokenize 诊断原文带进提示（取数面板同位置传空串、只显示前缀，用户看不到失败原因）。
          const diags = (lfResult as unknown as { diagnostics?: Array<{ diagnostic?: { message?: string } }> }).diagnostics;
          const detail = Array.isArray(diags) ? diags.map(d => d.diagnostic?.message).filter(Boolean).join('；') : '';
          msg?.error?.($t('actionDesigner.dialog.testFailedWith', { msg: detail }));
          return;
        }
        if (lfResult.doc !== undefined) draft.params = { ...draft.params, linked_form_v4: lfResult.doc };
      }
    }
    // 名称为空回落到插件动作名（避免存空串覆盖默认显示）。
    const name = draft.name.trim() || (resolveLocalized(props.definition?.title) || n.actionName || '');
    emit('saveAction', { params: finalizeActionParams(), async: draft.async, name, enabled: draft.enabled });
  } else if (n.kind === 'condition') {
    // 表达式面板是「确认时才产出」的组件（要把文本送宿主 lower-text
    // 端点 tokenize 成 V4 文档），故这里只负责**驱动确认并就此返回**——真正的提交与关窗在
    // onConditionConfirm / onConditionUnchanged 里完成，产不出文档时 onConditionEditorError 拦下。
    if (conditionPanelRef.value) {
      if (conditionConfirming.value) return; // 确认在途，重复点保存不重复触发
      conditionConfirming.value = true;
      // 🔴 面板确认可能被自己拦下（语法错/未解析标签：既不 emit 也不抛错），此时上面三个回调都不会
      // 跑；故等它落地后兜底复位旗标，否则保存按钮从此哑火。
      void Promise.resolve(conditionPanelRef.value.confirm()).finally(() => {
        conditionConfirming.value = false;
      });
      return;
    }
    commitConditionSave();
    return;
  } else if (n.kind === 'trigger-root') {
    // 多事件：至少保留一个（空选回落原 eventKey）；eventKey 恒为首事件（兼容读点）。
    const keys = draft.eventKeys.length > 0 ? draft.eventKeys : draft.eventKey ? [draft.eventKey] : [];
    // 触发字段按事件独立提交：不再合成共享 scopes——某事件未选字段，compile 侧会据此
    // 不产出该事件的 binding（不触发），此处仅如实提交各自集合。
    emit('saveTrigger', {
      eventKey: keys[0],
      eventKeys: keys,
      eventFieldIds: {
        'value-change': [...draft.eventScopeFields['value-change']],
        'field-click': [...draft.eventScopeFields['field-click']]
      },
      blockable: draft.blockable,
      // 恒显式带上该键（即使为 undefined）——useActionDesigner.setTriggerRoot 用
      // Object.assign(r, patch) 整体覆盖，「不限」必须能清空节点上既有的门，不能因为键缺失而残留。
      workflowGate: draft.workflowGate
        ? { notStarted: draft.workflowGate.notStarted, steps: draft.workflowGate.steps.map(s => ({ ...s, arrivals: [...s.arrivals] })) }
        : undefined
    });
  }
  visible.value = false;
}

/**
 * 条件节点提交本体：只产出 V4 形态 guardSpec。
 * - mode 恒填 'expression'——仍按 mode 分派界面的旧读点不至于拿到未知值，但数据形态已只由 v4 决定；
 * - conditionId 优先沿用节点上已有的（改表达式不换身份，guard.path 引用才稳定），缺省现分配；
 * - plan（后端钉入的发布物身份）与 negate 原样透传，前端不改写不补算。
 * 未配表达式时不提交（saveDisabled 已在按钮上拦住，这里是第二道兜底，不静默落一个空 guard）。
 */
function commitConditionSave(): void {
  const v4 = draft.guardV4;
  if (!v4) {
    const msg = typeof window !== 'undefined' ? window.$message : undefined;
    msg?.error?.($t('actionDesigner.compile.conditionMissing', { label: $t('actionDesigner.dialog.tabCondition') }));
    return;
  }
  const conditionId = props.node?.guardSpec?.v4?.conditionId ?? v4.conditionId ?? newConditionId();
  const guardSpec: ConditionNodeGuard = { mode: 'expression', v4: { ...v4, conditionId } };
  emit('saveCondition', guardSpec);
  visible.value = false;
}

function onRemove(): void {
  emit('remove');
  visible.value = false;
}

const testing = ref(false);

// 把后端编译/解析错误包装成能定位根源的友好提示；未知模式回落原文（原文已含位置+描述）。
function friendlyExprError(raw?: string): string {
  const s = (raw ?? '').trim();
  if (!s) return $t('actionDesigner.dialog.testFailedWith', { msg: '' });
  if (/FROM must reference.*table/i.test(s)) return $t('actionDesigner.dialog.errFromTable');
  if (/physical column names are not allowed|use \{\{field/i.test(s)) return $t('actionDesigner.dialog.errFieldToken');
  if (/JOIN is not supported/i.test(s)) return $t('actionDesigner.dialog.errNoJoin');
  if (/is not registered|unknown_function/i.test(s)) return $t('actionDesigner.dialog.errUnknownFunc', { msg: s });
  return $t('actionDesigner.dialog.testFailedWith', { msg: s });
}

// 测试：客户端必填校验 → V4 配置面自身的两段式校验（finalize → host.compile）。
async function onTest(): Promise<void> {
  const n = props.node;
  const msg = typeof window !== 'undefined' ? window.$message : undefined;
  if (!n || n.kind !== 'action') return;

  // 1) 客户端必填校验。
  const schema = props.definition?.params_schema as { required?: string[] } | undefined;
  const required = schema?.required ?? [];
  const missing = required.filter(k => draft.params[k] === undefined || draft.params[k] === '');
  if (missing.length > 0) {
    msg?.warning?.($t('actionDesigner.dialog.missingParams', { params: missing.join('、') }));
    return;
  }
  // 1b) V4 节点（取数 extract_v4 / 写动作 write_v4）走配置面自身暴露的 test()
  // （finalize → host.compile 两段式校验），不再走下方 3.4 的 compilePreview 分支——V4 文档不是
  // ExpressionModel 形状，旧分支会送错模型。
  if (v4SurfaceEditor.value) {
    const surfaceInstance = firstRefInstance(actionConfigSurfaceRef.value);
    if (!surfaceInstance?.test) {
      // 旧 bundle/未接线的配置面：无 test() 可调，回落既有 key 提示（不新增文案键）。
      msg?.warning?.($t('actionDesigner.dialog.testFailedWith', { msg: '' }));
      return;
    }
    testing.value = true;
    try {
      const result = await surfaceInstance.test();
      if (result.ok) {
        msg?.success?.($t('actionDesigner.dialog.testPassed'));
      } else {
        // 既有诊断展示方式：无专用诊断列表 UI，回落 testFailedWith 汇总前三条。
        msg?.error?.($t('actionDesigner.dialog.testFailedWith', { msg: result.diagnostics.slice(0, 3).join('；') }));
      }
    } catch (e) {
      msg?.error?.(friendlyExprError(e instanceof Error ? e.message : String(e)));
    } finally {
      testing.value = false;
    }
    return;
  }
  // 2a) 联动表单（V4）：节点文档落 linked_form_v4，不是 3.4
  // ExpressionModel——查询段是 V4 token 化文本（`[标签]#{rN}`），3.4 的 compilePreview 读不懂，
  // 误调会把「未绑定的稳定引用」当语法错误汇报，对用户是错误信号。真正的 V4 编译校验（与取数/
  // 写动作 V4 配置面统一走 host.compile 两段式）尚未接线，本分支暂只做「已选目标模板」的最低限度
  // 放行，不再调用 3.4 compilePreview。
  if (isLinkedFormAction.value && props.scope) {
    const doc = draft.params.linked_form_v4;
    if (!isLinkedFormNodeDocumentV4(doc) || !doc.target.data_table_id) {
      msg?.success?.($t('actionDesigner.dialog.testPassed'));
      return;
    }
    msg?.success?.($t('actionDesigner.dialog.testPassed'));
    return;
  }
  // 2) 其余情况（非 V4 配置面、非联动表单）：无可编译内容，必填过即通过。
  msg?.success?.($t('actionDesigner.dialog.testPassed'));
}

/**
 * 登录终态的同步清洗入口。组件常驻于 ActionDesigner，不能依赖关闭弹窗或异步卸载来清除
 * 未提交草稿；同时推进全部目录 generation，令认证终止前发出的迟到响应失效。
 */
function scrubSensitiveState(): void {
  sensitiveAuthorityGeneration += 1;
  actionConfigLoadGeneration += 1;
  // 条件节点表目录同样按代作废，避免认证终止前发出的迟到响应把表/字段写回。
  conditionTablesLoadGeneration += 1;
  sheetCatalogLoadGeneration += 1;
  workflowCatalogLoadGeneration += 1;

  draft.params = {};
  draft.async = false;
  draft.name = '';
  draft.enabled = true;
  draft.guardV4 = null;
  draft.guardLegacy = false;
  draft.eventKey = undefined;
  draft.eventKeys = [];
  draft.scope = 'form';
  draft.eventScopeFields = { 'value-change': [], 'field-click': [] };
  draft.blockable = false;
  draft.workflowGate = undefined;

  tab.value = 'main';
  renamingNode.value = false;
  renameDraft.value = '';
  optionsPopVisible.value = false;
  testing.value = false;

  actionConfigSurfaceComponent.value = null;
  actionConfigBridge.value = null;
  surfaceLoading.value = false;
  surfaceError.value = null;
  conditionTables.value = [];
  conditionConfirming.value = false;
  sheetCatalog.value = [];
  workflowCatalog.value = null;
  workflowCatalogFailed.value = false;
}

defineExpose({ scrubSensitiveState });

onBeforeUnmount(() => {
  sensitiveStateDisposed = true;
  sensitiveAuthorityGeneration += 1;
  actionConfigLoadGeneration += 1;
  conditionTablesLoadGeneration += 1;
  sheetCatalogLoadGeneration += 1;
  workflowCatalogLoadGeneration += 1;
});
</script>

<template>
  <!-- ActionDesignerDialog（KDialog standard 档）提供拖拽/最大化/缩放/关闭，禁用最小化（节点编辑框不需要挂起到角落）；
       页脚经 #footer 插槽放 KDialogFooter，不再在内容区里自绘底栏。 -->
  <ActionDesignerDialog v-model:show="visible" :title="title" :minimizable="false" :host-api="hostApi" :escape-interceptor="onEscapeInner">
    <!-- ncd-cond：条件节点专属高度链（tab 内容区填满弹窗），口径见下方同名样式注释。 -->
    <div class="ncd-body" :class="{ 'ncd-expr': useExpressionEditor, 'ncd-cond': node?.kind === 'condition', 'ncd-session-readonly': readonly }">
      <div v-if="!node" class="ncd-empty"><NEmpty size="small" :description="$t('actionDesigner.dialog.notSelected')" /></div>

      <template v-else>
        <!-- 动作节点：名称 + 启用（框架级属性，始终可见，与具体参数 tab 无关）。
             名称区：非编辑态=粗体标题+「重命名」链接；编辑态=原地输入框，自动聚焦全选，
             Enter/失焦确认写回 draft.name，Esc 取消放弃编辑（数据路径不变，沿用 draft.name 绑定）。 -->
        <div v-if="node.kind === 'action'" class="ncd-action-head">
          <div class="ncd-name-cell">
            <template v-if="!renamingNode">
              <span class="ncd-node-title">{{ displayNodeName }}</span>
              <KControlSize include-button :tiers="RENAME_BTN_TIERS">
                <NButton size="tiny" secondary type="primary" class="ncd-rename-link" @click="startRename">
                  <template #icon><SvgIcon icon="ph:pencil-simple-line" /></template>
                  {{ $t('actionDesigner.dialog.renameNode') }}
                </NButton>
              </KControlSize>
            </template>
            <NInput
              v-else
              ref="renameInputRef"
              v-model:value="renameDraft"
              size="tiny"
              class="ncd-rename-input"
              @keydown.enter.prevent="confirmRename"
              @keydown.esc.prevent="cancelRename"
              @blur="confirmRename"
            />
          </div>
          <!-- 头部右侧：「选项」浮层入口 + 启用开关同排。
               选项按钮已上移到头部右侧，
               与「启用」共用头部右端——两者都是"这个动作节点整体"的属性入口，同排更聚拢，
               也把下方那一行让给内容。浮层内容与触发逻辑（optionsPopVisible）原样不动。 -->
          <div class="ncd-head-right">
            <KControlSize v-if="optionsTabKey" include-button :tiers="OPTIONS_BTN_TIERS">
              <NPopover v-model:show="optionsPopVisible" trigger="click" placement="bottom-end" :show-arrow="false">
                <template #trigger>
                  <NButton size="tiny" type="primary" ghost class="ncd-options-btn">{{ optionsTabLabel }}</NButton>
                </template>
                <div class="ncd-options-pop">
                  <div class="ncd-options-pop-head">
                    <span>{{ optionsTabLabel }}</span>
                    <button type="button" class="ncd-pop-close" @click="optionsPopVisible = false">✕</button>
                  </div>
                  <!-- 写动作行数阈值（留空 = 不限，不设缺省与硬顶）：不区分引导式/高级，写安全阈值恒需可设。 -->
                  <template v-if="isWriteAction">
                    <div class="ncd-opt-row">
                      <span class="ncd-opt-label">{{ $t('actionDesigner.dialog.maxAffectedRows') }}</span>
                      <NInputNumber style="width: 120px" size="small" :min="1" :precision="0" clearable :placeholder="$t('actionDesigner.dialog.maxAffectedRowsPlaceholder')" :value="maxAffectedRows" @update:value="setMaxAffectedRows" />
                    </div>
                    <span class="hint ncd-opt-hint">{{ $t('actionDesigner.dialog.maxAffectedRowsHint') }}</span>
                  </template>
                  <!-- 框架级异步执行开关继续对结构化表达式动作可用。
                       before-save 根下的写动作强制同步——开关置灰且展示态强制为关（即使
                       draft.async 已由上方 resetDraft 兜底置 false，这里的三元仍是第二道防线）；
                       与「无能力支持」提示互斥展示（同一时刻至多一条，before-save 阻断提示更具体，
                       优先于泛化的能力判定提示展示）。 -->
                  <div class="ncd-opt-row">
                    <span class="ncd-opt-label">{{ $t('actionDesigner.dialog.asyncExec') }}</span>
                    <NSwitch size="medium" :value="asyncBlockedByBeforeSave ? false : draft.async" :disabled="!asyncable || asyncBlockedByBeforeSave" @update:value="v => (draft.async = v)" />
                  </div>
                  <span v-if="asyncBlockedByBeforeSave" class="hint ncd-opt-hint">{{ $t('actionDesigner.dialog.asyncBlockedBeforeSave') }}</span>
                  <span v-else-if="!asyncable" class="hint ncd-opt-hint">{{ $t('actionDesigner.dialog.noAsyncSupport') }}</span>
                  <!-- 数据动作的插件附加业务参数：标准配置面板之外的参数在这里配，增量回写 draft.params。 -->
                  <div v-if="dataActionExtraFields.length > 0" class="ncd-opt-extra" data-testid="ncd-data-action-extra-params">
                    <div class="ncd-opt-extra-title">{{ $t('actionDesigner.dialog.pluginParams') }}</div>
                    <GenericParamsForm :fields="dataActionExtraFields" :params="draft.params" :field-groups="fieldGroups" :readonly="readonly" @patch="patchGenericParams" />
                  </div>
                </div>
              </NPopover>
            </KControlSize>
            <!-- 启用：裸 span+switch 替代 NFormItem，去掉自带 label 行与留白，压缩头部高度 -->
            <div class="ncd-enabled-cell">
              <span class="ncd-enabled-label">{{ $t('actionDesigner.dialog.nodeEnabled') }}</span>
              <NSwitch v-model:value="draft.enabled" size="small" />
            </div>
          </div>
        </div>

        <!-- 联动表单（x-editor=linked-form）：专用步骤面板，无 tabs。 -->
        <LinkedFormPanel
          v-if="node.kind === 'action' && isLinkedFormAction && scope"
          ref="linkedFormPanelRef"
          :app-id="scope.appId"
          :template-id="scope.templateId"
          :params="draft.params"
          :host-api="hostApi"
          :v4-host="linkedFormV4Host"
          :expression-host="expressionHostInstance"
          @patch="patchPanelParams"
        />
        <FormControlPanel
          v-else-if="node.kind === 'action' && isFormControlAction"
          :params="draft.params"
          @patch="patchPanelParams"
        />
        <!-- 切换Sheet（x-picker=sheet-switch）：专用卡片面板，无 tabs。 -->
        <SwitchSheetPanel
          v-else-if="node.kind === 'action' && isSheetSwitchAction"
          :sheets="sheetCatalog"
          :value="(paramValue(sheetSwitchParamKey) as string) ?? ''"
          :scope="scope"
          :host-api="hostApi"
          @update:value="id => setParam(sheetSwitchParamKey, id)"
        />
        <!-- 打印单据（x-picker=sheet-print）：专用双步骤面板，无 tabs。 -->
        <PrintPanel
          v-else-if="node.kind === 'action' && isPrintAction"
          :sheets="sheetCatalog"
          :params="draft.params"
          :scope="scope"
          :host-api="hostApi"
          @patch="patchPanelParams"
        />
        <!-- 明细排序（x-editor=detail-sort）：专用步骤面板，无 tabs。 -->
        <DetailSortPanel
          v-else-if="node.kind === 'action' && isDetailSortAction && scope"
          :app-id="scope.appId"
          :template-id="scope.templateId"
          :params="draft.params"
          :host-api="hostApi"
          @patch="patchDetailSortParams"
        />
        <!-- 提示语（ui.message）：三步骤+实时预览专用面板，无 tabs。 -->
        <MessagePanel
          v-else-if="node.kind === 'action' && isMessageAction"
          :params="draft.params"
          :params-schema="definition?.params_schema"
          @patch="patchPanelParams"
        />
        <NTabs v-else v-model:value="tab" type="line" animated :class="['ncd-tabs', { 'ncd-tabs-hide-nav': hideActionTabNav }]">
        <!-- 动作 -->
        <template v-if="node.kind === 'action'">
          <!-- tab 由插件 params_schema['x-tabs'] 声明（取数/选项…）；primary 承载取数编辑器；
               options 组不再进 tab 列表（见 tabsWithoutOptions），改由下方浮层承载。 -->
          <NTabPane v-for="pt in tabsWithoutOptions" :key="pt.key" :name="pt.key" :tab="pt.label">
            <!-- 取数（primary）：只承载结构化表达式编辑器。 -->
            <template v-if="pt.key === primaryTabKey">
              <template v-if="useExpressionEditor && scope">
                <!-- V4 配置面——顶层 x-editor==='extract-v4'（取数）或 'write-v4'
                     （新增/修改/删除数据）。深层编辑 UI 由 record-controllers 插件的
                     action-config surface（ActionConfigSurface.vue）承载；本文件
                     只负责路由/空文档兜底（expressionDraftModel）/旧格式失效横幅/挂载失败错误态
                     ——挂载失败时绝不静默回落（旧格式已停用，回落等于让用户误以为还能用）。
                     （3.4 顶层/字段级 x-editor:'expression' 判据无插件使用，不再支持）——useExpressionEditor 现在
                     恒等价于 v4SurfaceEditor && scope，这里不再需要 v-else-if/v-else 兜底。 -->
                <NAlert v-if="legacyExpressionPresent" type="warning" :bordered="false" class="legacy-banner" :show-icon="true">
                  {{ $t(legacyV4ConfigBannerKey) }}
                </NAlert>
                <div v-if="surfaceLoading" class="surface-loading"><NSpin size="small" /></div>
                <div v-else-if="actionConfigSurfaceComponent" class="ncd-expr-scroll">
                  <component :is="actionConfigSurfaceComponent" ref="actionConfigSurfaceRef" :input="actionConfigSurfaceInput" />
                </div>
                <NAlert v-else-if="surfaceError" type="error" data-testid="ncd-v4-surface-error" :bordered="false" :show-icon="true">
                  {{ $t('actionDesigner.dialog.testFailedWith', { msg: surfaceError }) }}
                </NAlert>
                <!-- 理论上不可达：record-controllers 插件恒声明 extract-v4/write-v4 各自的
                     action-config surface，createActionConfigSurface 要么解析出组件、要么抛错
                     进入上方 surfaceError 分支。兜底空态而非静默回落旧编辑器，避免用户看到的
                     是旧格式界面。 -->
                <!-- 宿主没有解析到官方标准面板（含按种类回落）。 -->
                <NAlert v-else-if="standardPanelMissing" type="warning" data-testid="ncd-standard-panel-missing" :bordered="false" :show-icon="true">
                  {{ $t('actionDesigner.dialog.standardPanelMissing') }}
                </NAlert>
                <NEmpty v-else size="small" :description="$t('actionDesigner.dialog.noExtConfig')" />
              </template>
              <!-- 非表达式动作且插件声明了 action-config 面板：挂插件面板（通用参数契约）。 -->
              <template v-else-if="genericActionConfigMounted && actionConfigSurfaceComponent">
                <div class="ncd-expr-scroll" data-testid="ncd-generic-action-config">
                  <component :is="actionConfigSurfaceComponent" :input="genericActionConfigSurfaceInput" />
                </div>
              </template>
              <div v-else-if="surfaceLoading && !useExpressionEditor" class="surface-loading"><NSpin size="small" /></div>
              <!-- 非表达式动作：按 params_schema 通用渲染（GenericParamsForm：字段目标数组出字段下拉、default 预填、
                   约束提示），未知复杂参数回退 JSON 文本框。 -->
              <template v-else-if="paramFields.length > 0">
                <GenericParamsForm :fields="paramFields" :params="draft.params" :field-groups="fieldGroups" :readonly="readonly" @patch="patchGenericParams" />
              </template>
              <div v-else class="params-readonly">{{ JSON.stringify(draft.params ?? {}, null, 2) }}</div>
            </template>
            <!-- 其它插件声明的 tab（非 primary 非 options）：占位（后续由 schema 渲染其字段）。
                 options 组已摘出 tabsWithoutOptions（见头注），此处不会再命中 optionsTabKey。 -->
            <template v-else>
              <div class="placeholder">{{ $t('actionDesigner.dialog.noExtConfig') }}</div>
            </template>
          </NTabPane>
        </template>

        <!-- 条件（V4 判断表达式，只表达式一种形态）
             配置页本身就是表达式编辑界面，故这里**内嵌** ConditionV4Editor（薄包装共享包 AdvancedExpressionPanel，
             purpose='where'），不再有摘要 + 「编辑条件」按钮 + 弹窗那三级跳；引导式条件树与判断方式
             切换按钮已退役——旧形态一律重配，不做任何兼容 UI
             （见 labels.guardSpecStatement / validate.validateConditionGuard 同口径）。 -->
        <template v-else-if="node.kind === 'condition'">
          <NTabPane name="main" :tab="$t('actionDesigner.dialog.tabCondition')">
            <!-- 条件页不要标题行，面板顶格；语法状态条常显（idle 给占位文案）。 -->
            <div class="ncd-guard">
              <!-- job 模式：定时任务无表单字段上下文，条件分支整体不可用，
                   只给一句说明，不渲染编辑界面。 -->
              <NAlert v-if="conditionJobUnsupported" type="info" :bordered="false" class="ncd-guard-notice">
                {{ $t('actionDesigner.dialog.conditionJobUnsupported') }}
              </NAlert>
              <!-- 宿主未提供 V4 桥/表达式域桥（旧宿主）：降级提示，面板不实例化——它在 setup 顶层
                   provide 这两座桥，桥缺席时根本不该构造它。 -->
              <NAlert v-else-if="!conditionPanelReady" type="warning" :bordered="false" class="ncd-guard-notice">
                {{ $t('actionDesigner.dialog.conditionHostUnavailable') }}
              </NAlert>
              <template v-else>
                <!-- 旧形态节点：只提示重新配置，不回显旧内容（面板从空文本起步——显示旧内容会让
                     用户以为它还在生效）。 -->
                <NAlert v-if="draft.guardLegacy" type="warning" :bordered="false" class="ncd-guard-notice">
                  {{ $t('actionDesigner.dialog.conditionLegacyFormat') }}
                </NAlert>
                <!-- 条件页剩余高度全部交给共享面板，由其自身测量并选择适合小高度的布局。 -->
                <div class="ncd-guard-panel">
                  <!-- restore 落定前不挂面板：它只在挂载那一刻读 textSource，早挂就把 token 文本钉进编辑区。 -->
                  <ConditionV4Editor
                    v-if="!conditionRestorePending"
                    ref="conditionPanelRef"
                    data-testid="condition-panel"
                    :show="show"
                    :spec="draft.guardV4"
                    :tables="conditionTables"
                    :expression-host="expressionHostInstance!"
                    :v4-host="aliceV4Host!"
                    :condition-id="conditionIdForEditor"
                    @confirm="onConditionConfirm"
                    @unchanged="onConditionUnchanged"
                    @error="onConditionEditorError"
                  />
                </div>
                <!-- 语法检查状态条：面板按 syntax-status-placement="external" 自己不渲染，交由宿主壳摆放
                     （取数「筛选条件」弹窗把它并进页脚左侧，见 ExpressionDialogShell.vue）。这里靠左放在
                     面板下方、不参与 flex:1，视觉/交互与共享包 SyntaxStatusLine.vue 逐项对齐。
                     🔴 为什么不直接复用那个组件：共享包 package.json 的 exports 白名单只放行 `.`，深路径被
                     拦死，而 index.ts 未导出 SyntaxStatusLine，故就地等价渲染。
                     补导出后应换回共享组件（testid 已保持一致，判据不用改）。 -->
                <div
                  class="ncd-guard-status"
                  :class="`ncd-guard-status--${conditionPanelRef?.syntaxState ?? 'idle'}`"
                  data-testid="adv-syntax-status"
                  @click="onConditionSyntaxJump"
                >
                  <span class="ncd-guard-status-mark" aria-hidden="true">
                    {{ conditionPanelRef?.syntaxState === 'ok' ? '✓' : conditionPanelRef?.syntaxState === 'error' ? '✗' : '•' }}
                  </span>
                  <!-- 常显：idle 态面板不给文案，这里放一句占位，避免状态条忽隐忽现抖动布局。 -->
                  <span class="ncd-guard-status-label">{{ (conditionPanelRef?.syntaxState ?? 'idle') === 'idle' ? $t('actionDesigner.dialog.conditionSyntaxIdle') : conditionPanelRef?.syntaxLabel }}</span>
                  <!-- 明细可能很长（服务端诊断原文）：单行省略，完整文本放 title。 -->
                  <span
                    v-if="conditionPanelRef?.syntaxDetail"
                    class="ncd-guard-status-detail"
                    :title="conditionPanelRef?.syntaxDetail"
                  >{{ conditionPanelRef?.syntaxDetail }}</span>
                </div>
              </template>
            </div>
          </NTabPane>
        </template>

        <!-- 触发根 -->
        <template v-else-if="node.kind === 'trigger-root'">
          <NTabPane name="main" :tab="$t('actionDesigner.summary.trigger')">
            <!-- 多选触发事件：任一事件命中即触发本流程；至少保留一个。 -->
            <NFormItem :label="$t('actionDesigner.dialog.triggerEvent')" size="small">
              <NSelect
                :value="draft.eventKeys"
                multiple
                :show="eventMenuShow"
                :options="eventOptions"
                :render-tag="renderEventTag"
                size="small"
                @update:show="(v: boolean) => (eventMenuShow = v)"
                @update:value="onEventKeysUpdate"
              />
            </NFormItem>
            <!-- 旧 before-save/after-save 迁移合并为新建/编辑两档提示——仅内存态展示，
                 不据此自动做任何处理，只是提醒核对迁移结果。 -->
            <NAlert v-if="node.legacySaveMigrated" type="info" size="small" :bordered="false" :show-icon="true" class="ncd-field-warn">
              {{ $t('actionDesigner.dialog.gate.legacySaveMigrated') }}
            </NAlert>
            <!-- 可阻断开关：before-save / before-delete 两类"前置钩子"事件均可标记阻断（后端据此
                 决定失败时是否中止保存/删除，如 before-delete 阻断 → 409）；文案通用，
                 不假设唯一的前置事件类型；显示条件为已选事件与 BLOCKABLE_EVENT_KEYS
                 （新建/编辑保存前两档 + before-delete）有交集。 -->
            <NFormItem
              v-if="BLOCKABLE_EVENT_KEYS.some(k => draft.eventKeys.includes(k))"
              :label="$t('actionDesigner.dialog.blockable')"
              size="small"
            >
              <NSwitch v-model:value="draft.blockable" />
            </NFormItem>
            <!-- 触发字段按事件独立：value-change / field-click 各自一份字段多选，与各自
                 独立编译出的 binding.scopes 一一对应；未设置字段该事件不产出绑定（不触发），故字段
                 为空时就地提示，不静默隐藏。 -->
            <template v-if="draft.eventKeys.includes('value-change')">
              <NFormItem :label="$t('actionDesigner.dialog.valueChangeFields')" size="small">
                <NSelect
                  v-model:value="draft.eventScopeFields['value-change']"
                  multiple
                  filterable
                  :options="triggerFieldOptions"
                  :placeholder="$t('actionDesigner.dialog.triggerFieldsPlaceholder')"
                  size="small"
                />
              </NFormItem>
              <NAlert
                v-if="draft.eventScopeFields['value-change'].length === 0"
                type="warning"
                size="small"
                :bordered="false"
                :show-icon="true"
                class="ncd-field-warn"
              >
                {{ $t('actionDesigner.dialog.eventFieldsEmptyWarn') }}
              </NAlert>
            </template>
            <template v-if="draft.eventKeys.includes('field-click')">
              <NFormItem :label="$t('actionDesigner.dialog.fieldClickFields')" size="small">
                <NSelect
                  v-model:value="draft.eventScopeFields['field-click']"
                  multiple
                  filterable
                  :options="triggerFieldOptions"
                  :placeholder="$t('actionDesigner.dialog.triggerFieldsPlaceholder')"
                  size="small"
                />
              </NFormItem>
              <NAlert
                v-if="draft.eventScopeFields['field-click'].length === 0"
                type="warning"
                size="small"
                :bordered="false"
                :show-icon="true"
                class="ncd-field-warn"
              >
                {{ $t('actionDesigner.dialog.eventFieldsEmptyWarn') }}
              </NAlert>
            </template>

            <!-- 流程步骤门——「仅当命中门内某流程步骤（按到达方式）/ 未发起时才触发」。
                 目录为空（模板未绑定任何流程）且门也为空时整区不渲染（无事可配、也无残留待清理）。 -->
            <template v-if="gateSectionVisible">
              <NFormItem :label="$t('actionDesigner.dialog.gate.title')" size="small">
                <NRadioGroup v-model:value="gateMode">
                  <NRadio value="any">{{ $t('actionDesigner.dialog.gate.any') }}</NRadio>
                  <NRadio value="only">{{ $t('actionDesigner.dialog.gate.only') }}</NRadio>
                </NRadioGroup>
              </NFormItem>
              <template v-if="gateMode === 'only'">
                <NAlert v-if="workflowCatalogFailed" type="warning" size="small" :bordered="false" :show-icon="true" class="ncd-field-warn">
                  {{ $t('actionDesigner.dialog.gate.loadFailed') }}
                </NAlert>
                <NCheckbox size="medium" v-model:checked="gateNotStarted" class="ncd-gate-not-started">
                  {{ $t('actionDesigner.dialog.gate.notStarted') }}
                </NCheckbox>
                <div v-for="card in gateCards" :key="card.definitionId" class="ncd-gate-card" :class="{ 'is-dead': card.deadDefinition }">
                  <div class="ncd-gate-card-head">
                    <span class="ncd-gate-card-name">{{ card.name }}</span>
                    <NTag v-if="card.deadDefinition" size="small" type="warning">{{ $t('actionDesigner.dialog.gate.deadDefinition') }}</NTag>
                    <template v-else>
                      <NTag size="small" :type="card.published ? 'primary' : 'default'">
                        {{ card.published ? $t('actionDesigner.dialog.gate.published', { version: card.latestVersionNo }) : $t('actionDesigner.dialog.gate.unpublished') }}
                      </NTag>
                      <NTag v-if="card.disabled" size="small" type="warning">{{ $t('actionDesigner.dialog.gate.disabledDef') }}</NTag>
                    </template>
                    <span class="ncd-gate-card-spacer" />
                    <span v-if="!card.deadDefinition" class="ncd-gate-card-count">
                      {{ $t('actionDesigner.dialog.gate.selectedOf', { selected: card.selectedCount, total: card.totalCount }) }}
                    </span>
                  </div>
                  <!-- 扁平并列（checkbox 不带 slot，kind/name/hint/到达方式均为本行直接子项）：
                       若嵌在 NCheckbox 默认插槽里（naive-ui 自带 label 容器）会够不着 .ncd-gate-row
                       自身的 flex gap；gap 统一吃行级 8px，不各自补间距。 -->
                  <div v-for="row in card.rows" :key="row.key" class="ncd-gate-row" :class="{ 'is-dead': row.dead }">
                    <!-- 失效行恒 checked（row.checked 由 gateCards 计算属性固定为 true）+ disabled，
                         只作占位对齐，不接受交互；真正的"移除/替换"走下方失效行专属操作按钮。 -->
                    <NCheckbox
                      size="medium"
                      :checked="row.checked"
                      :disabled="row.dead || !card.published"
                      @update:checked="(v: boolean) => toggleGateStep(card, row, v)"
                    />
                    <span v-if="gateNodeKindLabel(row.nodeKind)" class="ncd-gate-row-kind">{{ gateNodeKindLabel(row.nodeKind) }}</span>
                    <span class="ncd-gate-row-name" :class="{ 'ncd-gate-row-dead-name': row.dead }">{{ row.nodeName }}</span>
                    <template v-if="!row.dead">
                      <span v-if="row.nodeKind === 'START'" class="ncd-gate-row-hint">{{ $t('actionDesigner.dialog.gate.startIncludesLaunch') }}</span>
                      <!-- 未发布定义整卡不可选：逐行补一个「不可选」小标，说明勾不动的原因（不只是灰显）。 -->
                      <span v-if="!card.published" class="ncd-gate-row-hint">{{ $t('actionDesigner.dialog.gate.noneSelectable') }}</span>
                      <span v-if="row.checked" class="ncd-gate-arrivals">
                        <NTag
                          size="small"
                          checkable
                          :type="row.arrivals.includes('submitted') ? 'primary' : 'default'"
                          :checked="row.arrivals.includes('submitted')"
                          @update:checked="() => toggleGateArrival(card.definitionId, row.nodeId, 'submitted')"
                        >
                          {{ $t('actionDesigner.dialog.gate.arrivalSubmitted') }}
                        </NTag>
                        <NTag
                          size="small"
                          checkable
                          :type="row.arrivals.includes('returned') ? 'primary' : 'default'"
                          :checked="row.arrivals.includes('returned')"
                          @update:checked="() => toggleGateArrival(card.definitionId, row.nodeId, 'returned')"
                        >
                          {{ $t('actionDesigner.dialog.gate.arrivalReturned') }}
                        </NTag>
                      </span>
                    </template>
                    <template v-else>
                      <NTag size="small" type="warning">{{ $t('actionDesigner.dialog.gate.deadStep', { version: card.latestVersionNo }) }}</NTag>
                      <span class="ncd-gate-row-actions">
                        <NButton v-if="row.replaceCandidate" size="tiny" text type="primary" @click="replaceGateStep(card.definitionId, row.nodeId, row.replaceCandidate)">
                          {{ $t('actionDesigner.dialog.gate.replaceWith', { name: row.replaceCandidate.nodeName }) }}
                        </NButton>
                        <NButton size="tiny" text type="primary" @click="removeGateStep(card.definitionId, row.nodeId)">{{ $t('actionDesigner.dialog.gate.remove') }}</NButton>
                      </span>
                    </template>
                  </div>
                </div>
                <div class="ncd-gate-summary">
                  <span>{{ $t('actionDesigner.dialog.gate.summary', { steps: gateSummaryStepCount, defs: gateSummaryDefCount }) }}</span>
                  <span v-if="gateDeadStepCount > 0" class="ncd-gate-summary-dead">{{ $t('actionDesigner.dialog.gate.deadCount', { count: gateDeadStepCount }) }}</span>
                </div>
              </template>
              <NAlert
                v-if="draft.eventKeys.includes('before-delete') || draft.eventKeys.includes('after-delete')"
                type="warning"
                size="small"
                :bordered="false"
                :show-icon="true"
                class="ncd-field-warn"
              >
                {{ $t('actionDesigner.dialog.gate.deleteEventsNote') }}
              </NAlert>
              <div v-if="gateNoGateHint" class="ncd-gate-hint">{{ $t('actionDesigner.dialog.gate.noGateHint') }}</div>
            </template>
          </NTabPane>
          <!-- 触发根不再有「执行条件」：guard 仅动作/条件节点具备，根只声明触发事件。 -->
        </template>
        </NTabs>
      </template>

    </div>
    <!-- 底部操作栏：KDialogFooter 小档 28px，取消在左确认在右。
         「删除节点」「测试」不是取消 / 确认，放 extra 插槽：删除靠左、测试贴右（紧邻取消）。
         保存按钮显隐沿用 visibleButtons.save（预留 definition.dialogButtons 接线），经 KDialogFooter hideConfirm 接上。 -->
    <template v-if="node" #footer>
      <KDialogFooter
        class="ncd-footer"
        :confirm-text="$t('console.dept.save')"
        :cancel-text="$t('common.cancel')"
        :confirm-disabled="readonly || saveDisabled"
        :hide-cancel="!visibleButtons.cancel"
        :hide-confirm="!visibleButtons.save"
        @confirm="onSave"
        @cancel="onCancel"
      >
        <template #extra>
          <!-- 删除节点：红色描边（ghost）+ 垃圾桶图标 -->
          <NButton v-if="canRemove" size="small" class="ncd-foot-btn" type="error" ghost :disabled="readonly" @click="onRemove">
            <template #icon><SvgIcon icon="ph:trash" /></template>
            {{ $t('actionDesigner.dialog.removeNode') }}
          </NButton>
          <!-- 测试：蓝色描边（ghost），margin-left:auto 推到 extra 右端，紧邻取消 -->
          <NButton v-if="visibleButtons.test" size="small" class="ncd-foot-btn ncd-foot-test" type="primary" ghost :disabled="readonly" :loading="testing" @click="onTest">{{ $t('actionDesigner.dialog.test') }}</NButton>
        </template>
      </KDialogFooter>
    </template>
  </ActionDesignerDialog>
</template>

<style scoped>
/* ncd-body 作为 KDialog .kdlg-body（flex 列，flush 通栏）的子项填充全部空间，自身也是 flex 列 */
.ncd-body {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
  padding: 12px 20px 16px;
  box-sizing: border-box;
  overflow: hidden;
}
.ncd-empty {
  padding: 24px 0;
}
/* 动作节点框架级属性头（名称 + 启用）：单行紧凑布局（总高约40px=上下padding4+内容行高约27+分隔线1），
   固定在 tab 之上（已去掉底部分隔线） */
.ncd-action-head {
  flex: 0 0 auto;
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 16px;
  padding: 4px 0 6px;
  margin-bottom: 6px;
}
/* 名称占满剩余宽度、启用不伸缩，二者同行 */
.ncd-name-cell {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 10px;
}
/* 头部右端：「选项」按钮 + 启用开关同排。 */
.ncd-head-right {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 16px;
}
/* 右侧「启用」文字+开关：裸行不伸缩，垂直居中对齐名称区 */
.ncd-enabled-cell {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 8px;
}
.ncd-enabled-label {
  font-size: 12px;
  color: rgb(var(--text-secondary-color));
  white-space: nowrap;
}
/* 节点名粗体标题 */
.ncd-node-title {
  font-size: 15px;
  font-weight: 600;
  color: rgb(var(--base-text-color));
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* 「重命名」链接：浅蓝底 chip，NButton secondary（高 22 / 内边距 8 经 RENAME_BTN_TIERS 钉定），
   图标与文字间距原为 3px（Naive 默认 6px，对齐 2d 前 CSS gap:3px）。 */
.ncd-rename-link {
  flex-shrink: 0;
}
.ncd-rename-link :deep(.n-button__icon) {
  margin-right: 3px;
}
.ncd-rename-input {
  max-width: 260px;
}

/* NTabs 填充 ncd-body 剩余空间 */
.ncd-body :deep(.n-tabs) {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  width: 100%;
}
.ncd-body :deep(.n-tabs-nav) {
  flex-shrink: 0;
}
/* 动作节点摘除 options 组后只剩 1 个 tab 时隐藏 tab 头（见 hideActionTabNav 头注），
   仅无 tab 可切换时生效，不影响条件/触发根节点固有的单 tab 头样式。 */
.ncd-tabs-hide-nav :deep(.n-tabs-nav) {
  display: none;
}
/* 表达式编辑器模式：animated NTabs 在 .n-tabs 与 .n-tab-pane 之间插有 .n-tabs-pane-wrapper 中间层，
   必须一并纳入 flex 高度链——否则该层按内容自然高度撑开，ExpressionEditor 拿不到受限高度，
   ④段填充行列表的内部滚动（.target-tab-body overflow-y:auto）失效、整体被 .ncd-body 的
   overflow:hidden 硬裁切（修复来源；同 console-tabs / app-backup-inner-tabs 惯例）。 */
.ncd-body.ncd-expr :deep(.ncd-tabs .n-tabs-pane-wrapper) {
  flex: 1 1 auto;
  min-height: 0;
}
/* tab-pane 撑满 wrapper 高度并作 flex 列，ExpressionEditor 才能填充高度 */
.ncd-body.ncd-expr :deep(.ncd-tabs .n-tab-pane) {
  height: 100%;
  box-sizing: border-box;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
/* 条件节点同款高度链：条件页只有一个 tab，若 .n-tabs-pane-wrapper / .n-tab-pane 按内容自然高度
   收缩，内嵌表达式面板拿不到受限高度、只能吃写死的 460 —— 扣掉面板自身壳体 chrome 后编辑区会把
   字段树坞挤得几乎不见，同时大弹窗下半截大片空白。这里补齐与 .ncd-expr 逐字相同的两层规则，
   只对条件节点生效（.ncd-cond 由 node.kind==='condition' 挂上）。 */
/* 条件页只留一层内边距：
   保留 .ncd-body 自己的 padding 作为唯一一层；把 NTabs 面板的默认内边距与共享表达式面板根节点
   自带的水平 padding（.adv-editor { padding: 0 16px }）都归零，避免叠成两层。 */
.ncd-body.ncd-cond :deep(.ncd-tabs .n-tab-pane) {
  padding: 0;
}
.ncd-body.ncd-cond :deep(.ncd-guard-panel .adv-editor) {
  padding: 0;
}
/* 树坞区自带的左右 16px 同样归零，只留顶部 12px 与搜索框的间距。 */
.ncd-body.ncd-cond :deep(.ncd-guard-panel .adv-dock) {
  padding-left: 0;
  padding-right: 0;
}
.ncd-body.ncd-cond :deep(.ncd-tabs .n-tabs-pane-wrapper) {
  flex: 1 1 auto;
  min-height: 0;
}
.ncd-body.ncd-cond :deep(.ncd-tabs .n-tab-pane) {
  height: 100%;
  box-sizing: border-box;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
/* FieldDrawer 内的 drawer-tabs tab-pane 恢复为块级+独立滚动（优先级同上，靠顺序覆盖） */
.ncd-body.ncd-expr :deep(.drawer-tabs .n-tab-pane) {
  display: block;
  flex: unset;
  overflow-y: auto;
  overflow-x: hidden;
  min-height: 0;
}
/* ExpressionEditor 内嵌容器：并行任务把包内 ExpressionEditor.vue 根节点定为 min-width:900
   （判断型左栏铺满/输出型分栏都要求最小可用宽度），节点配置弹窗在窄窗（如 1280×800 屏的较窄
   分栏）下会小于这个宽度，需要横向滚动查看，不能被 .ncd-body 的 overflow:hidden 硬裁切。
   自身仍是 .n-tab-pane（flex 列）的直接子项，继续走 flex:1 1 auto + min-height:0 撑满剩余高度，
   把受限高度转交给 ExpressionEditor 自身——只新增横向滚动这一层，不改动既有高度链。
   overflow-y:hidden：纵向滚动仍由 ExpressionEditor 内部（.editor-main）自己处理，这里不重复开口，
   避免出现两层纵向滚动条。 */
.ncd-expr-scroll {
  display: flex;
  min-height: 0;
  flex: 1 1 auto;
  flex-direction: column;
  overflow-x: auto;
  overflow-y: hidden;
}

/* 页脚 extra 区里的次要动作按钮（删除节点 / 测试）：最小宽度对齐 KDialogFooter 的 72px；
   页脚本身的布局、分隔线、内边距由 KDialog / KDialogFooter 提供 */
.ncd-foot-btn {
  min-width: 72px;
}
.ncd-foot-test {
  margin-left: auto;
}

.surface-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 32px 0;
  flex: 1;
}
.legacy-banner {
  margin-bottom: 12px;
  flex-shrink: 0;
}
/* 触发字段为空提醒：紧跟在对应事件的字段多选之后，与下一个表单项留出间距。 */
.ncd-field-warn {
  margin-bottom: 12px;
}
/* 流程步骤门——沿用弹窗既有 token（rgb(var(--xxx-color))），卡片 4px 圆角，
   失效条目用 warning 色系；不引入新依赖。 */
/* 不能用 display:block（会打断 NCheckbox 自身 box+label 的 inline-flex 布局，勾选框独占一行）——
   保持同行 + 垂直居中；label 与 box 的 8px 间距用 :deep 显式
   钉死（不依赖 naive-ui 主题的默认 labelPadding，避免主题差异下跑偏）。 */
.ncd-gate-not-started {
  display: flex;
  align-items: center;
  margin-bottom: 8px;
}
.ncd-gate-not-started :deep(.n-checkbox__label) {
  padding-left: 8px;
}
.ncd-gate-card {
  border: 1px solid rgb(var(--border-color));
  border-radius: 4px;
  padding: 8px 10px;
  margin-bottom: 8px;
}
.ncd-gate-card.is-dead {
  border-color: rgb(var(--warning-color, 240, 160, 30) / 0.5);
  background-color: rgb(var(--warning-color, 240, 160, 30) / 0.06);
}
.ncd-gate-card-head {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
}
.ncd-gate-card-name {
  font-size: 13px;
  font-weight: 500;
  color: rgb(var(--base-text-color));
}
.ncd-gate-card-spacer {
  flex: 1;
}
.ncd-gate-card-count {
  font-size: 12px;
  color: rgb(var(--base-text-color) / 0.55);
}
.ncd-gate-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 0;
  font-size: 12px;
}
.ncd-gate-row.is-dead {
  color: rgb(var(--warning-color, 240, 160, 30));
}
/* 类型徽标做成小标签（纯文字紧挨节点名会显示成「发起发起」），
   固定尺寸不参与收缩——本身即与相邻项隔开行级 gap:8px，不再需要单独补 margin。 */
.ncd-gate-row-kind {
  flex-shrink: 0;
  font-size: 11px;
  line-height: 16px;
  padding: 0 5px;
  border-radius: 3px;
  background-color: rgb(var(--border-lightest-color));
  color: rgb(var(--text-secondary-color));
}
/* 名称区可伸缩收窄 + 省略号，窄弹窗（560px）下不挤爆右侧到达方式胶囊。 */
.ncd-gate-row-name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: rgb(var(--base-text-color));
}
.ncd-gate-row-hint {
  flex-shrink: 0;
  color: rgb(var(--text-hint-color));
  font-size: 12px;
}
.ncd-gate-row-dead-name {
  text-decoration: line-through;
  color: rgb(var(--warning-color, 240, 160, 30));
}
/* 失效行「替换/移除」靠右（margin-left:auto，不参与收缩）；
   文字主色由模板 NButton 的 type="primary" 承担，不额外 deep 覆盖内部类名。 */
.ncd-gate-row-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-left: auto;
  flex-shrink: 0;
}
/* 到达方式胶囊固定尺寸不收缩/不换行，窄弹窗下宁可挤压名称也不挤爆自己。 */
.ncd-gate-arrivals {
  display: inline-flex;
  flex-shrink: 0;
  white-space: nowrap;
  gap: 4px;
  margin-left: auto;
}
.ncd-gate-summary {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12px;
  color: rgb(var(--base-text-color) / 0.65);
  margin-top: 4px;
}
.ncd-gate-summary-dead {
  color: rgb(var(--warning-color, 240, 160, 30));
}
.ncd-gate-hint {
  font-size: 12px;
  color: rgb(var(--base-text-color) / 0.45);
  margin-top: 4px;
}
/* 「选项」浮层触发按钮：蓝色描边小按钮（与 LinkedFormPanel .lf-options-btn 同款约定）。 */
/* 「选项」按钮：NButton（24 高 / 12px / 内边距 12 经 OPTIONS_BTN_TIERS 钉定），最小宽 64 沿用原值 */
.ncd-options-btn {
  flex-shrink: 0;
  min-width: 64px;
}
/* 「选项」浮层卡片（白底/圆角/投影由 NPopover 默认提供）。 */
.ncd-options-pop {
  width: 240px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.ncd-options-pop-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 14px;
  color: rgb(var(--base-text-color));
  padding-bottom: 6px;
  margin-bottom: 4px;
  border-bottom: 1px solid rgb(var(--border-lightest-color));
}
.ncd-pop-close {
  border: none;
  background: transparent;
  cursor: pointer;
  color: rgb(var(--text-secondary-color));
  font-size: 12px;
  padding: 2px;
}
.ncd-opt-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 32px;
}
.ncd-opt-label {
  font-size: 13px;
  color: rgb(var(--base-text-color));
}
.ncd-opt-hint {
  display: block;
  margin: -4px 0 4px;
}
/* 数据动作附加参数区：与上方开关行用分隔线隔开，宽度跟随浮层（.ncd-options-pop 定宽 240px），
   表单控件不得撑出浮层右缘。 */
.ncd-opt-extra {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid rgb(var(--border-lightest-color));
  min-width: 0;
  max-width: 100%;
}
.ncd-opt-extra :deep(.n-form-item),
.ncd-opt-extra :deep(.n-input),
.ncd-opt-extra :deep(.n-input-number),
.ncd-opt-extra :deep(.n-base-selection) {
  max-width: 100%;
}
.ncd-opt-extra-title {
  font-size: 12px;
  color: rgb(var(--base-text-color) / 0.6);
  margin-bottom: 6px;
}
/* 「仅限前 N 条」步进器：− 不限/数值 + 。 */
.ncd-stepper {
  display: flex;
  align-items: center;
  gap: 10px;
}
.ncd-stepper-btn {
  width: 20px;
  height: 20px;
  border: none;
  background: transparent;
  color: rgb(var(--primary-color));
  font-size: 15px;
  line-height: 1;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.ncd-stepper-btn:disabled {
  color: rgb(var(--text-hint-color));
  cursor: not-allowed;
}
.ncd-stepper-val {
  min-width: 32px;
  text-align: center;
  font-size: 13px;
  color: rgb(var(--base-text-color));
}
.params-readonly {
  font-family: var(--font-mono, monospace);
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-all;
  background-color: rgb(var(--base-text-color) / 0.04);
  border-radius: 6px;
  padding: 8px;
  color: rgb(var(--base-text-color) / 0.75);
}
.ncd-session-readonly {
  pointer-events: none;
  user-select: text;
}
.placeholder {
  font-size: 13px;
  line-height: 1.6;
  color: rgb(var(--base-text-color) / 0.55);
  padding: 12px 0;
}
.hint {
  font-size: 11px;
  color: rgb(var(--base-text-color) / 0.45);
  margin-left: 6px;
}
.readonly-field {
  font-size: 13px;
  color: rgb(var(--base-text-color) / 0.8);
}
/* ── 条件节点（条件分支，内嵌表达式面板）：只剩「标题 + 提示 + 内嵌表达式面板」三件 ──
   引导式条件组那套自绘样式（组头/条件行/三件套/组尾＋条件、表达式语法示例块）随界面一并退役，
   面板本体的视觉由共享包 AdvancedExpressionPanel 自带，本文件不再复刻。 */
/* 条件页填满整个 tab 内容区：面板要按真实
   可用高度分栏，容器就不能按内容自然高度收缩。标题/提示行是固定高（下方 flex:0 0 auto），
   剩余全部交给 .ncd-guard-panel。 */
.ncd-guard {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
  gap: 12px;
}
/* legacy / job / 缺桥三条提示：固定高度，不参与剩余空间分配（不挤占面板高度）。 */
.ncd-guard-notice {
  flex: 0 0 auto;
  font-size: 12px;
  line-height: 1.5;
}
/* 内嵌面板容器：高度由父级分配，不能被字段树内容撑开；共享面板按这个空间自适应。 */
.ncd-guard-panel {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
/* 语法检查状态条（与共享包 SyntaxStatusLine.vue 等价渲染，见模板处 🔴 注释说明为何不直接复用）：
   三态配色 + 错误可点击定位；明细单行省略。 */
.ncd-guard-status {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  font-size: 12px;
  line-height: 1.4;
}
.ncd-guard-status--idle {
  color: rgb(var(--text-secondary-color));
}
.ncd-guard-status--typing {
  color: rgb(var(--text-secondary-color));
}
.ncd-guard-status--checking {
  color: rgb(var(--info-color));
}
.ncd-guard-status--ok {
  color: rgb(var(--success-color));
}
.ncd-guard-status--error {
  color: rgb(var(--error-color));
  cursor: pointer;
}
.ncd-guard-status-mark {
  flex-shrink: 0;
  font-weight: 600;
}
.ncd-guard-status-label {
  flex-shrink: 0;
}
.ncd-guard-status-detail {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: rgb(var(--text-secondary-color));
}
</style>
