<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { NButton, NEmpty, NSelect, type SelectNodeProps } from 'naive-ui';
import { KControlSize, type KControlSizeTiers } from '@kimposoft/ui-kit';
import { tableRoleOf } from '@kimposoft/expression-editor';
import type { ActionDesignerHostApi } from './hostApi';
import type { TemplateDataTable, TemplateField } from './hostTypes';
import { t as $t } from '../i18n';

/**
 * 「添加排序键」描边小按钮的尺寸钉定（NButton）。
 * 目标尺寸：24 高、字号 12、左右内边距 12、1px 主色描边；对应 Naive small 档（默认 28 高）钉到 24 / 12 / 12。
 * 容器只包这一枚按钮，不影响同面板其它控件。
 */
const ADD_KEY_BTN_TIERS: KControlSizeTiers = { small: { height: 24, fontSize: 12, paddingX: 13 } };

/**
 * 明细排序（data.sort_detail）专用配置面板——Kimpo 设计层动作设计器 NodeConfigDialog 的
 * x-editor:detail-sort 特化渲染。
 *
 * 步骤流：①选目标明细表 → ②排序字段（行 = 排序手柄图标 + 字段下拉 242px + 升/降序下拉 98px +
 * 品牌色上下移按钮堆叠 + 删除格；数组序 = 排序优先级，首个最优先）。未选表时步骤②给
 * 缺省页插图（icon-缺省页2）占位，「添加排序字段」按钮禁用。框架级「异步执行」开关不在本面板，
 * 统一由 NodeConfigDialog 头部「选项」按钮承载（面板自身不再提供第二个「选项」入口）。
 *
 * 参数形态刻意沿用网关旧形态 params.targets[]{data_table_id, field_id, order}（见插件侧
 * 明细排序动作实现）：每行冗余携带 data_table_id，使宿主 write grant 白名单覆盖
 * 目标明细表，ReorderDetailRows 的表级行操作授权由此满足。清空时 targets=undefined，由
 * NodeConfigDialog.patchDetailSortParams 删除该键（不留空数组）。
 */
const props = defineProps<{
  appId: string;
  templateId: string;
  params: Record<string, unknown>;
  /** 宿主能力注入面，明细表/字段目录经此拉取。 */
  hostApi: ActionDesignerHostApi;
}>();

const emit = defineEmits<{
  patch: [partial: Record<string, unknown>];
}>();
const stableOptionNodeProps: SelectNodeProps = option => {
  const value = 'value' in option ? option.value : undefined;
  // 自动化身份只能来自 option.value；本组件的 tableOptions 将它绑定到
  // 服务端 data_table_id。缺值时不生成空锚点，更不能回退 label/顺序。
  if (typeof value !== 'string' || value.trim() === '') return {};
  return { 'data-option-value': value };
};

interface DetailSortKeyRow {
  fieldId: string;
  order: 'asc' | 'desc';
}

// ── 参数读取（params 为权威，面板无独立草稿） ────────────────────────────────
// 从 params.targets 解出结构化编辑态（回显）；容错历史脏数据（非对象项跳过）。
const sortKeys = computed<DetailSortKeyRow[]>(() => {
  const raw = props.params.targets;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
    .map(item => ({
      fieldId: typeof item.field_id === 'string' ? item.field_id : '',
      order: item.order === 'desc' ? 'desc' : 'asc'
    }));
});
// 当前目标明细表（targets 各行同表，取首行）。
const tableId = computed(() => {
  const raw = props.params.targets;
  if (!Array.isArray(raw)) return '';
  const first = raw[0] as { data_table_id?: unknown } | undefined;
  return typeof first?.data_table_id === 'string' ? first.data_table_id : '';
});

// ── 明细表/字段目录按需拉取（换表时字段目录跟随重拉） ─────────────────────────
const tables = ref<TemplateDataTable[]>([]);
const fields = ref<TemplateField[]>([]);
watch(
  () => [props.appId, props.templateId, tableId.value] as const,
  async ([appId, templateId, dt]) => {
    if (!appId || !templateId) {
      tables.value = [];
      fields.value = [];
      return;
    }
    try {
      const { data } = await props.hostApi.listTemplateTables(appId, templateId);
      tables.value = data?.items ?? [];
    } catch {
      tables.value = [];
    }
    if (dt) {
      try {
        const { data } = await props.hostApi.listTemplateFields(appId, templateId, undefined, dt);
        fields.value = data?.items ?? [];
      } catch {
        fields.value = [];
      }
    } else {
      fields.value = [];
    }
  },
  { immediate: true }
);
// 仅明细表可选（主表单行无行序概念）；角色判定以后端权威 table_role 为准（tableRoleOf，勿靠 sort_no）。
const tableOptions = computed(() =>
  tables.value.filter(t => tableRoleOf(t, tables.value) === 'detail').map(t => ({ label: t.table_name, value: t.data_table_id }))
);
// 字段下拉：已被其他排序键选中的字段禁用（后端 ValidateParams 拒绝重复键，前端先挡一道）。
function fieldOptions(currentIdx: number) {
  const used = new Set(sortKeys.value.filter((_, i) => i !== currentIdx).map(k => k.fieldId));
  return fields.value.map(f => ({ label: f.field_name, value: f.field_id, disabled: used.has(f.field_id) }));
}
const orderOptions = computed(() => [
  { label: $t('actionDesigner.dialog.detailSort.orderAsc'), value: 'asc' as const },
  { label: $t('actionDesigner.dialog.detailSort.orderDesc'), value: 'desc' as const }
]);

// ── 编辑写回（每次编辑即 patch，保存/校验读到最新值） ─────────────────────────
function commit(rows: DetailSortKeyRow[]): void {
  const dt = tableId.value;
  if (!dt || rows.length === 0) {
    emit('patch', { targets: undefined });
    return;
  }
  emit('patch', { targets: rows.map(r => ({ data_table_id: dt, field_id: r.fieldId, order: r.order })) });
}
// 换表：排序字段属于旧表，整体重置为一条空排序键（引导用户重选字段）。
function setTable(dt: string | null): void {
  if (!dt) {
    emit('patch', { targets: undefined });
    return;
  }
  emit('patch', { targets: [{ data_table_id: dt, field_id: '', order: 'asc' }] });
}
function addKey(): void {
  commit([...sortKeys.value, { fieldId: '', order: 'asc' }]);
}
function removeKey(idx: number): void {
  commit(sortKeys.value.filter((_, i) => i !== idx));
}
function setKeyField(idx: number, fieldId: string): void {
  commit(sortKeys.value.map((k, i) => (i === idx ? { ...k, fieldId } : k)));
}
function setKeyOrder(idx: number, order: 'asc' | 'desc'): void {
  commit(sortKeys.value.map((k, i) => (i === idx ? { ...k, order } : k)));
}
// 上移/下移调整排序优先级（数组序即优先级）。
function moveKey(idx: number, delta: -1 | 1): void {
  const rows = [...sortKeys.value];
  const to = idx + delta;
  if (to < 0 || to >= rows.length) return;
  [rows[idx], rows[to]] = [rows[to], rows[idx]];
  commit(rows);
}
</script>

<template>
  <div class="ds-panel">
    <!-- ① 目标明细表：左轨圆点恒为当前步=品牌色；连线/步骤②圆点在选表后点亮 -->
    <div class="ds-step-row">
      <div class="ds-rail">
        <span class="ds-dot active">1</span>
        <span class="ds-line" :class="{ active: !!tableId }" />
      </div>
      <div class="ds-section">
        <div class="ds-title">{{ $t('actionDesigner.dialog.detailSort.tableLabel') }}</div>
        <NSelect
          v-if="tableOptions.length > 0"
          class="ds-table-select"
          size="small"
          filterable
          :value="tableId || null"
          :options="tableOptions"
          :node-props="stableOptionNodeProps"
          :placeholder="$t('actionDesigner.dialog.detailSort.tablePlaceholder')"
          data-testid="detail-sort-table"
          @update:value="setTable"
        />
        <NEmpty v-else class="ds-table-empty" size="small" :description="$t('actionDesigner.dialog.detailSort.tableEmpty')" />
      </div>
    </div>

    <!-- ② 排序字段：行编辑（字段/升降序/上下移/删除）；未选表时缺省页占位 -->
    <div class="ds-step-row ds-step-last">
      <div class="ds-rail">
        <span class="ds-dot" :class="{ active: !!tableId }">2</span>
      </div>
      <div class="ds-section">
        <div class="ds-title-row">
          <span class="ds-title">{{ $t('actionDesigner.dialog.detailSort.keysLabel') }}</span>
          <KControlSize include-button :tiers="ADD_KEY_BTN_TIERS">
            <NButton size="small" type="primary" ghost :disabled="!tableId" data-testid="add-detail-sort-key" @click="addKey">
              {{ $t('actionDesigner.dialog.detailSort.addKey') }}
            </NButton>
          </KControlSize>
        </div>
        <template v-if="tableId">
          <div class="ds-hint">{{ $t('actionDesigner.dialog.detailSort.priorityHint') }}</div>
          <div class="ds-key-list">
            <div v-for="(sk, idx) in sortKeys" :key="idx" class="ds-key-row" :data-testid="`detail-sort-key-${idx}`">
              <div class="ds-key-main">
                <!-- 排序手柄图标（仅视觉标识行可调序，拖拽由上下移按钮承载） -->
                <svg class="ds-key-handle" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
                  <path
                    d="M5.375 2.0625C5.97906 2.0625 6.46875 2.55219 6.46875 3.15625C6.46875 3.76031 5.97906 4.25 5.375 4.25C4.77094 4.25 4.28125 3.76031 4.28125 3.15625C4.28125 2.55219 4.77094 2.0625 5.375 2.0625ZM6.46875 8C6.46875 7.39594 5.97906 6.90625 5.375 6.90625C4.77094 6.90625 4.28125 7.39594 4.28125 8C4.28125 8.60406 4.77094 9.09375 5.375 9.09375C5.97906 9.09375 6.46875 8.60406 6.46875 8ZM11.7188 8C11.7188 7.39594 11.2291 6.90625 10.625 6.90625C10.0209 6.90625 9.53125 7.39594 9.53125 8C9.53125 8.60406 10.0209 9.09375 10.625 9.09375C11.2291 9.09375 11.7188 8.60406 11.7188 8ZM5.375 11.75C5.97906 11.75 6.46875 12.2397 6.46875 12.8438C6.46875 13.4478 5.97906 13.9375 5.375 13.9375C4.77094 13.9375 4.28125 13.4478 4.28125 12.8438C4.28125 12.2397 4.77094 11.75 5.375 11.75ZM11.7188 12.8438C11.7188 12.2397 11.2291 11.75 10.625 11.75C10.0209 11.75 9.53125 12.2397 9.53125 12.8438C9.53125 13.4478 10.0209 13.9375 10.625 13.9375C11.2291 13.9375 11.7188 13.4478 11.7188 12.8438ZM11.7188 3.15625C11.7188 2.55219 11.2291 2.0625 10.625 2.0625C10.0209 2.0625 9.53125 2.55219 9.53125 3.15625C9.53125 3.76031 10.0209 4.25 10.625 4.25C11.2291 4.25 11.7188 3.76031 11.7188 3.15625Z"
                    fill="currentColor"
                  />
                </svg>
                <div class="ds-key-fields">
                  <NSelect
                    class="ds-key-field"
                    size="small"
                    filterable
                    :value="sk.fieldId || null"
                    :options="fieldOptions(idx)"
                    :placeholder="$t('actionDesigner.dialog.detailSort.fieldPlaceholder')"
                    @update:value="v => setKeyField(idx, v)"
                  />
                  <NSelect class="ds-key-order" size="small" :value="sk.order" :options="orderOptions" @update:value="v => setKeyOrder(idx, v)" />
                  <!-- 上下移按钮堆叠（24×32 品牌色两半，极浅描边分隔） -->
                  <span class="ds-key-move">
                    <button
                      type="button"
                      class="ds-move-btn"
                      :disabled="idx === 0"
                      :aria-label="$t('actionDesigner.dialog.detailSort.moveUp')"
                      @click="moveKey(idx, -1)"
                    >
                      <svg viewBox="0 0 10 6" width="10" height="6" style="transform: rotate(180deg)" aria-hidden="true">
                        <path
                          d="M0.295 1.707C-0.335 1.077 0.111 0 1.002 0H8.174C9.064 0 9.511 1.077 8.881 1.707L5.295 5.293C4.904 5.683 4.271 5.683 3.881 5.293L0.295 1.707Z"
                          fill="currentColor"
                        />
                      </svg>
                    </button>
                    <button
                      type="button"
                      class="ds-move-btn"
                      :disabled="idx === sortKeys.length - 1"
                      :aria-label="$t('actionDesigner.dialog.detailSort.moveDown')"
                      @click="moveKey(idx, 1)"
                    >
                      <svg viewBox="0 0 10 6" width="10" height="6" aria-hidden="true">
                        <path
                          d="M0.295 1.707C-0.335 1.077 0.111 0 1.002 0H8.174C9.064 0 9.511 1.077 8.881 1.707L5.295 5.293C4.904 5.683 4.271 5.683 3.881 5.293L0.295 1.707Z"
                          fill="currentColor"
                        />
                      </svg>
                    </button>
                  </span>
                </div>
              </div>
              <button
                type="button"
                class="ds-key-remove"
                :aria-label="$t('actionDesigner.dialog.detailSort.removeKey')"
                @click="removeKey(idx)"
              >
                ✕
              </button>
            </div>
          </div>
        </template>
        <div v-else class="ds-empty">
          <SvgIcon local-icon="empty-select-hint2" class="ds-empty-icon" />
          <span class="ds-empty-text">{{ $t('actionDesigner.dialog.detailSort.pickTableFirst') }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ds-panel {
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 4px 4px 16px;
}

/* 步骤行：左轨（圆点+连线）+ 右内容（步骤条：完成/当前=品牌蓝，未到=灰） */
.ds-step-row {
  display: flex;
  gap: 16px;
}
.ds-rail {
  flex: 0 0 28px;
  display: flex;
  flex-direction: column;
  align-items: center;
}
.ds-dot {
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
.ds-dot.active {
  background-color: rgb(var(--primary-color));
  font-weight: 500;
}
.ds-line {
  flex: 1 1 auto;
  width: 2px;
  min-height: 24px;
  margin: 8px 0;
  background-color: rgb(var(--border-deep-color, 205 208 214));
}
.ds-line.active {
  background-color: rgb(var(--primary-color));
}
.ds-section {
  flex: 1 1 auto;
  min-width: 0;
  padding-bottom: 40px;
}
.ds-step-last .ds-section {
  padding-bottom: 8px;
}

.ds-title {
  font-size: 14px;
  font-weight: 500;
  line-height: 22px;
  color: rgb(var(--base-text-color));
}
/* 步骤②标题行：标题 + 添加按钮（间距 16） */
.ds-title-row {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-bottom: 16px;
}
.ds-hint {
  font-size: 12px;
  color: rgb(var(--text-hint-color));
  margin: 0 0 16px;
}
/* 目标明细表下拉（367px 宽） */
.ds-table-select {
  max-width: 367px;
  margin-top: 16px;
}
.ds-table-empty {
  margin-top: 16px;
  align-items: flex-start;
}

/* 排序键行（整行描边圆角 8，右侧删除格竖线分隔） */
.ds-key-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.ds-key-row {
  display: flex;
  align-items: stretch;
  width: fit-content;
  border: 1px solid rgb(var(--border-color));
  border-radius: 8px;
  background-color: #fff;
}
.ds-key-main {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 8px 12px 8px 4px;
  border-right: 1px solid rgb(var(--border-color));
}
.ds-key-handle {
  flex: 0 0 auto;
  color: rgb(var(--text-hint-color));
}
.ds-key-fields {
  display: flex;
  align-items: center;
  gap: 16px;
}
.ds-key-field {
  width: 242px;
}
.ds-key-order {
  width: 98px;
}
/* 上下移按钮堆叠：24 宽两半品牌色，圆角 4，极浅描边分隔 */
.ds-key-move {
  flex: 0 0 24px;
  width: 24px;
  display: flex;
  flex-direction: column;
  border-radius: 4px;
  overflow: hidden;
}
.ds-move-btn {
  height: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  padding: 0;
  background-color: rgb(var(--primary-color));
  color: #fff;
  cursor: pointer;
}
.ds-move-btn + .ds-move-btn {
  border-top: 0.5px solid #f2f5fc;
}
.ds-move-btn:hover:not(:disabled) {
  background-color: rgb(var(--primary-color) / 0.85);
}
.ds-move-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
/* 行尾删除格（竖线分隔的独立格，16px ✕） */
.ds-key-remove {
  flex: 0 0 24px;
  width: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  color: rgb(var(--text-secondary-color));
  font-size: 12px;
  cursor: pointer;
}
.ds-key-remove:hover {
  color: rgb(var(--error-color));
}

/* 未选表缺省页（icon-缺省页2 107px + 提示文字） */
.ds-empty {
  width: 456px;
  max-width: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 40px 0 24px;
}
.ds-empty-icon {
  width: 107px;
  height: 107px;
  font-size: 107px;
}
.ds-empty-text {
  font-size: 12px;
  line-height: 22px;
  color: rgb(var(--text-hint-color));
}
</style>
