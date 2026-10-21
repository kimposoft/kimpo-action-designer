<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { NEmpty, NInput, NScrollbar } from 'naive-ui';
import type { ActionDefinition } from './hostTypes';
import { setCustomDragImage } from './dragImage';
import { categoryColor } from './categoryColors';
import { t as $t } from '../i18n';
import { resolveLocalized } from './localize';

type DragPayload = { kind: 'action'; name: string } | { kind: 'condition' };

/**
 * contextFilter：调色板按声明位过滤——
 * - 'template'（缺省）：不过滤，模板模式既有行为。
 * - 'scheduled'：job 模式，只展示 capabilities.scheduled_context === true 的动作；registry 本身
 *   不过滤（画布上已存在的、被过滤掉的动作节点仍按其真实定义渲染，不受本面板展示裁剪影响，
 *   否则已配置节点会被误判为"未知动作"）。
 */
const props = withDefaults(
  defineProps<{
    registry: ActionDefinition[];
    contextFilter?: 'template' | 'scheduled';
    // 动作注册中心加载态（对齐 useActionDesigner.registryState）：驱动下方空态三分文案。
    // 缺省 'ok'：兼容未传该 prop 的既有调用方，行为等同改动前（仅"确实无动作"一种空态）。
    registryState?: 'ok' | 'error' | 'not-ready';
    /**
     * 动作在模板绑定编辑器下不可用的原因（缺失命令 / 档案）。返回非 null 的动作
     * 置灰、不可拖入 / 点击，悬停提示原因。缺省 = 全部可用。
     */
    unsupportedOf?: (def: ActionDefinition) => { command: string; profile: string } | null;
  }>(),
  {
    contextFilter: 'template',
    registryState: 'ok'
  }
);
const emit = defineEmits<{
  addAction: [name: string];
  addCondition: [];
  dragStart: [payload: DragPayload];
  dragEnd: [];
}>();

const keyword = ref('');

// 搜索框收纳：默认只露放大镜图标，点击展开输入框；清空失焦后收回。
const showSearch = ref(false);
const searchInputRef = ref<InstanceType<typeof NInput> | null>(null);
function toggleSearch(): void {
  showSearch.value = !showSearch.value;
  if (showSearch.value) {
    void nextTick(() => searchInputRef.value?.focus());
  } else {
    keyword.value = '';
  }
}
function onSearchBlur(): void {
  if (!keyword.value.trim()) showSearch.value = false;
}

// 功能分类页签：全部 + 各动作在 GetActions 里声明的功能分类
//（数据/流程/表单/界面…），分类顺序取「该分类内最小排序权重」升序；未声明分类的动作归「其他」页签（有才显示）。
const OTHER_FILTER = '__other';
const activeFilter = ref<string>('all');

function categoryOf(def: ActionDefinition): string {
  return (def.category ?? '').trim();
}

// job 模式（contextFilter==='scheduled'）声明位过滤：只保留 capabilities.scheduled_context===true
// 的动作——分类页签/搜索列表均基于这份过滤后的清单，避免展示一个点开全空的分类。
const contextFilteredRegistry = computed<ActionDefinition[]>(() =>
  props.contextFilter === 'scheduled' ? props.registry.filter(def => def.capabilities?.scheduled_context === true) : props.registry
);

// 空态三分文案：清单为空时，按 registryState 区分"加载失败/注册中心未就绪/确实无动作"，
// 不把三种情况一律显示同一句「暂无可用动作」误导用户。
const emptyDescriptionKey = computed(() => {
  if (props.registryState === 'error') return 'actionDesigner.panel.noActionsError';
  if (props.registryState === 'not-ready') return 'actionDesigner.panel.noActionsNotReady';
  return 'actionDesigner.panel.noActions';
});

const filterTabs = computed<{ key: string; label: string }[]>(() => {
  const weightOf = (def: ActionDefinition) => (def.sort_weight && def.sort_weight > 0 ? def.sort_weight : Number.MAX_SAFE_INTEGER);
  const minWeight = new Map<string, number>();
  let hasOther = false;
  for (const def of contextFilteredRegistry.value) {
    const cat = categoryOf(def);
    if (!cat) {
      hasOther = true;
      continue;
    }
    minWeight.set(cat, Math.min(minWeight.get(cat) ?? Number.MAX_SAFE_INTEGER, weightOf(def)));
  }
  const tabs = [{ key: 'all', label: $t('actionDesigner.panel.filterAll') }];
  tabs.push(
    ...[...minWeight.entries()].sort((a, b) => a[1] - b[1]).map(([cat]) => ({ key: cat, label: cat }))
  );
  if (hasOther) tabs.push({ key: OTHER_FILTER, label: $t('actionDesigner.panel.filterOther') });
  return tabs;
});

// 注册表变化（如切换实例后重拉）可能让当前选中的分类消失：回落「全部」避免空列表假象。
watch(filterTabs, tabs => {
  if (!tabs.some(tab => tab.key === activeFilter.value)) activeFilter.value = 'all';
});

// 分类页签行滚轮横滚：页签超宽时纵向滚轮转为横向滚动（单行排布不换行）。
const tabsRef = ref<HTMLElement | null>(null);
function onTabsWheel(e: WheelEvent): void {
  const el = tabsRef.value;
  if (!el || el.scrollWidth <= el.clientWidth) return;
  e.preventDefault();
  el.scrollLeft += Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
}

/** 不可用动作的悬停提示（可用时 undefined，不出 title）。 */
function unsupportedTitle(def: ActionDefinition): string | undefined {
  const gap = props.unsupportedOf?.(def);
  return gap ? $t('actionDesigner.panel.editorUnsupported', { command: gap.command, profile: gap.profile }) : undefined;
}

/** 点击添加：不可用动作不响应。 */
function onActionClick(def: ActionDefinition): void {
  if (props.unsupportedOf?.(def)) return;
  emit('addAction', def.name);
}

/** 拖起：不可用动作阻止拖入画布。 */
function onActionDragStart(e: DragEvent, def: ActionDefinition): void {
  if (props.unsupportedOf?.(def)) {
    e.preventDefault();
    return;
  }
  onDragStart(e, { kind: 'action', name: def.name }, resolveLocalized(def.title));
}

function onDragStart(e: DragEvent, payload: DragPayload, label: string): void {
  if (!e.dataTransfer) return;
  e.dataTransfer.effectAllowed = 'copy';
  e.dataTransfer.setData('application/x-action-designer', JSON.stringify(payload));
  setCustomDragImage(e, label);
  emit('dragStart', payload);
}

// 按排序权重升序（越小越靠前）；权重缺省/0 视为「未设」排到末尾，同权重按名称稳定排序。
function bySortWeight(a: ActionDefinition, b: ActionDefinition): number {
  const wa = a.sort_weight && a.sort_weight > 0 ? a.sort_weight : Number.MAX_SAFE_INTEGER;
  const wb = b.sort_weight && b.sort_weight > 0 ? b.sort_weight : Number.MAX_SAFE_INTEGER;
  return wa !== wb ? wa - wb : a.name.localeCompare(b.name);
}

// 扁平清单：关键字 + 分类筛选后按排序权重升序直排，无分组标题（卡片直排）。
const items = computed<ActionDefinition[]>(() => {
  const kw = keyword.value.trim().toLowerCase();
  const match = (def: ActionDefinition) => !kw || resolveLocalized(def.title).toLowerCase().includes(kw) || def.name.toLowerCase().includes(kw);
  return contextFilteredRegistry.value
    .filter(def => {
      if (!match(def)) return false;
      if (activeFilter.value === 'all') return true;
      const cat = categoryOf(def);
      if (activeFilter.value === OTHER_FILTER) return !cat;
      return cat === activeFilter.value;
    })
    .sort(bySortWeight);
});

// 卡片左缘语义色（彩色分类线）：复用节点样式约定的闭集语义色映射，
// 未声明 style.color 的动作回落 info 灰，不引入裸色值。
const ACCENT_VARS: Record<string, string> = {
  primary: 'rgb(var(--primary-color))',
  success: 'rgb(var(--success-color))',
  warning: 'rgb(var(--warning-color))',
  danger: 'rgb(var(--error-color))',
  info: 'rgb(var(--info-color))'
};
function accentOf(def: ActionDefinition): string {
  return ACCENT_VARS[def.style?.color ?? ''] ?? ACCENT_VARS.info;
}

// 卡片右侧徽标 = 功能分类名（未分类显示「其他」，与页签口径一致）。
function badgeOf(def: ActionDefinition): string {
  return categoryOf(def) || $t('actionDesigner.panel.filterOther');
}

// ── 分类色盘：分类页签与动作行分类 tag 同色（与画布节点分类 tag 共用 categoryColor）──
/** 分类页签着色：「全部」保持品牌色默认外观；分类页签按色盘取色（未激活=彩字彩边，激活=加浅色底）。 */
function tabStyle(tab: { key: string; label: string }): Record<string, string> | undefined {
  if (tab.key === 'all') return undefined;
  const c = categoryColor(tab.label);
  const active = activeFilter.value === tab.key;
  return {
    color: c.text,
    borderColor: active ? c.text : `${c.text}66`,
    backgroundColor: active ? c.bg : 'transparent'
  };
}
/** 动作行分类 tag 着色（同一色盘）。 */
function badgeStyle(def: ActionDefinition): Record<string, string> {
  const c = categoryColor(badgeOf(def));
  return { color: c.text, backgroundColor: c.bg };
}
</script>

<template>
  <div class="action-panel">
    <div class="panel-head">
      <span class="panel-title">{{ $t('actionDesigner.summary.action') }}</span>
      <!-- 搜索图标 -->
      <button class="panel-search-btn" :class="{ active: showSearch }" :title="$t('actionDesigner.panel.searchAction')" @click="toggleSearch">
        <svg viewBox="0 0 11.8122 11.8122" width="13" height="13" fill="none">
          <path
            d="M5.25 0C8.14949 0 10.5 2.35051 10.5 5.25C10.5 6.50019 10.0616 7.64718 9.33203 8.54883C9.35446 8.56539 9.37714 8.58222 9.39746 8.60254L11.6475 10.8525C11.8671 11.0722 11.8671 11.4278 11.6475 11.6475C11.4278 11.8671 11.0722 11.8671 10.8525 11.6475L8.60254 9.39746C8.58222 9.37714 8.56539 9.35446 8.54883 9.33203C7.64718 10.0616 6.50019 10.5 5.25 10.5C2.35051 10.5 0 8.14949 0 5.25C0 2.35051 2.35051 0 5.25 0ZM5.25 1.125C2.97183 1.125 1.125 2.97183 1.125 5.25C1.125 7.52817 2.97183 9.375 5.25 9.375C7.52817 9.375 9.375 7.52817 9.375 5.25C9.375 2.97183 7.52817 1.125 5.25 1.125Z"
            fill="currentColor"
          />
        </svg>
      </button>
    </div>
    <NInput
      v-if="showSearch"
      ref="searchInputRef"
      v-model:value="keyword"
      size="small"
      clearable
      :placeholder="$t('actionDesigner.panel.searchAction')"
      class="panel-search"
      @blur="onSearchBlur"
    />
    <!-- 「条件分支」新增入口：job 模式（contextFilter='scheduled'）隐藏——定时任务没有
         表单字段上下文，V4 判断表达式无从解析引用，条件分支整体不可用，不该给出会配出死条件的入口。 -->
    <div
      v-if="contextFilter !== 'scheduled'"
      class="primitive"
      draggable="true"
      @click="emit('addCondition')"
      @dragstart="onDragStart($event, { kind: 'condition' }, $t('actionDesigner.panel.conditionBranch'))"
      @dragend="emit('dragEnd')"
    >
      <span class="primitive-icon" />
      <span>{{ $t('actionDesigner.panel.conditionBranch') }}</span>
    </div>
    <div ref="tabsRef" class="panel-tabs" @wheel="onTabsWheel">
      <button
        v-for="tab in filterTabs"
        :key="tab.key"
        class="panel-tab"
        :class="{ active: activeFilter === tab.key, 'is-cat': tab.key !== 'all' }"
        :style="tabStyle(tab)"
        @click="activeFilter = tab.key"
      >
        {{ tab.label }}
      </button>
    </div>
    <NScrollbar class="panel-list">
      <div
        v-for="def in items"
        :key="def.name"
        class="action-item"
        :class="{ 'is-unsupported': !!unsupportedTitle(def) }"
        :data-action-name="def.name"
        :title="unsupportedTitle(def)"
        :aria-disabled="unsupportedTitle(def) ? 'true' : undefined"
        :draggable="!unsupportedTitle(def)"
        @click="onActionClick(def)"
        @dragstart="onActionDragStart($event, def)"
        @dragend="emit('dragEnd')"
      >
        <div class="item-body" :style="{ borderLeftColor: accentOf(def) }">
          <span class="item-title">{{ resolveLocalized(def.title) }}</span>
          <span class="item-badge" :style="badgeStyle(def)">{{ badgeOf(def) }}</span>
        </div>
      </div>
      <NEmpty v-if="items.length === 0" size="small" :description="$t(emptyDescriptionKey)" class="panel-empty" />
    </NScrollbar>
  </div>
</template>

<style scoped>
.action-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  padding: 10px 12px 12px;
  gap: 12px;
  box-sizing: border-box;
}
.panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 24px;
  flex-shrink: 0;
}
.panel-title {
  font-size: 14px;
  font-weight: 500;
  color: rgb(var(--text-secondary-color));
}
.panel-search-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: none;
  background: transparent;
  border-radius: 4px;
  cursor: pointer;
  color: rgb(var(--text-secondary-color));
}
.panel-search-btn:hover,
.panel-search-btn.active {
  background-color: rgb(var(--base-text-color) / 0.08);
  color: rgb(var(--primary-color));
}
/* 条件分支：高 32 虚线深色描边小圆角 */
.primitive {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 32px;
  padding: 0 4px;
  border: 1px dashed rgb(var(--border-dark-color));
  border-radius: 4px;
  cursor: pointer;
  font-size: 14px;
  color: rgb(var(--text-secondary-color));
  flex-shrink: 0;
}
.primitive:hover {
  border-color: rgb(var(--primary-color));
  color: rgb(var(--primary-color));
}
/* 菱形图标：品牌色描边的 45° 旋转小方块 */
.primitive-icon {
  position: relative;
  width: 16px;
  height: 16px;
  flex-shrink: 0;
}
.primitive-icon::before {
  content: '';
  position: absolute;
  left: 50%;
  top: 50%;
  width: 10.7px;
  height: 10.7px;
  border: 1px solid rgb(var(--primary-color));
  transform: translate(-50%, -50%) rotate(45deg);
}
/* 功能分类页签：高 24 小圆角单行排布；选中浅蓝底品牌色描边。
   超宽时横向滚动（滚轮纵滚转横滚，见 onTabsWheel），滚动条隐藏 */
.panel-tabs {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 4px;
  flex-shrink: 0;
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: none;
}
.panel-tabs::-webkit-scrollbar {
  display: none;
}
.panel-tab {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 24px;
  min-width: 48px;
  padding: 0 4px;
  border: 1px solid rgb(var(--border-color));
  border-radius: 4px;
  background: transparent;
  cursor: pointer;
  font-size: 12px;
  color: rgb(var(--text-hint-color));
  flex-shrink: 0;
}
.panel-tab:hover {
  border-color: rgb(var(--primary-color) / 0.6);
  color: rgb(var(--primary-color));
}
.panel-tab.active {
  border-color: rgb(var(--primary-color));
  background-color: rgb(var(--primary-50-color) / 0.5);
  color: rgb(var(--primary-color));
}
/* 分类页签（色盘着色，见 tabStyle 内联样式）：hover 不再抢品牌色，仅轻微加深底色提示可点。 */
.panel-tab.is-cat:hover {
  filter: brightness(0.94);
}
.panel-list {
  flex: 1;
  min-height: 0;
}
/* 动作卡片：高 28、左缘 1px 语义色分类线 + 来源徽标 */
.action-item {
  display: flex;
  flex-direction: column;
  justify-content: center;
  height: 28px;
  padding: 2px 0;
  border-radius: 4px;
  margin-bottom: 8px;
  cursor: pointer;
  box-sizing: border-box;
  transition: background-color 0.15s ease;
}
.action-item:hover {
  background-color: rgb(var(--fill-light-color));
}
/* 当前模板编辑器不支持的动作：置灰、不可拖入，悬停 title 说明原因 */
.action-item.is-unsupported {
  cursor: not-allowed;
  opacity: 0.45;
}
.action-item.is-unsupported:hover {
  background-color: transparent;
}
.item-body {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 18px;
  padding: 0 4px 0 8px;
  border-left: 1px solid rgb(var(--info-color));
}
.item-title {
  font-size: 14px;
  color: rgb(var(--base-text-color));
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}
/* 来源徽标：描边/极浅底 + 提示文字色 */
.item-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 20px;
  min-width: 40px;
  padding: 0 4px;
  border-radius: 4px;
  background-color: rgb(var(--border-lightest-color));
  font-size: 10px;
  color: rgb(var(--text-hint-color));
  flex-shrink: 0;
  margin-left: 8px;
}
.panel-empty {
  margin-top: 24px;
}
</style>
