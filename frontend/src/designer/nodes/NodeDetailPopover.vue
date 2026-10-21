<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { ActionDefinition } from '../hostTypes';
import type { MindNode } from '../model';
import {
  extractV4DocumentOf,
  extractV4Summary,
  isExtractV4Node,
  isWriteV4Node,
  nodeSummary,
  writeV4DocumentOf,
  writeV4Summary,
  type ExprSeg
} from '../labels';
import { categoryColor } from '../categoryColors';
import { resolveOperationKind, type DataActionKind } from '../dataActionKind';
import { resolveLocalized } from '../localize';
import { t as $t } from '../../i18n';

/**
 * 节点「指向详情」Popover 内容（前端壳 + 默认渲染）。
 * - 动作节点：头部=动作图标 + 节点名（自定义名与动作名不同时并列动作名）+ 分类 tag；
 * - 取数节点（V4 取数文档）：「定义表」布局——左列灰底标签格
 *   （图标 + 段名 + 计数），右列内容，横竖网格线切格：来源表=横向 tag（本报表来源不列，带表主题色圆点）、
 *   筛选条件=限高约 3 行可滚动的代码块、填充=胶囊 tab 选目标表 + 限高可滚动的三列表格（目标字段 / 表达式 / 方式），
 *   目标级设置（清空 / 自动匹配 / 清理空行）不展示。表达式按类型着色：`[表]` 段按该表主题色
 *   实底（共享包 table-theme-colors.css 的 .ttc-N 提供 --ttc，本插件 bundle 已随 ExpressionEditor 带入）、
 *   `[字段]` 段按引用种类走与编辑器 token 同族的淡底语义色、函数名橙、字面量灰、关键字弱化——表段实底 vs
 *   字段段淡底的**形态差**才是「主题色与既有类型色撞色」的解法，色相层面 8 色表色板与 7 类语义色不可能互不
 *   相交。摘要由 labels.extractV4Summary 纯函数产出，本组件只负责布局；
 * - 其余节点：nodeSummary 默认行渲染（动作节点去掉首行「动作」，已由头部承载）。
 * 后续插件经 ActionDefinition.detailsSchema 提供自定义布局时，由此处按 schema 渲染覆盖默认视图。
 */
const props = defineProps<{
  node: MindNode;
  definition?: ActionDefinition | null;
  fieldName?: (fieldId: string) => string;
  /** 数据表显示名解析口（可选）：取数目标表按 data_table_id 显示表名。 */
  tableName?: (tableId: string) => string;
  /** 应用显示名解析口 + 当前设计所在应用 ID，供来源表/
   *  视图行的跨应用前缀「应用名 › 」使用（见 labels.ts crossAppPrefix）。均可选，未传时不产出前缀。 */
  appName?: (appId: string) => string;
  currentAppId?: string;
}>();

/** 数据动作的头部图标（iconify 名，必须在宿主离线图标集合内，否则渲染为空）。
 *  取数与三写动作（新增/修改/删除数据）各有专属图标。键为数据动作种类，第三方取数 / 写
 *  节点与官方同图标；种类按动作目录定义解析（resolveOperationKind，缺定义回落官方兼容表）。 */
const KIND_HEAD_ICONS: Record<DataActionKind, string> = {
  fetch: 'ph:database',
  create: 'ph:plus-square',
  update: 'ph:pencil-simple-line',
  delete: 'ph:trash'
};
/** 未登记动作的通用头部图标。 */
const GENERIC_ACTION_ICON = 'ph:squares-four';

const isAction = computed(() => props.node.kind === 'action');
const actionTitle = computed(
  () => resolveLocalized(props.definition?.title) || props.node.actionName || $t('actionDesigner.summary.actionDefault')
);
const nodeName = computed(() => props.node.name?.trim() ?? '');
const headTitle = computed(() => nodeName.value || actionTitle.value);
// 节点自定义名与动作名不同时，动作名作副标题并列（与画布卡片「主标题=节点名、副标题=动作名」同口径）。
const headSub = computed(() => (nodeName.value && nodeName.value !== actionTitle.value ? actionTitle.value : ''));
const headIcon = computed(() => {
  const kind = resolveOperationKind(props.node.actionName, props.definition);
  return kind ? KIND_HEAD_ICONS[kind] : GENERIC_ACTION_ICON;
});
// 分类 tag：与画布节点卡右上角同一色盘（categoryColor），空分类回落「其他」。
const categoryTag = computed(() => (props.definition?.category ?? '').trim() || $t('actionDesigner.panel.filterOther'));
const categoryTagStyle = computed(() => {
  const c = categoryColor(categoryTag.value);
  return { color: c.text, backgroundColor: c.bg };
});

// 取数节点：结构化摘要（来源表 / 筛选 / 填充 tab）。
const isExtract = computed(() => isExtractV4Node(props.node, props.definition));
const summary = computed(() =>
  isExtract.value
    ? extractV4Summary(extractV4DocumentOf(props.node), {
        fieldName: props.fieldName,
        tableName: props.tableName,
        appName: props.appName,
        currentAppId: props.currentAppId
      })
    : undefined
);

// 写节点（新增/修改/删除数据）：结构化摘要（目标表 / 定位条件 / 赋值行 / 父记录锚定 / 防重），
// 与取数节点同一挂法，见 labels.writeV4Summary 注释。
const isWrite = computed(() => isWriteV4Node(props.node, props.definition));
const writeSummary = computed(() =>
  isWrite.value
    ? writeV4Summary(writeV4DocumentOf(props.node), { fieldName: props.fieldName, tableName: props.tableName })
    : undefined
);

// 通用行：nodeSummary 对动作节点首行恒为「动作」名（见 labels.nodeSummary），已由头部承载，去掉避免重复。
const rows = computed(() => {
  const all = nodeSummary(props.node, props.definition, props.fieldName);
  return isAction.value ? all.slice(1) : all;
});
// 注：动作定义里的 description 多为实现层说明（如经宿主查询服务 / 宿主表单数据层执行），不是设计者关注的内容，详情浮层不再展示。

// 填充 tab 激活态：默认首个目标；目标集合变化（换节点 / 改配置）后当前 key 不在集合内则回到首个。
const activeTab = ref('');
watch(
  () => (summary.value?.tabs ?? []).map(tab => tab.key).join(' '),
  () => {
    const tabs = summary.value?.tabs ?? [];
    if (!tabs.some(tab => tab.key === activeTab.value)) activeTab.value = tabs[0]?.key ?? '';
  },
  { immediate: true }
);
const activePane = computed(() => summary.value?.tabs.find(tab => tab.key === activeTab.value));

/** 表主题色类：共享包全局 .ttc-N（提供 --ttc / --ttc-text）；-1 不加类，走 CSS 里的中性灰回退。 */
function tableColorClass(index: number | undefined): string {
  return index !== undefined && index >= 0 ? `ttc-${index}` : '';
}

/** 表达式分段的 class：按 kind 着色，整条引用附主题色类（本报表附独立色类 ttc-report），单段引用附引用种类（缺失时 none）。 */
function segClass(seg: ExprSeg): string[] {
  const classes = ['nd-seg', `nd-seg-${seg.kind}`];
  if (seg.kind === 'ref') classes.push(seg.report ? 'ttc-report' : tableColorClass(seg.colorIndex));
  if (seg.kind === 'field') classes.push(`nd-ref-${seg.refKind ?? 'none'}`);
  return classes.filter(Boolean);
}
</script>

<template>
  <div class="node-detail" :class="{ 'nd-extract': isExtract || isWrite }">
    <div v-if="isAction" class="nd-head" data-testid="nd-head">
      <span class="nd-head-icon"><SvgIcon :icon="headIcon" /></span>
      <span class="nd-head-title">{{ headTitle }}</span>
      <span v-if="headSub" class="nd-head-sub">{{ headSub }}</span>
      <span class="nd-head-cat" :style="categoryTagStyle">{{ categoryTag }}</span>
    </div>

    <!-- 取数节点：定义表布局（左标签列 + 网格线） -->
    <div v-if="summary" class="nd-ledger" data-testid="nd-extract-ledger">
      <div class="nd-lg-k">
        <SvgIcon icon="ph:table" class="nd-lg-icon" />
        <span>{{ $t('actionDesigner.summary.extractSources') }}</span>
        <span v-if="summary.sources.length" class="nd-lg-count">
          {{ $t('actionDesigner.summary.extractSourceCount', { count: summary.sources.length }) }}
        </span>
      </div>
      <div class="nd-lg-v" data-testid="nd-extract-sources">
        <div v-if="summary.sources.length" class="nd-chips">
          <span v-for="src in summary.sources" :key="src.key" class="nd-chip">
            <!-- 表主题色圆点：与表达式里该表的 [表] 段同色（共享包 .ttc-dot / .ttc-N） -->
            <span class="ttc-dot nd-chip-dot" :class="tableColorClass(src.colorIndex)" aria-hidden="true" />
            <!-- 图标按来源种类挑选（不用 tag 有无反推——视图行无 tag，
                 不该落回 catalog 的 ph:table）：staging=ph:stack，view=ph:eye，其余（catalog）=ph:table。 -->
            <SvgIcon :icon="src.kind === 'staging' ? 'ph:stack' : src.kind === 'view' ? 'ph:eye' : 'ph:table'" class="nd-chip-icon" />
            <span class="nd-chip-name">{{ src.name }}</span>
            <span v-if="src.tag" class="nd-tag">{{ src.tag }}</span>
          </span>
        </div>
        <span v-else class="nd-empty">{{ $t('actionDesigner.summary.unset') }}</span>
      </div>

      <div class="nd-lg-k">
        <SvgIcon icon="ph:funnel" class="nd-lg-icon" />
        <span>{{ $t('actionDesigner.summary.extractFilter') }}</span>
      </div>
      <div class="nd-lg-v" data-testid="nd-extract-filter">
        <!-- 限高约 3 行，超出在块内滚动（hover 弹层 keep-alive-on-hover，可滚）；逐段按类型着色 -->
        <code v-if="summary.filterSegments.length" class="nd-expr nd-filter">
          <span v-for="(seg, i) in summary.filterSegments" :key="i" :class="segClass(seg)">
            <template v-if="seg.parts"><span v-for="(part, j) in seg.parts" :key="j" :class="`nd-part-${part.role}`">{{ part.text }}</span></template>
            <template v-else>{{ seg.text }}</template>
          </span>
        </code>
        <span v-else class="nd-empty">{{ $t('actionDesigner.summary.unset') }}</span>
      </div>

      <div class="nd-lg-k">
        <SvgIcon icon="ph:paint-bucket" class="nd-lg-icon" />
        <span>{{ $t('actionDesigner.summary.extractFill') }}</span>
        <span v-if="summary.tabs.length" class="nd-lg-count">
          {{ $t('actionDesigner.summary.extractTargetCount', { count: summary.tabs.length }) }}
        </span>
      </div>
      <div class="nd-lg-v" data-testid="nd-extract-fill">
        <template v-if="summary.tabs.length">
          <!-- 目标表胶囊 tab（表名 + 角色小标签） -->
          <div class="nd-chip-tabs" role="tablist">
            <button
              v-for="tab in summary.tabs"
              :key="tab.key"
              type="button"
              role="tab"
              class="nd-chip-tab"
              :class="{ 'is-active': tab.key === activeTab }"
              :aria-selected="tab.key === activeTab"
              :data-testid="`nd-extract-tab-${tab.key}`"
              @click="activeTab = tab.key"
            >
              <span class="nd-chip-tab-name">{{ tab.label }}</span>
              <span v-if="tab.role" class="nd-tag">{{ tab.role }}</span>
            </button>
          </div>
          <!-- 当前目标的输出表：限高可滚动，表头吸顶；表达式逐段着色 -->
          <div v-if="activePane" class="nd-outputs-scroll" data-testid="nd-extract-pane">
            <div v-if="activePane.outputs.length" class="nd-mt" :class="{ 'nd-mt-staging': activePane.staging }">
              <span class="nd-th">
                {{ $t(activePane.staging ? 'actionDesigner.summary.extractColStagingColumn' : 'actionDesigner.summary.extractColField') }}
              </span>
              <span class="nd-th">{{ $t('actionDesigner.summary.extractColExpr') }}</span>
              <span v-if="!activePane.staging" class="nd-th">{{ $t('actionDesigner.summary.extractColStrategy') }}</span>
              <template v-for="(out, i) in activePane.outputs" :key="i">
                <span class="nd-td nd-name">{{ out.field }}</span>
                <code class="nd-td nd-expr nd-out-expr" :title="out.expression">
                  <template v-if="out.segments.length">
                    <span v-for="(seg, j) in out.segments" :key="j" :class="segClass(seg)">
                      <template v-if="seg.parts"><span v-for="(part, k) in seg.parts" :key="k" :class="`nd-part-${part.role}`">{{ part.text }}</span></template>
                      <template v-else>{{ seg.text }}</template>
                    </span>
                  </template>
                  <span v-else class="nd-empty">{{ $t('actionDesigner.summary.unset') }}</span>
                </code>
                <span v-if="!activePane.staging" class="nd-td nd-td-strategy"><span class="nd-tag">{{ out.strategy }}</span></span>
              </template>
            </div>
            <span v-else class="nd-empty">{{ $t('actionDesigner.summary.unset') }}</span>
          </div>
        </template>
        <span v-else class="nd-empty">{{ $t('actionDesigner.summary.unset') }}</span>
      </div>
    </div>

    <!-- 写节点（新增/修改/删除数据）：同款定义表布局，无多目标 tab（恒单一写目标），
         与取数 nd-ledger 复用同一套样式类。 -->
    <div v-else-if="writeSummary" class="nd-ledger" data-testid="nd-write-ledger">
      <div class="nd-lg-k">
        <SvgIcon icon="ph:table" class="nd-lg-icon" />
        <span>{{ $t('actionDesigner.summary.writeTarget') }}</span>
      </div>
      <div class="nd-lg-v" data-testid="nd-write-target">
        <span class="nd-chip">
          <SvgIcon icon="ph:table" class="nd-chip-icon" />
          <span class="nd-chip-name">{{ writeSummary.target }}</span>
          <span v-if="writeSummary.operationLabel" class="nd-tag">{{ writeSummary.operationLabel }}</span>
        </span>
      </div>

      <!-- 定位条件：仅 update/delete 产出（insert 无 filter 段，writeSummary.filter 恒 undefined）。 -->
      <template v-if="writeSummary.filter !== undefined">
        <div class="nd-lg-k">
          <SvgIcon icon="ph:funnel" class="nd-lg-icon" />
          <span>{{ $t('actionDesigner.summary.writeFilter') }}</span>
        </div>
        <div class="nd-lg-v" data-testid="nd-write-filter">
          <code v-if="(writeSummary.filterSegments ?? []).length" class="nd-expr nd-filter">
            <span v-for="(seg, i) in writeSummary.filterSegments" :key="i" :class="segClass(seg)">
              <template v-if="seg.parts"><span v-for="(part, j) in seg.parts" :key="j" :class="`nd-part-${part.role}`">{{ part.text }}</span></template>
              <template v-else>{{ seg.text }}</template>
            </span>
          </code>
          <span v-else class="nd-empty">{{ $t('actionDesigner.summary.unset') }}</span>
        </div>
      </template>

      <div class="nd-lg-k">
        <SvgIcon icon="ph:paint-bucket" class="nd-lg-icon" />
        <span>{{ $t('actionDesigner.summary.writeAssignments') }}</span>
        <span v-if="writeSummary.assignments.length" class="nd-lg-count">
          {{ $t('actionDesigner.summary.writeAssignmentCount', { count: writeSummary.assignments.length }) }}
        </span>
      </div>
      <div class="nd-lg-v" data-testid="nd-write-assignments">
        <div v-if="writeSummary.assignments.length" class="nd-outputs-scroll">
          <div class="nd-mt nd-mt-staging">
            <span class="nd-th">{{ $t('actionDesigner.summary.extractColField') }}</span>
            <span class="nd-th">{{ $t('actionDesigner.summary.extractColExpr') }}</span>
            <template v-for="(out, i) in writeSummary.assignments" :key="i">
              <span class="nd-td nd-name">{{ out.field }}</span>
              <code class="nd-td nd-expr nd-out-expr" :title="out.expression">
                <template v-if="out.segments.length">
                  <span v-for="(seg, j) in out.segments" :key="j" :class="segClass(seg)">
                    <template v-if="seg.parts"><span v-for="(part, k) in seg.parts" :key="k" :class="`nd-part-${part.role}`">{{ part.text }}</span></template>
                    <template v-else>{{ seg.text }}</template>
                  </span>
                </template>
                <span v-else class="nd-empty">{{ $t('actionDesigner.summary.unset') }}</span>
              </code>
            </template>
          </div>
        </div>
        <span v-else class="nd-empty">{{ $t('actionDesigner.summary.unset') }}</span>
      </div>

      <!-- 不展示「父记录锚定」：父记录恒取自查询结果里目标模板主表（隐含来源）的记录，
           不是用户可配的独立项，见 labels.ts writeTargetTableRef 头注释。 -->

      <!-- 防重：仅配置了唯一键才产出。 -->
      <template v-if="writeSummary.dedupe">
        <div class="nd-lg-k">
          <SvgIcon icon="ph:list-checks" class="nd-lg-icon" />
          <span>{{ $t('actionDesigner.summary.writeDedupe') }}</span>
        </div>
        <div class="nd-lg-v" data-testid="nd-write-dedupe">{{ writeSummary.dedupe.fields }}（{{ writeSummary.dedupe.scope }}）</div>
      </template>
    </div>

    <div v-else class="nd-rows">
      <div v-for="(row, i) in rows" :key="i" class="nd-row">
        <span class="nd-label">{{ row.label }}</span>
        <span class="nd-value">{{ row.value }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.node-detail {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-width: 320px;
  min-width: 180px;
}
/* 取数详情：定义表布局固定 420 宽 */
.nd-extract {
  width: 420px;
  max-width: 420px;
}
/* 头部：动作图标 + 节点名（+ 动作名副标题）+ 分类 tag */
.nd-head {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.nd-head-icon {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 6px;
  font-size: 14px;
  color: rgb(var(--primary-color));
  background-color: rgb(var(--primary-color) / 0.12);
}
.nd-head-title {
  font-size: 13px;
  font-weight: 600;
  color: rgb(var(--base-text-color));
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.nd-head-sub {
  flex-shrink: 0;
  font-size: 11px;
  color: rgb(var(--base-text-color) / 0.5);
}
.nd-head-sub::before {
  content: '·';
  margin-right: 6px;
}
/* 分类 tag：色值由 categoryColor 色盘内联注入，与画布节点卡同色 */
.nd-head-cat {
  margin-left: auto;
  flex-shrink: 0;
  font-size: 10px;
  line-height: 16px;
  padding: 0 6px;
  border-radius: 8px;
  white-space: nowrap;
}
/* 定义表：左标签列（灰底）+ 右内容列，横竖网格线 */
.nd-ledger {
  display: grid;
  grid-template-columns: 74px minmax(0, 1fr);
  border: 1px solid rgb(var(--base-text-color) / 0.14);
  border-radius: 6px;
  overflow: hidden;
}
.nd-lg-k {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  padding: 8px 10px;
  background-color: rgb(var(--base-text-color) / 0.06);
  border-right: 1px solid rgb(var(--base-text-color) / 0.14);
  font-size: 12px;
  font-weight: 600;
  line-height: 1.4;
  color: rgb(var(--base-text-color) / 0.72);
}
.nd-lg-icon {
  font-size: 14px;
  color: rgb(var(--base-text-color) / 0.5);
}
.nd-lg-count {
  font-size: 10px;
  font-weight: 400;
  color: rgb(var(--base-text-color) / 0.45);
  font-variant-numeric: tabular-nums;
}
.nd-lg-v {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 10px;
  min-width: 0;
  font-size: 12px;
  line-height: 1.5;
}
.nd-lg-k,
.nd-lg-v {
  border-bottom: 1px solid rgb(var(--base-text-color) / 0.14);
}
/* 最后一行（最后两个格）不再画底线 */
.nd-ledger > :nth-last-child(-n + 2) {
  border-bottom: 0;
}
/* 来源表：横向 tag，前置表主题色圆点 */
.nd-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.nd-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  max-width: 100%;
  padding: 2px 8px 2px 6px;
  border-radius: 999px;
  border: 1px solid rgb(var(--base-text-color) / 0.14);
  background-color: rgb(var(--container-bg-color));
  font-weight: 600;
  color: rgb(var(--base-text-color) / 0.88);
}
/* 圆点尺寸由共享包 .ttc-dot 给出，这里只补与图标的间距 */
.nd-chip-dot {
  margin-right: 1px;
}
.nd-chip-icon {
  font-size: 13px;
  color: rgb(var(--base-text-color) / 0.45);
}
.nd-chip-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.nd-name {
  color: rgb(var(--base-text-color) / 0.88);
  font-weight: 600;
  word-break: break-all;
}
.nd-expr {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px;
  line-height: 1.6;
  padding: 1px 5px;
  border-radius: 4px;
  color: rgb(var(--base-text-color) / 0.85);
  background-color: rgb(var(--base-text-color) / 0.04);
  word-break: break-all;
}
/* 筛选条件：限高 3 行（3 × 1.6em + 上下 padding），超出块内滚动 */
.nd-filter {
  display: block;
  padding: 4px 6px;
  white-space: pre-wrap;
  max-height: calc(4.8em + 8px);
  overflow: auto;
}
/* ── 表达式分段着色（淡底胶囊）──
   整条引用 `[表].[字段]`：--ttc 12% 淡底 + 表色文字（--ttc/--ttc-text 来自共享包全局 .ttc-N / .ttc-report；
   来源丢失时无色类 → 中性灰淡底、文字随正文），表名加粗、括号点号压暗；单段引用按种类淡底语义色（系统变量紫）；
   函数名橙、字面量灰底、关键字弱化加粗。 */
.nd-seg {
  border-radius: 3px;
  padding: 0 3px;
}
.nd-seg-text {
  padding: 0;
  border-radius: 0;
}
.nd-seg-ref {
  background-color: rgb(var(--ttc, 148 163 184) / 12%);
  color: var(--ttc-text, rgb(var(--base-text-color) / 0.85));
  border-radius: 4px;
  padding: 0 4px;
}
.nd-part-table {
  font-weight: 600;
}
.nd-part-punc {
  opacity: 0.45;
}
.nd-seg-field {
  color: #2061c4;
  background-color: rgb(32 128 240 / 14%);
}
.nd-seg-field.nd-ref-report_field {
  color: #18914f;
  background-color: rgb(24 160 88 / 14%);
}
.nd-seg-field.nd-ref-system_var {
  color: #6b41d8;
  background-color: rgb(124 77 255 / 16%);
}
.nd-seg-field.nd-ref-none {
  color: rgb(var(--base-text-color) / 0.7);
  background-color: rgb(var(--base-text-color) / 0.08);
}
.nd-seg-func {
  color: #c47d10;
  font-weight: 600;
  padding: 0;
}
.nd-seg-string,
.nd-seg-number {
  color: rgb(var(--base-text-color) / 0.8);
  background-color: rgb(var(--base-text-color) / 0.07);
}
.nd-seg-keyword {
  color: rgb(var(--base-text-color) / 0.6);
  font-weight: 600;
  padding: 0;
}
:global(html.dark) .nd-seg-field {
  color: #6ab0ff;
  background-color: rgb(32 128 240 / 22%);
}
:global(html.dark) .nd-seg-field.nd-ref-report_field {
  color: #4ade80;
  background-color: rgb(24 160 88 / 22%);
}
:global(html.dark) .nd-seg-field.nd-ref-system_var {
  color: #b79bff;
  background-color: rgb(124 77 255 / 24%);
}
:global(html.dark) .nd-seg-func {
  color: #ffb84d;
}
.nd-tag {
  flex-shrink: 0;
  font-size: 10px;
  line-height: 16px;
  padding: 0 6px;
  border-radius: 8px;
  white-space: nowrap;
  color: rgb(var(--base-text-color) / 0.6);
  background-color: rgb(var(--base-text-color) / 0.08);
}
.nd-empty {
  font-size: 12px;
  color: rgb(var(--base-text-color) / 0.4);
}
/* 填充：目标表胶囊 tab */
.nd-chip-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.nd-chip-tab {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 10px;
  border-radius: 999px;
  border: 1px solid rgb(var(--base-text-color) / 0.16);
  background: transparent;
  color: rgb(var(--base-text-color) / 0.7);
  font: inherit;
  font-size: 12px;
  line-height: 1.5;
  white-space: nowrap;
  cursor: pointer;
}
.nd-chip-tab.is-active {
  background-color: rgb(var(--primary-color) / 0.12);
  border-color: rgb(var(--primary-color) / 0.5);
  color: rgb(var(--primary-color));
  font-weight: 600;
}
.nd-chip-tab:focus-visible {
  outline: 2px solid rgb(var(--primary-color));
  outline-offset: 1px;
}
.nd-chip-tab-name {
  max-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* 当前目标输出表：限高可滚动，表头吸顶 */
.nd-outputs-scroll {
  max-height: 150px;
  overflow: auto;
}
.nd-mt {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  column-gap: 10px;
  align-items: center;
}
.nd-mt-staging {
  grid-template-columns: auto minmax(0, 1fr);
}
.nd-th {
  position: sticky;
  top: 0;
  padding: 0 0 3px;
  background-color: rgb(var(--container-bg-color));
  font-size: 10px;
  letter-spacing: 0.04em;
  color: rgb(var(--base-text-color) / 0.45);
}
.nd-td {
  padding: 4px 0;
  border-top: 1px solid rgb(var(--base-text-color) / 0.08);
  min-width: 0;
}
.nd-mt .nd-out-expr {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.nd-td-strategy {
  display: flex;
  align-items: center;
}
.nd-rows {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.nd-row {
  display: flex;
  gap: 8px;
  font-size: 12px;
  line-height: 1.5;
}
.nd-label {
  flex-shrink: 0;
  min-width: 48px;
  color: rgb(var(--base-text-color) / 0.45);
}
.nd-value {
  flex: 1;
  min-width: 0;
  color: rgb(var(--base-text-color) / 0.85);
  font-weight: 600;
  word-break: break-all;
}
</style>
