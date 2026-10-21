<script setup lang="ts">
import { computed, ref } from 'vue';
import { NInput, NInputNumber, NRadioButton, NRadioGroup, useThemeVars } from 'naive-ui';
import { KControlSize, type KControlSizeTiers } from '@kimposoft/ui-kit';
import { t as $t } from '../i18n';

/**
 * 提示语（ui.message）专用配置面板——Kimpo 设计层动作设计器 NodeConfigDialog 的特化渲染。
 * 动作本体由 kimpo-ui-controllers 插件提供，本面板只是宿主侧的参数编辑 UI，产物仍走插件
 * params_schema 契约（level + text + duration）。
 *
 * 三步骤：①提示类型（信息/成功/警告/错误 分段切换）②提示内容（纯文本，上限 120 字，后端
 * 不做表达式求值）③持续时间（3/5/10 秒与「永久」快捷档，或 1~60 秒自定义，缺省 3 秒）；
 * 右侧为实时预览提示卡片。
 * 框架级「异步执行」开关统一由 NodeConfigDialog 头部「选项」按钮承载（面板自身不再提供第二个
 * 「选项」入口）。
 *
 * ── 预览口径 ──────────────────
 * 预览卡片按**填报态真实观感**还原。填报态的落点是宿主全局 message：表格编辑器的 `message.show`
 * handler → showHostMessage → SDK HostMessageClient → 宿主注入的 naive-ui `useMessage()`，
 * 其形态由平台统一控制、不由单个动作定义，因此：
 * - **无标题行**：message 无标题位，预览只画正文（用户文案在主位）；
 * - **无宽度档**：ui.message 的 params_schema 未声明 width，真实宽度是 naive message 的
 *   min 420 / max 720px 按内容自适应（下方 schemaHasProperty 的 feature-detect 只服务 duration）；
 * - **关闭角标**：运行时只有「永久」档才带（duration=0 才 closable），故预览跟随 ③ 的档位联动。
 * 卡片的底色/文字色/图标色/圆角/阴影一律取 naive 主题变量（useThemeVars）；图标为自绘线框图标，
 * 颜色取主题功能色（--msg-icon-color），主题切换时预览自动跟随。
 *
 * 档位持久化受插件契约门控：ui.message 的 params_schema 声明了哪些属性，本面板才敢往 params 里
 * 落哪些键（多余键会被后端 ValidateParams 整单拒绝，连 level/text 都保存不了）。duration 插件
 * 已声明（integer，0=永久，1~60 自定义）→ 正常落 params.duration；老插件二进制未声明时降级为
 * 本地档位（只改预览、不入库）。
 */
const props = defineProps<{
  params: Record<string, unknown>;
  /** 动作 params_schema（用于探测插件是否已支持 duration 属性，见头注契约门控）。 */
  paramsSchema?: Record<string, unknown>;
}>();

const emit = defineEmits<{
  patch: [partial: Record<string, unknown>];
}>();

type MessageLevel = 'info' | 'success' | 'warning' | 'error';
const LEVELS: readonly MessageLevel[] = ['info', 'success', 'warning', 'error'] as const;

/** 当前提示类型（params 为权威；历史脏数据容错回落 info，与插件 schema 缺省一致）。 */
const level = computed<MessageLevel>(() => {
  const v = props.params.level;
  return v === 'success' || v === 'warning' || v === 'error' ? v : 'info';
});
function setLevel(v: MessageLevel): void {
  emit('patch', { level: v });
}

/** 提示内容（纯字符串；插件侧 v1 不做表达式求值，上限 120 与 NInput maxlength 同源）。 */
const text = computed<string>(() => (typeof props.params.text === 'string' ? props.params.text : ''));
function setText(v: string): void {
  emit('patch', { text: v });
}

/** 插件 schema 是否已声明某属性（声明后才允许把该档位落 params，见头注契约门控）。 */
function schemaHasProperty(name: string): boolean {
  const properties = (props.paramsSchema as { properties?: Record<string, unknown> } | undefined)?.properties;
  return !!properties && name in properties;
}

// ── 持续时间（快捷档 3/5/10 秒 + 永久，或 1~60 秒自定义）────────────────────────
/** 快捷档秒数；0 = 永久（不自动关闭，填报态由 editor 侧强制带关闭角标）。 */
const DURATION_QUICK = [3, 5, 10, 0] as const;
const PERMANENT_DURATION = 0;
const DEFAULT_DURATION = 3;
const CUSTOM_DURATION_MIN = 1;
const CUSTOM_DURATION_MAX = 60;

const durationPersistable = computed(() => schemaHasProperty('duration'));
/** schema 未支持 duration（老插件二进制）时的本地档位（不入库，关窗即弃）。 */
const localDuration = ref<number>(DEFAULT_DURATION);
/** 当前秒数（params 为权威；历史脏数据/越界值容错回落 3 秒，与插件 schema 缺省一致）。 */
const duration = computed<number>(() => {
  if (!durationPersistable.value) return localDuration.value;
  const v = props.params.duration;
  const legal = typeof v === 'number' && Number.isInteger(v) && v >= PERMANENT_DURATION && v <= CUSTOM_DURATION_MAX;
  return legal ? v : DEFAULT_DURATION;
});
function setDuration(v: number): void {
  if (durationPersistable.value) emit('patch', { duration: v });
  else localDuration.value = v;
}

/**
 * 「自定义」片是否选中：秒数不在快捷档中恒为自定义；秒数恰好等于快捷值时，
 * 由用户是否点过「自定义」决定（否则点了自定义又被 3/5/10 抢回选中态）。
 */
const customPicked = ref(false);
const isCustomDuration = computed(
  () => customPicked.value || !(DURATION_QUICK as readonly number[]).includes(duration.value)
);
function pickQuickDuration(v: number): void {
  customPicked.value = false;
  setDuration(v);
}
/** 切到自定义：当前值不在可输入区间（如从「永久」切来）时补默认 3 秒，避免输入框显示越界值。 */
function pickCustomDuration(): void {
  customPicked.value = true;
  if (duration.value < CUSTOM_DURATION_MIN || duration.value > CUSTOM_DURATION_MAX) setDuration(DEFAULT_DURATION);
}
/** 自定义秒数输入：非法/清空回落默认值，越界夹到 1~60（与插件 ValidateParams 的判据同源）。 */
function setCustomDuration(v: number | null): void {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    setDuration(DEFAULT_DURATION);
    return;
  }
  const seconds = Math.round(v);
  setDuration(Math.min(CUSTOM_DURATION_MAX, Math.max(CUSTOM_DURATION_MIN, seconds)));
}

/** 持续时间分段选项：三个秒数档 + 永久 + 自定义。 */
const durationOptions = computed(() => [
  ...DURATION_QUICK.filter(v => v !== PERMANENT_DURATION).map(v => ({
    key: String(v),
    value: v,
    label: $t('actionDesigner.dialog.message.durationSeconds', { n: v }),
    active: !isCustomDuration.value && duration.value === v
  })),
  {
    key: 'permanent',
    value: PERMANENT_DURATION,
    label: $t('actionDesigner.dialog.message.durationPermanent'),
    active: !isCustomDuration.value && duration.value === PERMANENT_DURATION
  },
  {
    key: 'custom',
    value: -1,
    label: $t('actionDesigner.dialog.message.durationCustom'),
    active: isCustomDuration.value
  }
]);
/** 当前选中的持续时间档 key（NRadioGroup 的受控值；无选中时为 null）。 */
const activeDurationKey = computed<string | null>(() => durationOptions.value.find(opt => opt.active)?.key ?? null);
/** 分段点选：自定义档与快捷档走不同入口（与原 @click 分支一致）。 */
function onPickDuration(key: string): void {
  const opt = durationOptions.value.find(o => o.key === key);
  if (!opt) return;
  if (key === 'custom') pickCustomDuration();
  else pickQuickDuration(opt.value);
}

/** 预览注脚：说明这条提示会停留多久（永久档另给「需手动关闭」的说法）。 */
const durationHint = computed(() =>
  duration.value === PERMANENT_DURATION
    ? $t('actionDesigner.dialog.message.durationHintPermanent')
    : $t('actionDesigner.dialog.message.durationHint', { n: duration.value })
);

/** 类型分段选项（顺序：信息/成功/警告/错误）。 */
const levelOptions = computed(() =>
  LEVELS.map(v => ({ value: v, label: $t(`actionDesigner.dialog.message.${v}`) }))
);
/**
 * 分段器（NRadioGroup）尺寸钉定。
 * 目标尺寸：槽高 32（含 1px 描边），片宽 68（类型）/ 56（持续时间），字号 12；
 * 故 small 档：height 32、fontSize 12；片宽在下方 scoped 样式里钉定。
 */
const SEG_TIERS: KControlSizeTiers = { small: { height: 32, fontSize: 12 } };

/** 预览卡片正文：未填内容时回落示例文案。 */
const previewBody = computed(() => text.value || $t('actionDesigner.dialog.message.previewSample'));

/**
 * 预览关闭角标：与填报态同判据——只有「永久」档才带（表格编辑器在
 * duration=0 时才给 { duration: 0, closable: true }），
 * 其余档位由宿主按时长自动收起，运行时并无关闭角标。
 */
const previewClosable = computed(() => duration.value === PERMANENT_DURATION);

// ── 预览卡片主题变量：与运行时的宿主 naive-ui message 同源 ──────────────────────
// 取值对应 naive-ui message light/dark 主题（es/message/styles/light.mjs）：
// color=popoverColor / textColor=textColor2 / boxShadow=boxShadow2 /
// iconColor{Info,Success,Warning,Error}=对应功能色 / closeIconColor / borderRadius / lineHeight。
const themeVars = useThemeVars();
const LEVEL_ICON_VAR = {
  info: 'infoColor',
  success: 'successColor',
  warning: 'warningColor',
  error: 'errorColor'
} as const;
const previewVars = computed<Record<string, string>>(() => ({
  '--msg-bg': themeVars.value.popoverColor,
  '--msg-text': themeVars.value.textColor2,
  '--msg-shadow': themeVars.value.boxShadow2,
  '--msg-radius': themeVars.value.borderRadius,
  '--msg-line-height': String(themeVars.value.lineHeight),
  '--msg-icon-color': themeVars.value[LEVEL_ICON_VAR[level.value]],
  '--msg-close-color': themeVars.value.closeIconColor
}));
</script>

<template>
  <div class="msg-panel">
    <div class="msg-layout">
      <!-- 左列：三步骤（左轨圆点+连线；三项均有缺省值，恒为已完成=品牌色） -->
      <div class="msg-config">
        <!-- ① 提示类型 -->
        <div class="msg-step-row">
          <div class="msg-rail">
            <span class="msg-dot">1</span>
            <span class="msg-line" />
          </div>
          <div class="msg-section">
            <div class="msg-title">{{ $t('actionDesigner.dialog.message.typeTitle') }}</div>
            <!-- NRadioGroup + NRadioButton 分段（高 32 / 字号 12 经 SEG_TIERS 钉定） -->
            <KControlSize :tiers="SEG_TIERS">
              <NRadioGroup
                class="msg-seg msg-seg-level"
                size="small"
                :value="level"
                data-testid="message-level-seg"
                @update:value="(v: MessageLevel) => setLevel(v)"
              >
                <NRadioButton
                  v-for="opt in levelOptions"
                  :key="opt.value"
                  :value="opt.value"
                  :data-testid="`message-level-${opt.value}`"
                >
                  {{ opt.label }}
                </NRadioButton>
              </NRadioGroup>
            </KControlSize>
          </div>
        </div>

        <!-- ② 提示内容 -->
        <div class="msg-step-row">
          <div class="msg-rail">
            <span class="msg-dot">2</span>
            <span class="msg-line" />
          </div>
          <div class="msg-section">
            <div class="msg-title">{{ $t('actionDesigner.dialog.message.contentTitle') }}</div>
            <NInput
              size="medium"
              class="msg-content-input"
              type="textarea"
              :value="text"
              :maxlength="120"
              show-count
              :placeholder="$t('actionDesigner.dialog.message.contentPlaceholder')"
              data-testid="message-content-input"
              @update:value="setText"
            />
          </div>
        </div>

        <!-- ③ 持续时间：3/5/10 秒与「永久」快捷档 + 自定义秒数（选中自定义后右侧出输入框） -->
        <div class="msg-step-row msg-step-last">
          <div class="msg-rail">
            <span class="msg-dot">3</span>
          </div>
          <div class="msg-section">
            <div class="msg-title">{{ $t('actionDesigner.dialog.message.durationTitle') }}</div>
            <div class="msg-duration-row">
              <KControlSize :tiers="SEG_TIERS">
                <NRadioGroup
                  class="msg-seg msg-seg-duration"
                  size="small"
                  :value="activeDurationKey"
                  data-testid="message-duration-seg"
                  @update:value="(k: string) => onPickDuration(k)"
                >
                  <NRadioButton
                    v-for="opt in durationOptions"
                    :key="opt.key"
                    :value="opt.key"
                    :data-testid="`message-duration-${opt.key}`"
                  >
                    {{ opt.label }}
                  </NRadioButton>
                </NRadioGroup>
              </KControlSize>
              <!-- 自定义秒数：仅「自定义」档显示，1~60 秒（上界与插件 ValidateParams 同源） -->
              <NInputNumber
                v-if="isCustomDuration"
                class="msg-duration-input"
                size="small"
                :value="duration"
                :min="CUSTOM_DURATION_MIN"
                :max="CUSTOM_DURATION_MAX"
                :precision="0"
                data-testid="message-duration-custom-input"
                @update:value="setCustomDuration"
              >
                <template #suffix>{{ $t('actionDesigner.dialog.message.durationUnit') }}</template>
              </NInputNumber>
            </div>
          </div>
        </div>
      </div>

      <!-- 右列：实时预览——还原填报态真实观感（宿主 naive-ui message），见 script 头注「预览口径」 -->
      <div class="msg-preview">
        <div class="msg-title">{{ $t('actionDesigner.dialog.message.preview') }}</div>
        <div class="msg-preview-board">
          <div class="msg-toast" :class="`msg-toast-${level}`" :style="previewVars" data-testid="message-preview-card">
            <!-- 类型图标：自绘线框图标（24×24，描边 2），stroke 与圆点 fill 均走 currentColor，
                 颜色取主题功能色（.msg-toast-icon 的 --msg-icon-color） -->
            <span class="msg-toast-icon">
              <svg v-if="level === 'success'" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="9" />
                <path d="M8 12.3l2.8 2.7L16 9.5" />
              </svg>
              <svg v-else-if="level === 'warning'" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="9" />
                <path d="M12 7.5V13" />
                <circle cx="12" cy="16.5" r="1.1" fill="currentColor" stroke="none" />
              </svg>
              <svg v-else-if="level === 'error'" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="9" />
                <path d="M9 9l6 6M15 9l-6 6" />
              </svg>
              <svg v-else viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="9" />
                <path d="M12 11v5.5" />
                <circle cx="12" cy="7.75" r="1.1" fill="currentColor" stroke="none" />
              </svg>
            </span>
            <!-- 正文：运行态 message 把用户文案放在主文位（14px 主要文字色），预览同此层级 -->
            <span class="msg-toast-content">{{ previewBody }}</span>
            <!-- 关闭角标：仅「永久」档才画，与填报态 resolveMessageDurationOptions 同判据 -->
            <span v-if="previewClosable" class="msg-toast-close" data-testid="message-preview-close">
              <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
                <path d="M3.3,3.3 L12.7,12.7 M12.7,3.3 L3.3,12.7" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
              </svg>
            </span>
          </div>
        </div>
        <!-- 停留时长注脚：③ 的配置在静态预览里看不出来，用一行文字说明填报态的实际表现 -->
        <div class="msg-preview-hint" data-testid="message-duration-hint">{{ durationHint }}</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.msg-panel {
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 4px 4px 16px;
}

/* 双列：左配置(458) + 右预览自适应。预览基宽取 420——naive message 的 minWidth 即 420px
   （es/message/styles/_common.mjs），基宽与之对齐后弹窗够宽时卡片能整条展开，窄时整列换行 */
.msg-layout {
  display: flex;
  flex-wrap: wrap;
  gap: 24px 80px;
}
.msg-config {
  flex: 0 0 458px;
  max-width: 100%;
}
.msg-preview {
  flex: 1 1 420px;
  min-width: 0;
}

/* 步骤行：左轨（圆点+连线）+ 右内容（与联动表单面板同构；本面板三步均有缺省值，恒为品牌色） */
.msg-step-row {
  display: flex;
  gap: 16px;
}
.msg-rail {
  flex: 0 0 28px;
  display: flex;
  flex-direction: column;
  align-items: center;
}
.msg-dot {
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
.msg-line {
  flex: 1 1 auto;
  width: 2px;
  min-height: 24px;
  margin: 8px 0;
  background-color: rgb(var(--primary-color));
}
.msg-section {
  flex: 1 1 auto;
  min-width: 0;
  padding-bottom: 44px;
}
.msg-step-last .msg-section {
  padding-bottom: 8px;
}
.msg-title {
  font-size: 14px;
  font-weight: 500;
  line-height: 22px;
  color: rgb(var(--base-text-color));
}

/* 分段切换（NRadioGroup）：
   槽高 32、上方留白 40px、类型片宽 68、持续时间片宽 56（含 padding），字号 12。
   NRadioButton 默认内边距 0 14px 且宽度随文字，故用固定 width + 居中复现原片宽（布局属性，非组件变量）。 */
.msg-seg {
  /* flex + fit-content：块级盒避免 inline-block 基线在所在行里多撑几像素 */
  display: flex;
  width: fit-content;
  margin-top: 40px;
}
.msg-seg :deep(.n-radio-button) {
  box-sizing: border-box;
  padding: 0 4px;
  text-align: center;
  justify-content: center;
}
.msg-seg-level :deep(.n-radio-button) {
  width: 68px;
}
/* 五片（比类型段多一片）故取 56px：左列 458 扣掉步骤轨 28 与轨距 16 后正文只剩 414，
   5×56 + 分隔线 ≈ 284，加 12 间距 + 100 输入框 = 396，保证选中「自定义」后秒数输入框
   与分段器同行、不换行抖动 */
.msg-seg-duration :deep(.n-radio-button) {
  width: 56px;
}
/* ③ 行：分段器 + 自定义秒数输入框底对齐（分段器自带 40px 上间距，故不能用 center 对齐） */
.msg-duration-row {
  display: flex;
  align-items: flex-end;
  flex-wrap: wrap;
  gap: 12px;
}
.msg-duration-input {
  width: 100px;
}

/* ② 提示内容输入框（414×78、常用描边、12px 正文、右下 10px 计数） */
.msg-content-input {
  max-width: 414px;
  margin-top: 19px;
}
.msg-content-input :deep(.n-input__textarea-el),
.msg-content-input :deep(.n-input__placeholder) {
  font-size: 12px;
}
.msg-content-input :deep(textarea.n-input__textarea-el) {
  min-height: 78px;
  resize: none; /* 输入框不显示右下角拖拽角标 */
}
.msg-content-input :deep(.n-input-word-count) {
  font-size: 10px;
  color: rgb(var(--text-hint-color));
}

/* 右列预览画布：浅色底 + 常用描边，卡片绝对居中；卡片最小宽 420 放不下时横向滚动，
   宁可出滚动条也不缩卡片——缩了尺寸就不再是填报态真实宽度，预览会重新变得不可信 */
.msg-preview-board {
  margin-top: 16px;
  height: 330px;
  border: 1px solid rgb(var(--border-color));
  border-radius: 4px;
  background-color: rgb(var(--fill-light-color, 245 247 250));
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: auto;
}

/* 停留时长注脚（③ 的口头说明，画布下方一行小字） */
.msg-preview-hint {
  margin-top: 8px;
  font-size: 12px;
  line-height: 20px;
  color: rgb(var(--text-secondary-color));
}

/* 预览提示卡片 = 填报态宿主 naive-ui message 的真实观感（尺寸取自 es/message/styles/_common.mjs：
   padding 10px 20px / minWidth 420 / maxWidth 720 / fontSize 14 / iconSize 20 与 iconMargin 0 10px 0 0 /
   closeIconSize 16 与 closeMargin 0 0 0 10px），色值经 previewVars 取自 naive 主题变量，随主题切换。
   msg-toast-{level} 类只作类型钩子，配色一律走 --msg-icon-color，不在此处写死功能色。 */
.msg-toast {
  box-sizing: border-box;
  flex: none;
  display: flex;
  align-items: center;
  min-width: 420px;
  max-width: 720px;
  padding: 10px 20px;
  border-radius: var(--msg-radius, 3px);
  background-color: var(--msg-bg, #fff);
  box-shadow: var(--msg-shadow, 0 3px 6px -4px rgb(0 0 0 / 0.12), 0 6px 16px 0 rgb(0 0 0 / 0.08), 0 9px 28px 8px rgb(0 0 0 / 0.05));
  color: var(--msg-text, rgb(51, 54, 57));
  font-size: 14px;
  line-height: var(--msg-line-height, 1.6);
  text-align: left;
}
.msg-toast-icon {
  flex: none;
  display: inline-flex;
  margin: 0 10px 0 0;
  color: var(--msg-icon-color, currentColor);
}
.msg-toast-content {
  flex: 1 1 auto;
  min-width: 0;
  word-break: break-word;
}
.msg-toast-close {
  flex: none;
  display: inline-flex;
  margin: 0 0 0 10px;
  color: var(--msg-close-color, rgb(51, 54, 57));
}
</style>
