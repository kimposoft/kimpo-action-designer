<script setup lang="ts">
import { computed } from 'vue';
import { NEllipsis, useThemeVars } from 'naive-ui';
import type { MindNode } from '../model';
import type { ActionDefinition } from '../hostTypes';
import { categoryColor } from '../categoryColors';
import { actionCardDigest } from '../labels';
import { t as $t } from '../../i18n';
import { resolveLocalized } from '../localize';
import NodeGlyph from './NodeGlyph.vue';
import { actionIconKey } from './nodeIcons';
import { resolveOperationKind } from '../dataActionKind';

/**
 * 画布动作节点卡片（208×72）：
 * 左侧分类图标块（颜色=功能分类，替代原右上角分类文字标签）+ 第一行节点名称（单行约 10 字，溢出省略、
 * 悬停看全名）+ 名称后状态小图标（异步 / 门控）+ 第二行「动作类型 · 关键配置一句话」；停用整卡灰显。
 */
const props = defineProps<{
  node: MindNode;
  selected?: boolean;
  definition?: ActionDefinition;
  /** 字段 / 数据表显示名解析口：供第二行关键配置摘要还原名称（未传时摘要里显示 id 原样）。 */
  fieldName?: (fieldId: string) => string;
  tableName?: (tableId: string) => string;
}>();

// 插件动作名（动作本身的显示名）。
const actionTitle = computed(() => resolveLocalized(props.definition?.title) || props.node.actionName || $t('actionDesigner.summary.action'));
// 卡片主标题 = 节点自定义名称（默认取插件动作名、可改）；为空时回落到动作名。
const displayName = computed(() => props.node.name?.trim() || actionTitle.value);
// 停用态：enabled 显式为 false（旧节点无此字段 → 启用）。
const disabled = computed(() => props.node.enabled === false);

// 第二行：动作类型 · 关键配置（摘要为空时只显示动作类型；停用时前缀「停用」）。
const digest = computed(() =>
  actionCardDigest(props.node, props.definition, { fieldName: props.fieldName, tableName: props.tableName })
);
const metaText = computed(() => {
  const parts = [actionTitle.value, digest.value].filter(Boolean);
  if (disabled.value) parts.unshift($t('actionDesigner.node.disabled'));
  return parts.join(' · ');
});

// 分类图标块配色（色盘与面板页签/行 tag 共用 categoryColor，同分类处处同色）。
const category = computed(() => (props.definition?.category ?? '').trim() || $t('actionDesigner.panel.filterOther'));
// 数据动作按种类出图标（第三方与官方同口径），种类取动作目录定义、缺定义回落官方兼容表。
const iconKey = computed(() =>
  actionIconKey(props.node.actionName, props.definition?.category, resolveOperationKind(props.node.actionName, props.definition))
);

// 节点样式（插件声明，闭集语义名 → 主题 token）：声明了语义色时图标块与描边改用该色。
const themeVars = useThemeVars();
const colorMap = computed<Record<string, string>>(() => ({
  primary: themeVars.value.primaryColor,
  success: themeVars.value.successColor,
  warning: themeVars.value.warningColor,
  danger: themeVars.value.errorColor,
  info: themeVars.value.infoColor
}));
const accent = computed(() => colorMap.value[props.definition?.style?.color ?? ''] ?? '');
const tileStyle = computed(() => {
  if (accent.value) return { color: accent.value, backgroundColor: `color-mix(in srgb, ${accent.value} 14%, transparent)` };
  const c = categoryColor(category.value);
  return { color: c.text, backgroundColor: c.bg };
});
// 形状目录：重设计后只保留圆角变体（rounded 默认 / rect / pill）；diamond/hexagon 的 clip-path 会裁掉
// 图标块与两行文字，一律回落 rounded（现无插件声明这两种形状）。
const shape = computed(() => {
  const s = props.definition?.style?.shape;
  return s === 'rect' || s === 'pill' ? s : 'rounded';
});
</script>

<template>
  <div
    class="action-node"
    :class="[`shape-${shape}`, { selected, 'has-accent': !!accent, 'is-disabled': disabled }]"
    :style="accent ? { '--node-accent': accent } : undefined"
  >
    <span class="node-tile" :style="tileStyle" :title="category"><NodeGlyph :icon="iconKey" /></span>
    <div class="node-body">
      <div class="node-head">
        <!-- 主标题=节点名称；过长则 … 省略，指向显示全名（NEllipsis 仅溢出时弹 tooltip） -->
        <NEllipsis class="node-title" :tooltip="{ contentStyle: 'max-width: 360px' }">{{ displayName }}</NEllipsis>
        <!-- 状态小图标：异步（时钟）/ 门控（漏斗），hover 显示含义 -->
        <span v-if="node.async" class="node-flag flag-async" :title="$t('actionDesigner.summary.async')"><NodeGlyph icon="clock" :size="10" :stroke-width="2.6" /></span>
        <span v-if="node.nodeGuard" class="node-flag flag-guard" :title="$t('actionDesigner.node.guardTitle')"><NodeGlyph icon="filter" :size="10" :stroke-width="2.6" /></span>
      </div>
      <div class="node-meta" :title="metaText">{{ metaText }}</div>
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
  border: 1px solid rgb(var(--base-text-color) / 0.13);
  background-color: rgb(var(--container-bg-color));
  box-shadow: 0 1px 2px rgb(16 24 40 / 0.06);
  display: flex;
  align-items: center;
  gap: 10px;
  cursor: pointer;
  user-select: none;
  transition: box-shadow 0.15s ease, border-color 0.15s ease;
}
.action-node:hover {
  border-color: rgb(var(--base-text-color) / 0.24);
  box-shadow: 0 2px 6px rgb(16 24 40 / 0.1);
}
.selected,
.selected:hover {
  border-color: rgb(var(--primary-color));
  box-shadow: 0 0 0 3px rgb(var(--primary-color) / 0.18);
}
/* 插件语义色：描边取该色的淡化版（满色描边会被误认成选中态；选中环仍独立可见） */
.has-accent {
  border-color: color-mix(in srgb, var(--node-accent) 35%, rgb(var(--container-bg-color)));
}
.shape-rect {
  border-radius: 4px;
}
.shape-pill {
  border-radius: 36px;
  padding-left: 16px;
}
/* 分类图标块：32×32，色值由 categoryColor（或插件语义色）内联注入 */
.node-tile {
  flex: 0 0 auto;
  width: 32px;
  height: 32px;
  border-radius: 9px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.node-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.node-head {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
}
.node-title {
  min-width: 0;
  font-size: 13.5px;
  font-weight: 600;
  line-height: 20px;
  color: rgb(var(--base-text-color));
}
/* 名称后的状态小图标（16px 圆） */
.node-flag {
  flex: 0 0 auto;
  width: 16px;
  height: 16px;
  border-radius: 8px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.flag-async {
  background-color: rgb(32 128 240 / 0.12);
  color: #2080f0;
}
.flag-guard {
  background-color: rgb(var(--base-text-color) / 0.08);
  color: rgb(var(--base-text-color) / 0.7);
}
/* 第二行：动作类型 · 关键配置，单行省略 */
.node-meta {
  font-size: 11.5px;
  line-height: 16px;
  color: rgb(var(--base-text-color) / 0.58);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* 停用态：虚线描边 + 灰底 + 名称删除线（选中环仍独立可见） */
.is-disabled {
  border-style: dashed;
  background-color: rgb(var(--base-text-color) / 0.03);
  opacity: 0.7;
}
.is-disabled .node-tile {
  color: rgb(var(--base-text-color) / 0.4) !important;
  background-color: rgb(var(--base-text-color) / 0.08) !important;
}
.is-disabled .node-title {
  color: rgb(var(--base-text-color) / 0.55);
  text-decoration: line-through;
}
</style>
