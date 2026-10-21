<script setup lang="ts">
import { computed } from 'vue';
import { NAlert, NEmpty, NSwitch } from 'naive-ui';
import type { ActionDesignerHostApi } from './hostApi';
import type { SheetCatalogEntry } from './hostTypes';
import SheetCardGrid from './SheetCardGrid.vue';
import { useSheetThumbnails, type SheetThumbnailScope } from './useSheetThumbnails';
import { t as $t } from '../i18n';

/**
 * 打印单据（ui.print）专用配置面板——Kimpo 设计层动作设计器 NodeConfigDialog 的
 * x-picker:sheet-print 特化渲染。
 *
 * 双步骤（左轨圆点+连线，与联动表单面板同款步骤条）：
 * ① 选择要打印的 Sheet——列出当前模板**全部** sheet（kimposheet.sheet-catalog 能力，由
 *   NodeConfigDialog 拉取后透传），**只有设置了打印区域（print_area 非空）的可选**，其余置灰、
 *   指向时提示「未设置打印区域」。不按 printable 过滤：printable 是手动打印
 *   入口的「可打印」策略位，打印动作不读它，按它过滤会让只设了打印区域的 sheet 整个看不到。
 *   呈现形态：与切换Sheet 第一步同款的 Sheet 卡片网格 + 预览图（共用
 *   SheetCardGrid / useSheetThumbnails），不再是下拉；不做「仅显示可见」过滤（隐藏 sheet 设了打印区域同样可选）；
 * ② 相关设置——打印方式两卡二选一（先预览再打印[推荐徽标]/直接打印，选中=浅蓝底+品牌
 *   描边+右上角勾选角标，与切换Sheet面板卡片同一设计语言；直打附风险提示）+「允许用户
 *   调整打印设置」开关行。
 * 框架级「异步执行」开关统一由 NodeConfigDialog 头部「选项」按钮承载（面板自身不再提供第二个
 * 「选项」入口）。
 *
 * 产物落 draft.params（经 patch 事件由 NodeConfigDialog 浅合并）：
 * sheet_id = 打印目标；gate = { mode: 'preview'|'direct', allow_adjust: boolean }。
 * gate 每次整体重建且只含这两个键——插件侧 additionalProperties=false，重建顺带洗掉历史脏键。
 */
const props = defineProps<{
  /** sheet 目录（NodeConfigDialog 经 kimposheet.sheet-catalog 能力拉取后透传，面板内按打印区域判可选）。 */
  sheets: SheetCatalogEntry[];
  /** 节点参数草稿（权威在 NodeConfigDialog 的 draft.params，面板无独立草稿）。 */
  params: Record<string, unknown>;
  /** 设计上下文（预览图链路用：templateVersionNo 取设计文档、pluginId 解析表格编辑器 bundle）。 */
  scope?: SheetThumbnailScope;
  /** 宿主能力注入面，预览图渲染器经此解析（与切换Sheet 面板同一通路）。 */
  hostApi: ActionDesignerHostApi;
}>();

const emit = defineEmits<{
  patch: [partial: Record<string, unknown>];
}>();

/**
 * 打印目标卡片：全部 sheet 按目录顺序列出；未设置打印区域的置灰不可选、悬停提示「未设置打印区域」。
 * 旧插件二进制不产 print_area ⇒ 取到 undefined ⇒ 按「未设置」处理（全部置灰），不做回落放行。
 * 已选中的目标后来被取消打印区域时，该卡仍带选中角标（同时置灰），不自动清空参数。
 */
const orderedSheets = computed(() => [...props.sheets].sort((a, b) => a.index - b.index));
function printAreaOf(s: SheetCatalogEntry): string {
  return (s.print_area ?? '').trim();
}
function isLocked(s: SheetCatalogEntry): boolean {
  return printAreaOf(s) === '';
}
/** 卡片状态文字：未设区域=未设置打印区域 / 已选=打印目标 / 其余=打印区域 A1:L30；隐藏 sheet 前缀「已隐藏 · 」。 */
function statusOf(s: SheetCatalogEntry): string {
  const base = isLocked(s)
    ? $t('actionDesigner.dialog.print.noPrintArea')
    : s.id === sheetId.value
      ? $t('actionDesigner.dialog.print.statusTarget')
      : $t('actionDesigner.dialog.print.statusArea', { area: printAreaOf(s) });
  return s.visible === false ? `${$t('actionDesigner.dialog.sheetPicker.statusHidden')} · ${base}` : base;
}
/** 置灰卡悬停提示（可选卡由 SheetCardGrid 恒不提示）。 */
function lockedTip(): string {
  return $t('actionDesigner.dialog.print.noPrintArea');
}

// 预览图：与切换Sheet 面板同一生成逻辑（异步逐张上屏，失败静默保留占位块）。
const { thumbs } = useSheetThumbnails({
  scope: () => props.scope,
  sheets: () => props.sheets,
  hostApi: () => props.hostApi
});

const sheetId = computed(() => (typeof props.params.sheet_id === 'string' ? props.params.sheet_id : ''));

/** gate 读取容错：缺省/形状异常回落安全默认值（预览模式、不可调整版式），与插件 Execute 同基线。 */
const gateMode = computed<'preview' | 'direct'>(() => {
  const gate = props.params.gate as { mode?: unknown } | undefined;
  return gate?.mode === 'direct' ? 'direct' : 'preview';
});
const allowAdjust = computed(() => {
  const gate = props.params.gate as { allow_adjust?: unknown } | undefined;
  return gate?.allow_adjust === true;
});

/** 步骤②圆点/连线着色：步骤①完成（已选打印目标）后点亮（与联动表单 stepActive 同语义）。 */
const step2Active = computed(() => sheetId.value !== '');

/** 点选可选卡：写 sheet_id（置灰卡由 SheetCardGrid 挡掉，不会走到这里）。 */
function pickSheet(s: SheetCatalogEntry): void {
  if (isLocked(s)) return;
  emit('patch', { sheet_id: s.id });
}
/** gate 整体重建写回（只含 mode/allow_adjust 两个合法键，见头注）。 */
function patchGate(partial: { mode?: 'preview' | 'direct'; allow_adjust?: boolean }): void {
  emit('patch', { gate: { mode: gateMode.value, allow_adjust: allowAdjust.value, ...partial } });
}
</script>

<template>
  <div class="pp-panel">
    <!-- ① 选择要打印的 Sheet：标题/提示 + 全量 Sheet 卡片网格（含预览图），未设打印区域的置灰带提示 -->
    <div class="pp-step-row">
      <div class="pp-rail">
        <span class="pp-dot active">1</span>
        <span class="pp-line" :class="{ active: step2Active }" />
      </div>
      <div class="pp-section">
        <div class="pp-title">{{ $t('actionDesigner.dialog.print.sheetTitle') }}</div>
        <div class="pp-hint">{{ $t('actionDesigner.dialog.print.sheetHint') }}</div>
        <!-- 卡片网格 + 预览图（与切换Sheet 第一步同款）；未设打印区域的卡置灰、悬停提示 -->
        <SheetCardGrid
          v-if="orderedSheets.length > 0"
          :sheets="orderedSheets"
          :value="sheetId"
          :thumbs="thumbs"
          :is-locked="isLocked"
          :status-of="statusOf"
          :locked-tip="lockedTip"
          testid-prefix="print-sheet-card"
          @pick="pickSheet"
        />
        <NEmpty v-else class="pp-sheet-empty" size="small" :description="$t('actionDesigner.dialog.sheetPicker.emptyPrintable')" />
      </div>
    </div>

    <!-- ② 相关设置：打印方式两卡 + 直打风险提示 + 允许调整开关行 -->
    <div class="pp-step-row pp-step-last">
      <div class="pp-rail">
        <span class="pp-dot" :class="{ active: step2Active }">2</span>
      </div>
      <div class="pp-section">
        <div class="pp-title">{{ $t('actionDesigner.dialog.print.modeTitle') }}</div>
        <div class="pp-mode-cards">
          <button
            type="button"
            class="pp-mode-card"
            :class="{ selected: gateMode === 'preview' }"
            :aria-pressed="gateMode === 'preview'"
            data-testid="print-mode-preview"
            @click="patchGate({ mode: 'preview' })"
          >
            <span class="pp-card-title-row">
              <strong>{{ $t('actionDesigner.dialog.print.previewCard') }}</strong>
              <!-- 推荐徽标（40×20：成功色 15% 底 + 成功色 12px 文字） -->
              <span class="pp-recommend">{{ $t('actionDesigner.dialog.print.recommended') }}</span>
            </span>
            <small>{{ $t('actionDesigner.dialog.print.previewCardDesc') }}</small>
            <span v-if="gateMode === 'preview'" class="pp-card-check">
              <!-- 勾线为线稿，与切换Sheet面板卡片角标同款 -->
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
          <button
            type="button"
            class="pp-mode-card"
            :class="{ selected: gateMode === 'direct' }"
            :aria-pressed="gateMode === 'direct'"
            data-testid="print-mode-direct"
            @click="patchGate({ mode: 'direct' })"
          >
            <span class="pp-card-title-row">
              <strong>{{ $t('actionDesigner.dialog.print.directCard') }}</strong>
            </span>
            <small>{{ $t('actionDesigner.dialog.print.directCardDesc') }}</small>
            <span v-if="gateMode === 'direct'" class="pp-card-check">
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
        </div>
        <!-- 直打风险提示（评审 demo 定案：直接打印跳过人工确认，仅设备/版式固定场景使用） -->
        <NAlert v-if="gateMode === 'direct'" class="pp-direct-warning" type="warning" :show-icon="true" data-testid="print-direct-warning">
          {{ $t('actionDesigner.dialog.print.directWarning') }}
        </NAlert>
        <div class="pp-setting-row">
          <div class="pp-setting-text">
            <span class="pp-setting-title">{{ $t('actionDesigner.dialog.print.allowAdjust') }}</span>
            <span class="pp-setting-desc">{{ $t('actionDesigner.dialog.print.allowAdjustHint') }}</span>
          </div>
          <NSwitch
            size="small"
            data-testid="print-allow-adjust"
            :value="allowAdjust"
            @update:value="v => patchGate({ allow_adjust: v })"
          />
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.pp-panel {
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 4px 4px 16px;
}

/* 步骤行：左轨（28px 圆点+2px 连线）+ 右内容（步骤条，间距 16） */
.pp-step-row {
  display: flex;
  gap: 16px;
}
.pp-rail {
  flex: 0 0 28px;
  display: flex;
  flex-direction: column;
  align-items: center;
}
.pp-dot {
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
.pp-dot.active {
  background-color: rgb(var(--primary-color));
  font-weight: 500;
}
.pp-line {
  flex: 1 1 auto;
  width: 2px;
  min-height: 24px;
  margin: 8px 0;
  background-color: rgb(var(--border-deep-color, 205 208 214));
}
.pp-line.active {
  background-color: rgb(var(--primary-color));
}
.pp-section {
  flex: 1 1 auto;
  min-width: 0;
  padding-bottom: 40px;
}
.pp-step-last .pp-section {
  padding-bottom: 8px;
}

.pp-title {
  font-size: 14px;
  font-weight: 500;
  line-height: 22px;
  color: rgb(var(--base-text-color));
}
.pp-hint {
  font-size: 12px;
  color: rgb(var(--text-hint-color));
  margin: 8px 0 0;
}
.pp-sheet-empty {
  margin-top: 16px;
}

/* 打印方式卡片（280×100、内边距 8/12、横向间距 36；
   选中=浅蓝底+品牌描边+右上角勾选角标） */
.pp-mode-cards {
  display: flex;
  flex-wrap: wrap;
  gap: 16px 36px;
  margin-top: 24px;
}
.pp-mode-card {
  position: relative;
  width: 280px;
  height: 100px;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
  padding: 8px 12px;
  border: 1px solid rgb(var(--border-color));
  border-radius: 8px;
  background: transparent;
  cursor: pointer;
  text-align: left;
}
.pp-mode-card:hover {
  border-color: rgb(var(--primary-color) / 0.6);
}
.pp-mode-card.selected {
  border-color: rgb(var(--primary-color));
  background-color: rgb(var(--primary-50-color) / 0.5);
}
.pp-card-title-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.pp-mode-card strong {
  font-size: 14px;
  font-weight: 500;
  line-height: normal;
  color: rgb(var(--base-text-color));
}
.pp-mode-card small {
  font-size: 12px;
  color: rgb(var(--text-secondary-color));
}
/* 推荐徽标（40×20、成功色 15% 底、4px 圆角、成功色 12px 文字） */
.pp-recommend {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 40px;
  height: 20px;
  padding: 0 4px;
  border-radius: 4px;
  background-color: rgb(var(--success-color, 103 194 58) / 0.15);
  color: rgb(var(--success-color, 103 194 58));
  font-size: 12px;
  line-height: 22px;
}
/* 右上角勾选角标（24px 方块，右上/左下 8px 圆角与卡片圆角衔接，白勾线稿） */
.pp-card-check {
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

/* 直打风险提示（宽度对齐下方开关行=两卡总宽 596） */
.pp-direct-warning {
  width: 596px;
  max-width: 100%;
  margin-top: 24px;
}

/* 「允许用户调整打印设置」开关行（描边圆角容器、内边距 8/12、宽=两卡总宽 596） */
.pp-setting-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  width: 596px;
  max-width: 100%;
  margin-top: 24px;
  padding: 8px 12px;
  border: 1px solid rgb(var(--border-color));
  border-radius: 8px;
}
.pp-setting-text {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}
.pp-setting-title {
  font-size: 14px;
  font-weight: 500;
  line-height: normal;
  color: rgb(var(--base-text-color));
}
.pp-setting-desc {
  font-size: 12px;
  color: rgb(var(--text-hint-color));
}
</style>
