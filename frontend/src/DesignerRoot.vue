<script setup lang="ts">
/**
 * DesignerRoot —— action-designer surface 的根组件。
 *
 * 内部组合 ActionDesignerDialog（弹窗外壳，拖拽/最大化/最小化/缩放）+ ActionDesigner（设计器本体），
 * scope 之外再透传一个 hostApi 注入面（见 ./designer/hostApi.ts）。
 *
 * 显隐语义：input.visible 是宿主侧唯一真源（host 拥有 actionDesignerVisible 等价状态），本组件
 * 对 ActionDesignerDialog 的 `show` 走**一次性单向绑定**（不用 v-model）——弹窗内部的最小化/最大化
 * 只改其自身局部 windowState，不触碰 show；只有点击右上角「关闭」才会让 show 变化，此时
 * ActionDesignerDialog 会同时 emit `update:show(false)` 与 `close`（同一处 close() 函数配对触发，
 * 见 ActionDesignerDialog.vue），二者语义重复，本组件只监听 `close` 一次调用 Host 的
 * input.requestClose；dirty 确认和 owned 会话关闭都留在 Host，插件不直接结束 handle。
 *
 * i18n 不在本组件的 input 形状内——按 SDK SurfaceCreateInput 现状（对齐
 * kimpo-workflow/frontend/src/surfaces/designer.ts 的取法），setHostI18n 在 ../surfaces/index.ts
 * 的 createSurface 分发处经 input.hostBridge.i18n 统一注入，早于本组件挂载。
 *
 * hostApi 同理不在 input 形状内：改经 hostBridge['domain:action-designer'] 单独传参
 * （与 record-controllers 的 'domain:expression' 先例同款），见 ../surfaces/index.ts 的
 * createSurface 分发处——那里已把 hostBridge 里取出的 hostApi 与 input 一并作为本组件的两个
 * 独立 prop 传入。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue';
import type {
  InteractiveSessionHandle,
  InteractiveSessionSnapshot
} from '@kimposoft/plugin-sdk';
import ActionDesignerDialog from './designer/ActionDesignerDialog.vue';
import ActionDesigner from './designer/ActionDesigner.vue';
import type { ActionDesignerHostApi } from './designer/hostApi';
import type { ActionDesignerTarget } from './designer/hostTypes';
import { t as $t } from './i18n';
import { isActionDesignerSessionEditable, shouldScrubActionDraft } from './interactiveSession';

/**
 * action-designer surface 的 input 形状（挂载方按此实现，详见 ./designer/hostApi.ts 顶部注释，
 * 该处同时列出了与本接口逐字段对应的完整 JSDoc 说明）。不含 hostApi——hostApi 走独立的
 * hostApi prop（对应 hostBridge['domain:action-designer']，见上方文件头注释）。
 *
 * 叠加 ActionDesignerTarget 判别联合（'template' | 'job'），承载定时任务持有
 * 独立动作文档的 job 模式挂载入参；旧挂载方只传 `{ scope, visible, ... }`（kind 缺省即
 * 'template'）无需改动。
 */
export type ActionDesignerSurfaceInput = ActionDesignerTarget & {
  visible: boolean;
  title?: string;
  /** 由 Host 显式声明；继承父会话的嵌套 surface 绝不能关闭父 handle。 */
  interactiveSessionOwnership: 'inherited' | 'owned';
  /** Host 统一处理 dirty 确认与 owned 会话关闭；取消时返回 false 并保持 surface。 */
  requestClose: () => Promise<boolean>;
};

const props = defineProps<{
  input: ActionDesignerSurfaceInput;
  hostApi: ActionDesignerHostApi;
  interactiveSession: InteractiveSessionHandle;
}>();

const sessionSnapshot = shallowRef<Readonly<InteractiveSessionSnapshot>>(props.interactiveSession.snapshot);
const hasActivated = ref(false);
const requestingEdit = ref(false);
const releasingConflict = ref(false);
const sessionFeedback = ref('');
let stopSessionChange: (() => void) | undefined;
let closeRequestInFlight = false;

// ActionDesigner.vue 的 target prop 只消费判别联合本身（不含 visible/requestClose/title），
// 从 input 里剥出来传下去。
const target = computed<ActionDesignerTarget>(() =>
  props.input.kind === 'job'
    ? { kind: 'job', appId: props.input.appId, jobId: props.input.jobId, jobName: props.input.jobName }
    : { kind: 'template', scope: props.input.scope }
);

// 设计器本体引用：弹窗尺寸变化（拖拽缩放/最大化）后转发给 refit() 重新自适应视图。
const actionDesignerRef = ref<InstanceType<typeof ActionDesigner> | null>(null);
function onResize(): void {
  actionDesignerRef.value?.refit();
}
// Esc 内层分流：设计器内有内联编辑（事件页签重命名）时，Esc 只取消编辑、不关窗
function onEscapeInner(): boolean {
  return actionDesignerRef.value?.cancelInlineEdit?.() ?? false;
}

const targetKind = computed<'template' | 'job'>(() => (props.input.kind === 'job' ? 'job' : 'template'));
const sessionEditable = computed(() => isActionDesignerSessionEditable(sessionSnapshot.value, targetKind.value));

const sessionMessage = computed(() => {
  if (sessionFeedback.value) return sessionFeedback.value;
  const snapshot = sessionSnapshot.value;
  switch (snapshot.state) {
    case 'opening':
      return 'actionDesigner.session.opening';
    case 'conflicted':
      return snapshot.conflict?.ownerDisplayName
        ? 'actionDesigner.session.conflictedNamed'
        : 'actionDesigner.session.conflicted';
    case 'lost':
      return 'actionDesigner.session.lost';
    case 'auth_ended':
      return 'actionDesigner.session.authEnded';
    case 'closed':
      return 'actionDesigner.session.closed';
    default:
      return sessionEditable.value ? '' : 'actionDesigner.session.readonly';
  }
});

function applySessionSnapshot(snapshot: Readonly<InteractiveSessionSnapshot>): void {
  const previous = sessionSnapshot.value;
  const wasActivated = hasActivated.value;

  // auth_ended 的插件内草稿必须在公开终态渲染前同步清理；Host 自身也遵循 scrub → publish。
  if (shouldScrubActionDraft(snapshot)) {
    props.interactiveSession.markDirty(false);
    actionDesignerRef.value?.scrubSession();
  } else if (snapshot.state !== 'active') {
    actionDesignerRef.value?.invalidateAsyncBackfill();
  }

  sessionSnapshot.value = snapshot;
  sessionFeedback.value = '';
  if (sessionEditable.value) {
    hasActivated.value = true;
    if (wasActivated && previous.state === 'conflicted') {
      const expectedEpoch = snapshot.epoch;
      void nextTick().then(() => {
        if (
          sessionSnapshot.value.state === 'active' &&
          sessionSnapshot.value.epoch === expectedEpoch &&
          sessionEditable.value
        ) {
          void actionDesignerRef.value?.reloadAuthority();
        }
      });
    }
  }
}

async function requestEdit(): Promise<void> {
  const snapshot = sessionSnapshot.value;
  if (!snapshot.canRequestEdit || requestingEdit.value) return;
  const expectedEpoch = snapshot.epoch;
  requestingEdit.value = true;
  try {
    await props.interactiveSession.requestEdit(expectedEpoch);
    if (
      sessionSnapshot.value.state === 'conflicted' &&
      sessionSnapshot.value.epoch === expectedEpoch &&
      sessionSnapshot.value.canRequestEdit
    ) {
      sessionFeedback.value = 'actionDesigner.session.requestSent';
    }
  } catch {
    if (
      sessionSnapshot.value.state === 'conflicted' &&
      sessionSnapshot.value.epoch === expectedEpoch &&
      sessionSnapshot.value.canRequestEdit
    ) {
      sessionFeedback.value = 'actionDesigner.session.requestFailed';
    }
  } finally {
    requestingEdit.value = false;
  }
}

async function adminRelease(): Promise<void> {
  const snapshot = sessionSnapshot.value;
  if (!snapshot.canAdminRelease || releasingConflict.value) return;
  const expectedEpoch = snapshot.epoch;
  releasingConflict.value = true;
  try {
    await props.interactiveSession.adminRelease(expectedEpoch);
    if (
      sessionSnapshot.value.state === 'conflicted' &&
      sessionSnapshot.value.epoch === expectedEpoch &&
      sessionSnapshot.value.canAdminRelease
    ) {
      sessionFeedback.value = 'actionDesigner.session.adminReleased';
    }
  } catch {
    if (
      sessionSnapshot.value.state === 'conflicted' &&
      sessionSnapshot.value.epoch === expectedEpoch &&
      sessionSnapshot.value.canAdminRelease
    ) {
      sessionFeedback.value = 'actionDesigner.session.adminReleaseFailed';
    }
  } finally {
    releasingConflict.value = false;
  }
}

async function closeSurface(): Promise<void> {
  if (closeRequestInFlight) return;
  closeRequestInFlight = true;
  try {
    await props.input.requestClose();
  } finally {
    closeRequestInFlight = false;
  }
}

onMounted(() => {
  stopSessionChange = props.interactiveSession.onChange(applySessionSnapshot);
  applySessionSnapshot(props.interactiveSession.snapshot);
});

onBeforeUnmount(() => {
  stopSessionChange?.();
  props.interactiveSession.markDirty(false);
  actionDesignerRef.value?.invalidateAsyncBackfill();
});
</script>

<template>
  <ActionDesignerDialog
    :show="input.visible"
    :title="input.title"
    :host-api="props.hostApi"
    :escape-interceptor="onEscapeInner"
    @close="closeSurface"
    @resize="onResize"
  >
    <ActionDesigner
      v-if="hasActivated"
      ref="actionDesignerRef"
      :target="target"
      :host-api="props.hostApi"
      :interactive-session="props.interactiveSession"
      :session-editable="sessionEditable"
      @dirty-change="props.interactiveSession.markDirty"
    />
    <div
      v-if="!sessionEditable"
      class="action-session-blocker"
      :class="{ 'action-session-blocker--retained': hasActivated && sessionSnapshot.state === 'lost' }"
      role="status"
      aria-live="polite"
      :data-session-state="sessionSnapshot.state"
      :data-session-epoch="sessionSnapshot.epoch"
    >
      <p>{{ $t(sessionMessage, { name: sessionSnapshot.conflict?.ownerDisplayName ?? '' }) }}</p>
      <div v-if="sessionSnapshot.state === 'conflicted'" class="action-session-actions">
        <button v-if="sessionSnapshot.canRequestEdit" type="button" :disabled="requestingEdit" @click="requestEdit">
          {{ $t('actionDesigner.session.requestEdit') }}
        </button>
        <button v-if="sessionSnapshot.canAdminRelease" type="button" :disabled="releasingConflict" @click="adminRelease">
          {{ $t('actionDesigner.session.adminRelease') }}
        </button>
      </div>
    </div>
  </ActionDesignerDialog>
</template>

<style scoped>
.action-session-blocker {
  position: absolute;
  inset: 0;
  z-index: 30;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 24px;
  text-align: center;
  background: rgb(var(--container-bg-color) / 0.9);
  color: rgb(var(--base-text-color));
}

/* lost 保留内存内容供人工查看：只显示顶部告警，不遮住已冻结的画布。 */
.action-session-blocker--retained {
  inset: 0 0 auto;
  min-height: 52px;
  padding: 10px 16px;
  background: rgb(var(--warning-color) / 0.14);
  color: rgb(var(--warning-color));
}

.action-session-actions {
  display: flex;
  gap: 8px;
}

.action-session-actions button {
  min-height: 32px;
  padding: 0 14px;
  border: 1px solid rgb(var(--primary-color));
  border-radius: 4px;
  color: rgb(var(--primary-color));
  background: rgb(var(--container-bg-color));
}
</style>
