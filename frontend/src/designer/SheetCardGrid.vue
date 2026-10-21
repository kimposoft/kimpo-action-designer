<script setup lang="ts">
import { NTooltip } from 'naive-ui';
import type { SheetCatalogEntry } from './hostTypes';

/**
 * Sheet 卡片网格——切换Sheet（SwitchSheetPanel）/ 打印单据（PrintPanel）第一步共用
 * （同款卡片 + 预览图）。
 *
 * 只负责「画卡片」：264px 卡 = 缩略位（预览图异步到达前为灰色占位块）+ 名称 + 状态文字，
 * 选中 = 浅蓝底 + 品牌描边 + 右上角勾选角标，不可选 = 半透明 + 禁点。
 * 哪些卡可选、状态写什么、不可选时悬停提示什么，全部由调用方（面板）按各自业务口径传入——
 * 本组件不含任何切换/打印语义。预览图由调用方经 useSheetThumbnails 生成后以 thumbs 传入。
 *
 * 不可选卡的悬停提示：原生 disabled 按钮不派发鼠标事件，故每张卡外包一层 span 作为 NTooltip
 * 触发器，禁用按钮本身 pointer-events:none 让悬停落到外层；lockedTip 返回空串时不出提示
 * （切换Sheet 面板即不传，外观与抽出前一致）。
 */
const props = defineProps<{
  /** 要画的 sheet（调用方已按自身口径过滤/排序）。 */
  sheets: SheetCatalogEntry[];
  /** 当前选中的 sheet id。 */
  value: string;
  /** sheetId → 预览图 dataURL（缺失即显示占位块）。 */
  thumbs: Record<string, string>;
  /** 该卡是否不可选（置灰禁点）。 */
  isLocked: (s: SheetCatalogEntry) => boolean;
  /** 卡片状态文字。 */
  statusOf: (s: SheetCatalogEntry) => string;
  /** 不可选卡的悬停提示（空串 = 不提示）；可选卡恒不提示。 */
  lockedTip?: (s: SheetCatalogEntry) => string;
  /** 卡片 data-testid 前缀（`${prefix}-${sheetId}`）。 */
  testidPrefix: string;
}>();

const emit = defineEmits<{
  pick: [sheet: SheetCatalogEntry];
}>();

/** 悬停提示文本：只对不可选卡取 lockedTip。 */
function tipOf(s: SheetCatalogEntry): string {
  return props.isLocked(s) ? (props.lockedTip?.(s) ?? '') : '';
}

function onPick(s: SheetCatalogEntry): void {
  if (props.isLocked(s)) return; // 不可选卡不响应（双保险：按钮已 disabled）
  emit('pick', s);
}
</script>

<template>
  <div class="scg-cards">
    <NTooltip v-for="s in sheets" :key="s.id" :disabled="!tipOf(s)" placement="top">
      <template #trigger>
        <span class="scg-cell" :class="{ locked: isLocked(s) }">
          <button
            type="button"
            class="scg-card"
            :class="{ selected: s.id === value, locked: isLocked(s) }"
            :aria-pressed="s.id === value"
            :disabled="isLocked(s)"
            :data-testid="`${testidPrefix}-${s.id}`"
            @click="onPick(s)"
          >
            <!-- 缩略位：真实缩略图异步按序到达前显示填充/常用占位块 -->
            <span class="scg-thumb">
              <img v-if="thumbs[s.id]" class="scg-thumb-img" :src="thumbs[s.id]" alt="" />
            </span>
            <span class="scg-card-name">{{ s.name }}</span>
            <span class="scg-card-status">{{ statusOf(s) }}</span>
            <!-- 右上角勾选角标（右上/左下 8px 圆角方块 + 白勾线稿） -->
            <span v-if="s.id === value" class="scg-card-check">
              <svg viewBox="0 0 24 24" width="24" height="24" fill="none" aria-hidden="true">
                <path
                  d="M7 12.7143L11.1779 15.9698C11.8715 16.5103 12.884 16.3018 13.3077 15.5314L18 7"
                  stroke="#fff"
                  stroke-width="2"
                  stroke-linecap="round"
                />
              </svg>
            </span>
          </button>
        </span>
      </template>
      {{ tipOf(s) }}
    </NTooltip>
  </div>
</template>

<style scoped>
/* Sheet 卡片网格（264px 卡、横向间距 36、纵向间距 16） */
.scg-cards {
  display: flex;
  flex-wrap: wrap;
  gap: 16px 36px;
  margin-top: 24px;
}
/* 卡片外层（NTooltip 触发器）：不可选时由它承接悬停并显示禁用光标 */
.scg-cell {
  display: flex;
}
.scg-cell.locked {
  cursor: not-allowed;
}
.scg-card {
  position: relative;
  width: 264px;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
  padding: 12px;
  border: 1px solid rgb(var(--border-color));
  border-radius: 8px;
  background: transparent;
  cursor: pointer;
  text-align: left;
}
.scg-card:hover {
  border-color: rgb(var(--primary-color) / 0.6);
}
.scg-card.selected {
  border-color: rgb(var(--primary-color));
  background-color: rgb(var(--primary-50-color) / 0.5);
}
/* 不可选卡：半透明 + 禁点；pointer-events:none 让悬停落到外层 .scg-cell 触发提示 */
.scg-card.locked {
  opacity: 0.55;
  pointer-events: none;
}
/* 缩略位（113px 高、填充/常用占位底、4px 圆角；真实缩略图到达后整块覆盖） */
.scg-thumb {
  position: relative;
  width: 100%;
  height: 113px;
  border-radius: 4px;
  background-color: rgb(var(--fill-color, 240 242 245));
  overflow: hidden;
}
.scg-thumb-img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  display: block;
}
.scg-card-name {
  font-size: 14px;
  font-weight: 500;
  line-height: normal;
  color: rgb(var(--base-text-color));
}
.scg-card-status {
  font-size: 12px;
  color: rgb(var(--text-secondary-color));
}
/* 右上角勾选角标（24px 方块，右上/左下 8px 圆角与卡片圆角衔接，白勾线稿） */
.scg-card-check {
  position: absolute;
  top: -1px;
  right: -1px;
  width: 24px;
  height: 24px;
  border-radius: 0 8px 0 8px;
  background-color: rgb(var(--primary-color));
  display: flex;
  align-items: center;
  justify-content: center;
}
</style>
