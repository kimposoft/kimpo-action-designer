<script setup lang="ts">
import { computed } from 'vue';
import type { MindNode } from '../model';
import { t as $t } from '../../i18n';
import NodeGlyph from './NodeGlyph.vue';

/**
 * 画布上的条件节点卡片：标题恒为「条件分支」，不把判断表达式摘要画到
 * 卡片上——V4 文档里存的是 token 化源码（`[联系人]#{r1}`），画布拿不到经宿主 restore 的可读原文，硬画只会
 * 显示乱码；表达式本体在节点配置页里看。
 * 与动作卡片同一骨架（图标块 + 两行），琥珀虚线描边区分身份；第二行显示两条分支
 * 各编排了几步（只数分支 band 的直接成员，不展开嵌套）。
 */
const props = defineProps<{
  node: MindNode;
  selected?: boolean;
  /** 保留给 ActionDesignerCanvas 的既有传参面，本组件不消费字段名。 */
  fieldName?: (fieldId: string) => string;
  /** job 模式（定时任务）下条件分支整体不可用，卡片改显示不支持提示。 */
  jobMode?: boolean;
}>();

const branchText = computed(() => {
  const thenCount = props.node.thenChildren?.length ?? 0;
  const elseCount = props.node.elseChildren?.length ?? 0;
  const thenText = thenCount > 0 ? $t('actionDesigner.node.branchThenSteps', { count: thenCount }) : $t('actionDesigner.node.branchThenEmpty');
  const elseText = elseCount > 0 ? $t('actionDesigner.node.branchElseSteps', { count: elseCount }) : $t('actionDesigner.node.branchElseEmpty');
  return `${thenText} · ${elseText}`;
});
</script>

<template>
  <div class="action-node condition" :class="{ selected, 'is-job': jobMode }">
    <span class="cond-tile" aria-hidden="true"><NodeGlyph icon="branch" /></span>
    <div class="cond-body">
      <span class="cond-title">
        {{ jobMode ? $t('actionDesigner.dialog.conditionJobUnsupported') : $t('actionDesigner.panel.conditionBranch') }}
      </span>
      <span v-if="!jobMode" class="cond-meta">{{ branchText }}</span>
    </div>
  </div>
</template>

<style scoped>
.action-node {
  width: 100%;
  height: 100%;
  box-sizing: border-box;
  padding: 10px 12px;
  border-radius: 12px;
  border: 1px dashed rgb(224 164 58);
  background-color: rgb(255 250 240);
  display: flex;
  align-items: center;
  gap: 10px;
  cursor: pointer;
  user-select: none;
  transition: box-shadow 0.15s ease, border-color 0.15s ease;
}
.action-node:hover {
  border-color: rgb(196 125 16);
}
.selected,
.selected:hover {
  border-style: solid;
  border-color: rgb(var(--primary-color));
  box-shadow: 0 0 0 3px rgb(var(--primary-color) / 0.18);
}
/* 分支图标块：琥珀色，与动作卡片图标块同尺寸 */
.cond-tile {
  flex: 0 0 auto;
  width: 32px;
  height: 32px;
  border-radius: 9px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background-color: rgb(240 160 32 / 0.16);
  color: #b26b00;
}
.cond-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.cond-title {
  font-size: 13.5px;
  font-weight: 600;
  line-height: 20px;
  color: rgb(var(--base-text-color));
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.cond-meta {
  font-size: 11.5px;
  line-height: 16px;
  color: rgb(var(--base-text-color) / 0.58);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.is-job {
  border-color: rgb(var(--base-text-color) / 0.25);
  background-color: rgb(var(--container-bg-color));
}
.is-job .cond-tile {
  background-color: rgb(var(--base-text-color) / 0.08);
  color: rgb(var(--base-text-color) / 0.5);
}
.is-job .cond-title {
  font-weight: 500;
  color: rgb(var(--base-text-color) / 0.55);
}
</style>
