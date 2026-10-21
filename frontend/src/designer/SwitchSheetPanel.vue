<script setup lang="ts">
import { computed, ref } from 'vue';
import { NCheckbox, NEmpty } from 'naive-ui';
import { KControlSize, type KControlSizeTiers } from '@kimposoft/ui-kit';
// 缩略图渲染（取设计文档 → 解析表格编辑器 bundle → 取缩略图渲染导出）由宿主经
// hostApi.createSheetThumbnailRenderer 注入。
import type { ActionDesignerHostApi } from './hostApi';
import type { SheetCatalogEntry } from './hostTypes';
import SheetCardGrid from './SheetCardGrid.vue';
import { useSheetThumbnails } from './useSheetThumbnails';
import { t as $t } from '../i18n';

/**
 * 切换Sheet（ui.switch_sheet）专用配置面板——Kimpo 设计层动作设计器 NodeConfigDialog 的
 * x-picker:sheet-switch 特化渲染。
 *
 * 单步骤：选择用户接下来要看到的 Sheet——Sheet 卡片网格（264px 卡：缩略占位块 + 名称 +
 * 状态文字，选中=浅蓝底+品牌描边+右上角圆角方块勾选角标），标题右侧
 * 「仅显示可见Sheet」过滤勾选。框架级「异步执行」开关统一由 NodeConfigDialog 头部「选项」
 * 按钮承载（面板自身不再提供第二个「选项」入口）。
 *
 * 语义取舍：
 * ① 不提供「当前Sheet」禁用卡——动作运行时用户停在哪个 sheet 设计期不可知
 *   （kimposheet.sheet-catalog 能力无「当前」概念，设计器当前 sheet ≠ 运行时当前 sheet）；
 * ② 「仅显示可见Sheet」关闭后隐藏 sheet 以禁用卡展示——隐藏 sheet 不可作为切换目标
 *   （沿用原下拉 visible!==false 过滤规则，只放宽「看得到」不放宽「选得到」）。
 *
 * 分区（表格分区）口径：
 * ③ **可选范围 = 布局里定位得到的全部表**：堆叠分区成员与页签组成员一律可选，不再只限
 *   「主分区代表叶 / 独立 sheet」。运行期 switchSheetRegionAware 本就三档全支持（切页签 /
 *   切页签组当前页 / 同屏定位激活），若设计期把后两类置灰，「一个页签里用页签组装
 *   三张表」时只有组内第一张配得出来。故本面板**不读 switchable**（旧插件二进制回的 false
 *   是旧口径，读了反而把本该可选的成员锁死），可选性只由 visible 决定；
 * ④ 卡片**按页签（容器）分组**，组标题 = container_label（容器代表叶名，代表隐藏时表格编辑器侧已
 *   顺延取首个可见成员）；组内按分区序号、页签组内序号排；卡片状态文字按处境分写「切换页签」
 *   /「切到该页签 · 第 N 页」/「定位到该分区」；
 * ⑤ 旧插件二进制不产分区上下文字段时**退回不分组、全部可选（隐藏除外）**，不因缺字段锁死；
 * ⑥ 已选目标在目录里定位不到（表被删等）时出「配置已失效」提示条，**不自动清空**（与打印
 *   目标失去打印区域时的回显纪律一致）。
 *
 * 产物：选中 sheet id 经 update:value 事件写回 draft.params（键由 NodeConfigDialog 按
 * x-picker 属性名解析，现状即 sheet_id）。
 */
const props = defineProps<{
  /** sheet 目录（NodeConfigDialog 经 kimposheet.sheet-catalog 能力拉取后透传）。 */
  sheets: SheetCatalogEntry[];
  /** 已选目标 sheet id（draft.params 里 x-picker=sheet-switch 属性的当前值）。 */
  value: string;
  /** 设计上下文（缩略图链路用：templateVersionNo 取设计文档、pluginId 解析表格编辑器 bundle）。 */
  scope?: { appId: string; templateId: string; templateVersionNo?: string; pluginId?: string };
  /** 宿主能力注入面，缩略图渲染器经此解析。 */
  hostApi: ActionDesignerHostApi;
}>();

const emit = defineEmits<{
  'update:value': [id: string];
}>();

/** 仅显示可见 sheet（默认开——与原下拉「隐藏 sheet 不进选择器」的行为基线一致）。 */
const onlyVisible = ref(true);
/**
 * 「仅显示可见 Sheet」胶囊内 NCheckbox 的尺寸钉定。
 * 目标尺寸：文字 12px，勾选器 24×24 可点区域内 14px 方框（inset 5px）；
 * 故 small 档：boxSize 14、fontSize 12（Naive small 默认方块 14，此处显式钉定防主题漂移）。
 */
const VISIBLE_CHIP_TIERS: KControlSizeTiers = { small: { boxSize: 14, fontSize: 12 } };
const shownSheets = computed(() => (onlyVisible.value ? props.sheets.filter(s => s.visible !== false) : props.sheets));

/** 分区上下文是否可用（旧插件二进制不产这组字段 ⇒ 不分组、状态文字回落通用措辞，见 ⑤）。 */
const hasRegionContext = computed(() =>
  props.sheets.some(s => typeof s.container_index === 'number' && (s.container_index as number) >= 0)
);

/**
 * 是否真的需要分组：**至少有一个容器装了不止一张表**（多分区堆叠或页签组）才分。
 * 每张表各自独立成容器（常规多 sheet 表单，也是无显式布局时的合成形态）时分组毫无信息量——
 * 每组一张卡、组标题与卡名逐字相同，白白多出一层噪声。
 */
const groupingEnabled = computed(
  () => hasRegionContext.value && props.sheets.some(s => (s.region_count ?? 1) > 1 || (s.tab_count ?? 0) > 1)
);

/**
 * 不可点选：**只看隐藏**。分区成员一律可选——可切资格由运行期布局定位决定，
 * 而运行期三档全支持；这里刻意不读 switchable，见头注释 ③。
 */
function isLocked(s: SheetCatalogEntry): boolean {
  return s.visible === false;
}

/** 卡片状态文字：已选=切换目标 / 隐藏=已隐藏 / 页签组成员=第 N 页 / 堆叠分区=定位 / 其余=切换页签。 */
function statusOf(s: SheetCatalogEntry): string {
  if (s.visible === false) return $t('actionDesigner.dialog.sheetPicker.statusHidden');
  if (s.id === props.value) return $t('actionDesigner.dialog.sheetPicker.statusTarget');
  // 旧插件二进制无分区上下文：回落到通用措辞（不假装知道它的处境）。
  if (!hasRegionContext.value) return $t('actionDesigner.dialog.sheetPicker.statusPick');
  if (s.region_kind === 'tabs' && typeof s.tab_index === 'number' && s.tab_index >= 0) {
    return $t('actionDesigner.dialog.sheetPicker.statusTabPage', { n: s.tab_index + 1 });
  }
  // 堆叠分区：同屏本就可见，动作只做定位与激活（措辞必须与「切换页签」区分开）。
  if ((s.region_count ?? 1) > 1 && (s.region_index ?? 0) > 0) {
    return $t('actionDesigner.dialog.sheetPicker.statusLocate');
  }
  return $t('actionDesigner.dialog.sheetPicker.statusSwitchTab');
}

/** 一组卡片 = 页签栏上的一个页签（容器）。key 为空串表示「不分组」的扁平组。 */
interface SheetCardGroup {
  key: string;
  label: string;
  sheets: SheetCatalogEntry[];
}

/**
 * 按容器分组并排序：组间按 container_index（= 页签栏从左到右次序），
 * 组内按 region_index → tab_index → index（目录顺序兜底）。
 * 不需要分组时（见 groupingEnabled：旧二进制，或每张表各自独立成容器）退回单个扁平组，
 * 观感与分组落地前逐字一致。
 */
const sheetGroups = computed<SheetCardGroup[]>(() => {
  const shown = shownSheets.value;
  if (!groupingEnabled.value) return [{ key: '', label: '', sheets: shown }];
  const byContainer = new Map<string, SheetCardGroup & { order: number }>();
  const flat: SheetCatalogEntry[] = [];
  for (const s of shown) {
    const ctnIndex = typeof s.container_index === 'number' ? s.container_index : -1;
    if (ctnIndex < 0) {
      // 表格编辑器侧对「未被布局覆盖」的表回 container_index=-1，按独立表归到末尾扁平区。
      flat.push(s);
      continue;
    }
    const key = s.container_id || `ctn_${ctnIndex}`;
    let group = byContainer.get(key);
    if (!group) {
      group = {
        key,
        label: s.container_label || $t('actionDesigner.dialog.sheetPicker.groupFallback', { n: ctnIndex + 1 }),
        sheets: [],
        order: ctnIndex
      };
      byContainer.set(key, group);
    }
    group.sheets.push(s);
  }
  const groups = [...byContainer.values()].sort((a, b) => a.order - b.order);
  for (const group of groups) {
    group.sheets.sort(
      (a, b) =>
        (a.region_index ?? 0) - (b.region_index ?? 0) ||
        (a.tab_index ?? 0) - (b.tab_index ?? 0) ||
        a.index - b.index
    );
  }
  const result: SheetCardGroup[] = groups.map(({ key, label, sheets }) => ({ key, label, sheets }));
  if (flat.length > 0) result.push({ key: '', label: '', sheets: flat });
  return result;
});

/** 只有一个分组且无标题时不画组标题（单页签表单不分组）。 */
const showGroupLabels = computed(() => sheetGroups.value.some(group => group.label !== ''));

/**
 * 已选目标失效（目录里定位不到，如该表已被删除）：出提示条但**不自动清空**——
 * 保留原值让用户看得见"这里配过什么"，由用户自己改选（与打印目标口径一致）。
 */
const selectedMissing = computed(() => props.value !== '' && !props.sheets.some(s => s.id === props.value));

function pick(s: SheetCatalogEntry): void {
  if (isLocked(s)) return; // 隐藏 sheet 不可作为切换目标
  emit('update:value', s.id);
}

// ── Sheet 缩略图：生成逻辑在 useSheetThumbnails（与打印单据面板共用） ──
const { thumbs } = useSheetThumbnails({
  scope: () => props.scope,
  sheets: () => props.sheets,
  hostApi: () => props.hostApi
});
</script>

<template>
  <div class="ssp-panel">
    <!-- 单步骤：左轨圆点（恒为当前步=品牌色）+ 标题行（标题 + 可见过滤勾选）+ 提示 + 卡片网格 -->
    <div class="ssp-step-row">
      <div class="ssp-rail">
        <span class="ssp-dot">1</span>
      </div>
      <div class="ssp-section">
        <div class="ssp-title-row">
          <span class="ssp-title">{{ $t('actionDesigner.dialog.sheetPicker.title') }}</span>
          <!-- 「仅显示可见Sheet」过滤（浅灰底小胶囊 + 14px 勾选器）。
               NCheckbox（方块边长经 KControlSize 钉定 14px）；
               胶囊外框保留为纯布局壳（浅灰底 / 4px 圆角 / 24px 高），文字在前、勾选器在后的顺序用 row-reverse 复现 -->
          <KControlSize :tiers="VISIBLE_CHIP_TIERS">
            <NCheckbox
              v-model:checked="onlyVisible"
              size="small"
              class="ssp-visible-chip"
              data-testid="sheet-switch-only-visible"
            >
              {{ $t('actionDesigner.dialog.sheetPicker.onlyVisible') }}
            </NCheckbox>
          </KControlSize>
        </div>
        <div class="ssp-hint">{{ $t('actionDesigner.dialog.sheetPicker.cardHint') }}</div>

        <!-- 已选目标失效（表被删等）：出提示条但不自动清空，由用户改选 -->
        <div v-if="selectedMissing" class="ssp-invalid" data-testid="sheet-switch-invalid-target">
          {{ $t('actionDesigner.dialog.sheetPicker.invalidTarget') }}
        </div>

        <!-- 卡片网格（共用 SheetCardGrid；隐藏卡置灰禁点，无悬停提示）。
             按页签（容器）分组渲染——每组一个标题 + 一张网格；单页签表单/旧插件二进制
             无分区上下文时只有一个无标题组。 -->
        <template v-if="shownSheets.length > 0">
          <div v-for="group in sheetGroups" :key="group.key || '__flat__'" class="ssp-group">
            <div v-if="showGroupLabels && group.label" class="ssp-group-label" :data-testid="`sheet-switch-group-${group.key}`">
              {{ group.label }}
            </div>
            <SheetCardGrid
              :sheets="group.sheets"
              :value="value"
              :thumbs="thumbs"
              :is-locked="isLocked"
              :status-of="statusOf"
              testid-prefix="sheet-switch-card"
              @pick="pick"
            />
          </div>
        </template>
        <NEmpty v-else size="small" :description="$t('actionDesigner.dialog.sheetPicker.emptySwitchable')" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.ssp-panel {
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 4px 4px 16px;
}

/* 步骤行：左轨圆点 + 右内容（单步骤，圆点恒为品牌色无连线） */
.ssp-step-row {
  display: flex;
  gap: 16px;
}
.ssp-rail {
  flex: 0 0 28px;
  display: flex;
  flex-direction: column;
  align-items: center;
}
.ssp-dot {
  flex: 0 0 28px;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background-color: rgb(var(--primary-color));
  color: #fff;
  font-size: 14px;
  font-weight: 500;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.ssp-section {
  flex: 1 1 auto;
  min-width: 0;
}

/* 分区表单按页签分组——组标题 12px 次级文字，组间 12px 间距；无标题时不占位。 */
.ssp-group + .ssp-group {
  margin-top: 12px;
}
.ssp-group-label {
  margin: 4px 0 8px;
  font-size: 12px;
  line-height: 20px;
  color: rgb(var(--text-secondary-color));
}

/* 已选目标失效提示条（不自动清空，仅提示改选）。 */
.ssp-invalid {
  margin: 8px 0 0;
  padding: 6px 10px;
  border-radius: 4px;
  background-color: rgb(var(--warning-color) / 0.12);
  color: rgb(var(--warning-color));
  font-size: 12px;
  line-height: 20px;
}

/* 标题行：标题 + 「仅显示可见Sheet」胶囊（间距 16） */
.ssp-title-row {
  display: flex;
  align-items: center;
  gap: 16px;
}
.ssp-title {
  font-size: 14px;
  font-weight: 500;
  line-height: 22px;
  color: rgb(var(--base-text-color));
}
/* 过滤胶囊（浅色底、4px 圆角、整体 24px 高，内边距 0 2px 0 4px）。
   胶囊就是 NCheckbox 根节点本身（不再套一层外壳）。
   尺寸：文字 12px / 行高 22px，勾选器 24px 可点区域内 14px 方框（左右各 5px）、文字与可点区域间距 2px。
   文字在前、方框在后（row-reverse）；根行高 Naive 默认 1.6 会撑高，钉回 22，整体高度靠 height:24 固定。 */
.ssp-visible-chip.n-checkbox.n-checkbox--show-label {
  display: inline-flex;
  flex-direction: row-reverse;
  align-items: center;
  height: 24px;
  padding: 0 2px 0 4px;
  border-radius: 4px;
  line-height: 22px;
  background-color: rgb(var(--fill-light-color, 245 247 250));
  color: rgb(var(--primary-color));
}
/* 方框两侧各留 5px 构成 24px 可点区域；文字右侧 2px 间距（Naive 默认 label 内边距 0 8px 须清掉） */
.ssp-visible-chip :deep(.n-checkbox-box-wrapper) {
  margin: 0 5px;
}
.ssp-visible-chip :deep(.n-checkbox__label) {
  padding: 0 2px 0 0;
  color: inherit;
}
.ssp-hint {
  font-size: 12px;
  color: rgb(var(--text-hint-color));
  margin: 8px 0 0;
}
</style>
