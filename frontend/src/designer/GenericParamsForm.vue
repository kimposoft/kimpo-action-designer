<script setup lang="ts">
/**
 * 动作节点「通用参数表单」。
 *
 * 链路：动作设计器插件（kimpo-action-designer，设计态）· NodeConfigDialog —— 动作既不是表达式动作、也没有挂上
 * action-config 面板时，由本组件按 params_schema 顶层 properties 渲染：
 *   - boolean → 开关；number / integer → 数字框；带 enum → 下拉；string → 单行输入；
 *   - 字段目标数组（SDK biz.Targets 形状，识别见 genericParamForm.ts）→ 按数据表分组的字段下拉，maxItems=1 单选；
 *   - 其余数组 / 对象 → JSON 文本框（不认识的复杂参数不猜）。
 * 必填项标签带必填标记；minLength / maxLength、minimum / maximum、minItems / maxItems 显示在控件下方作提示，不拦截保存
 *（保存期由插件 ValidateParams 权威校验）。
 *
 * default 预填：本组件只在这条分支真正渲染时挂载，挂载时把「参数里还没有、schema 写了 default」的项经 patch 补进草稿，
 * 随保存写入；已有值不覆盖，只读打开不补。
 *
 * 字段候选来自宿主下发的本模板表 × 字段目录（fieldGroups，与触发字段下拉同源），只用作选项、不读写业务数据；
 * 取不到目录（定时任务 / 无模板上下文）时字段目标参数回落 JSON 文本框。
 */
import { computed, onMounted } from 'vue';
import { NFormItem, NInput, NInputNumber, NSelect, NSwitch } from 'naive-ui';
import type { SelectGroupOption, SelectOption } from 'naive-ui';
import { t as $t } from '../i18n';
import type { TemplateFieldGroup } from './hostTypes';
import {
  constraintHints,
  fieldTargetKey,
  fieldTargetsToKeys,
  keysToFieldTargets,
  missingDefaults,
  type GenericParamField
} from './genericParamForm';

const props = defineProps<{
  fields: GenericParamField[];
  params: Record<string, unknown>;
  /** 本模板数据表 × 字段（主表在前）；缺省或为空时字段目标参数回落 JSON 文本框。 */
  fieldGroups?: TemplateFieldGroup[];
  readonly?: boolean;
}>();

/** 增量回写：值为 undefined 表示删除该参数。 */
const emit = defineEmits<{ (e: 'patch', partial: Record<string, unknown>): void }>();

onMounted(() => {
  if (props.readonly) return;
  const defaults = missingDefaults(props.fields, props.params);
  if (Object.keys(defaults).length > 0) emit('patch', defaults);
});

/** 字段目标下拉候选：组头 = 表名，选项 = 字段名（不显示物理列名 / 字段 ID，与触发字段下拉同一口径）。 */
const targetOptions = computed<SelectGroupOption[]>(() =>
  (props.fieldGroups ?? []).map(group => ({
    type: 'group',
    label: group.table.table_name,
    key: group.table.data_table_id,
    children: group.fields.map<SelectOption>(f => ({
      label: f.field_name || f.field_code || f.field_id,
      value: fieldTargetKey(group.table.data_table_id, f.field_id)
    }))
  }))
);
const hasFieldCatalog = computed(() => targetOptions.value.some(g => (g.children?.length ?? 0) > 0));

/** 本参数实际用什么控件：字段目标数组在拿不到字段目录时回落 JSON。 */
function effectiveKind(field: GenericParamField): GenericParamField['kind'] {
  return field.kind === 'fieldTargets' && !hasFieldCatalog.value ? 'json' : field.kind;
}

function setParam(key: string, value: unknown): void {
  emit('patch', { [key]: value === '' || value === null ? undefined : value });
}

function jsonText(key: string): string {
  const v = props.params[key];
  return v === undefined ? '' : JSON.stringify(v);
}
function setJsonParam(key: string, raw: string): void {
  const text = raw.trim();
  if (text === '') {
    setParam(key, undefined);
    return;
  }
  try {
    setParam(key, JSON.parse(text));
  } catch {
    // 解析失败时不覆盖原值（保存期后端会再校验）。
  }
}

function targetSingle(field: GenericParamField): boolean {
  return field.maxItems === 1;
}
function targetValue(field: GenericParamField): string | string[] | null {
  const keys = fieldTargetsToKeys(props.params[field.key]);
  if (targetSingle(field)) return keys[0] ?? null;
  return keys;
}
function setTargetValue(field: GenericParamField, value: string | string[] | null): void {
  const keys = Array.isArray(value) ? value : value ? [value] : [];
  setParam(field.key, keysToFieldTargets(keys, field.maxItems));
}

/** 控件下方的约束提示（按界面语言）；没有约束返回 undefined（不占位）。 */
function feedbackOf(field: GenericParamField): string | undefined {
  const kind = effectiveKind(field);
  const parts = constraintHints({ ...field, kind }).map(h => $t(`actionDesigner.dialog.genericParam.${h.key}`, h.params));
  if (field.kind === 'fieldTargets' && kind === 'json') parts.unshift($t('actionDesigner.dialog.genericParam.fieldTargetsUnavailable'));
  return parts.length > 0 ? parts.join(' · ') : undefined;
}
</script>

<template>
  <NFormItem
    v-for="field in fields"
    :key="field.key"
    :label="field.label"
    size="small"
    :show-require-mark="field.required"
    :feedback="feedbackOf(field)"
    :show-feedback="feedbackOf(field) !== undefined"
    :data-param-key="field.key"
  >
    <NSwitch v-if="effectiveKind(field) === 'boolean'" :value="params[field.key] === true" @update:value="val => setParam(field.key, val)" />
    <NInputNumber
      v-else-if="effectiveKind(field) === 'number'"
      :value="(params[field.key] as number) ?? null"
      :min="field.minimum"
      :max="field.maximum"
      size="small"
      @update:value="val => setParam(field.key, val ?? undefined)"
    />
    <NSelect
      v-else-if="effectiveKind(field) === 'enum'"
      :value="(params[field.key] as string | number | null) ?? null"
      :options="(field.enum ?? []).map(v => ({ label: String(v), value: v as string }))"
      size="small"
      @update:value="val => setParam(field.key, val)"
    />
    <NInput
      v-else-if="effectiveKind(field) === 'string'"
      :value="(params[field.key] as string) ?? ''"
      :maxlength="field.maxLength"
      size="small"
      @update:value="val => setParam(field.key, val)"
    />
    <NSelect
      v-else-if="effectiveKind(field) === 'fieldTargets'"
      :value="targetValue(field)"
      :options="targetOptions"
      :multiple="!targetSingle(field)"
      :placeholder="$t('actionDesigner.dialog.genericParam.fieldTargetsPlaceholder')"
      filterable
      clearable
      size="small"
      data-testid="ncd-param-field-targets"
      @update:value="val => setTargetValue(field, val)"
    />
    <NInput
      v-else
      :value="jsonText(field.key)"
      type="textarea"
      size="small"
      :autosize="{ minRows: 1, maxRows: 4 }"
      placeholder="JSON"
      @update:value="val => setJsonParam(field.key, val)"
    />
  </NFormItem>
</template>
