<script setup lang="ts">
import { computed } from 'vue';
import { NPopover } from 'naive-ui';
import type { MindNode } from '../model';
import { eventLabel as resolveEventLabel } from '../labels';
import { FIELD_SCOPED_EVENT_KEYS, isWorkflowGateStepAlive, missingTriggerFieldEvents } from '../validate';
import type { WorkflowStepCatalogDefinition } from '../hostTypes';
import NodeGlyph from './NodeGlyph.vue';
import { t as $t } from '../../i18n';

const props = defineProps<{
  node: MindNode;
  selected?: boolean;
  /**
   * 流程步骤目录：null/undefined=目录未加载（拿不到目录时不判失效、只显示数量）；
   * []=已加载但本模板未绑定任何流程。来自 useActionDesigner.workflowStepCatalog（经 ActionDesigner.vue
   * → ActionDesignerCanvas.vue 逐层透传），惰性加载一份，与 NodeConfigDialog 门弹窗各自独立取数。
   */
  workflowStepCatalog?: WorkflowStepCatalogDefinition[] | null;
  /** 字段 id → 字段名（触发字段行用）；未传时回落显示字段 id。 */
  fieldName?: (fieldId: string) => string;
}>();

// 触发类型标签：多触发事件联合展示（如「新建时 / 保存后」）；无事件回落「触发」。
const typeLabel = computed(() => {
  const keys = props.node.eventKeys && props.node.eventKeys.length > 0 ? props.node.eventKeys : props.node.eventKey ? [props.node.eventKey] : [];
  return keys.length > 0 ? keys.map(k => resolveEventLabel(k) ?? k).join(' / ') : $t('actionDesigner.summary.trigger');
});
// 动作名称：主显示用事件名（用户命名），未命名时回落触发类型名。
const actionName = computed(() => props.node.name?.trim() || typeLabel.value);
// 第二行「开始 · 事件名」（恒显示，未命名时主标题与事件名相同也保留「开始」身份标识）。
const startLine = computed(() => `${$t('actionDesigner.node.startPrefix')} · ${typeLabel.value}`);
// 停用态：enabled 显式为 false（旧文档/新建事件缺省 → 启用）。停用 = 该事件的全部
// 触发都不再执行（不报错不提示）；视觉口径与动作节点停用态一致（灰显 + 「停用」徽标）。
const disabled = computed(() => props.node.enabled === false);

// ── 触发字段行（值变动 / 点击字段时）────────────────────────────────
/** 是否勾了按字段触发的事件——只有这两类事件才显示触发字段行。 */
const hasFieldScopedEvent = computed(() => {
  const keys = props.node.eventKeys && props.node.eventKeys.length > 0 ? props.node.eventKeys : props.node.eventKey ? [props.node.eventKey] : [];
  return keys.some(key => FIELD_SCOPED_EVENT_KEYS.includes(key));
});
/** 任一此类事件字段为空 ⇒ 行改为醒目的「未设置触发字段」（与 validate 报错同一判据）。 */
const triggerFieldsUnset = computed(() => missingTriggerFieldEvents(props.node).length > 0);
/** 触发字段名（两类事件各自的字段集合并去重，保持勾选顺序）。 */
const triggerFieldNames = computed(() => {
  const ids = new Set<string>();
  for (const key of FIELD_SCOPED_EVENT_KEYS) for (const id of props.node.eventFieldIds?.[key] ?? []) ids.add(id);
  return [...ids].map(id => (props.fieldName ? props.fieldName(id) : id));
});
const triggerFieldsText = computed(() => triggerFieldNames.value.join('、'));

// ── 流程步骤门徽标 ─────────────────────────────────────────────────
/** 门是否非空：至少一个步骤或勾了「未发起」（与 compile.ts buildWorkflowGate 的"空门=无门"口径一致）。 */
const hasGate = computed(() => {
  const gate = props.node.workflowGate;
  return !!gate && ((gate.steps?.length ?? 0) > 0 || gate.notStarted === true);
});
const gateBadgeCount = computed(() => (props.node.workflowGate?.steps.length ?? 0) + (props.node.workflowGate?.notStarted ? 1 : 0));

/** 节点类型短标签（发起/办理/审批/子流程）：无对应既有 i18n key，暂硬编码中文常量。 */
const GATE_NODE_KIND_LABEL: Record<string, string> = { START: '发起', HANDLE: '办理', APPROVE: '审批', SUBFLOW: '子流程' };

interface GatePopoverRow {
  key: string;
  label: string;
  arrivalLabel: string;
  dead: boolean;
}
/** 门内各步的展示行：目录未加载（undefined/null）时恒不判失效——只用快照名兜底展示。 */
const gateRows = computed<GatePopoverRow[]>(() => {
  const gate = props.node.workflowGate;
  if (!gate) return [];
  const catalog = props.workflowStepCatalog;
  return gate.steps.map(step => {
    const def = catalog?.find(d => d.definition_id === step.definitionId);
    const liveStep = def?.steps.find(s => s.node_id === step.nodeId);
    const dead = catalog ? !isWorkflowGateStepAlive(step, catalog) : false;
    const kindLabel = liveStep ? GATE_NODE_KIND_LABEL[liveStep.node_kind] ?? liveStep.node_kind : '';
    const defName = def?.name ?? step.definitionName ?? step.definitionId;
    const nodeName = liveStep?.node_name ?? step.nodeName ?? step.nodeId;
    const arrivals = step.arrivals ?? [];
    const hasSubmitted = arrivals.includes('submitted');
    const hasReturned = arrivals.includes('returned');
    const arrivalLabel =
      hasSubmitted && hasReturned
        ? $t('actionDesigner.dialog.gate.arrivalAny')
        : hasSubmitted
          ? $t('actionDesigner.dialog.gate.arrivalOnlySubmitted')
          : $t('actionDesigner.dialog.gate.arrivalOnlyReturned');
    return {
      key: `${step.definitionId}::${step.nodeId}`,
      label: kindLabel ? `${defName} · ${kindLabel} ${nodeName}` : `${defName} · ${nodeName}`,
      arrivalLabel,
      dead
    };
  });
});
const gateDeadCount = computed(() => gateRows.value.filter(row => row.dead).length);
/** 有失效条目时徽标整体改琥珀色展示（拿不到目录时 gateDeadCount 恒 0，不会误判）。 */
const gateBadgeDead = computed(() => gateDeadCount.value > 0);
</script>

<template>
  <!-- 起始节点 208×104——主色图标块 + 名称 / 「开始 · 事件」两行，底部固定触发字段栏。 -->
  <div class="action-node trigger-root" :class="{ selected, 'is-disabled': disabled, 'has-field-error': triggerFieldsUnset }">
    <div class="root-head">
      <span class="root-tile"><NodeGlyph icon="bolt" /></span>
      <div class="root-body">
        <div class="root-name-row">
          <span class="node-title" :title="actionName">{{ actionName }}</span>
          <span v-if="disabled" class="badge-disabled">{{ $t('actionDesigner.node.disabled') }}</span>
          <!-- 流程步骤门徽标——门非空才显示；含失效条目时整体切琥珀色，正常时主色 12% 底。 -->
          <NPopover v-if="hasGate" trigger="hover" placement="top" :show-arrow="true" :keep-alive-on-hover="true">
            <template #trigger>
              <span class="badge-gate" :class="{ 'is-dead': gateBadgeDead }" @click.stop @dblclick.stop @pointerdown.stop>
                {{ gateBadgeDead ? $t('actionDesigner.node.gateDead') : $t('actionDesigner.node.gateBadge', { count: gateBadgeCount }) }}
              </span>
            </template>
            <div class="gate-popover">
              <div class="gate-popover-title">{{ $t('actionDesigner.node.gatePopoverTitle') }}</div>
              <div v-if="node.workflowGate?.notStarted" class="gate-popover-row">{{ $t('actionDesigner.node.gateNotStartedRow') }}</div>
              <div v-for="row in gateRows" :key="row.key" class="gate-popover-row" :class="{ 'is-dead': row.dead }">
                <span class="gate-popover-label">{{ row.label }}</span>
                <span class="gate-popover-arrival">{{ row.arrivalLabel }}</span>
                <span v-if="row.dead" class="gate-popover-dead-tag">{{ $t('actionDesigner.node.gateDead') }}</span>
              </div>
            </div>
          </NPopover>
        </div>
        <span class="node-trigger-type" :title="startLine">{{ startLine }}</span>
      </div>
    </div>
    <!-- 值变动 / 点击字段时的触发字段栏；有事件缺字段时改醒目提示（与保存校验同一判据） -->
    <div v-if="hasFieldScopedEvent" class="node-fields" :class="{ 'is-unset': triggerFieldsUnset }" :title="triggerFieldsUnset ? undefined : triggerFieldsText">
      <NodeGlyph :icon="triggerFieldsUnset ? 'alert' : 'field'" :size="12" :stroke-width="2.3" />
      <span class="node-fields-text">
        {{ triggerFieldsUnset ? $t('actionDesigner.node.triggerFieldsUnset') : $t('actionDesigner.node.triggerFields', { fields: triggerFieldsText }) }}
      </span>
    </div>
  </div>
</template>

<style scoped>
.action-node {
  width: 100%;
  height: 100%;
  box-sizing: border-box;
  padding: 10px 12px;
  border-radius: 14px;
  border: 1.5px solid rgb(var(--primary-color));
  background-color: color-mix(in srgb, rgb(var(--primary-color)) 6%, rgb(var(--container-bg-color)));
  box-shadow: 0 2px 6px rgb(var(--primary-color) / 0.12);
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 8px;
  cursor: pointer;
  user-select: none;
  transition: box-shadow 0.15s ease;
}
.selected {
  box-shadow: 0 0 0 3px rgb(var(--primary-color) / 0.22);
}
/* 缺触发字段：整卡切错误色描边（与校验报错同一判据） */
.has-field-error {
  border-color: rgb(var(--error-color));
  background-color: color-mix(in srgb, rgb(var(--error-color)) 4%, rgb(var(--container-bg-color)));
}
.root-head {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
/* 主色实底图标块：起始节点的身份记号 */
.root-tile {
  flex: 0 0 auto;
  width: 32px;
  height: 32px;
  border-radius: 9px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background-color: rgb(var(--primary-color));
  color: #fff;
}
.root-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.root-name-row {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
}
.node-title {
  flex: 0 1 auto;
  min-width: 0;
  font-size: 14px;
  font-weight: 600;
  line-height: 20px;
  color: rgb(var(--base-text-color));
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 第二行「开始 · 事件名」：主色小字 */
.node-trigger-type {
  font-size: 11.5px;
  line-height: 16px;
  color: rgb(var(--primary-color));
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 触发字段栏——白底细边小条，单行省略；缺字段时切错误色 */
.node-fields {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 24px;
  box-sizing: border-box;
  padding: 0 8px;
  border-radius: 6px;
  border: 1px solid rgb(var(--primary-color) / 0.2);
  background-color: rgb(var(--container-bg-color));
  font-size: 11.5px;
  color: rgb(var(--base-text-color) / 0.8);
}
.node-fields > svg {
  flex: 0 0 auto;
  color: rgb(var(--primary-color));
}
.node-fields-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.node-fields.is-unset {
  border-color: rgb(var(--error-color) / 0.35);
  background-color: rgb(var(--error-color) / 0.06);
  color: rgb(var(--error-color));
  font-weight: 500;
}
.node-fields.is-unset > svg {
  color: rgb(var(--error-color));
}
/* 停用态与动作节点同一口径（ActionNode.vue .is-disabled / .badge-disabled） */
.is-disabled {
  opacity: 0.55;
  filter: grayscale(0.5);
}
.badge-disabled {
  flex-shrink: 0;
  font-size: 10px;
  line-height: 16px;
  padding: 0 6px;
  border-radius: 8px;
  background-color: rgb(var(--base-text-color) / 0.1);
  color: rgb(var(--base-text-color) / 0.6);
}
/* 流程步骤门徽标——默认主色 12% 底，含失效条目时切琥珀色。 */
.badge-gate {
  flex-shrink: 0;
  font-size: 10px;
  line-height: 16px;
  padding: 0 6px;
  border-radius: 8px;
  background-color: rgb(var(--primary-color) / 0.12);
  color: rgb(var(--primary-color));
  cursor: default;
}
.badge-gate.is-dead {
  background-color: rgb(var(--warning-color, 240, 160, 30) / 0.18);
  color: rgb(var(--warning-color, 240, 160, 30));
}
.gate-popover {
  min-width: 200px;
  max-width: 320px;
  font-size: 12px;
}
.gate-popover-title {
  font-weight: 600;
  margin-bottom: 4px;
  color: rgb(var(--base-text-color));
}
.gate-popover-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 0;
  color: rgb(var(--base-text-color) / 0.75);
}
.gate-popover-row.is-dead {
  color: rgb(var(--warning-color, 240, 160, 30));
}
.gate-popover-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.gate-popover-arrival {
  flex-shrink: 0;
  color: rgb(var(--base-text-color) / 0.5);
}
.gate-popover-dead-tag {
  flex-shrink: 0;
  font-size: 10px;
  padding: 0 4px;
  border-radius: 6px;
  background-color: rgb(var(--warning-color, 240, 160, 30) / 0.18);
}
</style>
