<script lang="ts">
import type { TemplateDataTable, TemplateField } from './hostTypes';

/** 递给编辑器的「本表单表」条目：与取数配置面的 formTablesForInput 同形（表 + 字段 + bt* 别名）。 */
export interface FormTableLite {
  table: TemplateDataTable;
  fields: TemplateField[];
  alias: string;
}

/**
 * 语法检查三态（与共享包 SyntaxStatusLine.vue 的 SyntaxStatusState 同枚举）。
 * 共享包的 exports 白名单只放行 `.`（深路径被拦死）且 index.ts 未导出该类型，故本地重声明；
 * 共享包改枚举时须同步本处（消费方＝NodeConfigDialog 条件页页脚状态条）。
 */
export type ConditionSyntaxState = 'idle' | 'typing' | 'checking' | 'ok' | 'error';
</script>

<script setup lang="ts">
/**
 * ConditionV4Editor —— 条件节点的 V4 判断表达式编辑面板。
 *
 * 形态：**内嵌**，不再套一层弹窗——编辑条件分支时配置页本身就是表达式编辑界面。故本组件直接渲染共享包的通用表达式面板
 * AdvancedExpressionPanel（purpose='where'），由节点配置弹窗的条件页把它嵌在 tab 里。
 *
 * 定位仍是**薄包装**，只做三件事——
 *   ① 在 setup 顶层把宿主桥与引用语法 provide 下去（Vue 注入约束：只能在 setup 顶层调用）：
 *      - AliceV4Host（生产桥，tokenize/restore/diagnose 走它）；
 *      - RefSyntax='brackets'（字段树点击插入 `本报表.[表].[字段]`）；
 *      - ExpressionHost = createV4ExpressionHost(3.4 桥, V4 桥, { wherePurpose: 'condition' })，
 *        即「目录/表/字段照旧走 3.4 桥，唯独 lowerText 转接到 V4 tokenize 且落 condition 用途」；
 *   ② 把面板的 confirm 能力经 defineExpose 转出去——面板是「确认时才产出」的组件（要把文本送
 *      lowerText 端点 tokenize），故父级的保存流程必须先驱动 confirm、拿到回调才真正提交；
 *   ③ 把确认载荷里的 3.4 sidecar 翻成整份 V4 表达式文档（textSourceToV4ExpressionDocument）。
 *
 * 为什么要整份 V4 文档而不是 sidecar：sidecar 的 refs 只有 {stable_id,label} 二元组，重开会丢绑定；
 * 条件节点持久化的是文档级 conditions 池条目，必须带 token 化 source_text + 完整 refs
 * （见 compile.ts registerCondition 与共享包 v4ExpressionHostAdapter 头注释）。
 *
 * 随身包缺席（textSourceToV4ExpressionDocument 返回 null）意味着这份 sidecar 不是 V4 适配器产出的
 * ——实际只可能是宿主桥缺席/降级导致，故 emit('error') 让父级就地提示且**不提交不关窗**，绝不半造
 * 一份没有绑定表的文档落库（服务端必报「未提供稳定引用 #{rN} 的绑定」）。
 */
import { computed, ref } from 'vue';
import {
  AdvancedExpressionPanel,
  createV4ExpressionHost,
  provideAliceV4Host,
  provideExpressionHost,
  provideRefSyntax,
  textSourceToV4ExpressionDocument,
  type AliceV4Host,
  type ConditionGroup,
  type ExpressionHost,
  type TextSource,
  type V4ExpressionDocument
} from '@kimposoft/expression-editor';
import type { ConditionV4Spec } from './model';

const props = withDefaults(
  defineProps<{
    /** 外层弹窗是否可见：透传给面板（它据此在每次打开时按 sidecar 复位文本）。 */
    show: boolean;
    /** 当前草稿条件（父级 draft.guardV4）；null=尚未配置，从空文本开始。 */
    spec: ConditionV4Spec | null;
    /** 本模板全部表（主表在前）+ 各自字段，alias 为 bt0..n。 */
    tables: FormTableLite[];
    /** 宿主注入的 3.4 表达式域桥（目录/表/字段等原样委派给它）。 */
    expressionHost: ExpressionHost;
    /** 宿主注入的 V4 生产桥。 */
    v4Host: AliceV4Host;
    /** 本条件节点的稳定 ID（= 产出文档的 expression_id）。 */
    conditionId: string;
    /**
     * 内嵌壳高（px）：面板内部按 `shellHeight − CHROME_PX(144)` 换算树坞/编辑区分栏可用空间，
     * 故父级传的是「容器真实高度 + 144」（见 NodeConfigDialog.conditionShellHeight）。
     * 缺省 660 = 取数「筛选条件」弹窗的默认窗口高，父级量不到容器时的同款回落。
     */
    shellHeight?: number;
  }>(),
  { shellHeight: 660 }
);

const emit = defineEmits<{
  /** 用户改了表达式并确认：带整份 V4 文档 + 用户可读原文。 */
  confirm: [payload: { expression: V4ExpressionDocument; readableText: string }];
  /** 文本未改（digest 不变）：父级保留既有 spec 原样。 */
  unchanged: [];
  /** 无法产出 V4 文档（随身包缺席/清空文本）：父级就地提示，不提交。 */
  error: [];
}>();

// 🔴 三个 provide 必须在 setup 顶层同步执行（Vue 注入约束），不能塞进 watch/事件回调里。
provideAliceV4Host(props.v4Host);
// 🔴 字段引用语法必须是方括号（缺省 braces 时字段树点击插入 3.4 的 `{字段}`，
// V4 分词报 ALICE_SYNTAX_LEX_INVALID）。与取数配置面 ActionConfigSurface.vue 同款：V4 文本只认
// `本报表.[表].[字段]` 三段保留形态。
provideRefSyntax('brackets');
// where 档落 'condition' 用途：动作条件分支的谓词根允许聚合，与取数②筛选条件的 'filter' 不同档。
provideExpressionHost(createV4ExpressionHost(props.expressionHost, props.v4Host, { wherePurpose: 'condition' }));

/**
 * 把草稿条件翻成编辑器认得的 3.4 sidecar：显示层用可读原文（缺省回落 token 化源码），
 * 随身包 `v4` 原样带上文档里已有的 source_text/refs——用户不编辑直接确认时走 unchanged 分支，
 * 一旦编辑则由适配器重新 tokenize 覆盖，两条路径都不会丢绑定。
 */
const whereTextSource = computed<TextSource | null>(() => {
  const spec = props.spec;
  if (!spec) return null;
  return {
    text: spec.readableText ?? spec.expression.source_text,
    pack_revision: 'alice-v4',
    digest: spec.expression.normalized_digest ?? '',
    refs: spec.expression.refs.map(r => ({ stable_id: r.ref_id, label: r.last_label })),
    v4: { source_text: spec.expression.source_text, refs: spec.expression.refs }
  };
});

/** 面板 defineExpose 的可消费面（见 AdvancedExpressionPanel.vue 尾部 defineExpose）。 */
interface PanelExposed {
  confirm: () => Promise<void> | void;
  syntaxState?: ConditionSyntaxState;
  syntaxLabel?: string;
  syntaxDetail?: string;
  focusIssue?: () => void;
  confirmDisabled?: boolean;
  dirty?: boolean;
  /** Esc 内层分流用：树坞搜索是否有内容 / 清空（面板 defineExpose，可选调用兼容单测 stub）。 */
  isSearching?: () => boolean;
  clearSearch?: () => void;
}

/** 面板实例：父级保存流程经本组件 defineExpose 的 confirm() 驱动它确认。 */
const panelRef = ref<PanelExposed | null>(null);

/**
 * 面板确认回包（purpose='where'）：结构化条件 `condition` 在 V4 链路里恒为 null（真实内容全在
 * textSource 的随身包里），故只取 textSource 翻文档。
 * 清空文本（textSource=null）同样按「产不出文档」处理：条件节点没有「空条件」这一档——空表达式
 * 会被 validate.ts 的 conditionMissing 拦下，这里不落一个空壳文档。
 */
function onConfirmWhere(payload: { condition: ConditionGroup | null; textSource: TextSource | null }): void {
  const textSource = payload.textSource;
  const doc = textSource ? textSourceToV4ExpressionDocument(textSource, props.conditionId, 'condition') : null;
  if (!doc || !textSource) {
    emit('error');
    return; // 不提交：让用户看得到提示，也保住已写的表达式
  }
  emit('confirm', { expression: doc, readableText: textSource.text });
}

// 供父级 onSave 驱动：面板 confirm() 是异步的（要等 lowerText 回包），把 Promise 原样透出，
// 父级据此在 finally 里复位「确认在途」旗，避免面板拦下（语法错/未解析标签）时保存按钮卡死。
//
// 语法状态四件套 + confirmDisabled/dirty 一并转出（对齐取数「筛选条件」弹窗）：
// 面板此处按 syntax-status-placement="external" 自己不渲染状态条，由宿主壳摆放——内嵌形态下
// 宿主壳就是节点配置弹窗的条件页（见 NodeConfigDialog 的 .ncd-guard-status），它经本组件读这几个值。
// 用 computed 转发（不是取值快照）：defineExpose 的结果会走 proxyRefs 自动解包，父级模板里
// `conditionPanelRef?.syntaxState` 读到的是解包后的值且保持响应式。
defineExpose({
  confirm: () => panelRef.value?.confirm(),
  syntaxState: computed<ConditionSyntaxState>(() => panelRef.value?.syntaxState ?? 'idle'),
  syntaxLabel: computed(() => panelRef.value?.syntaxLabel ?? ''),
  syntaxDetail: computed(() => panelRef.value?.syntaxDetail ?? ''),
  confirmDisabled: computed(() => panelRef.value?.confirmDisabled ?? false),
  dirty: computed(() => panelRef.value?.dirty ?? false),
  focusIssue: () => panelRef.value?.focusIssue?.(),
  // Esc 内层分流：节点配置弹窗的 escapeInterceptor 据此先清空树坞搜索，再轮到关窗
  isSearching: () => panelRef.value?.isSearching?.() ?? false,
  clearSearch: () => panelRef.value?.clearSearch?.()
});
</script>

<template>
  <!-- AdvancedExpressionPanel 是多根片段（树坞 / 分隔条 / 编辑区三个直接 flex 子项），故本组件包一层
       flex 列容器：既给它正确的布局上下文，也让本组件保持单根（属性透传不告警）。
       source-tables 恒空——条件分支没有「取数来源表」概念。
       装配三件套（hide-persistent-hints / compact-function-bar / syntax-status-placement）与取数
       「筛选条件」弹窗 ExpressionDialogShell.vue 逐字一致，保证两处观感统一：
       ① 隐藏文本框下方那段 3.4 口径的常驻说明（对 V4 条件是误导）；② 函数横条只留九个常用项、
       其余收进「更多」；③ 语法状态条外置给宿主壳摆放。前两项还同时把面板切进紧凑布局
       （编辑区最小高 270→210），把省下的高度还给字段树坞。 -->
  <div class="cv4-panel">
    <AdvancedExpressionPanel
      ref="panelRef"
      :show="show"
      purpose="where"
      :model-value="null"
      :text-source="whereTextSource"
      :source-tables="[]"
      :form-tables="tables"
      :shell-height="shellHeight"
      :hide-persistent-hints="true"
      :compact-function-bar="true"
      syntax-status-placement="external"
      @confirm-where="onConfirmWhere"
      @confirm-unchanged="emit('unchanged')"
    />
  </div>
</template>

<style scoped>
/* 填满父级（.ncd-guard-panel）分给的高度：面板的分栏换算吃的是父级量出来的真实高度，
   本容器只要不按内容自然撑开即可（flex:1 + min-height:0）。 */
.cv4-panel {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
}
</style>
