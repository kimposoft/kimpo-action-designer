/**
 * 动作设计器画布 —— 前端工作态数据模型（MindNode 树）。
 *
 * 这是「思维导图式画布」的内存模型，与 ActionBehaviorDocument 一一映射（见 compile.ts）。
 * 设计纪律：
 * - 节点 payload 只存稳定 ID（field_id / data_table_id / action_name），绝不存字段名/物理列/样式。
 * - 坐标与折叠态是非权威 uiHints，绝不进 bundle；打开时由布局 walker 从模型树重建。
 * - 一个「band（动作组泳道）」= 某容器（触发根 / 条件的 then 口 / 条件的 else 口）的 children 数组：
 *   一串顺序执行的成员，可在任意位置穿插任意数量的条件节点；每个条件经 then/else 向右分叉为两个子
 *   band，分支「成立/不成立二选一执行后汇合」，其后的成员继续顺序执行（可再遇下一个条件再次分叉）。
 */

/**
 * 16 类触发事件锚点（scheduled：宿主定时任务触发，服务端 headless 派发；
 * before-delete/after-delete：记录页删除动作派发的记录页事件，见 RECORD_PAGE_EVENT_KEYS；
 * handle-time / create-before-save / create-after-save / edit-before-save / edit-after-save：
 * 旧 before-save/after-save 不区分新建/编辑两态，细分后可分别对新建单据、
 * 修改单据独立配置动作。旧两键**保留在类型联合里**（读兼容——存量文档/交互按钮引用不因改动而失效），
 * 但从「用户可选事件集」退役，见下方 LEGACY_SAVE_EVENT_KEYS / SELECTABLE_TRIGGER_EVENT_KEYS。
 */
import type { ConditionGroup, TextSource, V4ExpressionDocument } from '@kimposoft/expression-editor';
export type ActionTriggerEventKey =
  | 'create-time'
  | 'edit-time'
  | 'view-time'
  | 'before-save'
  | 'after-save'
  | 'value-change'
  | 'field-click'
  | 'manual'
  | 'scheduled'
  | 'before-delete'
  | 'after-delete'
  | 'handle-time'
  | 'create-before-save'
  | 'create-after-save'
  | 'edit-before-save'
  | 'edit-after-save';

export const ACTION_TRIGGER_EVENT_KEYS: readonly ActionTriggerEventKey[] = [
  'create-time',
  'edit-time',
  'view-time',
  'before-save',
  'after-save',
  'value-change',
  'field-click',
  'manual',
  'scheduled',
  'before-delete',
  'after-delete',
  'handle-time',
  'create-before-save',
  'create-after-save',
  'edit-before-save',
  'edit-after-save'
];

/**
 * 老保存键：`before-save`/`after-save` 已被细分的新建/编辑四档取代，只保留「读兼容」——
 * 旧文档打开经 compile.ts openBundleToTrees 自动迁移为两档（并置 legacySaveMigrated 提示），
 * 新配置一律不再产出老键。本集合仅供 SELECTABLE_TRIGGER_EVENT_KEYS 排除计算使用。
 */
export const LEGACY_SAVE_EVENT_KEYS: readonly ActionTriggerEventKey[] = ['before-save', 'after-save'];

/**
 * 用户可选事件集合：ACTION_TRIGGER_EVENT_KEYS 去掉老保存键。凡是「决定用户在菜单/
 * 下拉里能选什么」的地方（事件菜单 eventMenu.ts、载体 supportedTriggers 求交等）一律改用本集合，
 * 不再直接用 ACTION_TRIGGER_EVENT_KEYS——后者仍是「类型联合的全量真值表」，用于读兼容/类型穷尽检查。
 */
export const SELECTABLE_TRIGGER_EVENT_KEYS: readonly ActionTriggerEventKey[] = ACTION_TRIGGER_EVENT_KEYS.filter(
  key => !LEGACY_SAVE_EVENT_KEYS.includes(key)
);

/**
 * 「可阻断」事件：新建/编辑保存前 + 删除前——失败可阻断对应操作（保存前=阻断保存，
 * 删除前=阻断删除）。本常量只提供判定口径，弹窗/画布的"可阻断"开关由消费方（另一张卡）读取使用。
 */
export const BLOCKABLE_EVENT_KEYS: readonly ActionTriggerEventKey[] = ['create-before-save', 'edit-before-save', 'before-delete'];

/**
 * 记录页事件：宿主记录页删除动作派发（before 可阻断 → 409 中止删除；after 为
 * 删除完成后的通知钩子），与具体渲染载体（sheet / 其它设计态插件）无关——删除动作作用于记录
 * 本身，不依赖哪个插件在渲染这条记录，故设计器里恒作"载体无关并集项"处理：
 * - 不需要载体 manifest 声明 supportedTriggers 即可用（哪怕 sheet manifest 暂未声明它俩）；
 * - 仅模板模式（非 job）适用——job（定时任务）没有"记录删除"语义，不产出这两个事件。
 * 消费点：useActionDesigner.ts 的 supportedTriggers 默认值/交集结果并入此集合；
 * NodeConfigDialog.vue 的 eventOptions 按 designerMode 反向于 scheduled 过滤此集合。
 */
export const RECORD_PAGE_EVENT_KEYS: readonly ActionTriggerEventKey[] = ['before-delete', 'after-delete'];

export type MindNodeKind = 'trigger-root' | 'action' | 'condition';

/**
 * 流程步骤门单步：定位到某流程定义的某一步骤节点，到达方式两档
 * （'submitted'=正向提交到达 / 'returned'=被回退到达；引擎侧的三档到达方式——正向/回退/撤销——
 * 撤销并入回退档，由宿主账本推导，本层不关心具体路径，只认这两档标签）。
 */
export interface WorkflowGateStep {
  /** 流程定义 id（稳定引用）。 */
  definitionId: string;
  /** 步骤节点 id（同一定义下的具体步骤，稳定引用）。 */
  nodeId: string;
  /** 展示用快照（非权威，弹窗回落展示用，定义/节点改名后可能过期，仅供兜底显示）。 */
  definitionName?: string;
  nodeName?: string;
  /**
   * 到达方式：内存态恒显式两档全写（'submitted' + 'returned'，缺省语义=两档都要）；
   * 编译时两档全选省略该键，单档才写出（见 compile.ts buildWorkflowGate）。
   */
  arrivals: ('submitted' | 'returned')[];
}

/** Guard 支持的比较操作符（对齐 actionquery 后端 guard 文法：无 NOT，取反靠操作符反转）。 */
export type ComparisonOperator = '=' | '!=' | '>' | '>=' | '<' | '<=';

export const COMPARISON_OPERATORS: readonly ComparisonOperator[] = ['=', '!=', '>', '>=', '<', '<='];

/** 单条简化条件：仅引用本表字段（稳定 field_id）+ 操作符 + 字面量。 */
export interface SimpleCondition {
  fieldId: string;
  op: ComparisonOperator;
  value: string | number | boolean;
}

/**
 * 条件节点 guard 双判断模式：
 * - 'guided'：引导式单层且/或——一组 SimpleCondition，组内统一用 AND 或 OR 连接（不支持混用/嵌套）。
 * - 'expression'：原始表达式串（KimpoSQL guard 文法子集：{{field:x}} 比较符 字面量 + AND/OR + 括号，
 *   不支持函数/参数/LIKE/IN/NULL 判定），由用户直接编写，编译时原样透传（trim 后）。
 * 两种模式互斥，以 mode 为准；guided/expression 字段按 mode 只填其一。
 */
export type GuardLogic = 'and' | 'or';

/** 引导式条件分组：单层——items 内统一按 logic 连接（AND 或 OR），不支持跨组嵌套。 */
export interface GuardConditionGroup {
  logic: GuardLogic;
  /** 至少 1 条（UI 强制），编译侧对 0 条防御性地视为「无条件」。 */
  items: SimpleCondition[];
}

/**
 * 条件节点 V4 判断表达式的发布物身份：
 * 后端保存时按 extract_v4 同款冻结产出、钉回条件条目的 `plan`；**前端只做原样透传**
 * （反编译带回来、编译原样写出去），绝不自行改写或补算——身份由后端持有。
 */
export interface ConditionV4Plan {
  publication_id: string;
  definition_id: string;
}

/**
 * 条件节点的 V4 判断表达式。
 *
 * 为什么存整份 V4 表达式文档而不是只存可读 sidecar：sidecar（TextSource）的 refs 只有
 * `{stable_id,label}`，重开编辑器会丢掉 V4 的绑定（source_instance_id / table_id / field_id），
 * 字段改名后无法重绘。故这里持久化 token 化 `source_text` + `refs` + `normalized_digest` 整份文档，
 * 可读原文另经宿主 restore 端点取回，只作展示（readableText）。
 *
 * 与 guided/group 旧形态的关系：**v4 存在时它就是权威**，旧字段一律不再参与编译
 * （旧条件不再兼容处理，旧节点在配置页/画布提示重新配置）。
 */
export interface ConditionV4Spec {
  /** 条件节点稳定 ID：`cond_<8位十六进制>`，节点创建时分配一次，改表达式不变（guard.path 按它引用条件池）。 */
  conditionId: string;
  /** 路径步的「不成立」侧标记：只由 invertGuardSpec 置位，表达式本身不变（后端按 negate 取反求值）。 */
  negate?: boolean;
  /** 整份 V4 表达式文档（expression_id 恒等于 conditionId，purpose 恒为 'condition'）。 */
  expression: V4ExpressionDocument;
  /** 展示用可读原文（由配置页经宿主 restore 端点填），可空——空时摘要回落 source_text。 */
  readableText?: string;
  /** 后端钉入的发布物身份，反编译原样带回、编译原样透传（前端不改写）。 */
  plan?: ConditionV4Plan;
}

/** 条件节点的双模式 guard；condition 字段仍保留作 guided 单条时的兼容镜像（见 createConditionNode）。 */
export interface ConditionNodeGuard {
  mode: 'guided' | 'expression';
  /** mode='guided' 时权威。历史形态（单层且/或 + 字面量右值），见 group 注释。 */
  guided?: GuardConditionGroup;
  /** mode='expression' 时权威（原始 KimpoSQL guard 串）。历史形态，见 group 注释。 */
  expression?: string;
  /**
   * V3.4 结构化条件：**存在时它就是权威**，两个 mode 共用同一个载体
   * （mode 只决定用哪种界面编辑它——引导式条件树 / 表达式面板，不再决定数据形态）。
   *
   * 为什么是「并存」而不是「替换」：guard 的持久化形态是动作文档里的 guards[] 条目，编译/反编译
   * 两条路径都很长（组级 guard 是整条条件路径的 AND 链，then/else 还要靠可重算的规范串配对）。
   * 结构化走一条独立的新路径，旧的 guided/expression 原样不动——既让新界面立刻拿到全部表达力
   * （NOT/形如/属于/为空 + 任意嵌套，见后端 guardevaluate.CompileGroup），又不必一次性重写既有
   * 编译链与其上几百条断言。旧文档打开后仍按旧形态编辑，新配的条件一律落结构化。
   */
  group?: ConditionGroup;
  /**
   * 表达式模式的文本 sidecar（宿主 lower-text 端点降级时一并产出）：重开编辑器时按原文恢复文本，
   * 字段改名靠其中的稳定 ID 重绘。只原样存取，前端不自行计算 digest。
   */
  textSource?: TextSource | null;
  /**
   * V4 判断表达式：**存在时它就是唯一权威**，优先于 group / guided / expression
   * 三种旧形态（mode 恒填 'expression'，只为兼容仍按 mode 分派界面的旧读点，不再决定数据形态）。
   * 编译产物是文档级 conditions 池 + guard.path 引用，见 compile.ts pushGuardPath。
   */
  v4?: ConditionV4Spec;
}

export interface MindNode {
  id: string;
  kind: MindNodeKind;

  // ── trigger-root ──
  /** 首个触发事件（兼容读点/展示回落）；权威集合见 eventKeys，二者保持 eventKey===eventKeys[0]。 */
  eventKey?: ActionTriggerEventKey;
  /** 触发事件集合（多选，至少一个）：任一事件命中即触发本流程。持久化为 binding.trigger_event_keys。 */
  eventKeys?: ActionTriggerEventKey[];
  /**
   * 'form' | `field:${fieldId}`（旧单值触发范围字段）。已降级为「编译派生结果 + 旧文档回读
   * 兼容」的展示字段——compile 不再以它为 value-change/field-click 的权威来源，权威改为 eventFieldIds。
   */
  scope?: string;
  /**
   * 触发范围集合（旧多选字段，元素为 'form' 或 `field:${fieldId}`）。同 scope 一样降级为
   * 展示/回读兼容字段；value-change/field-click 的编译权威来源改为 eventFieldIds（见下）。
   */
  scopes?: string[];
  /**
   * 触发字段分事件独立集合：仅 value-change / field-click 两键有意义，值为该事件
   * 下勾选的字段 id 数组（不带 'field:' 前缀）；同一触发根下两个事件各持独立字段集，互不共享。
   * 语义：某事件未在此登记字段（缺省或空数组）= 该事件不产出触发绑定（不触发）——'form' 整表单
   * 兜底已废除。生命周期事件（create-time 等）不使用此字段，编译时恒 scopes=['form']。
   */
  eventFieldIds?: Partial<Record<ActionTriggerEventKey, string[]>>;
  /**
   * 旧文档回读迁移提示标记（仅内存态展示用，绝不进 bundle）：openBundleToTrees 若发现某
   * value-change/field-click 事件是从旧「共享 scopes=['form']」文档迁移而来、字段集合为空，会把
   * 该事件登记到这里，供 NodeConfigDialog 打开时提示「需补选字段，否则保存后不再触发」。
   * 不据此自动删除事件、不静默丢弃——只是提示，是否处理由设计者自行判断。
   */
  needsFieldSelection?: ActionTriggerEventKey[];
  /** before-save 可标记可阻断 */
  blockable?: boolean;
  /** 动作事件的稳定身份：作为 bundle 的 binding_id 持久化、跨保存/加载不变（多个同类型事件靠它区分）。 */
  bindingId?: string;
  /** 动作事件的自定义名称（持久化进 binding.name）；为空时显示回落到事件类型名。 */
  name?: string;
  /**
   * 定时排期（仅 eventKeys 含 'scheduled' 时有意义）：cron 表达式 + 可选时区 + 启用开关。
   * 持久化为 binding.schedule；compile 侧强制「scheduled 必须有、其它事件不得有」（与宿主后端
   * 动作行为文档校验同一条规则）。enabled=false＝已配置但暂停，发布同步侧
   * 不为其保留运行中的定时任务，文档本身完整保留。
   */
  schedule?: { cron: string; timezone?: string; enabled: boolean };
  /**
   * 流程步骤门（触发根附加门控）：仅在配置了 steps/notStarted 时该根拆出的每条绑定
   * 才会带上同一份 workflow_gate（与 disabled/seq 同规则，见 compile.ts）——表示"仅当命中门内某个
   * 流程步骤（按到达方式）/ 未发起 时才触发"。未配置（undefined）＝无门控，一个字节都不多写。
   */
  workflowGate?: { notStarted: boolean; steps: WorkflowGateStep[] };
  /**
   * 旧保存键迁移提示（仅内存态展示用，绝不进 bundle，定位同 needsFieldSelection）：openBundleToTrees
   * 若发现该根是由旧 before-save/after-save 事件迁移合并而来，会置位供 UI 提示「已按新建/编辑两档
   * 拆分，请确认」。不据此自动做其它处理，只是提示。
   */
  legacySaveMigrated?: boolean;

  // ── action ──
  actionName?: string;
  /** 'builtin' | 'plugin'（来源徽标，来自注册中心定义） */
  source?: string;
  /** 仅引用稳定 ID 的参数 */
  params?: Record<string, unknown>;
  /** 可选的节点级门控（单条简化条件） */
  nodeGuard?: SimpleCondition;
  async?: boolean;
  /**
   * 启用状态（默认启用），**触发根与动作节点共用**。
   * - 动作节点：停用 = 跳过该节点**及其子分支**（子流程/续接不执行），但同级后续节点照常执行；
   *   持久化为 `action_nodes[].disabled`。
   * - 触发根（= 左侧列表一个「动作事件」）：停用 = 该事件的**全部绑定**都不参与触发匹配，表现为
   *   「这个事件不存在」——不报错不提示不执行，绑定了交互按钮的按钮点了也没反应；持久化为
   *   `trigger_bindings[].disabled`（同根拆产的多条绑定同值）。
   * 两者都只写停用态（disabled=true），启用态省略；文档完整保留，重新启用即恢复（切换启停非破坏性）。
   * 注：动作节点的自定义显示名复用上方 `name` 字段（与触发根共用），默认取插件动作显示名、可手动改。
   */
  enabled?: boolean;

  // ── condition ──
  /**
   * 旧单条简化条件（降级为兼容镜像）：guardSpec 为 guided 单条时与之精确同步，供画布 label 等
   * 尚未切换到 guardSpec 的旧消费点兜底读取；guardSpec 为 guided 多条/expression 模式时可能为
   * undefined（无法用单条 SimpleCondition 表达）。新代码一律以 guardSpec 为权威。
   */
  condition?: SimpleCondition;
  /** 条件节点 guard 权威来源（双判断模式）：缺省（旧文档回读兼容）时按 condition 合成 guided 单条镜像。 */
  guardSpec?: ConditionNodeGuard;
  /** 成立分支 band（子节点序列） */
  thenChildren?: MindNode[];
  /** 不成立分支 band（子节点序列） */
  elseChildren?: MindNode[];

  /**
   * 出口分支 band（仅动作节点、且其定义声明了 x-outcomes 时使用）：outcome key（如 "hit"/"miss"）→
   * 该出口命中时的后续 band。与 condition 的 thenChildren/elseChildren 同构（各出口各自一条顺序 band，
   * 可挂任意数量的动作/条件）；与「节点后直接续接条件分支」（children 上挂条件、编译为 continuation_group_ids）
   * 互斥——一个动作节点要么有 outcomeChildren，要么走 children 续接，不共存。
   */
  outcomeChildren?: Record<string, MindNode[]>;

  /** band 顺序序列：trigger-root 直挂的根 band；动作节点不使用（动作是 band 的成员）。 */
  children?: MindNode[];
}

/** 非权威视图态：折叠 + 视口；旁挂、绝不进 bundle。 */
export interface CanvasUiHints {
  collapsed: Record<string, boolean>;
  viewport?: { zoom: number; x: number; y: number };
}

/** 反转一个比较操作符，用于条件 else 分支的 guard 取反（后端 guard 文法无 NOT）。 */
export function invertOperator(op: ComparisonOperator): ComparisonOperator {
  switch (op) {
    case '=':
      return '!=';
    case '!=':
      return '=';
    case '>':
      return '<=';
    case '>=':
      return '<';
    case '<':
      return '>=';
    case '<=':
      return '>';
    default:
      return op;
  }
}

export function invertCondition(condition: SimpleCondition): SimpleCondition {
  return { ...condition, op: invertOperator(condition.op) };
}

/**
 * 反转一个条件节点 guard，用于 else 分支取反：
 * - guided：逐条 invertCondition + 组合逻辑德摩根翻转（AND↔OR），单层即可精确取反；
 * - expression：无 NOT（宿主后端该文法只有 AND/OR/括号/比较符，求值器也只覆盖
 *   And/Or/Comparison/Function 四种谓词，均无 NOT），无法机械取反——调用方须保证仅在
 *   elseChildren 为空时才会用到本函数的 expression 分支返回值（此时返回值不参与实际 guard 拼接，
 *   仅为类型完整性占位，不抛错以免打断编译）。
 */
export function invertGuardSpec(spec: ConditionNodeGuard): ConditionNodeGuard {
  // V4 判断表达式：优先于 group/guided 分支——取反 = 翻转路径步的 negate 标记，
  // 表达式文档本身逐字不动（同一条件在 then/else 两侧共用一份池条目，后端也只求值一次）。
  if (spec.v4) {
    return { ...spec, v4: { ...spec.v4, negate: !spec.v4.negate } };
  }
  // 结构化条件：直接翻转组级 negate——后端把它降成 ir.Not，任意嵌套/任意算子都成立。
  // 这同时解掉了历史限制「表达式模式不支持不成立分支」：那条限制的根因是 KimpoSQL guard 文法没有
  // NOT、无法生成取反串，结构化形态下不再存在。
  if (spec.group) {
    return { ...spec, group: { ...spec.group, negate: !spec.group.negate } };
  }
  if (spec.mode === 'guided') {
    const group = spec.guided ?? { logic: 'and', items: [] };
    return {
      mode: 'guided',
      guided: {
        logic: group.logic === 'or' ? 'and' : 'or',
        items: group.items.map(invertCondition)
      }
    };
  }
  return spec;
}

/**
 * band（容器的 children）是否合法：可含任意数量、任意位置的条件节点与动作节点
 * （每个条件都是一道「成立/不成立二选一执行后汇合再继续」的顺序门控，条件之间/前后均可挂动作）；
 * 唯一约束是 band 内不得直接含触发根。
 */
export function isLegalBand(band: MindNode[] | undefined): boolean {
  if (!band || band.length === 0) return true;
  return band.every(node => node.kind !== 'trigger-root');
}

let nodeSeq = 0;

/** 生成画布节点 id（前端工作态，仅 action 节点的 id 会作为 node_id 进 bundle 并可逆回填）。 */
export function createNodeId(prefix = 'mn'): string {
  nodeSeq += 1;
  return `${prefix}_${nodeSeq.toString(36)}_${Math.floor(performance.now?.() ?? 0).toString(36)}`;
}

/**
 * 生成条件节点稳定 ID：`cond_` + 8 位十六进制随机串。
 *
 * 与 createNodeId 的自增序列不同——conditionId 会作为 `condition_id` 进动作文档、被 guard.path
 * 跨事件引用，必须全局唯一且跨会话不撞号，故用随机而非进程内计数。测试要固定值时直接在
 * guardSpec.v4.conditionId 上显式传入（createConditionNode 只在缺省时才分配）。
 */
export function newConditionId(): string {
  let hex = '';
  for (let i = 0; i < 8; i += 1) hex += Math.floor(Math.random() * 16).toString(16);
  return `cond_${hex}`;
}

export function createTriggerRoot(input: {
  eventKey: ActionTriggerEventKey;
  /** 多触发事件集合；缺省 [eventKey]。首个事件与 eventKey 保持一致。 */
  eventKeys?: ActionTriggerEventKey[];
  scope?: string;
  scopes?: string[];
  /** 触发字段分事件独立集合；缺省空对象（各事件均未选字段，编译时按需跳过）。 */
  eventFieldIds?: Partial<Record<ActionTriggerEventKey, string[]>>;
  blockable?: boolean;
  children?: MindNode[];
  bindingId?: string;
  name?: string;
}): MindNode {
  const eventKeys = input.eventKeys && input.eventKeys.length > 0 ? [...input.eventKeys] : [input.eventKey];
  const scopes = input.scopes && input.scopes.length > 0 ? [...input.scopes] : [input.scope ?? 'form'];
  return {
    id: createNodeId('trigger'),
    kind: 'trigger-root',
    eventKey: eventKeys[0],
    eventKeys,
    scope: scopes[0],
    scopes,
    eventFieldIds: input.eventFieldIds ? { ...input.eventFieldIds } : {},
    blockable: input.blockable,
    // 新建事件即生成稳定 bindingId（持久化为 binding_id，跨保存/加载不变）。
    bindingId: input.bindingId ?? createNodeId('tb'),
    name: input.name,
    children: input.children ?? []
  };
}

export function createActionNode(input: {
  actionName: string;
  source?: string;
  params?: Record<string, unknown>;
  nodeGuard?: SimpleCondition;
  async?: boolean;
  name?: string;
  enabled?: boolean;
  id?: string;
}): MindNode {
  return {
    id: input.id ?? createNodeId('n'),
    kind: 'action',
    actionName: input.actionName,
    source: input.source,
    params: input.params,
    nodeGuard: input.nodeGuard,
    async: input.async,
    name: input.name,
    // 默认启用（未显式传入即视为启用）。
    enabled: input.enabled ?? true
  };
}

export function createConditionNode(input: {
  /** 旧单条简化条件（兼容 API）；缺省 guardSpec 时据此合成 guided 单条镜像。 */
  condition?: SimpleCondition;
  /** 双模式 guard：显式提供时优先于 condition 作为权威来源。 */
  guardSpec?: ConditionNodeGuard;
  thenChildren?: MindNode[];
  elseChildren?: MindNode[];
  id?: string;
}): MindNode {
  let guardSpec: ConditionNodeGuard | undefined =
    input.guardSpec ?? (input.condition ? { mode: 'guided', guided: { logic: 'and', items: [input.condition] } } : undefined);
  // V4 形态的条件节点在**创建时**分配稳定 conditionId（改表达式不重新分配）；
  // 调用方已显式给定（反编译回读、测试注入）时原样沿用，绝不覆盖——覆盖会让 guard.path 的引用断链。
  if (guardSpec?.v4 && !guardSpec.v4.conditionId) {
    guardSpec = { ...guardSpec, v4: { ...guardSpec.v4, conditionId: newConditionId() } };
  }
  // condition 镜像：guardSpec 为 guided 单条时精确同步（供画布 label 等旧消费点兜底读取）；
  // guided 多条 / expression 模式无法用单条 SimpleCondition 表达，回落调用方原始传入值（可能为空）。
  const condition =
    guardSpec?.mode === 'guided' && guardSpec.guided && guardSpec.guided.items.length === 1
      ? guardSpec.guided.items[0]
      : input.condition;
  return {
    id: input.id ?? createNodeId('c'),
    kind: 'condition',
    condition,
    guardSpec,
    thenChildren: input.thenChildren ?? [],
    elseChildren: input.elseChildren ?? []
  };
}
