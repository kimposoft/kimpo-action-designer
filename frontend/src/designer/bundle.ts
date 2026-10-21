/**
 * `ActionBehaviorDocument` 的前端 TS 镜像（snake_case，与宿主后端动作行为文档结构一一对应）。
 * 这是画布编译产物 / 反向打开输入的权威 schema。坐标/折叠态绝不出现在此结构中。
 */

import type { ConditionGroup, V4ExpressionDocument } from '@kimposoft/expression-editor';
import type { ConditionV4Plan } from './model';
export interface BehaviorTriggerBinding {
  binding_id: string;
  /** 动作事件的自定义名称（可选）；为空时前端回落到事件类型名显示。 */
  name?: string;
  /** 旧单事件字段（兼容读/写=首事件）；权威集合见 trigger_event_keys。 */
  trigger_event_key?: string;
  /** 多触发事件集合（任一命中即触发）；空/缺省时读方回落 trigger_event_key。 */
  trigger_event_keys?: string[];
  /** 旧单值触发范围字段（兼容读点）；权威集合见 scopes。新写入不再写此字段。 */
  scope?: string;
  /** 触发范围集合（多选）：元素为 'form' 或 `field:${fieldId}`，任一命中即触发。 */
  scopes?: string[];
  ordered_group_ids: string[];
  /** 动作事件停用标记：true = 该绑定不参与任何触发匹配（生命周期 / 手动按钮 /
   *  值变动 / 点击字段），表现为「该事件不存在」——不报错不提示不执行。同一触发根拆产的多条
   *  绑定同值。启用态**不写此键**（与 seq 同一约束：多写零值会改变宿主规范化字节、破坏校验和）。 */
  disabled?: boolean;
  /**
   * 画布顺序：同一触发下多个动作事件按它执行，1 起连续；
   * 同根拆产的多条 binding 同值。缺省/0 = 旧文档，宿主排序退回 binding_id 字典序。后端 omitempty，
   * 不写 0。
   */
  seq?: number;
  /**
   * 流程步骤门（与宿主后端 workflow_gate 字段逐字对齐）：绑定仅在命中门内某流程定义的
   * 某步骤节点（按到达方式）、或（notStarted=true 时）流程尚未发起，才参与触发匹配。
   * not_started 只在 true 时写（省略=false，规范化字节口径同 disabled/seq）；steps[].arrivals
   * 缺省=两档（submitted+returned）都要，两档都选时省略该键，见 compile.ts buildWorkflowGate。
   */
  workflow_gate?: {
    not_started?: boolean;
    steps: {
      definition_id: string;
      node_id: string;
      definition_name?: string;
      node_name?: string;
      arrivals?: ('submitted' | 'returned')[];
    }[];
  };
}

export interface BehaviorActionGroup {
  group_id: string;
  group_guard_id?: string;
  ordered_node_ids: string[];
}

export interface BehaviorActionNode {
  node_id: string;
  action_name: string;
  source?: string;
  async?: boolean;
  /** 节点自定义显示名（默认取插件动作显示名、可改）；为空时前端回落到动作 title。 */
  name?: string;
  /** 停用标记：仅停用时写 true（启用为默认、省略）。停用节点运行时被跳过但仍保留于文档，可重新启用。 */
  disabled?: boolean;
  node_guard_id?: string;
  params?: Record<string, unknown>;
  /**
   * 子流程：本节点之后顺序执行的纯动作嵌套子节点 id（按序）。子节点同样平铺在 action_nodes 池中，
   * 仅经此字段可达；组的 ordered_node_ids 只含顶层节点。引用图须无环（节点不得是自身后代）。
   */
  children_node_ids?: string[];
  /**
   * 续接组：本节点之后顺序执行的「续接泳道」组 id（按序）——条件分支(成立/不成立 + 汇合)接在动作
   * 后面的表达方式。被引用的组平铺在 action_groups 池中、各自带 guard。一个节点要么用 children_node_ids
   * (纯动作子流程)、要么用 continuation_group_ids(含分支的续接)。
   */
  continuation_group_ids?: string[];
  /**
   * 出口分支续接组（与后端 `OutcomeContinuationGroupIDs` json tag 一致）：outcome（如 "hit"/"miss"）→
   * 该出口命中时的续接组 id 列表（按序）。与 continuation_group_ids 互斥——一个节点要么普通续接
   * （children_node_ids / continuation_group_ids），要么按 outcome 分流（本字段）。由声明了
   * params_schema['x-outcomes'] 的动作产出（首个消费者：打开表单 ui.open_form 的 hit/miss）。
   */
  outcome_continuation_group_ids?: Record<string, string[]>;
}

export interface BehaviorGuard {
  guard_id: string;
  /** 历史形态：KimpoSQL guard 子集串。结构化条件存在时本字段写空串。 */
  condition: string;
  /**
   * V3.4 结构化条件（与宿主后端 BehaviorGuard.ConditionGroup 同名同形）。
   * 存在时后端**独占**按它求值，不回落 condition 串——回落会让一条本该被拒的条件换套语义偷跑。
   */
  condition_group?: ConditionGroup;
  /**
   * V4 判断表达式路径（与宿主后端 BehaviorGuard.Path 同名同形）：
   * 一条路径 = 从触发根到该 band 的**全部**条件节点，按深度顺序，每步引用文档级 conditions 池里的
   * 一条条件；`negate` 表示走的是该条件的「不成立」侧（省略 = 成立侧，与后端 omitempty 对齐）。
   * guard 三形态（condition 串 / condition_group / path）至多其一，前端新写只产 path。
   */
  path?: { condition_id: string; negate?: boolean }[];
}

/**
 * 文档级条件池条目（与宿主后端 BehaviorCondition 同名同形）：
 * 一条条件节点的 V4 判断表达式整份文档；被一条或多条 guard.path 按 condition_id 引用（同一条件在
 * then/else 两侧、以及多条嵌套路径上共用同一条目，后端一次派发内只求值一次）。
 * `plan` 是后端保存时钉入的发布物身份，**前端只原样透传**。
 */
export interface BehaviorCondition {
  condition_id: string;
  document: {
    schema_version: 'kimpo.report-expression/v4';
    mode: 'condition';
    expression: V4ExpressionDocument;
  };
  plan?: ConditionV4Plan;
}

export interface ActionBehaviorDocument {
  trigger_bindings: BehaviorTriggerBinding[];
  action_groups: BehaviorActionGroup[];
  action_nodes: BehaviorActionNode[];
  guards: BehaviorGuard[];
  /**
   * 条件池：无条件节点时**整键省略**（不写空数组——与 seq/disabled 同一约束，
   * 多写零值会改变宿主规范化字节、破坏文档校验和）。
   */
  conditions?: BehaviorCondition[];
}

export function emptyBehaviorDocument(): ActionBehaviorDocument {
  return { trigger_bindings: [], action_groups: [], action_nodes: [], guards: [] };
}
