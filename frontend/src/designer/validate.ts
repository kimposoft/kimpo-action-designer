/**
 * 设计期轻量校验：把非法编排在交互层先挡住（保存期仍由宿主后端二次兜底）。
 * 返回定位到具体节点的 issue 列表，UI 据此标徽标 + 阻止保存（有 error 时）。
 */

import { t as $t } from '../i18n';
import type { ActionTriggerEventKey, MindNode, SimpleCondition, WorkflowGateStep } from './model';
import type { WorkflowStepCatalogDefinition } from './hostTypes';
import { eventLabel } from './labels';

export type IssueLevel = 'error' | 'warn';

/** 需要指定触发字段的事件（仅这两类事件按字段作用域触发）。 */
export const FIELD_SCOPED_EVENT_KEYS: readonly ActionTriggerEventKey[] = ['value-change', 'field-click'];

/**
 * 触发根上「勾了值变动 / 点击字段时、却没选触发字段」的事件清单。
 * 校验（报错阻断保存）与画布触发根卡片（「未设置触发字段」提示）共用同一判据，避免口径漂移。
 */
export function missingTriggerFieldEvents(root: MindNode): ActionTriggerEventKey[] {
  if (root.kind !== 'trigger-root') return [];
  const keys = root.eventKeys && root.eventKeys.length > 0 ? root.eventKeys : root.eventKey ? [root.eventKey] : [];
  return keys.filter(key => FIELD_SCOPED_EVENT_KEYS.includes(key) && (root.eventFieldIds?.[key]?.length ?? 0) === 0);
}

/**
 * 流程步骤门单步是否仍在目录里有效：定义存在且该步骤节点仍在其**最新版本**步骤清单内。
 * 画布触发根徽标（TriggerRootNode.vue）与本文件的门校验共用同一判据，避免两处失效口径漂移。
 */
export function isWorkflowGateStepAlive(step: WorkflowGateStep, catalog: readonly WorkflowStepCatalogDefinition[]): boolean {
  const def = catalog.find(d => d.definition_id === step.definitionId);
  return !!def && def.steps.some(s => s.node_id === step.nodeId);
}

/**
 * 门内失效步骤数。catalog 为 null（目录尚未加载/未拿到）时恒判 0——不误报失效，等目录到位再判
 * （与画布徽标"拿不到目录时不判失效、只显示数量"同一口径，见 TriggerRootNode.vue）。
 */
export function countDeadWorkflowGateSteps(
  gate: { steps: WorkflowGateStep[] } | undefined,
  catalog: readonly WorkflowStepCatalogDefinition[] | null | undefined
): number {
  if (!gate || !catalog) return 0;
  return gate.steps.filter(step => !isWorkflowGateStepAlive(step, catalog)).length;
}

export interface ValidationIssue {
  nodeId: string;
  level: IssueLevel;
  message: string;
}

export interface ValidateContext {
  /** 当前模板版本字段集（稳定 field_id）；为空表示未加载，跳过字段存在性校验避免误报。 */
  fieldIds: Set<string>;
  /** 动作是否支持异步（来自注册中心 capabilities.asyncable）。 */
  asyncable: (actionName: string) => boolean;
  /** 条件最大嵌套深度（含本层），默认 3。 */
  maxDepth?: number;
  /**
   * 流程步骤目录：供根 workflowGate 失效校验。undefined/null（未加载）时跳过该项
   * 校验——目录尚在加载途中不应把有效门误判成一片警告。
   */
  workflowStepCatalog?: readonly WorkflowStepCatalogDefinition[] | null;
  /**
   * 动作在模板绑定编辑器下不可用的原因：返回缺失的命令与档案；可用或不裁剪时 null。
   * 缺省（未传）时不做该项校验（job 模式 / 旧调用点）。
   */
  actionUnsupported?: (actionName: string) => { command: string; profile: string } | null;
}

export function validateTree(root: MindNode, ctx: ValidateContext): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const maxDepth = ctx.maxDepth ?? 3;
  const checkField = ctx.fieldIds.size > 0;

  /** 单条 SimpleCondition 校验（用于动作节点级门控 nodeGuard，未受双模式改造，仍是单条）。 */
  function validateCondition(nodeId: string, condition: SimpleCondition | undefined, label: string): void {
    if (!condition || !condition.fieldId) {
      issues.push({ nodeId, level: 'error', message: $t('actionDesigner.validate.noField', { label }) });
      return;
    }
    if (checkField && !ctx.fieldIds.has(condition.fieldId)) {
      issues.push({ nodeId, level: 'error', message: $t('actionDesigner.validate.noSuchField', { label, fieldId: condition.fieldId }) });
    }
  }

  /**
   * 条件节点 guard 校验：guardSpec 为权威来源，
   * 缺省时从旧字段 condition 合成 guided 单条镜像（兼容仍只设置 condition 的旧调用点/测试）。
   * - V4 判断表达式（spec.v4）：只校验 token 化源码非空——表达式内部的绑定/形状规则由宿主诊断端点
   *   与后端保存期具名拒绝负责，前端不重复实现一遍 V4 文法；
   * - 旧形态（结构化 / 旧 KimpoSQL 串 / 引导式草稿）：一律报「旧格式，请重新配置」错误
   *   （旧条件必须重配，不再逐字段校验——校验通过反而会让用户以为它还能保存生效）。
   */
  function validateConditionGuard(nodeId: string, node: MindNode, label: string): void {
    const spec = node.guardSpec ?? (node.condition ? { mode: 'guided' as const, guided: { logic: 'and' as const, items: [node.condition] } } : undefined);
    if (!spec) {
      issues.push({ nodeId, level: 'error', message: $t('actionDesigner.validate.noField', { label }) });
      return;
    }
    if (spec.v4) {
      if ((spec.v4.expression?.source_text ?? '').trim() === '') {
        issues.push({ nodeId, level: 'error', message: $t('actionDesigner.compile.conditionMissing', { label }) });
      }
      return;
    }
    issues.push({ nodeId, level: 'error', message: $t('actionDesigner.dialog.conditionLegacyFormat') });
  }

  function walk(band: MindNode[] | undefined, depth: number): void {
    for (const node of band ?? []) {
      if (node.kind === 'action') {
        if (!node.actionName) {
          issues.push({ nodeId: node.id, level: 'error', message: $t('actionDesigner.validate.noActionSelected') });
        }
        // 需要编辑器档案而当前模板编辑器不支持的节点报错阻止保存（宿主保存期再校验）。
        const gap = node.actionName && ctx.actionUnsupported ? ctx.actionUnsupported(node.actionName) : null;
        if (gap) {
          issues.push({ nodeId: node.id, level: 'error', message: $t('actionDesigner.validate.editorUnsupported', { command: gap.command, profile: gap.profile }) });
        }
        if (node.async && node.actionName && !ctx.asyncable(node.actionName)) {
          issues.push({ nodeId: node.id, level: 'error', message: $t('actionDesigner.validate.asyncNotSupported') });
        }
        if (node.nodeGuard) validateCondition(node.id, node.nodeGuard, $t('actionDesigner.validate.nodeGuardLabel'));
      } else if (node.kind === 'condition') {
        validateConditionGuard(node.id, node, $t('actionDesigner.dialog.tabCondition'));
        if (depth + 1 > maxDepth) {
          issues.push({ nodeId: node.id, level: 'error', message: $t('actionDesigner.validate.nestTooDeep', { maxDepth }) });
        }
        const thenEmpty = !(node.thenChildren && node.thenChildren.length > 0);
        const elseEmpty = !(node.elseChildren && node.elseChildren.length > 0);
        if (thenEmpty && elseEmpty) {
          issues.push({ nodeId: node.id, level: 'warn', message: $t('actionDesigner.validate.bothBranchesEmpty') });
        }
        // 旧 expression 模式（KimpoSQL 串）无 NOT，不支持非空 else（编译期也会报错，这里提前
        // 在设计期拦下）。V4 判断表达式取反 = 路径步 negate 翻转，恒可用——这道闸只对
        // 「无 v4」的旧形态保留，否则 V4 条件的不成立分支会被误拦。
        if (node.guardSpec?.mode === 'expression' && !node.guardSpec.v4 && !elseEmpty) {
          issues.push({ nodeId: node.id, level: 'error', message: $t('actionDesigner.compile.expressionElseUnsupported') });
        }
        walk(node.thenChildren, depth + 1);
        walk(node.elseChildren, depth + 1);
      }
    }
  }

  walk(root.children, 0);
  // 值变动 / 点击字段时未选触发字段 ⇒ 报错阻断保存
  // （编译侧「字段空不产绑定」防线保留；此处在设计期提前拦下「永远不会触发」的事件）。
  for (const key of missingTriggerFieldEvents(root)) {
    issues.push({ nodeId: root.id, level: 'error', message: $t('actionDesigner.validate.noTriggerField', { event: eventLabel(key) ?? key }) });
  }
  if (!(root.children && root.children.length > 0)) {
    issues.push({ nodeId: root.id, level: 'warn', message: $t('actionDesigner.validate.canvasEmpty') });
  }
  // 触发根流程步骤门失效校验——只计警告（门仍可保存，只是部分/全部条目已失效）；
  // 目录未加载时跳过（见 ValidateContext.workflowStepCatalog 注释）。
  if (root.workflowGate && ctx.workflowStepCatalog) {
    const deadCount = countDeadWorkflowGateSteps(root.workflowGate, ctx.workflowStepCatalog);
    if (deadCount > 0) {
      const allDead = !root.workflowGate.notStarted && root.workflowGate.steps.length > 0 && deadCount === root.workflowGate.steps.length;
      issues.push({
        nodeId: root.id,
        level: 'warn',
        message: allDead ? $t('actionDesigner.dialog.gate.allDeadWarn') : $t('actionDesigner.dialog.gate.deadCount', { count: deadCount })
      });
    }
  }
  return issues;
}

export function countByLevel(issues: ValidationIssue[]): { error: number; warn: number } {
  return issues.reduce(
    (acc, issue) => {
      acc[issue.level] += 1;
      return acc;
    },
    { error: 0, warn: 0 }
  );
}
