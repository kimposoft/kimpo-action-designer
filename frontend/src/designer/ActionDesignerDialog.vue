<script setup lang="ts">
/**
 * 动作设计器窗口外壳（kimpo-action-designer 插件 · 设计层）。
 *
 * 基于 `@kimposoft/ui-kit` 的 `KDialog`（standard 档，minimizable / maximizable / resizable），
 * 本组件只保留一层薄适配，供 DesignerRoot / NodeConfigDialog 调用：
 *   - 尺寸记忆：经 memoryStore 适配器接 hostApi.loadWindowSize / saveWindowSize；
 *   - 默认尺寸采用 XL 档 + 1200×800 基准，视口计算与自动最大化统一由 ui-kit 提供；
 *   - `resize` 事件：设计器画布要在窗口尺寸变化（缩放 / 最大化 / 最小化还原）后 refit，KDialog 不对外发尺寸事件，
 *     这里用 ResizeObserver 观察外壳元素补出（打开时的首次回调忽略，打开不触发）；
 *   - Esc：由 KLayerStack 统一仲裁（顺序 收浮层 → 还原最大化 → 关闭）；
 *   - 点遮罩无动作；
 *   - 未保存确认不在此处（不传 dirty）：关闭请求交给宿主（DesignerRoot.closeSurface → Host 统一 dirty 确认）。
 *
 * 兼容类名（暂留，供宿主侧尚未迁移的读取方使用）：
 *   - `adlg-root`：宿主表单运行窗口的 Esc 判断扫描可见的 `.adlg-root` 判定「本弹窗之上还有动作设计器」，
 *     挂在 KDialog 外壳上；
 *   - `adlg-window`：宿主 e2e 用例以此定位设计器窗口。
 *   待宿主侧改用 KLayerStack 登记后可删除这两个类名。
 */
import { nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { KDialog, type KDialogMemoryStore } from '@kimposoft/ui-kit';
// 窗口尺寸记忆（按登录用户分桶存 localStorage）经 hostApi 注入。
import { t as $t } from '../i18n';
import type { ActionDesignerHostApi } from './hostApi';

// minimizable 默认 true；Boolean prop 在 Vue 3 隐式转换中未传时会变 false，
// 所以必须用 withDefaults 明确设默认值，否则主动作设计窗口的最小化按钮也会消失。
const props = withDefaults(
  defineProps<{
    show: boolean;
    title?: string;
    minimizable?: boolean;
    hostApi: ActionDesignerHostApi;
    /** Esc 拦截器（透传 KDialog.escapeInterceptor）：窗内有比「还原 / 关闭」更内层的 Esc 语义时提供，返回 true = 已消费。 */
    escapeInterceptor?: (event: KeyboardEvent) => boolean;
  }>(),
  {
    title: undefined,
    minimizable: true,
    escapeInterceptor: undefined
  }
);
const emit = defineEmits<{
  'update:show': [value: boolean];
  close: [];
  resize: [];
}>();

/**
 * 尺寸记忆适配器（KDialog memoryStore）：沿用 hostApi 注入的「按用户分桶」存取通道，
 * 键（memoryKey）仅用于启用记忆，存储键由宿主实现决定。
 */
const memoryStore: KDialogMemoryStore = {
  load: () => props.hostApi.loadWindowSize(),
  save: (_key, size) => props.hostApi.saveWindowSize(size)
};

// 默认基准由共享 XL 档随 CSS 视口换算；插件不再自行复制视口比例。
const defaultSize = { width: 1200, height: 800 };

function onClose(): void {
  // 同一处配对触发 update:show(false) 与 close
  emit('update:show', false);
  emit('close');
}

// —— resize 事件：观察 KDialog 外壳元素尺寸 ——
const dialogRef = ref<InstanceType<typeof KDialog> | null>(null);
let observer: ResizeObserver | null = null;

function stopObserve(): void {
  observer?.disconnect();
  observer = null;
}

watch(
  () => dialogRef.value?.shellRef ?? null,
  el => {
    stopObserve();
    if (!el || typeof ResizeObserver === 'undefined') return;
    // 首次回调是「开始观察」的初始尺寸通知，不算变化
    let first = true;
    observer = new ResizeObserver(() => {
      if (first) {
        first = false;
        return;
      }
      void nextTick().then(() => emit('resize'));
    });
    observer.observe(el);
  },
  { flush: 'post' }
);
onBeforeUnmount(stopObserve);
</script>

<template>
  <!-- 单一元素根：满足页面 <Transition> 对插槽单根的要求；KDialog 内容仍经 NModal 传送到 body。 -->
  <div class="adlg-host">
    <KDialog
      size-preset="XL"
      ref="dialogRef"
      class="adlg-window adlg-root"
      :show="show"
      :title="title || $t('actionDesigner.dialogWin.title')"
      density="standard"
      maximizable
      resizable
      :minimizable="minimizable"
      flush
      memory-key="action-designer-dialog"
      :memory-store="memoryStore"
      :default-size="defaultSize"
      :escape-interceptor="escapeInterceptor"
      @close="onClose"
    >
      <slot />
      <template v-if="$slots['header-extra']" #header-extra><slot name="header-extra" /></template>
      <template v-if="$slots.footer" #footer><slot name="footer" /></template>
    </KDialog>
  </div>
</template>

<style scoped>
.adlg-host {
  display: contents;
}
</style>
