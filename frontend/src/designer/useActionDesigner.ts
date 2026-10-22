import { computed, ref, shallowRef, watch } from 'vue';
// 动作文档读写、动作注册中心、插件元数据、模板表/字段目录一律经 hostApi 注入。
import { t as $t } from '../i18n';
import { resolveLocalized } from './localize';
import type { ActionDesignerHostApi } from './hostApi';
import type {
  ActionDefinition,
  ActionDesignerScope,
  ActionDesignerTarget,
  AppCatalogEntry,
  EditorCapabilities,
  TemplateDataTable,
  TemplateField,
  TemplateFieldGroup,
  WorkflowStepCatalogDefinition
} from './hostTypes';
import { tableRoleOf } from '@kimposoft/expression-editor';
import { emptyBehaviorDocument } from './bundle';
import type { ActionBehaviorDocument } from './bundle';
import { compileEventsToBundle, openBundleToTrees } from './compile';
import { resolveOperationKind } from './dataActionKind';
import { actionEditorGap, type ActionEditorGap } from './editorCapabilities';
import { readHostError } from './hostError';
import { actionOutcomes, writeV4DocumentOf } from './labels';
import type { ActionTriggerEventKey, ConditionNodeGuard, MindNode, WorkflowGateStep } from './model';
import { RECORD_PAGE_EVENT_KEYS, SELECTABLE_TRIGGER_EVENT_KEYS, createActionNode, createConditionNode, createTriggerRoot, newConditionId } from './model';

/**
 * 拖拽落点：band 归属（root.id / condition id / 出口分支动作 id）+ 分支 + 兄弟插入索引（动作子集内）。
 * branch：条件用 'then'/'else'；出口分支节点用动作声明的 outcome key（如 "hit"/"miss"）；
 * 无分支（普通动作续接 band）为 undefined。
 */
export interface DropTarget {
  ownerId: string;
  branch?: string;
  index: number;
}

/** 拖拽载荷：新动作 / 新条件 / 移动已有节点。 */
export type DragPayload = { kind: 'action'; name: string } | { kind: 'condition' } | { kind: 'move'; nodeId: string };

interface Located {
  node: MindNode;
  band: MindNode[];
  index: number;
  ownerId: string;
  branch?: string;
}

/** 在树中定位节点，并带回其所属 band 的归属（owner + branch），供 reparent/插入用。 */
function locate(band: MindNode[], id: string, ownerId: string, branch?: string): Located | null {
  for (let i = 0; i < band.length; i += 1) {
    const node = band[i];
    if (node.id === id) return { node, band, index: i, ownerId, branch };
    if (node.kind === 'condition') {
      const inThen = locate(node.thenChildren ?? [], id, node.id, 'then');
      if (inThen) return inThen;
      const inElse = locate(node.elseChildren ?? [], id, node.id, 'else');
      if (inElse) return inElse;
    } else if (node.kind === 'action') {
      // 出口分支：与普通续接（children）互斥，逐 outcome band 递归查找。
      if (node.outcomeChildren) {
        for (const outcome of Object.keys(node.outcomeChildren)) {
          const found = locate(node.outcomeChildren[outcome] ?? [], id, node.id, outcome);
          if (found) return found;
        }
      } else if (node.children && node.children.length > 0) {
        const inChild = locate(node.children, id, node.id, undefined);
        if (inChild) return inChild;
      }
    }
  }
  return null;
}

/** 一个节点及其全部后代 id（用于 reparent 的环路防护）。 */
function subtreeIds(node: MindNode): Set<string> {
  const ids = new Set<string>();
  const walk = (n: MindNode) => {
    ids.add(n.id);
    (n.thenChildren ?? []).forEach(walk);
    (n.elseChildren ?? []).forEach(walk);
    (n.children ?? []).forEach(walk);
    if (n.outcomeChildren) Object.values(n.outcomeChildren).forEach(band => band.forEach(walk));
  };
  walk(node);
  return ids;
}

/**
 * useActionDesigner 的 options：与 ActionDesignerTarget 判别联合叠加
 * hostApi——沿用扁平形态（不裹一层 target 字段），保证既有调用方 `{ scope, hostApi }`
 * （kind 缺省即 'template'）无需改动即可编译通过。job 模式改传
 * `{ kind: 'job', appId, jobId, jobName?, hostApi }`。
 */
export type UseActionDesignerOptions = ActionDesignerTarget & {
  hostApi: ActionDesignerHostApi;
  /** Host 会话失去写权限后，所有在途权威读取/写入结果都必须丢弃。 */
  canCommitAuthority?: () => boolean;
};

type MutableExpressionTarget = {
  target_kind?: string;
  target_template_id?: string;
  target_data_table_id?: string;
  target_table_role?: string;
};

/**
 * 旧动作文档在引入 target_table_role 之前已落库。设计器加载时依据当前模板的数据表元数据补齐
 * 该派生字段，避免用户仅保存事件就被插件要求逐个重新选择目标表。只处理当前模板目标；跨模板目标
 * 没有本地权威元数据，保持原样并由对应节点配置界面加载目标模板后盖章。
 */
export function normalizeActionTargetRoles(
  doc: ActionBehaviorDocument,
  currentTemplateId: string,
  availableTables: TemplateDataTable[]
): ActionBehaviorDocument {
  const tableById = new Map(availableTables.map(table => [table.data_table_id, table] as const));
  let documentChanged = false;
  const actionNodes = (doc.action_nodes ?? []).map(node => {
    const expression = node.params?.expression as
      | { target?: MutableExpressionTarget; targets?: MutableExpressionTarget[] }
      | undefined;
    if (!expression) return node;
    const params = JSON.parse(JSON.stringify(node.params)) as Record<string, unknown>;
    const nextExpression = params.expression as {
      target?: MutableExpressionTarget;
      targets?: MutableExpressionTarget[];
    };
    let nodeChanged = false;
    const stamp = (target: MutableExpressionTarget | undefined): void => {
      if (!target || target.target_kind === 'staging' || target.target_table_role) return;
      if (target.target_template_id && target.target_template_id !== currentTemplateId) return;
      const table = target.target_data_table_id ? tableById.get(target.target_data_table_id) : undefined;
      if (!table) return;
      target.target_table_role = tableRoleOf(table, availableTables);
      nodeChanged = true;
    };
    stamp(nextExpression.target);
    nextExpression.targets?.forEach(stamp);
    if (!nodeChanged) return node;
    documentChanged = true;
    return { ...node, params };
  });
  return documentChanged ? { ...doc, action_nodes: actionNodes } : doc;
}

export function useActionDesigner(options: UseActionDesignerOptions) {
  /**
   * supportedTriggers 的默认全量值（SELECTABLE 版）：未拿到载体声明前 /
   * 拉取失败 / 未命中插件时的回退值，也是 job 模式的恒定值（loadSupportedTriggers 对 job 模式早退，
   * 不会再改写它）。
   * - 模板模式：SELECTABLE_TRIGGER_EVENT_KEYS 全量（含记录页事件 RECORD_PAGE_EVENT_KEYS——它俩载体
   *   无关，天然应在"未知/放行全局"的默认值里；不含老保存键 before-save/after-save——它俩已退役出
   *   可选事件集，哪怕未拿到载体声明也不该出现在「＋事件」下拉里）；
   * - job 模式：全量剔除记录页事件（定时任务没有"记录删除"语义）。
   */
  function defaultSupportedTriggers(): ActionTriggerEventKey[] {
    return options.kind === 'job'
      ? SELECTABLE_TRIGGER_EVENT_KEYS.filter(key => !RECORD_PAGE_EVENT_KEYS.includes(key))
      : [...SELECTABLE_TRIGGER_EVENT_KEYS];
  }

  // 多动作事件：一个模板维护一组触发根（动作事件），activeEventId 指向当前编辑的事件。
  // 空白起步：新开设计器（无已保存事件）时不自动种事件，由用户经「＋ 事件」显式新增。
  const events = ref<MindNode[]>([]);
  const activeEventId = ref<string>('');
  // 当前事件的触发根；找不到时回退首个；无任何事件时为 null（空白态）。
  const activeRoot = computed<MindNode | null>(() => events.value.find(e => e.id === activeEventId.value) ?? events.value[0] ?? null);
  // root 为 activeRoot 的别名：现有 band/locate/画布逻辑沿用 root 指向当前事件。空白态为 null。
  const root = activeRoot;
  const selectedId = ref<string | null>(null);
  const saveErrorNodeId = ref<string | null>(null);
  const registry = shallowRef<ActionDefinition[]>([]);
  // 当前载体(template 绑定的插件)声明支持的触发事件子集；用于过滤「＋事件」下拉。
  // 默认回退为全量锚点：载体未声明 / 拉取失败 / 未命中插件时，不破现状（放行全局）。
  // 记录页事件（RECORD_PAGE_EVENT_KEYS）与载体声明无关、恒属于模板模式的默认全量，
  // 但 job 模式没有"记录删除"语义，默认值本身就要把它俩排除（loadSupportedTriggers 对 job 模式
  // 早退、不会再改写这个初值，故 job 模式的排除只能在这里做到，不能指望后续交集逻辑兜底）。
  const supportedTriggers = ref<ActionTriggerEventKey[]>(defaultSupportedTriggers());
  const tables = shallowRef<TemplateDataTable[]>([]);
  const fieldsByTable = shallowRef<Record<string, TemplateField[]>>({});
  // 应用目录：供画布节点指向详情把跨应用来源的 app_id
  // 解析成可读应用名（labels.ts crossAppPrefix）。旧宿主未提供 hostApi.listApps 时恒空数组，
  // appName() 对任何 appId 回退原样，摘要不产出前缀——不阻断，仅少一层可读性（同 tables/fields
  // 判空降级范式）。
  const apps = shallowRef<AppCatalogEntry[]>([]);
  // 流程步骤目录（触发根「流程步骤门」）：null=尚未加载/加载中，[]=已加载（可能确实
  // 为空，即本模板未绑定任何流程）。惰性加载一次（见 ensureWorkflowStepCatalog），供画布触发根
  // 徽标失效判定与设计期校验共用；NodeConfigDialog 打开门弹窗时另经 hostApi 独立取一份（互不依赖）。
  const workflowStepCatalog = shallowRef<WorkflowStepCatalogDefinition[] | null>(null);
  let workflowStepCatalogLoading: Promise<void> | null = null;
  // 动作注册中心加载态（不与 loading 合并：loading 覆盖整个 load() 流程，registryState 只描述
  // loadRegistry 这一步的结果三分）：
  // - 'ok'：成功拿到清单（清单本身可能为空——那是"确实没有动作"，非本状态要区分的失败态）；
  // - 'error'：hostApi 调用失败/响应非预期（data 缺失）；
  // - 'not-ready'：宿主显式声明 ready===false（注册中心尚未就绪，如插件系统还在启动）。
  // 初值 'ok'：load() 尚未跑完前面板由外层 loading 覆盖显示，不依赖本状态的初值语义。
  const registryState = ref<'ok' | 'error' | 'not-ready'>('ok');
  const loading = ref(false);
  const saving = ref(false);
  const errorText = ref('');
  const dirty = ref(false);
  // 按事件跟踪未保存改动（单事件保存语义）：编辑/新增/重命名标记当前事件 dirty，保存该事件后清除。
  const dirtyEventIds = ref<Set<string>>(new Set());

  // 当前已持久化的动作行为文档（独立存储），与设计文件/表格完全解耦。
  let currentActions: ActionBehaviorDocument | undefined;
  let actionVersionBaseline = 0;
  // 每次 load 或终态冻结都会推进；在途 Promise 只能在代际仍匹配且 Host 仍允许时回填。
  let authorityGeneration = 0;
  // 本文档引用了、但当前设计者无设计权限的跨应用来源应用 ID
  // 清单，来自 OpenActionDocument 响应（EditorActionDocument.unauthorized_source_apps）。
  // 供 NodeConfigDialog 判定某条取数公式是否要以只读打开——不在此处主动阻断任何编辑，本 controller
  // 只负责透传数据，判定逻辑留在消费方（各表达式模型的来源表是否命中这份清单）。
  const unauthorizedSourceApps = ref<string[]>([]);

  const registryByName = computed(() => new Map(registry.value.map(def => [def.name, def] as const)));

  // 模板绑定编辑器的能力视图。null = 不裁剪（job 模式 / 旧宿主未提供 / 尚未加载）；
  // 读取失败按「不支持任何档案」降级（profiles 空、commands null），不回落表格编辑器。
  const editorCapabilities = shallowRef<EditorCapabilities | null>(null);

  /** 动作在当前编辑器下不可用的原因（缺哪条命令 / 档案）；可用或不裁剪时 null。 */
  function actionEditorUnsupported(actionName: string | undefined): ActionEditorGap | null {
    if (!actionName) return null;
    return actionEditorGap(registryByName.value.get(actionName), editorCapabilities.value);
  }

  /** 出口分支：某动作是否声明 x-outcomes 及其出口 key 集合；未登记/未声明回落空数组。 */
  function outcomesOf(actionName: string | undefined): string[] {
    return actionOutcomes(actionName ? registryByName.value.get(actionName) : undefined);
  }

  /**
   * 动作暂存区：计算某节点在画布拓扑中的"暂存生产者"——与动作引擎侧
   * 续接带/子流程可见性语义严格对齐：
   * 把 X 挂在自己续接带/子流程里的那个父 action 节点即生产者；顺序兄弟互相不可见（同一 band
   * 内前一个成员不是后一个成员的生产者，二者共同的 band owner 才是）；condition 节点编译为
   * group guard、非 pipeline 节点，故透明跳过——沿途遇到的第一个 action 节点即生产者，
   * 一路到 root/trigger 根都未遇到则无生产者。
   * 实现：单趟树遍历，随身携带"当前 band 最近的 action 祖先"：进入某 action 的
   * children/outcomeChildren 时更新为该 action；进入 condition 的 then/else 时原样透传（不更新）。
   * 用 undefined 区分"本 band 未找到目标节点"与 null 区分"找到但无生产者"，二者语义不同不可合并。
   */
  function stagingProducerOf(nodeId: string): MindNode | null {
    const r = root.value;
    if (!r || nodeId === r.id) return null; // 空白态 / 目标即触发根自身：无生产者

    function walk(band: MindNode[], ancestor: MindNode | null): MindNode | null | undefined {
      for (const node of band) {
        if (node.id === nodeId) return ancestor;
        if (node.kind === 'condition') {
          // 条件透明跳过：ancestor 原样透传给 then/else 两侧 band。
          const inThen = walk(node.thenChildren ?? [], ancestor);
          if (inThen !== undefined) return inThen;
          const inElse = walk(node.elseChildren ?? [], ancestor);
          if (inElse !== undefined) return inElse;
        } else if (node.kind === 'action') {
          if (node.outcomeChildren) {
            for (const outcome of Object.keys(node.outcomeChildren)) {
              const found = walk(node.outcomeChildren[outcome] ?? [], node);
              if (found !== undefined) return found;
            }
          } else if (node.children && node.children.length > 0) {
            const found = walk(node.children, node);
            if (found !== undefined) return found;
          }
        }
      }
      return undefined;
    }

    const result = walk(r.children ?? [], null);
    return result === undefined ? null : result;
  }

  const allFields = computed<TemplateField[]>(() => Object.values(fieldsByTable.value).flat());

  /**
   * guard（条件分支）专用字段候选：条件分支只能用主表字段判定，
   * 不能再选到扩展表/子表字段——必须在 allFields 拍平之前按表归属过滤，因为 TemplateField
   * 本身不带 data_table_id（见 hostTypes.ts），拍平之后（allFields）就再也反查不到某字段属于
   * 哪张表了。角色判定复用权威函数 tableRoleOf（以后端 table_role 为准，sort_no 仅兜底撞号回退），
   * 不新造判定逻辑，与 useActionDesigner/NodeConfigDialog/DetailSortPanel/LinkedFormPanel 等既有
   * 用法保持一致。
   */
  const guardFields = computed<TemplateField[]>(() => {
    const mainTableIds = new Set(
      tables.value.filter(table => tableRoleOf(table, tables.value) === 'main').map(table => table.data_table_id)
    );
    return tables.value.filter(table => mainTableIds.has(table.data_table_id)).flatMap(table => fieldsByTable.value[table.data_table_id] ?? []);
  });

  /**
   * 触发字段（值变动/点击）下拉的按表分组候选（按数据表分组、只显示表名与字段名，
   * 不显示物理列名/字段 id）：表顺序信任宿主表目录序（后端已按「主表优先 → 设计器拖动排序位」下发，
   * 前端不再自排）；无字段的表不出现。与 guardFields 同理，TemplateField
   * 不带 data_table_id，必须在拍平（allFields）之前按 fieldsByTable 的键归组。
   */
  const fieldGroups = computed<TemplateFieldGroup[]>(() => {
    return tables.value
      .map(table => ({ table, fields: fieldsByTable.value[table.data_table_id] ?? [] }))
      .filter(group => group.fields.length > 0);
  });

  const fieldNameMap = computed(() => new Map(allFields.value.map(f => [f.field_id, f.field_name] as const)));

  function fieldName(fieldId: string): string {
    return fieldNameMap.value.get(fieldId) ?? fieldId;
  }

  const tableNameMap = computed(() => new Map(tables.value.map(t => [t.data_table_id, t.table_name] as const)));

  /** 数据表显示名：按 data_table_id 查当前模板表目录，再查写节点目标模板的表目录（见下方
   *  foreignTableNames），都查不到回退 id 原样（与 fieldName 同一范式；供画布节点卡片摘要 / 指向详情
   *  解析取数目标表、写目标表、本报表来源表的表名）。 */
  function tableName(tableId: string): string {
    return tableNameMap.value.get(tableId) ?? foreignTableNames.value.get(tableId) ?? tableId;
  }

  // 写节点目标表名补齐：新增/修改/删除数据的目标表常在别的模板下，不在当前模板表目录 tables 里，
  // tableName() 只能回退表 ID（画布节点副标题会显示成「新增 tbl_…」）。这里按当前事件树里
  // 写节点 target.template_id 收集「非当前模板」的模板 ID，经 SDK 宿主接口 listTemplateTables 逐个拉
  // 一次表目录并缓存表名；每个模板只请求一次，失败静默（仍回退 ID，不阻断设计器）。
  const foreignTableNames = shallowRef<Map<string, string>>(new Map());
  const requestedForeignTemplateIds = new Set<string>();

  /** 收集一棵事件树里写节点目标模板 ID（不含当前模板；job 模式没有当前模板，全收）。 */
  function collectWriteTargetTemplateIds(node: MindNode | null, out: Set<string>): Set<string> {
    if (!node) return out;
    const targetTemplateId = writeV4DocumentOf(node)?.target?.template_id?.trim();
    const currentTemplateId = options.kind === 'job' ? '' : options.scope.templateId;
    if (targetTemplateId && targetTemplateId !== currentTemplateId) out.add(targetTemplateId);
    const bands: MindNode[][] = [node.children ?? [], node.thenChildren ?? [], node.elseChildren ?? [], ...Object.values(node.outcomeChildren ?? {})];
    for (const band of bands) for (const child of band) collectWriteTargetTemplateIds(child, out);
    return out;
  }

  async function loadForeignTableNames(templateIds: string[]): Promise<void> {
    const appId = currentAppId.value;
    const pending = templateIds.filter(id => !requestedForeignTemplateIds.has(id));
    if (!appId || pending.length === 0) return;
    pending.forEach(id => requestedForeignTemplateIds.add(id));
    const results = await Promise.all(
      pending.map(templateId => options.hostApi.listTemplateTables(appId, templateId).catch(() => ({ data: null })))
    );
    const next = new Map(foreignTableNames.value);
    for (const result of results) {
      for (const table of result.data?.items ?? []) {
        if (table.data_table_id && table.table_name) next.set(table.data_table_id, table.table_name);
      }
    }
    foreignTableNames.value = next;
  }


  // 当前设计所在应用 ID（两种模式各自的 appId 字段名不同，统一成一个只读值，
  // 供 labels.ts crossAppPrefix 判断来源是否「跨应用」）。
  const currentAppId = computed(() => (options.kind === 'job' ? options.appId : options.scope.appId));

  // 写节点目标表名补齐的触发器（见上方 foreignTableNames）：事件树里出现新的目标模板时补拉其表目录。
  // 放在 currentAppId 之后：immediate 首次执行要读它。
  watch(
    () => [...collectWriteTargetTemplateIds(root.value, new Set())].sort().join(','),
    key => {
      if (key) void loadForeignTableNames(key.split(','));
    },
    { immediate: true }
  );

  const appNameMap = computed(() => new Map(apps.value.map(a => [a.app_id, a.app_name] as const)));

  /** 应用显示名：按 app_id 查应用目录，查不到回退空串（不产出前缀，见 labels.ts crossAppPrefix；
   *  与 tableName「查不到回退 id 原样」不同——app_id 本身不是给用户看的可读文本，宁可不展示前缀）。 */
  function appName(appId: string): string {
    return appNameMap.value.get(appId) ?? '';
  }

  const selectedNode = computed<MindNode | null>(() => {
    const r = root.value;
    if (!selectedId.value || !r) return null;
    if (selectedId.value === r.id) return r;
    return locate(r.children ?? [], selectedId.value, r.id)?.node ?? null;
  });

  // 拖拽中的载荷（dragstart 时由面板/画布节点写入），供画布 dragover 计算合法落点用。
  const dragSource = ref<DragPayload | null>(null);
  function setDragSource(payload: DragPayload | null): void {
    dragSource.value = payload;
  }

  function markDirty(): void {
    dirty.value = true;
    // 编辑均作用于当前事件（选中节点恒在 activeRoot 树内），故标记当前事件为脏。
    const next = new Set(dirtyEventIds.value);
    next.add(activeEventId.value);
    dirtyEventIds.value = next;
  }
  /** 当前事件是否有未保存改动（供「保存当前事件」按钮态用）。 */
  const activeDirty = computed(() => dirtyEventIds.value.has(activeEventId.value));

  function selectNode(id: string | null): void {
    selectedId.value = id;
  }

  /** 取目标 DropTarget 对应的 band 数组（按 owner + branch）。空白态（无 root）返回空数组。 */
  function bandOf(target: DropTarget): MindNode[] {
    const r = root.value;
    if (!r) return [];
    if (!r.children) r.children = [];
    if (target.ownerId === r.id) return r.children;
    const owner = locate(r.children, target.ownerId, r.id)?.node;
    if (owner && owner.kind === 'condition') {
      if (target.branch === 'else') {
        if (!owner.elseChildren) owner.elseChildren = [];
        return owner.elseChildren;
      }
      if (!owner.thenChildren) owner.thenChildren = [];
      return owner.thenChildren;
    }
    // 动作作为容器：
    // - target.branch 命中（出口分支 R5）→ 挂进 owner.outcomeChildren[branch]（惰性建带）；
    // - 否则 → 其普通子流程（向右挂载的嵌套子节点，续接编译为 continuation_group_ids）。
    // 二者互斥：出口分支节点的落点只会带 branch（见 layout.ts/dropSlots.ts 对出口节点的落点生成），
    // 画布已不再为其展示无 branch 的普通续接框，这里的分支只是结构上的双重保险。
    if (owner && owner.kind === 'action') {
      if (target.branch) {
        if (!owner.outcomeChildren) owner.outcomeChildren = {};
        if (!owner.outcomeChildren[target.branch]) owner.outcomeChildren[target.branch] = [];
        return owner.outcomeChildren[target.branch];
      }
      if (!owner.children) owner.children = [];
      return owner.children;
    }
    return r.children;
  }

  // 落点 index 现为 band 数组插入位（含条件在内的成员序），条件之前/之后均可定位。
  function clampBandIndex(band: MindNode[], index: number): number {
    return Math.max(0, Math.min(index, band.length));
  }

  // 新动作默认**同步执行**（S1 任务4）：无论动作是否声明 asyncable，新建时一律默认同步，
  // 需要异步的场景由用户在属性面板显式切换。运行时默认同步与此保持一致（见宿主动作引擎）。
  function defaultAsync(_actionName: string): boolean {
    return false;
  }

  function addActionAt(actionName: string, target: DropTarget): void {
    if (!root.value) return; // 空白态无事件，忽略添加（应先经「＋ 事件」建事件）
    const band = bandOf(target);
    const def = registryByName.value.get(actionName);
    // 名称默认取插件动作的显示名（可在属性面板改）；启用默认 true。
    const defaultName = resolveLocalized(def?.title) || actionName;
    const node = createActionNode({ actionName, source: def?.source, async: defaultAsync(actionName), name: defaultName, enabled: true });
    band.splice(clampBandIndex(band, target.index), 0, node);
    selectNode(node.id);
    markDirty();
  }

  function addConditionAt(target: DropTarget): void {
    // 条件可放进任意 band（含动作的子流程/续接 band）。插入语义：把落点「之后」的所有成员移入新条件的
    // 「成立」分支——即在中间插入条件 = 其后的流程变为「条件成立才执行」；插在末尾则无后续、成立分支为空
    // （此时为一个独立的顺序条件）。动作的 children band 含条件时由 compile 编译为该动作的续接组。
    if (!root.value) return; // 空白态无事件，忽略添加
    const band = bandOf(target);
    const index = clampBandIndex(band, target.index);
    const following = band.splice(index); // 取出落点之后的全部成员（动作/条件均移入成立分支）
    // 新建条件节点直接种一份**空的 V4 判断表达式**（conditionId 创建时分配，改表达式不换），
    // 不种旧式单条 condition——旧式会被配置页判成「旧格式，请重新配置」。
    const conditionId = newConditionId();
    const node = createConditionNode({
      guardSpec: {
        mode: 'expression',
        v4: { conditionId, expression: { expression_id: conditionId, purpose: 'condition', source_text: '', refs: [] } }
      },
      thenChildren: following,
      elseChildren: []
    });
    band.push(node);
    selectNode(node.id);
    markDirty();
  }

  /** 移动已有节点到目标 band/索引（reparent + 重排），含环路防护与条件唯一性。async 不随位置改变。 */
  function moveNodeAt(nodeId: string, target: DropTarget): void {
    const r = root.value;
    if (!r || !r.children) return;
    const found = locate(r.children, nodeId, r.id);
    if (!found || found.node.kind === 'trigger-root') return;
    const moving = found.node;
    if (subtreeIds(moving).has(target.ownerId)) return; // 不能放进自身子树
    const targetBand = bandOf(target);
    // band 可含多个顺序条件，移动条件不再要求目标 band 无条件。
    let insertIndex = clampBandIndex(targetBand, target.index);
    if (found.band === targetBand && found.index < insertIndex) insertIndex -= 1; // 同 band 内移动按移除调整
    found.band.splice(found.index, 1);
    // 动作与条件都按落点插入（band 可含多个顺序条件，无数量限制）。
    targetBand.splice(Math.max(0, Math.min(insertIndex, targetBand.length)), 0, moving);
    selectNode(moving.id);
    markDirty();
  }

  /** 拖拽落点统一入口。 */
  function applyDrop(target: DropTarget, payload: DragPayload): void {
    if (payload.kind === 'action') addActionAt(payload.name, target);
    else if (payload.kind === 'condition') addConditionAt(target);
    else moveNodeAt(payload.nodeId, target);
  }

  /** 点击添加：以选中节点所在 band 末尾为目标。空白态返回哑目标（bandOf 会无害化）。 */
  function targetFromSelected(): DropTarget {
    const r = root.value;
    if (!r) return { ownerId: '', index: 0 };
    const children = r.children ?? [];
    const id = selectedId.value;
    if (!id || id === r.id) return { ownerId: r.id, index: children.length };
    const found = locate(children, id, r.id);
    if (!found) return { ownerId: r.id, index: children.length };
    if (found.node.kind === 'condition') {
      return { ownerId: found.node.id, branch: 'then', index: (found.node.thenChildren ?? []).length };
    }
    return { ownerId: found.ownerId, branch: found.branch, index: found.band.length };
  }

  function addAction(actionName: string): void {
    if (!root.value) return;
    addActionAt(actionName, targetFromSelected());
  }

  function addCondition(): void {
    if (!root.value) return;
    addConditionAt(targetFromSelected());
  }

  function deleteSelected(): void {
    const r = root.value;
    const id = selectedId.value;
    if (!id || !r || id === r.id) return;
    const found = locate(r.children ?? [], id, r.id);
    if (!found) return;
    found.band.splice(found.index, 1);
    selectNode(null);
    markDirty();
  }

  function updateSelected(patch: Partial<MindNode>): void {
    const node = selectedNode.value;
    if (!node) return;
    Object.assign(node, patch);
    markDirty();
  }

  /**
   * 更新选中条件节点的 guard（双判断模式：guided 引导式 / expression 表达式）。
   * guardSpec 为权威来源；condition 字段仅在 guided 单条时同步镜像（供画布 label 等旧消费点兜底读取，
   * guided 多条/expression 模式无法用单条 SimpleCondition 表达，保留原值不强改）。
   */
  function updateSelectedCondition(guardSpec: ConditionNodeGuard): void {
    const node = selectedNode.value;
    if (!node || node.kind !== 'condition') return;
    node.guardSpec = guardSpec;
    if (guardSpec.mode === 'guided' && guardSpec.guided && guardSpec.guided.items.length === 1) {
      node.condition = guardSpec.guided.items[0];
    }
    markDirty();
  }

  function setTriggerRoot(patch: {
    eventKey?: ActionTriggerEventKey;
    eventKeys?: ActionTriggerEventKey[];
    /** 触发字段分事件独立集合：Dialog 保存时整体替换（value-change/field-click 各自一份）。 */
    eventFieldIds?: Partial<Record<ActionTriggerEventKey, string[]>>;
    scope?: string;
    scopes?: string[];
    blockable?: boolean;
    /** 流程步骤门：undefined = 不限（清空既有门）；Dialog 保存时整体替换。 */
    workflowGate?: { notStarted: boolean; steps: WorkflowGateStep[] };
  }): void {
    const r = root.value;
    if (!r) return;
    Object.assign(r, patch);
    // 多事件不变式：eventKeys 至少含一个、eventKey===eventKeys[0]（大量展示/编译读点依赖首事件）。
    if (r.eventKeys && r.eventKeys.length > 0) r.eventKey = r.eventKeys[0];
    else if (r.eventKey) r.eventKeys = [r.eventKey];
    // 多触发范围不变式：scopes 至少含一个、scope===scopes[0]。
    if (r.scopes && r.scopes.length > 0) r.scope = r.scopes[0];
    else if (r.scope) r.scopes = [r.scope];
    markDirty();
  }

  // ── 动作事件管理 ──

  /** 切换当前编辑的动作事件；切换后清空选中并定位到该事件触发根。 */
  function setActiveEvent(eventId: string): void {
    if (!events.value.some(e => e.id === eventId)) return;
    activeEventId.value = eventId;
    selectNode(activeRoot.value?.id ?? null);
  }

  /** 新增动作事件；统一作用于表单，允许同类型多个事件并存（各自有稳定 bindingId，可重命名区分）。 */
  function addEvent(input: { eventKey: ActionTriggerEventKey; scope?: string; blockable?: boolean }): boolean {
    const node = createTriggerRoot({ eventKey: input.eventKey, scopes: ['form'], blockable: input.blockable, children: [] });
    events.value.push(node);
    activeEventId.value = node.id;
    selectNode(node.id);
    markDirty();
    return true;
  }

  /**
   * 把动作事件移到指定下标（左侧列表指针拖动排序的通用入口；moveEvent 是本函数的 ±1 薄包装）。
   * 画布顺序 = 同一触发下多个动作的执行顺序。
   * 先把该事件从原位摘出插到 toIndex（其余相对顺序不变），再把当前顺序写成全部已落盘 binding 的 seq
   * （同根多 binding 同值，1 起连续）并保存；未落盘的根在其首次保存时按下标补 seq。
   * 越界/未找到/位置未变返回 false；无落盘文档只改内存顺序返回 true。
   */
  async function moveEventTo(eventId: string, toIndex: number): Promise<boolean> {
    const idx = events.value.findIndex(e => e.id === eventId);
    if (idx < 0 || toIndex < 0 || toIndex >= events.value.length || toIndex === idx) return false;
    const rows = [...events.value];
    const [moved] = rows.splice(idx, 1);
    rows.splice(toIndex, 0, moved);
    events.value = rows;
    const doc = currentActions;
    if (!doc || !Array.isArray(doc.trigger_bindings) || doc.trigger_bindings.length === 0) return true;
    const seqByBindingId = new Map<string, number>();
    rows.forEach((root, i) => {
      // 与 compile.ts 的 rootBindingId 规则一致：未落盘根用 `tb_${root.id}`，在文档里自然匹配不到。
      for (const id of bindingIdsForRoot(doc, root.bindingId ?? `tb_${root.id}`)) seqByBindingId.set(id, i + 1);
    });
    if (seqByBindingId.size === 0) return true;
    const next: ActionBehaviorDocument = {
      ...doc,
      trigger_bindings: doc.trigger_bindings.map(binding =>
        seqByBindingId.has(binding.binding_id) ? { ...binding, seq: seqByBindingId.get(binding.binding_id)! } : binding
      )
    };
    return persistDoc(next);
  }

  /** 上/下移一格（moveEventTo 的 ±1 包装，保留给既有调用方与测试）。 */
  async function moveEvent(eventId: string, delta: -1 | 1): Promise<boolean> {
    const idx = events.value.findIndex(e => e.id === eventId);
    if (idx < 0) return false;
    return moveEventTo(eventId, idx + delta);
  }

  /**
   * 切换动作事件的启用/停用（点击即切换）。
   * 语义：停用 = 该事件的**全部** binding 都不参与触发匹配（宿主 ResolveTargeted / resolveAffectedRoots
   * 双路径同口径），表现为「这个事件不存在」——不报错不提示不执行；文档内容原样保留，重启用即恢复。
   * 持久化口径与「拖动排序」「删除事件」一致——**点击即落盘**（不必再点保存）：已落盘的事件直接改
   * 其名下全部 binding 的 disabled 并保存；尚未落盘的新事件只改内存并标脏，随首次保存写入。
   * 返回是否已写盘（未落盘事件返回 false 属正常，不是失败）。
   */
  async function toggleEventEnabled(eventId: string, enabled?: boolean): Promise<boolean> {
    const ev = events.value.find(e => e.id === eventId);
    if (!ev) return false;
    const next = enabled ?? ev.enabled === false;
    ev.enabled = next;
    const doc = currentActions;
    const baseId = ev.bindingId;
    const bindingIds = doc && baseId ? bindingIdsForRoot(doc, baseId) : new Set<string>();
    if (!doc || bindingIds.size === 0) {
      // 未落盘：只标脏，等该事件首次保存时由 compile 写入 disabled。
      const dirtySet = new Set(dirtyEventIds.value);
      dirtySet.add(eventId);
      dirtyEventIds.value = dirtySet;
      dirty.value = true;
      return false;
    }
    const nextDoc: ActionBehaviorDocument = {
      ...doc,
      trigger_bindings: (doc.trigger_bindings ?? []).map(binding => {
        if (!bindingIds.has(binding.binding_id)) return binding;
        if (next) {
          // 启用态不写该键（宿主规范化对零值敏感，见 bundle.ts 注释）。
          const { disabled: _dropped, ...rest } = binding;
          return rest;
        }
        return { ...binding, disabled: true };
      })
    };
    return persistDoc(nextDoc);
  }

  /** 重命名动作事件（空名回落到事件类型名显示）。 */
  function renameEvent(eventId: string, name: string): void {
    const ev = events.value.find(e => e.id === eventId);
    if (!ev) return;
    const trimmed = name.trim();
    ev.name = trimmed || undefined;
    // 重命名标记该事件脏（即便不是当前事件）。
    const next = new Set(dirtyEventIds.value);
    next.add(eventId);
    dirtyEventIds.value = next;
    dirty.value = true;
  }

  /** 删除动作事件（连带该事件整棵树）；允许删到 0（回到空白态）。若该事件已落盘，同时从设计文档移除并保存。 */
  async function removeEvent(eventId: string): Promise<void> {
    const idx = events.value.findIndex(e => e.id === eventId);
    if (idx < 0) return;
    const removed = events.value[idx];
    events.value.splice(idx, 1);
    if (activeEventId.value === eventId) {
      activeEventId.value = events.value[Math.max(0, idx - 1)]?.id ?? '';
      selectNode(activeRoot.value?.id ?? null);
    }
    const next = new Set(dirtyEventIds.value);
    next.delete(eventId);
    dirtyEventIds.value = next;
    dirty.value = next.size > 0;
    // 已落盘的事件：从行为文档移除其名下全部 binding（一个 root 可能拆产多条）+ 专属实体并保存
    // （单事件模型下删除即持久化）。
    const persisted = !!removed.bindingId && bindingIdsForRoot(currentActions ?? emptyBehaviorDocument(), removed.bindingId).size > 0;
    if (persisted) {
      await persistDoc(removeRootFromDoc(currentActions!, removed.bindingId!));
    }
  }

  function canCommitAuthority(generation: number): boolean {
    return generation === authorityGeneration && (options.canCommitAuthority?.() ?? true);
  }

  async function loadFields(generation: number): Promise<void> {
    // job 模式无模板字段目录（任务不绑定单一模板），跳过拉取，
    // tables/fieldsByTable/allFields 恒空——各消费方据此走"无字段上下文"分支（见 NodeConfigDialog）。
    if (options.kind === 'job') return;
    const { data } = await options.hostApi.listTemplateTables(
      options.scope.appId,
      options.scope.templateId,
      options.scope.templateVersionNo
    );
    const items = data?.items ?? [];
    if (!canCommitAuthority(generation)) return;
    tables.value = items;
    const map: Record<string, TemplateField[]> = {};
    await Promise.all(
      items.map(async table => {
        const res = await options.hostApi.listTemplateFields(
          options.scope.appId,
          options.scope.templateId,
          options.scope.templateVersionNo,
          table.data_table_id
        );
        map[table.data_table_id] = res.data?.items ?? [];
      })
    );
    if (canCommitAuthority(generation)) fieldsByTable.value = map;
  }

  /**
   * 加载模板绑定编辑器的能力视图：job 模式无模板、旧宿主未提供 getEditorCapabilities 时
   * 保持 null（不裁剪）；宿主返回 null / 抛错时降级为「不支持任何档案」，档案级节点置灰并在保存前点名。
   */
  async function loadEditorCapabilities(generation: number): Promise<void> {
    if (options.kind === 'job' || !options.hostApi.getEditorCapabilities) return;
    const scope = options.scope;
    let caps: EditorCapabilities | null = null;
    try {
      caps = await options.hostApi.getEditorCapabilities({ appId: scope.appId, templateId: scope.templateId });
    } catch {
      caps = null;
    }
    if (!canCommitAuthority(generation)) return;
    editorCapabilities.value = caps ?? { pluginId: scope.pluginId ?? '', designerType: scope.designerType ?? '', profiles: [], commands: null };
  }

  /**
   * 加载应用目录（可选宿主方法）：供 appName 解析口。旧宿主未提供
   * hostApi.listApps 时静默保持 apps 恒空——与 tables/fields 判空降级同一范式，不阻断整个
   * load() 流程（画布节点指向详情只是少一层「应用名 › 」前缀，不影响其余展示）。
   */
  async function loadApps(generation: number): Promise<void> {
    if (!options.hostApi.listApps) return;
    try {
      const { data } = await options.hostApi.listApps();
      if (!canCommitAuthority(generation)) return;
      apps.value = data?.items ?? [];
    } catch {
      // 应用目录加载失败不算致命错误（同上，只影响跨应用来源的可读性），吞掉不上抛。
    }
  }

  /**
   * 惰性加载一次本模板的流程步骤目录：供画布触发根徽标失效判定 + 设计期校验共用。
   * 已加载（非 null）或正在加载中都直接复用，不重复发起请求；job 模式无模板，恒不加载（画布也不会
   * 渲染任何触发根门徽标）。加载失败保持 null 并仅 console.warn 上报（不阻断整个设计器），消费方据
   * 此退化为「不判失效、只显示数量」（见 TriggerRootNode.vue）。
   */
  async function ensureWorkflowStepCatalog(): Promise<void> {
    if (options.kind === 'job') return;
    if (workflowStepCatalog.value !== null) return;
    if (workflowStepCatalogLoading) return workflowStepCatalogLoading;
    const generation = authorityGeneration;
    workflowStepCatalogLoading = (async () => {
      try {
        const { data } = await options.hostApi.listTemplateWorkflows(options.scope.appId, options.scope.templateId);
        if (!canCommitAuthority(generation)) return;
        workflowStepCatalog.value = data?.definitions ?? [];
      } catch {
        // 加载失败保持 null（不是空数组）：空数组会让画布徽标与校验把所有门条目误判为「已失效」；
        // null 才是「目录未拿到 ⇒ 不判失效、只显示数量」的约定值，下次进入弹窗 / 挂载会再试一次。
        if (canCommitAuthority(generation)) {
          workflowStepCatalog.value = null;
          console.warn('[action-designer] ensureWorkflowStepCatalog failed');
        }
      } finally {
        workflowStepCatalogLoading = null;
      }
    })();
    return workflowStepCatalogLoading;
  }

  /**
   * 加载动作注册中心清单——不对失败/未就绪静默吞成空数组（否则"hostApi 调用失败"和"注册中心
   * 确实没有可用动作"会混同为同一个空清单，用户在 ActionPanel 里分不清）。按 registryState 三分：
   * data 缺失（非 200/网络异常/hostApi 抛错）记 'error'；data.ready===false（宿主显式声明未就绪）
   * 记 'not-ready'；否则记 'ok'（ready 缺省视为 true，兼容宿主端点尚未带 ready 字段的响应）。
   */
  async function loadRegistry(generation: number): Promise<void> {
    try {
      const { data } = await options.hostApi.listActionRegistry();
      if (!canCommitAuthority(generation)) return;
      if (!data) {
        registryState.value = 'error';
        registry.value = [];
        return;
      }
      if (data.ready === false) {
        registryState.value = 'not-ready';
        registry.value = [];
        return;
      }
      registryState.value = 'ok';
      registry.value = data.actions ?? [];
    } catch {
      if (!canCommitAuthority(generation)) return;
      // hostApi 实现内部直接抛错（如网络异常）时与"resolve 但 data 缺失"归并为同一失败语义。
      registryState.value = 'error';
      registry.value = [];
    }
  }

  // 载体动作能力：按 scope.pluginId 命中已安装插件，取其 manifest 声明的 supportedTriggers。
  // 与全量锚点求交集 → 设计器只展示载体真正支持的事件。任何缺失/失败均回退默认全量（不破现状）。
  // hostApi.getSupportedTriggers 只负责拉取原始声明清单（宿主读取插件元数据），
  // 与 SELECTABLE_TRIGGER_EVENT_KEYS 的交集运算留在本函数（插件本地常量，不下放宿主）。
  async function loadSupportedTriggers(generation: number): Promise<void> {
    // job 模式固定单一 scheduled 事件（画布不提供「＋事件」，见 ActionDesigner.vue），
    // 无载体插件上下文可拉取声明，跳过（supportedTriggers 维持默认值，不影响 job 模式——
    // 该列表只驱动 template 模式的「＋事件」下拉）。
    if (options.kind === 'job') return;
    const pluginId = options.scope.pluginId;
    if (!pluginId) return; // 无载体上下文：保持默认全量（defaultSupportedTriggers()）
    try {
      const declared = await options.hostApi.getSupportedTriggers(pluginId);
      if (!canCommitAuthority(generation)) return;
      if (Array.isArray(declared) && declared.length > 0) {
        const allowed = new Set(declared);
        // 载体老键兼容——manifest 若仍声明老键 before-save/after-save（未及时跟进新
        // 四档声明，装机顺序错位的存量现状），视同声明了对应方向的两档新键，避免保存类事件整组从
        // 「＋事件」下拉消失。handle-time 不做任何映射，必须显式声明（与旧键无对应关系）。
        if (allowed.has('before-save')) {
          allowed.add('create-before-save');
          allowed.add('edit-before-save');
        }
        if (allowed.has('after-save')) {
          allowed.add('create-after-save');
          allowed.add('edit-after-save');
        }
        // 改用 SELECTABLE 版求交——老保存键本身仍不会经交集漏回可选事件集，只保留读兼容。
        const intersection = SELECTABLE_TRIGGER_EVENT_KEYS.filter(k => allowed.has(k));
        // 仅当交集非空才采用，避免声明值与平台枚举完全错位时把下拉清空。
        if (intersection.length > 0) {
          // 记录页事件与载体声明无关（见 RECORD_PAGE_EVENT_KEYS 注释），交集运算天然
          // 会把它们排除在外（载体 manifest 目前不会声明这两个 key）——故交集之后恒并入，不受
          // 载体声明是否覆盖影响。走到这里已确定是模板模式（job 模式已在函数入口早退），故无需
          // 再判一次 designerMode。
          supportedTriggers.value = Array.from(new Set([...intersection, ...RECORD_PAGE_EVENT_KEYS]));
        }
      }
    } catch {
      // 拉取失败静默回退默认全量，不阻断设计器加载。
    }
  }

  /** 模板模式文档加载（原 load() 内联逻辑抽出，语义逐字不变）。 */
  async function loadTemplateDocumentInto(scope: ActionDesignerScope, generation: number): Promise<void> {
    // 动作行为文档独立存储：从专属端点读取（与表格设计 design_file 完全解耦）。
    const opened = await options.hostApi.openActionDocument(scope);
    const doc = opened.data;
    if (!doc) {
      throw new Error(opened.error?.message ?? $t('actionDesigner.errors.openDocFailed'));
    }
    if (!canCommitAuthority(generation)) return;
    actionVersionBaseline = doc.version_no ?? 0;
    // 随文档一并落地本次读取到的跨应用来源无权限清单（数组恒存在，缺省空数组防旧夹具/离线响应）。
    unauthorizedSourceApps.value = Array.isArray(doc.unauthorized_source_apps) ? doc.unauthorized_source_apps : [];
    const rawActions = (doc.actions ?? undefined) as ActionBehaviorDocument | undefined;
    const actions = rawActions ? normalizeActionTargetRoles(rawActions, scope.templateId, tables.value) : undefined;
    currentActions = actions;
    if (actions && Array.isArray(actions.trigger_bindings) && actions.trigger_bindings.length > 0) {
      events.value = openBundleToTrees(actions);
    } else {
      // 空白起步：无已保存事件时保持空，画布显示空态、引导用户新增事件。
      events.value = [];
    }
  }

  /**
   * job 模式文档加载：任务级动作文档接口不带
   * template_id/unauthorized_source_apps（见 hostTypes.JobActionDocumentWire），故不做
   * normalizeActionTargetRoles 补齐（job 文档每条 target 自带显式 target_template_id，
   * 无"当前模板"概念）、unauthorizedSourceApps 恒空数组。
   * 首次打开/空文档时自动 seed 一个固定的 scheduled 触发根——与模板模式"空白起步不自动种事件"
   * 相反：job 只有一种事件语义，无需用户手动新增，直接给出可用画布。
   */
  async function loadJobDocumentInto(
    target: { appId: string; jobId: string },
    generation: number
  ): Promise<void> {
    const opened = await options.hostApi.openJobActionDocument(target.appId, target.jobId);
    const doc = opened.data;
    if (!doc) {
      throw new Error(opened.error?.message ?? $t('actionDesigner.errors.openDocFailed'));
    }
    if (!canCommitAuthority(generation)) return;
    actionVersionBaseline = doc.version_no ?? 0;
    unauthorizedSourceApps.value = [];
    const rawActions = (doc.actions ?? undefined) as ActionBehaviorDocument | undefined;
    currentActions = rawActions;
    if (rawActions && Array.isArray(rawActions.trigger_bindings) && rawActions.trigger_bindings.length > 0) {
      events.value = openBundleToTrees(rawActions);
    } else {
      events.value = [createTriggerRoot({ eventKey: 'scheduled', scopes: ['form'] })];
    }
  }

  async function load(): Promise<void> {
    const generation = ++authorityGeneration;
    loading.value = true;
    errorText.value = '';
    try {
      // job 模式下 loadFields/loadSupportedTriggers 内部已早退（无模板字段目录/载体触发声明可拉），
      // 仍统一并发发起以保持两种模式同一形状，早退开销可忽略。
      await Promise.all([
        loadRegistry(generation),
        loadFields(generation),
        loadSupportedTriggers(generation),
        loadApps(generation),
        loadEditorCapabilities(generation)
      ]);
      if (!canCommitAuthority(generation)) return;
      if (options.kind === 'job') {
        await loadJobDocumentInto(options, generation);
      } else {
        await loadTemplateDocumentInto(options.scope, generation);
      }
      if (!canCommitAuthority(generation)) return;
      activeEventId.value = events.value[0]?.id ?? '';
      selectNode(activeRoot.value?.id ?? null);
      dirty.value = false;
      dirtyEventIds.value = new Set();
    } catch (error) {
      if (canCommitAuthority(generation)) {
        errorText.value = error instanceof Error ? error.message : $t('actionDesigner.errors.loadFailed');
      }
    } finally {
      if (generation === authorityGeneration) loading.value = false;
    }
  }

  // ── 单事件保存：把当前事件合并进设计文档（其他事件保留磁盘原样） ──

  /**
   * 某 root 的 bindingId 在文档中实际覆盖的全部 binding id：一个 root 可能拆产多条 binding
   * （基名本身 + `${基名}__<event>` 后缀形式，见 compile.ts 的 binding_id 稳定性规则），
   * 故按「等于基名 或 以 `${基名}__` 开头」匹配，而非单条精确匹配。
   */
  function bindingIdsForRoot(doc: ActionBehaviorDocument, baseBindingId: string): Set<string> {
    const ids = new Set<string>();
    for (const b of doc.trigger_bindings ?? []) {
      if (b.binding_id === baseBindingId || b.binding_id.startsWith(`${baseBindingId}__`)) ids.add(b.binding_id);
    }
    return ids;
  }

  /**
   * id 是否落在某 root 的**命名空间**内：组恒为 `${基名}_g<数字>`、guard 恒为 `${基名}_gd<数字>`
   * （见 compile.ts 的 emitGroup / pushGuard）。用于清扫「没有任何 binding 指向、可达遍历够不着」
   * 的残留实体。不用前缀正则是为了避免转义问题；`_gd1` 的后缀 'd1' 非纯数字，故组判据不会误吞 guard。
   */
  function isRootNamespacedId(id: string, baseBindingId: string, infix: '_g' | '_gd'): boolean {
    const prefix = `${baseBindingId}${infix}`;
    if (!id.startsWith(prefix)) return false;
    const suffix = id.slice(prefix.length);
    return suffix.length > 0 && /^\d+$/.test(suffix);
  }

  /** 从设计文档移除某 root（按其 bindingId 基名，覆盖其名下全部 binding）及其专属可达实体（group/node/guard，含 children/续接组），返回新文档（不改原对象）。 */
  function removeRootFromDoc(doc: ActionBehaviorDocument, baseBindingId: string): ActionBehaviorDocument {
    const bindingIds = bindingIdsForRoot(doc, baseBindingId);
    const groupById = new Map((doc.action_groups ?? []).map(g => [g.group_id, g] as const));
    const nodeById = new Map((doc.action_nodes ?? []).map(n => [n.node_id, n] as const));
    const groupIds = new Set<string>();
    const nodeIds = new Set<string>();
    const guardIds = new Set<string>();
    const visitNode = (nid: string): void => {
      if (nodeIds.has(nid)) return;
      const n = nodeById.get(nid);
      if (!n) return;
      nodeIds.add(nid);
      if (n.node_guard_id) guardIds.add(n.node_guard_id);
      for (const c of n.children_node_ids ?? []) visitNode(c);
      for (const cg of n.continuation_group_ids ?? []) visitGroup(cg);
      // 出口分支（x-outcomes）通过 outcome_continuation_group_ids 挂接子组；旧实现只遍历普通
      // continuation_group_ids，会把这些出口组和其节点遗留在 base 文档中。随后当前事件重新编译
      // 又追加同 ID 实体，保存请求就因 group/node 重复被后端判 DESIGN_FILE_INVALID。
      for (const outcomeGroupIds of Object.values(n.outcome_continuation_group_ids ?? {})) {
        for (const outcomeGroupId of outcomeGroupIds) visitGroup(outcomeGroupId);
      }
    };
    const visitGroup = (gid: string): void => {
      if (groupIds.has(gid)) return;
      const g = groupById.get(gid);
      if (!g) return;
      groupIds.add(gid);
      if (g.group_guard_id) guardIds.add(g.group_guard_id);
      for (const nid of g.ordered_node_ids) visitNode(nid);
    };
    // 该 root 名下所有 binding 共享同一批组（compile.ts 只 walkBand 一次），visitGroup 内部已去重，
    // 逐条 binding 遍历其 ordered_group_ids 是幂等的（不会重复处理）。
    for (const binding of doc.trigger_bindings ?? []) {
      if (!bindingIds.has(binding.binding_id)) continue;
      for (const gid of binding.ordered_group_ids ?? []) visitGroup(gid);
    }
    // 🔴 孤儿清扫（与上面的可达遍历互补，不能互相替代）：
    // 上面那轮从 binding 出发，只够得着「有 binding 指向」的实体。历史上 compile.ts 会在
    // 「value-change/field-click 尚未选触发字段」时产出组/节点却不产 binding（已在 compile.ts 侧
    // 治本），这批实体没有遍历起点，旧实现又在 bindingIds 为空时直接 return doc，于是它们永远删
    // 不掉；下次保存追加同名组/同 id 节点，后端就判 duplicate group_id / node_id 整份 400，此后
    // 该事件再也存不进去。故这里改按命名空间前缀兜底清扫——**存量文档里的孤儿也一并带走**。
    // 组/guard 的 id 天然带 root 命名空间，节点 id 不带（用 MindNode id），所以节点只能由
    // visitGroup 从孤儿组的 ordered_node_ids 递归收集。
    for (const group of doc.action_groups ?? []) {
      if (isRootNamespacedId(group.group_id, baseBindingId, '_g')) visitGroup(group.group_id);
    }
    for (const guard of doc.guards ?? []) {
      if (isRootNamespacedId(guard.guard_id, baseBindingId, '_gd')) guardIds.add(guard.guard_id);
    }
    // 文档级 conditions 池随 guard 一起摘——只摘「被摘 guard 的 path 引用、且剩余 guard
    // 不再引用」的条件；条件 ID 天然按节点唯一，跨 root 共用理论上不存在，仍按引用计数防御。
    // 若把池整个丢掉 ⇒ 后端「path 引用的条件不在池内」⇒ 整份文档报「设计文件格式错误」。
    const keptGuards = (doc.guards ?? []).filter(g => !guardIds.has(g.guard_id));
    const keptConditionIds = new Set(keptGuards.flatMap(g => (g.path ?? []).map(step => step.condition_id)));
    const removedConditionIds = new Set(
      (doc.guards ?? [])
        .filter(g => guardIds.has(g.guard_id))
        .flatMap(g => (g.path ?? []).map(step => step.condition_id))
        .filter(id => !keptConditionIds.has(id))
    );
    const conditions = (doc.conditions ?? []).filter(c => !removedConditionIds.has(c.condition_id));
    return {
      trigger_bindings: (doc.trigger_bindings ?? []).filter(b => !bindingIds.has(b.binding_id)),
      action_groups: (doc.action_groups ?? []).filter(g => !groupIds.has(g.group_id)),
      action_nodes: (doc.action_nodes ?? []).filter(n => !nodeIds.has(n.node_id)),
      guards: keptGuards,
      // 无条件时不带该键（与后端 omitempty / compile.ts 产出口径一致，避免旧文档多出一个空数组）。
      ...(conditions.length > 0 ? { conditions } : {})
    };
  }

  /**
   * 追加合并，同 id 以 next（本次编译产物）为准：base 里 id 撞车的条目被丢弃而不是并存。
   * 这是最后一道防线——后端对 duplicate binding_id / group_id / node_id / guard_id 一律整份
   * 拒绝保存（DESIGN_FILE_INVALID），一条重复就能让同模板下所有已配好的动作跟着存不进去。
   * 正常路径下 removeRootFromDoc 已经把旧实体摘干净，这里恒为空转；它兜的是「摘除判据将来又
   * 漏了某条挂接边」这类回归，代价只有一次 Set 构造。
   */
  function concatById<T>(base: T[] | undefined, next: T[] | undefined, idOf: (item: T) => string): T[] {
    const nextItems = next ?? [];
    const nextIds = new Set(nextItems.map(idOf));
    return [...(base ?? []).filter(item => !nextIds.has(idOf(item))), ...nextItems];
  }

  /**
   * 把单事件（root）编译产物（mini，可能含多条 binding）合并进设计文档：
   * 先按 rootBindingId（基名）移除该 root 旧名下的全部 binding + 专属实体，再追加新实体
   * （命名空间化 id 不冲突）。
   */
  function mergeEventIntoDoc(
    prev: ActionBehaviorDocument | undefined,
    rootBindingId: string,
    mini: ActionBehaviorDocument
  ): ActionBehaviorDocument {
    const base = prev && Array.isArray(prev.trigger_bindings) ? removeRootFromDoc(prev, rootBindingId) : prev ?? emptyBehaviorDocument();
    const mergedConditions = concatById(base.conditions, mini.conditions, c => c.condition_id);
    return {
      trigger_bindings: concatById(base.trigger_bindings, mini.trigger_bindings, b => b.binding_id),
      action_groups: concatById(base.action_groups, mini.action_groups, g => g.group_id),
      action_nodes: concatById(base.action_nodes, mini.action_nodes, n => n.node_id),
      guards: concatById(base.guards, mini.guards, g => g.guard_id),
      // conditions 池同样按 condition_id 追加合并（本次编译产物优先），空则不带该键。
      ...(mergedConditions.length > 0 ? { conditions: mergedConditions } : {})
    };
  }

  /**
   * 保存失败定位：后端错误带 node_id 时，切到该节点所在的动作事件并选中它，
   * 供 ActionDesigner.vue 在画布上居中聚焦（saveErrorNodeId）。节点不在任何已加载事件里（如存量文档中
   * 未打开的节点）时只展示错误文案、不改选中。
   */
  function locateSaveErrorNode(nodeId: string | undefined): void {
    if (!nodeId) return;
    for (const event of events.value) {
      const found = event.id === nodeId || !!locate(event.children ?? [], nodeId, event.id);
      if (!found) continue;
      if (activeEventId.value !== event.id) activeEventId.value = event.id;
      selectNode(nodeId);
      saveErrorNodeId.value = nodeId;
      return;
    }
  }

  /** 持久化动作行为文档（独立存储端点），成功后更新内存当前文档与版本基线。
   *  job 模式改走任务级动作文档端点，其余乐观锁/异常处理逻辑与模板模式完全一致。 */
  async function persistDoc(actions: ActionBehaviorDocument): Promise<boolean> {
    const generation = authorityGeneration;
    if (!canCommitAuthority(generation)) return false;
    saving.value = true;
    errorText.value = '';
    saveErrorNodeId.value = null;
    try {
      const { data, error } =
        options.kind === 'job'
          ? await options.hostApi.saveJobActionDocument(options.appId, options.jobId, {
              actions,
              expectedVersionNo: actionVersionBaseline
            })
          : await options.hostApi.saveActionDocument(options.scope, {
              actions,
              expectedVersionNo: actionVersionBaseline
            });
      if (error || !data) {
        // 保存闸错误（如 DATA_ACTION_KIND_UNRESOLVED）直接展示后端按请求语言
        // 渲染好的 message，并按 params.node_id 定位到出错节点。
        const hostError = readHostError(error);
        if (canCommitAuthority(generation)) locateSaveErrorNode(hostError.nodeId);
        throw new Error(hostError.message || $t('actionDesigner.canvas.saveFailed'));
      }
      if (!canCommitAuthority(generation)) return false;
      currentActions = actions;
      actionVersionBaseline = data.version_no ?? actionVersionBaseline;
      return true;
    } catch (error) {
      if (canCommitAuthority(generation)) {
        errorText.value = error instanceof Error ? error.message : $t('actionDesigner.canvas.saveFailed');
      }
      return false;
    } finally {
      if (generation === authorityGeneration) saving.value = false;
    }
  }

  /** 保存当前动作事件：仅把当前事件合并进行为文档，其他事件保留原样。seq 按该事件在列表中的下标写入（画布顺序）。 */
  async function saveActiveEvent(): Promise<boolean> {
    const active = activeRoot.value;
    if (!active) return false; // 空白态无事件可保存
    const index = events.value.findIndex(e => e.id === active.id);
    // 写节点强制同步按动作目录的数据动作种类识别（第三方与官方同口径）；
    // 目录里查不到该动作时 resolveOperationKind 回落官方兼容表。
    const mini = compileEventsToBundle([active], {
      seqStart: Math.max(index, 0) + 1,
      operationKindOf: name => resolveOperationKind(name, name ? registryByName.value.get(name) : undefined)
    });
    // 回落写法必须与 compile.ts 的 `root.bindingId ?? \`tb_${root.id}\`` 逐字一致：少一个 `tb_`
    // 前缀会让 bindingIdsForRoot 匹配不到任何 binding，摘除整体落空、重复实体照旧追加。
    const ok = await persistDoc(mergeEventIntoDoc(currentActions, active.bindingId ?? `tb_${active.id}`, mini));
    if (ok) {
      const next = new Set(dirtyEventIds.value);
      next.delete(active.id);
      dirtyEventIds.value = next;
      dirty.value = next.size > 0;
    }
    return ok;
  }

  /**
   * lost/conflicted/closed 时终止所有在途回填，但保留已加载内容供人工只读查看。
   * 代际推进后，即使旧 Promise 稍后成功，也不能再改写画布或保存基线。
   */
  function invalidateAsyncBackfill(): void {
    authorityGeneration += 1;
    loading.value = false;
    saving.value = false;
  }

  /**
   * auth_ended 的敏感内存清理。与 lost 的“保留只读内容”不同，这里不恢复任何历史快照，
   * 而是清空动作文档、目录、字段、权限清单和错误文本，再由外层发布终态提示。
   */
  function scrubSensitiveState(): void {
    invalidateAsyncBackfill();
    currentActions = undefined;
    actionVersionBaseline = 0;
    events.value = [];
    activeEventId.value = '';
    selectedId.value = null;
    registry.value = [];
    registryState.value = 'ok';
    // 复用与初值同一条 job/模板判据（defaultSupportedTriggers），而非裸写全量——
    // 否则 job 模式在 auth_ended 之后会短暂"错误地"把记录页事件重新纳入 supportedTriggers
    // （现状因 ActionDesigner.vue 的 addEventOptions 有独立 job 早退兜底而不外显，但状态本身
    // 应保持自洽，不依赖消费端的双重防御）。
    supportedTriggers.value = defaultSupportedTriggers();
    tables.value = [];
    fieldsByTable.value = {};
    apps.value = [];
    workflowStepCatalog.value = null;
    workflowStepCatalogLoading = null;
    unauthorizedSourceApps.value = [];
    dirty.value = false;
    dirtyEventIds.value = new Set();
    errorText.value = '';
    saveErrorNodeId.value = null;
  }

  return {
    root,
    events,
    activeEventId,
    activeRoot,
    setActiveEvent,
    addEvent,
    removeEvent,
    moveEvent,
    moveEventTo,
    renameEvent,
    toggleEventEnabled,
    selectedId,
    selectedNode,
    registry,
    registryState,
    registryByName,
    // 模板绑定编辑器能力 + 动作是否被当前编辑器支持。
    editorCapabilities,
    actionEditorUnsupported,
    outcomesOf,
    stagingProducerOf,
    supportedTriggers,
    tables,
    fieldsByTable,
    allFields,
    guardFields,
    fieldGroups,
    fieldName,
    tableName,
    // 跨应用来源的可读应用名解析口 + 当前设计所在应用 ID，供画布节点指向
    // 详情（NodeDetailPopover 经 labels.ts crossAppPrefix）展示「应用名 › 名称」。
    appName,
    currentAppId,
    // 流程步骤目录（画布触发根徽标失效判定 + 设计期校验共用）+ 惰性加载入口。
    workflowStepCatalog,
    ensureWorkflowStepCatalog,
    // 跨应用来源无设计权限清单，供 NodeConfigDialog 判定表达式编辑器是否只读打开。
    unauthorizedSourceApps,
    loading,
    saving,
    errorText,
    // 最近一次保存失败定位到的节点（无则 null），供画布聚焦。
    saveErrorNodeId,
    dirty,
    dirtyEventIds,
    activeDirty,
    selectNode,
    addAction,
    addCondition,
    applyDrop,
    dragSource,
    setDragSource,
    deleteSelected,
    updateSelected,
    updateSelectedCondition,
    setTriggerRoot,
    load,
    saveActiveEvent,
    invalidateAsyncBackfill,
    scrubSensitiveState
  };
}

export type ActionDesignerController = ReturnType<typeof useActionDesigner>;
