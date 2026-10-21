<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import type { InteractiveSessionHandle } from '@kimposoft/plugin-sdk';
import { NButton, NDropdown, NInput, NPopconfirm, NPopover, NSpin } from 'naive-ui';
import type { DropdownOption } from 'naive-ui';
import { KControlSize, type KControlSizeTiers } from '@kimposoft/ui-kit';
// 设计态作用域用本地结构等价类型；useActionDesigner 需同时注入 hostApi（宿主能力注入面）。
// target 为 ActionDesignerTarget 判别联合（'template' | 'job'），承载定时任务持有独立动作文档的
// job 模式（kind 缺省即 'template'）。
import type { ActionDesignerTarget } from './hostTypes';
import type { ActionDesignerHostApi } from './hostApi';
import ActionDesignerCanvas from './ActionDesignerCanvas.vue';
import ActionPanel from './ActionPanel.vue';
import NodeConfigDialog from './NodeConfigDialog.vue';
import { eventLabel } from './labels';
import { t as $t } from '../i18n';
import type { ActionTriggerEventKey } from './model';
import { buildEventMenuEntries } from './eventMenu';
import { useActionDesigner } from './useActionDesigner';
import { countByLevel, countDeadWorkflowGateSteps, validateTree } from './validate';
import type { IssueLevel } from './validate';

// 本地环境类型声明——window.$message 由宿主页面在运行时提供（naive-ui
// discrete message API 挂载于宿主 window）；
// 插件与宿主同页运行、共享同一 window，运行时可用，仅编译期本插件 tsconfig 不含宿主环境声明，
// 需本地补一份类型（仅类型声明，无运行时依赖）。
declare global {
  interface Window {
    $message?: import('naive-ui').MessageProviderInst;
  }
}

/**
 * 事件区「＋事件」虚线按钮的尺寸钉定。
 * 目标尺寸：32 高、字号 14、左右内边距 10、1px 虚线描边；对应 Naive medium 档（默认 34 高）钉到 32 / 14 / 10。
 * 容器只包这一枚按钮（含其 NDropdown，菜单不受影响），不波及同页保存按钮（NButton medium）。
 */
const EVENT_ADD_BTN_TIERS: KControlSizeTiers = { medium: { height: 32, fontSize: 14, paddingX: 10 } };

const props = defineProps<{
  target: ActionDesignerTarget;
  hostApi: ActionDesignerHostApi;
  interactiveSession: InteractiveSessionHandle;
  sessionEditable: boolean;
}>();
const emit = defineEmits<{ dirtyChange: [dirty: boolean] }>();

const ctrl = useActionDesigner({
  ...props.target,
  hostApi: props.hostApi,
  canCommitAuthority: () => props.sessionEditable
});

// job 模式判定：定时任务持有独立动作文档，画布固定单一 scheduled 事件——
// 驱动下方事件列/新增下拉/NodeConfigDialog/ActionPanel 的一系列条件分支。
const isJobMode = computed(() => props.target.kind === 'job');

// 传给 NodeConfigDialog 的 scope：template 模式原样透传设计态作用域；job 模式无模板上下文，
// 仍传 { appId, templateId: '' }（保证 record-controllers 的 action-config
// surface 加载链路不因 scope 整体缺失而跳过——该链路只在 templateId 非空时才发起模板相关请求，
// 空串会被其内部 `!templateId` 判空自然短路，不会报错）。
const nodeConfigScope = computed(() =>
  props.target.kind === 'job'
    ? { appId: props.target.appId, templateId: '' }
    : {
        appId: props.target.scope.appId,
        templateId: props.target.scope.templateId,
        templateVersionNo: props.target.scope.templateVersionNo,
        pluginId: props.target.scope.pluginId
      }
);

// 窄屏响应式：右侧动作面板可折叠（收起时宽 0 完整隐藏），腾出画布空间。
const rightCollapsed = ref(false);

// 右侧动作面板宽度：默认 184，左边框拖拽调整、双击把手复位。
// 下限=默认宽（再窄卡片徽标会挤压换行），上限防把画布挤没。
const RIGHT_PANEL_DEFAULT_W = 184;
const RIGHT_PANEL_MIN_W = 184;
const RIGHT_PANEL_MAX_W = 480;
const rightWidth = ref(RIGHT_PANEL_DEFAULT_W);
// 拖拽中禁用宽度过渡（否则跟手有回弹感），仅折叠开合保留动画。
const rightResizing = ref(false);
function startPanelResize(e: PointerEvent): void {
  if (!props.sessionEditable) return;
  e.preventDefault();
  rightResizing.value = true;
  const sx = e.clientX;
  const sw = rightWidth.value;
  const move = (ev: PointerEvent) => {
    // 向左拖=变宽：宽度增量取起点与当前指针的水平位移差。
    rightWidth.value = Math.min(RIGHT_PANEL_MAX_W, Math.max(RIGHT_PANEL_MIN_W, sw + (sx - ev.clientX)));
  };
  const up = () => {
    rightResizing.value = false;
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

// 画布组件引用：用于打开后自动适应视图。
const canvasRef = ref<InstanceType<typeof ActionDesignerCanvas> | null>(null);
const nodeConfigDialogRef = ref<InstanceType<typeof NodeConfigDialog> | null>(null);

// 节点属性配置 Dialog：双击节点打开；编辑目标即当前选中节点。
const dialogOpen = ref(false);
function onEditNode(id: string): void {
  if (!props.sessionEditable) return;
  ctrl.selectNode(id);
  // 定时模式下触发根不开配置弹窗：任务模式的触发根是「定时触发」，
  // 它的调度（cron/时区/超时/执行身份）全部在任务表单里配，设计器侧没有任何可配项——
  // 弹出模板模式那套「动作设置」对用户是误导。双击仍会选中该节点（保留高亮反馈），只是不弹窗。
  // 模板模式下触发根双击照常打开，用于配触发事件与作用域。
  if (isJobMode.value && ctrl.selectedNode.value?.kind === 'trigger-root') return;
  dialogOpen.value = true;
}

// 正在编辑的动作定义（供 Dialog 的参数渲染/测试用）。
const editingDefinition = computed(() => {
  const node = ctrl.selectedNode.value;
  if (!node || node.kind !== 'action' || !node.actionName) return null;
  return ctrl.registryByName.value.get(node.actionName) ?? null;
});

// 当前编辑节点所属触发根的事件键集合，供 Dialog 判定写动作节点是否落在 before-save 根下
// （须强制同步，见 NodeConfigDialog.asyncBlockedByBeforeSave）。ctrl.root 即 activeEventId 对应的
// 事件树（useActionDesigner.activeRoot），画布任一时刻只展示/可编辑该棵树，故它就是「当前编辑节点
// 所属触发根」——job 模式下同样成立（root 恒为唯一的 scheduled 事件根，不含 before-save，不会误阻断）。
// 取值口径与上面 eventTabs 的 keys 派生（:164 附近）一致：优先 eventKeys 多选集合，回落单值 eventKey。
const activeRootEventKeys = computed<ActionTriggerEventKey[]>(() => {
  const r = ctrl.root.value;
  if (!r) return [];
  return r.eventKeys && r.eventKeys.length > 0 ? r.eventKeys : r.eventKey ? [r.eventKey] : [];
});

// 动作暂存区：当前选中节点的暂存生产者（画布拓扑推导，见 useActionDesigner.stagingProducerOf），
// 传给 Dialog 供表达式编辑器④来源段接入「上一步暂存区」。
const stagingProducer = computed(() => (ctrl.selectedId.value ? ctrl.stagingProducerOf(ctrl.selectedId.value) : null));

const fieldIds = computed(() => new Set(ctrl.allFields.value.map(f => f.field_id)));
const issues = computed(() =>
  ctrl.root.value
    ? validateTree(ctrl.root.value, {
        fieldIds: fieldIds.value,
        asyncable: name => ctrl.registryByName.value.get(name)?.capabilities?.asyncable === true,
        // 门失效校验需要目录，未加载时 validateTree 内部自行跳过（不误报）。
        workflowStepCatalog: ctrl.workflowStepCatalog.value,
        // 节点按模板绑定编辑器档案校验。
        actionUnsupported: ctrl.actionEditorUnsupported
      })
    : []
);
const issueCounts = computed(() => countByLevel(issues.value));

// D2 动作事件列表：每个流程一个标签（自定义名优先、回落事件类型名 + 脏标记 + 是否含错误）。
// 多触发事件的流程显示为「事件A / 事件B」联合标签。
// job 模式：恒一项，label 优先任务名（target.jobName），无任务名回落
// 「定时触发」译文——与模板模式「自定义名优先、回落事件类型名」同一优先级思路，只是自定义名的
// 来源换成了任务定义本身（job 模式画布不提供重命名入口，ev.name 恒不会被设置）。
const eventTabs = computed(() => {
  if (props.target.kind === 'job') {
    const ev = ctrl.events.value[0];
    if (!ev) return [];
    const fallbackLabel = $t('actionDesigner.events.scheduled');
    return [
      {
        id: ev.id,
        index: 0,
        name: ev.name,
        typeLabel: fallbackLabel,
        label: props.target.jobName?.trim() || fallbackLabel,
        active: true,
        // job 模式不提供启停按钮（任务启停由任务本身持有），恒按启用呈现。
        enabled: true,
        dirty: ctrl.dirtyEventIds.value.has(ev.id),
        // job 模式的触发根恒为 scheduled，不产出 legacySaveMigrated/workflowGate（两者
        // 均是模板模式概念），恒不提示。
        gateWarn: false,
        gateWarnTitle: '',
        hasError:
          countByLevel(
            validateTree(ev, {
              fieldIds: fieldIds.value,
              asyncable: name => ctrl.registryByName.value.get(name)?.capabilities?.asyncable === true,
              actionUnsupported: ctrl.actionEditorUnsupported
            })
          ).error > 0
      }
    ];
  }
  return ctrl.events.value.map((ev, index) => {
    const keys = (ev.eventKeys && ev.eventKeys.length > 0 ? ev.eventKeys : ev.eventKey ? [ev.eventKey] : []) as ActionTriggerEventKey[];
    const typeLabel = keys.length > 0 ? keys.map(k => eventLabel(k) ?? k).join(' / ') : $t('actionDesigner.summary.event');
    return {
      id: ev.id,
      index,
      name: ev.name,
      typeLabel,
      label: ev.name || typeLabel,
      active: ev.id === ctrl.activeEventId.value,
      dirty: ctrl.dirtyEventIds.value.has(ev.id),
      // 启用态：仅显式 false 为停用（旧文档/新建事件缺省即启用）。
      enabled: ev.enabled !== false,
      // 旧 before-save/after-save 迁移提示，或门内含失效条目（目录未加载时恒判 0，
      // 不误报）——任一为真即显示左侧列表提示点，title 分别取对应文案；停用事件不计（同 hasError：停掉一个配置不全的事件后不应继续在列表上碍眼）。
      gateWarn:
        ev.enabled !== false &&
        (ev.legacySaveMigrated === true || countDeadWorkflowGateSteps(ev.workflowGate, ctrl.workflowStepCatalog.value) > 0),
      gateWarnTitle: ev.legacySaveMigrated
        ? $t('actionDesigner.canvas.eventDirtyMigrated')
        : $t('actionDesigner.dialog.gate.deadCount', { count: countDeadWorkflowGateSteps(ev.workflowGate, ctrl.workflowStepCatalog.value) }),
      hasError:
        // 停用的事件不再计入错误徽标（停掉一个配置不全的事件后不应继续报红）；
        // 文档校验本身不放宽——停用事件的内容仍须合法，保存照旧校验。
        ev.enabled !== false &&
        countByLevel(
          validateTree(ev, {
            fieldIds: fieldIds.value,
            asyncable: name => ctrl.registryByName.value.get(name)?.capabilities?.asyncable === true,
            actionUnsupported: ctrl.actionEditorUnsupported
          })
        ).error > 0
    };
  });
});

// 新增事件下拉：全局锚点 ∩ 当前载体声明支持的触发点（载体未声明则回退全部锚点），按 eventMenu.ts 的
// 三组（打开 / 保存 / 删除，带子菜单的父项——指向父项即展开子菜单，点子项才真正选中）+ 平铺顺序产出
// NDropdown options。分组与顺序见 eventMenu.ts（触发根「触发事件」下拉共用同一份，不各自维护）。
// 统一作用于表单；允许同类型多个，靠重命名区分。
// job 模式恒返回空——画布固定单一 scheduled 事件，「＋事件」整块按钮已 v-if 隐藏，
// 本计算属性理论上不会被消费，仍防御性返回空数组。
// template 模式：scheduled 事件已改由任务持有，模板侧不再提供该选项
// ——即使某载体插件的 supportedTriggers 声明里仍带 scheduled（旧声明未清理），也一律排除（从 allowed
// 集合剔除；eventMenu 的末尾兜底只补 allowed 里的锚点，不会把它补回来）。
const addEventOptions = computed<DropdownOption[]>(() => {
  if (props.target.kind === 'job') return [];
  const allowed = new Set(ctrl.supportedTriggers.value.filter(key => key !== 'scheduled'));
  return buildEventMenuEntries(allowed).map(entry =>
    entry.kind === 'group'
      ? { label: entry.label, key: entry.key, children: entry.members.map(member => ({ label: member.label, key: member.key })) }
      : { label: entry.label, key: entry.key }
  );
});

function onAddEvent(key: string): void {
  if (!props.sessionEditable) return;
  ctrl.addEvent({ eventKey: key as ActionTriggerEventKey });
  // 新增事件同样切换了 activeEventId，需与切换事件一致地重新初始化视图。
  resetCanvasView();
}

// 删除动作事件：若删除的是当前事件，controller 会自动切到相邻事件（activeEventId 变化），
// 同样需要重新初始化视图，避免沿用被删事件遗留的 pan/zoom。
async function onRemoveEvent(eventId: string): Promise<void> {
  if (!props.sessionEditable) return;
  await ctrl.removeEvent(eventId);
  resetCanvasView();
}

// 事件列表指针拖动排序（画布顺序 = 同一触发下多个动作的执行顺序）。按住事件项竖向拖动，其余项实时让位，松手落位后经 ctrl.moveEventTo
// 重写落盘 binding 的 seq 并保存；不切换当前事件，视图不重置。
// 实现要点：
// - pointerdown 只记起点，竖向位移超过阈值才进入拖动态（区分「点击切换事件」与「拖动」）；拖动结束后压掉
//   紧随其后的那次 click，避免落位瞬间又触发切换；
// - 拖动项按指针位移做 translateY 跟手；命中检测只看「其余项」的自然几何（各项等高）：指针进入哪一项的
//   矩形，拖动项就挪到该项当前的位置——挪动后指针落回拖动项自身矩形内，天然稳定不抖；
// - 让位靠 displayTabs 按预览顺序渲染（keyed 复用 DOM），不动 ctrl.events，松手才提交。
// job 模式单事件无序可言，不启用；只读会话不启用。
const eventsListRef = ref<HTMLElement | null>(null);
const eventDrag = ref<{ id: string; from: number; to: number; offsetY: number } | null>(null);
const EVENT_DRAG_START_THRESHOLD = 4;
// 拖动落位后紧随 pointerup 的那次 click 要压掉（同步派发，宏任务后即解除，不会吞掉下一次正常点击）。
let suppressTabClick = false;

// 渲染用的事件列表：拖动中按预览顺序（拖动项挪到 to 位）展示，其余时刻即 eventTabs。
const displayTabs = computed(() => {
  const d = eventDrag.value;
  const tabs = eventTabs.value;
  if (!d || d.from === d.to) return tabs;
  const rows = [...tabs];
  const [moved] = rows.splice(d.from, 1);
  if (!moved) return tabs;
  rows.splice(d.to, 0, moved);
  return rows;
});

function eventTabElements(): HTMLElement[] {
  const host = eventsListRef.value;
  return host ? Array.from(host.querySelectorAll<HTMLElement>('.ad-event-tab')) : [];
}

function onEventPointerDown(e: PointerEvent, tab: { id: string; index: number }): void {
  if (!props.sessionEditable || isJobMode.value || eventTabs.value.length < 2) return;
  if (e.button !== 0 || renamingId.value === tab.id) return;
  // 操作按钮/重命名输入框区域各有自己的点击语义，不作为拖动起点。
  if ((e.target as HTMLElement | null)?.closest('.ad-event-actions, .ad-event-rename')) return;
  const el = e.currentTarget as HTMLElement;
  const startY = e.clientY;
  // 按下点在项内的纵向偏移：跟手时保持指针相对项的位置不变。
  const grabOffsetY = startY - el.getBoundingClientRect().top;
  let active = false;
  const move = (ev: PointerEvent) => {
    if (!active) {
      if (Math.abs(ev.clientY - startY) < EVENT_DRAG_START_THRESHOLD) return;
      active = true;
      suppressTabClick = true;
      eventDrag.value = { id: tab.id, from: tab.index, to: tab.index, offsetY: 0 };
    }
    ev.preventDefault();
    const d = eventDrag.value;
    if (!d) return;
    // 命中检测：指针进入哪一个「其余项」的矩形，拖动项就挪到该项当前的显示位置。
    const hit = eventTabElements().findIndex((node, i) => {
      if (i === d.to) return false;
      const rect = node.getBoundingClientRect();
      return ev.clientY >= rect.top && ev.clientY <= rect.bottom;
    });
    if (hit >= 0) d.to = hit;
    // 跟手：等 DOM 按预览顺序重排后，用拖动项的自然位置（offsetTop 不含 transform）算位移。
    void nextTick().then(() => {
      const dd = eventDrag.value;
      const host = eventsListRef.value;
      const dragged = eventTabElements()[dd?.to ?? -1];
      if (!dd || !host || !dragged) return;
      const naturalTop = host.getBoundingClientRect().top - host.scrollTop + dragged.offsetTop;
      dd.offsetY = ev.clientY - grabOffsetY - naturalTop;
    });
  };
  const finish = (commit: boolean) => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', cancel);
    const d = eventDrag.value;
    eventDrag.value = null;
    if (!active) return;
    window.setTimeout(() => {
      suppressTabClick = false;
    }, 0);
    // 先清预览再改 ctrl.events：二者同一 tick 内生效，displayTabs 只重算一次，落位不闪。
    if (commit && d && d.to !== d.from) void ctrl.moveEventTo(d.id, d.to);
  };
  const up = () => finish(true);
  const cancel = () => finish(false);
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', cancel);
}

// 点击事件项切换当前事件；拖动落位后紧随的那次 click 被压掉。
function onEventTabClick(eventId: string): void {
  if (suppressTabClick) return;
  onSwitchEvent(eventId);
}

// 删除确认浮层打开中的事件 id：操作区（重命名/删除）默认只在悬停时显示，指针移到确认浮层上时该项
// 已不再 hover，靠这个态把操作区钉住，避免触发元素消失导致浮层失位。
const confirmingDeleteId = ref<string | null>(null);
function onDeleteConfirmToggle(eventId: string, show: boolean): void {
  confirmingDeleteId.value = show ? eventId : confirmingDeleteId.value === eventId ? null : confirmingDeleteId.value;
}

// 动作事件启用/停用：点击即切换，无二次确认（停用可逆，区别于删除的 popconfirm）。
// 已落盘的事件由控制器直接写回文档并保存（点击即落盘）；未落盘的只标脏，随首次保存写入。
function onToggleEventEnabled(eventId: string): void {
  if (!props.sessionEditable) return;
  void ctrl.toggleEventEnabled(eventId);
}

// 动作事件内联重命名：点操作区的重命名按钮或双击标签进入编辑，回车/失焦提交，Esc 取消。
const renamingId = ref<string | null>(null);
const renameText = ref('');
function startRename(tab: { id: string; name?: string }): void {
  if (!props.sessionEditable) return;
  renamingId.value = tab.id;
  renameText.value = tab.name ?? '';
}
function commitRename(id: string): void {
  if (!props.sessionEditable) return;
  if (renamingId.value !== id) return;
  ctrl.renameEvent(id, renameText.value);
  renamingId.value = null;
}
const issueByNode = computed(() => {
  const map = new Map<string, IssueLevel>();
  for (const issue of issues.value) {
    if (map.get(issue.nodeId) !== 'error') map.set(issue.nodeId, issue.level);
  }
  return map;
});

// 警告/错误明细：按级别分组，供徽标 popover 展开逐条文案。
const issuesByLevel = computed(() => ({
  error: issues.value.filter(i => i.level === 'error'),
  warn: issues.value.filter(i => i.level === 'warn')
}));

// 点击某条 issue：选中对应节点并居中聚焦，便于定位问题。
function onSelectIssue(nodeId: string): void {
  ctrl.selectNode(nodeId);
  void nextTick().then(() => canvasRef.value?.focusNode?.(nodeId));
}

// 保存当前动作事件（单事件语义）：仅持久化当前事件，其他事件保留磁盘原样。
async function onSave(): Promise<void> {
  if (!props.sessionEditable) return;
  if (issueCounts.value.error > 0) {
    if (typeof window !== 'undefined' && window.$message) {
      window.$message.error($t('actionDesigner.canvas.hasErrorsBeforeSave', { count: issueCounts.value.error }));
    }
    return;
  }
  const ok = await ctrl.saveActiveEvent();
  if (typeof window !== 'undefined' && window.$message) {
    if (ok) window.$message.success($t('actionDesigner.canvas.eventSaved'));
    else window.$message.error(ctrl.errorText.value || $t('actionDesigner.canvas.saveFailed'));
  }
  // 保存闸报出具体节点（如 DATA_ACTION_KIND_UNRESOLVED）时，画布居中聚焦该节点。
  const failedNodeId = ok ? null : ctrl.saveErrorNodeId.value;
  if (failedNodeId) void nextTick().then(() => canvasRef.value?.focusNode?.(failedNodeId));
}

// 键盘可达：Delete/Backspace 删除选中节点（触发根除外），Esc 取消选中。输入框内不拦截。
// 节点配置对话框打开时（dialogOpen）不响应任何画布快捷键：Esc 由对话框自己接管关闭，此处再 selectNode(null)
// 会清空节点致对话框内容空白；Delete 也可能误删画布节点。
function onKeydown(e: KeyboardEvent): void {
  if (!props.sessionEditable) return;
  if (dialogOpen.value) return;
  const target = e.target as HTMLElement | null;
  const tag = target?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) return;
  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (ctrl.selectedId.value && ctrl.root.value && ctrl.selectedId.value !== ctrl.root.value.id) {
      e.preventDefault();
      ctrl.deleteSelected();
    }
  } else if (e.key === 'Escape') {
    ctrl.selectNode(null);
  }
}

// 重新初始化画布视图：有内容自适应缩放居中（fitView），无内容居中偏左（centerRootLeft）。
// 供首次加载与「切换动作事件」共用，保证每次进入一个事件都是全新视口，不沿用上一个事件的 pan/zoom。
function resetCanvasView(): void {
  void nextTick().then(() => {
    const hasContent = (ctrl.root.value?.children?.length ?? 0) > 0;
    if (hasContent) canvasRef.value?.fitView();
    else canvasRef.value?.centerRootLeft?.();
  });
}

// 切换动作事件：先切 activeEventId（含选中根），再等 DOM 用新事件的节点几何重新定位视图。
function onSwitchEvent(eventId: string): void {
  ctrl.setActiveEvent(eventId);
  resetCanvasView();
}

onMounted(() => {
  // 加载完成后等 DOM 渲染再定位一次视图：
  // - 新建动作（触发根尚无子节点）：置于「画布正中偏左」，为向右生长留出空间；
  // - 已有内容：自适应缩放居中（fitView）。避免内容堆在左上角。
  void ctrl.load().then(() => resetCanvasView());
  // 流程步骤目录惰性加载一次，供画布触发根徽标失效判定；与 ctrl.load() 并行、互不
  // 阻塞（job 模式内部早退，恒无害）。
  void ctrl.ensureWorkflowStepCatalog();
  window.addEventListener('keydown', onKeydown);
});

watch(
  () => ctrl.dirty.value,
  dirty => emit('dirtyChange', dirty),
  { immediate: true }
);

watch(
  () => props.sessionEditable,
  editable => {
    if (!editable) {
      dialogOpen.value = false;
      ctrl.invalidateAsyncBackfill();
    }
  }
);

onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown);
  ctrl.invalidateAsyncBackfill();
  emit('dirtyChange', false);
});

// 暴露给页面：对话框窗口态变化（最大化/还原）后重新自适应视图（仍受 fitView 的 ≤100% 钳制）。
function refit(): void {
  void nextTick().then(() => canvasRef.value?.fitView());
}

/** 冲突后成功取得编辑权时重新读取 Host 权威文档，不提交冲突期间的旧快照。 */
async function reloadAuthority(): Promise<void> {
  if (!props.sessionEditable) return;
  await ctrl.load();
  if (props.sessionEditable) resetCanvasView();
}

/** 登录确认失效时立即清空未保存草稿和已加载业务内容。 */
function scrubSession(): void {
  dialogOpen.value = false;
  // 登录终态发布前同步清空节点弹窗内未提交草稿及目录；仅关闭弹窗不足以销毁常驻组件。
  nodeConfigDialogRef.value?.scrubSensitiveState();
  ctrl.scrubSensitiveState();
  emit('dirtyChange', false);
}

function invalidateAsyncBackfill(): void {
  ctrl.invalidateAsyncBackfill();
}

/**
 * Esc 内层分流：事件页签处于内联重命名编辑态时，Esc 只取消重命名（返回 true = 已消费，不关窗）。
 * 供 DesignerRoot 经 ActionDesignerDialog 的 escapeInterceptor 调用（弹层栈先于输入框自带的 @keydown.esc 派发）。
 */
function cancelInlineEdit(): boolean {
  if (renamingId.value === null) return false;
  renamingId.value = null;
  return true;
}

defineExpose({ refit, reloadAuthority, scrubSession, invalidateAsyncBackfill, cancelInlineEdit });
</script>

<template>
  <div class="action-designer">
    <div class="ad-toolbar">
      <div class="ad-toolbar-left">
        <span class="ad-name">{{ $t('actionDesigner.canvas.title') }}</span>
        <span v-if="ctrl.dirty.value" class="ad-dirty" :title="$t('actionDesigner.canvas.unsavedChanges')">●</span>
      </div>
      <div class="ad-toolbar-right">
        <NPopover v-if="issueCounts.error > 0" trigger="hover" placement="bottom-end" :show-arrow="true">
          <template #trigger>
            <span class="ad-issue ad-issue-error">{{ $t('actionDesigner.canvas.errorCount', { count: issueCounts.error }) }}</span>
          </template>
          <div class="ad-issue-list">
            <div v-for="(it, i) in issuesByLevel.error" :key="`e${i}`" class="ad-issue-item ad-issue-item-error" @click="onSelectIssue(it.nodeId)">
              {{ it.message }}
            </div>
          </div>
        </NPopover>
        <NPopover v-if="issueCounts.warn > 0" trigger="hover" placement="bottom-end" :show-arrow="true">
          <template #trigger>
            <span class="ad-issue ad-issue-warn">{{ $t('actionDesigner.canvas.warnCount', { count: issueCounts.warn }) }}</span>
          </template>
          <div class="ad-issue-list">
            <div v-for="(it, i) in issuesByLevel.warn" :key="`w${i}`" class="ad-issue-item ad-issue-item-warn" @click="onSelectIssue(it.nodeId)">
              {{ it.message }}
            </div>
          </div>
        </NPopover>
        <span v-if="ctrl.errorText.value" class="ad-error">{{ ctrl.errorText.value }}</span>
        <NButton size="medium" type="primary" :disabled="!sessionEditable || issueCounts.error > 0" :loading="ctrl.saving.value" @click="onSave">{{ $t('actionDesigner.canvas.saveCurrentEvent') }}</NButton>
      </div>
    </div>
    <div class="ad-body">
      <div class="ad-columns">
        <!-- D2 动作事件列表（最左列）：一个模板多个动作事件，每个事件一张画布 -->
        <div class="ad-col ad-events-col">
          <div class="ad-events-title">{{ $t('actionDesigner.canvas.eventsTitle') }}</div>
          <div ref="eventsListRef" class="ad-events" :class="{ dragging: !!eventDrag }">
            <!-- 事件项：点击切换；按住竖向拖动排序（onEventPointerDown）；悬停露出重命名/删除操作区 -->
            <div
              v-for="tab in displayTabs"
              :key="tab.id"
              class="ad-event-tab"
              :class="{
                active: tab.active,
                dragging: eventDrag?.id === tab.id,
                confirming: confirmingDeleteId === tab.id,
                'is-disabled': !tab.enabled
              }"
              :style="eventDrag?.id === tab.id ? { transform: `translateY(${eventDrag.offsetY}px)` } : undefined"
              @pointerdown="onEventPointerDown($event, tab)"
              @click="onEventTabClick(tab.id)"
            >
              <span v-if="tab.hasError" class="ad-event-dot" :title="$t('actionDesigner.canvas.eventHasError')" />
              <span v-else-if="tab.dirty" class="ad-event-dirty" :title="$t('actionDesigner.canvas.unsavedChanges')" />
              <!-- 旧保存键迁移 / 门含失效条目提示点，复用既有 .ad-event-dirty 圆点样式
                   （未保存改动优先于本提示——同一时刻只有一个圆点位）。 -->
              <span v-else-if="tab.gateWarn" class="ad-event-dirty" :title="tab.gateWarnTitle" />
              <NInput
                v-if="renamingId === tab.id"
                v-model:value="renameText"
                size="tiny"
                class="ad-event-rename"
                :placeholder="tab.typeLabel"
                :autofocus="true"
                @click.stop
                @blur="commitRename(tab.id)"
                @keydown.enter="commitRename(tab.id)"
                @keydown.esc="renamingId = null"
              />
              <!-- job 模式：固定单一 scheduled 事件，双击重命名禁用（标签恒为
                   任务名/回落译文，见 eventTabs），保留原生 title 但不挂 dblclick 处理器。 -->
              <span
                v-else
                class="ad-event-label"
                :title="isJobMode ? undefined : $t('actionDesigner.canvas.dblclickRename')"
                @dblclick.stop="!isJobMode && startRename(tab)"
              >{{ tab.label }}</span>
              <!-- 停用徽标：操作区只在悬停时显示，停用标识必须常显，否则不悬停时看不出该事件已停用。 -->
              <span v-if="!tab.enabled && renamingId !== tab.id" class="ad-event-disabled-tag">{{
                $t('actionDesigner.canvas.eventDisabledTag')
              }}</span>
              <!-- 操作区（重命名 + 删除）：默认 display:none 不占位，悬停该项/删除确认打开期间才显示；
                   重命名中（输入框占据标签位）不显示。job 模式固定单一事件不可改名不可删，整块隐藏。 -->
              <span v-if="!isJobMode && renamingId !== tab.id" class="ad-event-actions" @click.stop @pointerdown.stop>
                <!-- 启用/停用：点击即切换，无二次确认；停用后该事件的全部触发都不再执行。 -->
                <button
                  type="button"
                  class="ad-event-action-btn ad-event-toggle-btn"
                  :disabled="!sessionEditable"
                  :title="tab.enabled ? $t('actionDesigner.canvas.disableEventTitle') : $t('actionDesigner.canvas.enableEventTitle')"
                  @click.stop="onToggleEventEnabled(tab.id)"
                >
                  <!-- 电源图标线稿：启用=实线圆弧+竖线，停用=同图形加一道斜杠（与铅笔同 currentColor 描边风格） -->
                  <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M5.2 4.4a4.6 4.6 0 105.6 0" />
                    <path d="M8 2.2v4.6" />
                    <path v-if="!tab.enabled" d="M3 13L13 3" />
                  </svg>
                </button>
                <button
                  type="button"
                  class="ad-event-action-btn ad-event-rename-btn"
                  :disabled="!sessionEditable"
                  :title="$t('actionDesigner.canvas.renameEventTitle')"
                  @click.stop="startRename(tab)"
                >
                  <!-- 铅笔线稿：与「＋事件」加号同为 currentColor 描边风格 -->
                  <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M11.5 2.5l2 2L5 13H3v-2L11.5 2.5z" />
                    <path d="M10 4l2 2" />
                  </svg>
                </button>
                <NPopconfirm @positive-click="onRemoveEvent(tab.id)" @update:show="onDeleteConfirmToggle(tab.id, $event)">
                  <template #trigger>
                    <button
                      type="button"
                      class="ad-event-action-btn ad-event-close"
                      :disabled="!sessionEditable"
                      :title="$t('actionDesigner.canvas.deleteEventTitle')"
                      @click.stop
                    >×</button>
                  </template>
                  {{ $t('actionDesigner.canvas.confirmDeleteEvent', { name: tab.label }) }}
                </NPopconfirm>
              </span>
            </div>
            <!-- job 模式：「＋事件」整块隐藏（固定单一事件，不可新增）。 -->
            <KControlSize v-if="!isJobMode" include-button :tiers="EVENT_ADD_BTN_TIERS">
              <NDropdown trigger="click" :disabled="!sessionEditable" :options="addEventOptions" @select="onAddEvent">
                <!-- 新增事件：加号图标+「事件」文案。
                     NButton dashed（32 高 / 14px / 内边距 10 经 EVENT_ADD_BTN_TIERS 钉定） -->
                <NButton class="ad-event-add" dashed :title="$t('actionDesigner.canvas.addEventTitle')">
                  <span class="ad-event-add-inner">
                    <svg viewBox="0 0 13 13" width="13" height="13" fill="none">
                      <path
                        d="M6.5 0C6.77614 0 7 0.223858 7 0.5V6H12.5C12.7761 6 13 6.22386 13 6.5C13 6.77614 12.7761 7 12.5 7H7V12.5C7 12.7761 6.77614 13 6.5 13C6.22386 13 6 12.7761 6 12.5V7H0.5C0.223858 7 0 6.77614 0 6.5C0 6.22386 0.223858 6 0.5 6H6V0.5C6 0.223858 6.22386 0 6.5 0Z"
                        fill="currentColor"
                      />
                    </svg>
                    {{ $t('actionDesigner.summary.event') }}
                  </span>
                </NButton>
              </NDropdown>
            </KControlSize>
          </div>
        </div>
        <div class="ad-col ad-center">
          <div class="ad-canvas-host">
            <ActionDesignerCanvas
              v-if="ctrl.root.value"
              ref="canvasRef"
              :root="ctrl.root.value"
              :selected-id="ctrl.selectedId.value"
              :registry-by-name="ctrl.registryByName.value"
              :field-name="ctrl.fieldName"
              :table-name="ctrl.tableName"
              :app-name="ctrl.appName"
              :current-app-id="ctrl.currentAppId.value"
              :issues="issueByNode"
              :drag-source="ctrl.dragSource.value"
              :job-mode="isJobMode"
              :workflow-step-catalog="ctrl.workflowStepCatalog.value"
              :class="{ 'ad-session-frozen': !sessionEditable }"
              @select="ctrl.selectNode"
              @edit="onEditNode"
              @drop="ctrl.applyDrop($event.target, $event.payload)"
              @node-drag-start="ctrl.setDragSource({ kind: 'move', nodeId: $event })"
              @drag-end="ctrl.setDragSource(null)"
            />
            <!-- 空白态：尚无动作事件，引导用户经左侧「＋ 事件」新增（不再自动种默认事件）。 -->
            <div v-else class="ad-canvas-empty">
              <div class="ad-canvas-empty-title">{{ $t('actionDesigner.canvas.noEvents') }}</div>
              <div class="ad-canvas-empty-hint">{{ $t('actionDesigner.canvas.noEventsHint') }}</div>
            </div>
          </div>
        </div>
        <!--
 动作面板（最右列）：可拖拽的「条件分支 + 动作」清单，从画布右侧拖入。
             左边框可拖拽调宽（双击复位默认宽）；收起时宽 0 完整隐藏，仅留左缘悬浮把手可再展开 
-->
        <div
          class="ad-col ad-right"
          :class="{ collapsed: rightCollapsed, resizing: rightResizing }"
          :style="rightCollapsed ? undefined : { width: `${rightWidth}px` }"
        >
          <div
            v-if="!rightCollapsed"
            class="ad-right-resizer"
            :title="$t('actionDesigner.canvas.resizePanelTitle')"
            @pointerdown="startPanelResize"
            @dblclick="rightWidth = RIGHT_PANEL_DEFAULT_W"
          />
          <button class="ad-collapse ad-collapse-right" :title="rightCollapsed ? $t('actionDesigner.canvas.expandPanel') : $t('actionDesigner.canvas.collapsePanel')" @click="rightCollapsed = !rightCollapsed">
            {{ rightCollapsed ? '‹' : '›' }}
          </button>
          <ActionPanel
            v-show="!rightCollapsed"
            :registry="ctrl.registry.value"
            :registry-state="ctrl.registryState.value"
            :context-filter="isJobMode ? 'scheduled' : 'template'"
            :unsupported-of="def => ctrl.actionEditorUnsupported(def.name)"
            :class="{ 'ad-session-frozen': !sessionEditable }"
            @add-action="ctrl.addAction"
            @add-condition="ctrl.addCondition"
            @drag-start="ctrl.setDragSource($event)"
            @drag-end="ctrl.setDragSource(null)"
          />
        </div>
      </div>
      <div v-if="ctrl.loading.value" class="ad-loading">
        <NSpin :size="28" />
      </div>
    </div>

    <!-- 节点属性配置 Dialog（双击节点打开，取代右侧属性面板） -->
    <NodeConfigDialog
      ref="nodeConfigDialogRef"
      v-model:show="dialogOpen"
      :node="ctrl.selectedNode.value"
      :definition="editingDefinition"
      :fields="ctrl.allFields.value"
      :guard-fields="ctrl.guardFields.value"
      :field-groups="ctrl.fieldGroups.value"
      :scope="nodeConfigScope"
      :designer-mode="isJobMode ? 'job' : 'template'"
      :interactive-session="props.interactiveSession"
      :readonly="!sessionEditable"
      :host-api="props.hostApi"
      :staging-producer="stagingProducer"
      :unauthorized-source-apps="ctrl.unauthorizedSourceApps.value"
      :band-event-keys="activeRootEventKeys"
      @save-action="ctrl.updateSelected"
      @save-condition="ctrl.updateSelectedCondition"
      @save-trigger="ctrl.setTriggerRoot"
      @remove="ctrl.deleteSelected"
    />
  </div>
</template>

<style scoped>
.action-designer {
  display: flex;
  flex-direction: column;
  height: 100%;
  /* 画布区底 = 中性色/填充/背景（layout 档），两侧栏白底 */
  background-color: rgb(var(--layout-bg-color));
}
.ad-session-frozen {
  pointer-events: none;
  user-select: text;
}
/* 工具栏行：白底 + 浅色2 底边描边 */
.ad-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 48px;
  padding: 0 24px;
  background-color: rgb(var(--container-bg-color));
  border-bottom: 1px solid rgb(var(--border-lighter-color));
  flex-shrink: 0;
}
.ad-toolbar-left {
  display: flex;
  align-items: center;
  gap: 8px;
}
.ad-name {
  font-size: 16px;
  font-weight: 500;
  color: rgb(var(--base-text-color));
}
.ad-dirty {
  color: rgb(var(--primary-color));
  font-size: 12px;
}
.ad-toolbar-right {
  display: flex;
  align-items: center;
  gap: 12px;
}
.ad-error {
  font-size: 12px;
  color: rgb(var(--error-color));
}
/* 警告/错误徽标：功能色 15% 底 + 功能色文字，小圆角 */
.ad-issue {
  display: inline-flex;
  align-items: center;
  height: 24px;
  padding: 0 8px;
  font-size: 12px;
  border-radius: 4px;
  cursor: pointer;
}
.ad-issue-error {
  background-color: rgb(var(--error-color) / 0.15);
  color: rgb(var(--error-color));
}
.ad-issue-warn {
  background-color: rgb(var(--warning-color) / 0.15);
  color: rgb(var(--warning-color));
}
/* 警告/错误明细 popover：逐条文案，点击定位节点 */
.ad-issue-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-width: 320px;
}
.ad-issue-item {
  font-size: 12px;
  line-height: 1.5;
  padding: 4px 8px;
  border-radius: 6px;
  cursor: pointer;
  color: rgb(var(--base-text-color) / 0.85);
}
.ad-issue-item:hover {
  background-color: rgb(var(--base-text-color) / 0.06);
}
.ad-issue-item-error {
  border-left: 3px solid rgb(var(--error-color));
}
.ad-issue-item-warn {
  border-left: 3px solid rgb(var(--warning-color));
}
.ad-body {
  position: relative;
  flex: 1;
  min-height: 0;
}
.ad-loading {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background-color: rgb(var(--container-bg-color) / 0.6);
  z-index: 5;
}
.ad-columns {
  display: flex;
  height: 100%;
}
.ad-col {
  height: 100%;
  position: relative;
}
/* 动作面板列：默认宽 184（inline style 驱动、左边框可拖宽）、白底、浅色2 左描边 */
.ad-right {
  width: 184px;
  flex-shrink: 0;
  border-left: 1px solid rgb(var(--border-lighter-color));
  background-color: rgb(var(--container-bg-color));
  transition: width 0.15s ease;
}
/* 拖拽调宽期间关掉过渡，宽度实时跟手 */
.ad-right.resizing {
  transition: none;
}
/* 收起 = 完整隐藏：宽 0 且去描边（1px 边框也不残留），仅留悬浮把手 */
.ad-right.collapsed {
  width: 0 !important;
  border-left: none;
}
/* 左边框拖宽把手：6px 竖向可点区域骑在描边上，悬停亮 2px 主色指示线；层级低于折叠把手 */
.ad-right-resizer {
  position: absolute;
  left: -3px;
  top: 0;
  bottom: 0;
  width: 6px;
  cursor: ew-resize;
  z-index: 3;
}
.ad-right-resizer:hover::after,
.ad-right.resizing .ad-right-resizer::after {
  content: '';
  position: absolute;
  left: 2px;
  top: 0;
  bottom: 0;
  width: 2px;
  background-color: rgb(var(--primary-color) / 0.55);
}
.ad-center {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.ad-canvas-host {
  flex: 1;
  min-height: 0;
  position: relative;
}
/* 空白态：无动作事件时画布中央的引导文案 */
.ad-canvas-empty {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 24px;
  text-align: center;
}
.ad-canvas-empty-title {
  font-size: 14px;
  font-weight: 600;
  color: rgb(var(--base-text-color) / 0.7);
}
.ad-canvas-empty-hint {
  font-size: 12px;
  color: rgb(var(--base-text-color) / 0.45);
}
/* 动作事件列（宽 180）：白底、浅色2 右描边 */
.ad-events-col {
  width: 180px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  border-right: 1px solid rgb(var(--border-lighter-color));
  background-color: rgb(var(--container-bg-color));
}
.ad-events-title {
  font-size: 14px;
  font-weight: 500;
  color: rgb(var(--text-secondary-color));
  padding: 12px 12px;
}
.ad-events {
  /* relative：作为事件项的 offsetParent，拖动跟手用 offsetTop 取自然位置（不受 transform 影响） */
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 8px;
  flex: 1;
  min-height: 0;
  padding: 0 12px 12px;
  overflow-y: auto;
}
/* 拖动排序进行中：整列禁选文本、抓手光标，操作区一律不显示 */
.ad-events.dragging {
  user-select: none;
  cursor: grabbing;
}
.ad-events.dragging .ad-event-actions {
  display: none;
}
/* 事件项：高 32 小圆角；未选中 = 浅色2 填充 + 深色描边 */
.ad-event-tab {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 32px;
  padding: 0 8px;
  border-radius: 4px;
  border: 1px solid rgb(var(--border-dark-color));
  background-color: rgb(var(--fill-lighter-color));
  cursor: pointer;
  font-size: 14px;
  color: rgb(var(--text-secondary-color));
  flex-shrink: 0;
  /* 指针拖动排序在 pointer 事件上实现，禁掉触屏默认滚动/缩放手势 */
  touch-action: none;
  transition:
    border-color 0.15s ease,
    background-color 0.15s ease;
}
.ad-event-tab:hover {
  border-color: rgb(var(--primary-color) / 0.6);
}
/* 拖动中的项：跟手位移（inline transform）+ 抬起感（描边主色 + 阴影 + 压过其余项） */
.ad-event-tab.dragging {
  position: relative;
  z-index: 2;
  cursor: grabbing;
  border-color: rgb(var(--primary-color));
  box-shadow: 0 6px 18px rgb(0 0 0 / 0.14);
  transition: none;
}
/* 选中事件：浅蓝底（primary-50 = #E6F6FF 的 50%）+ 品牌色描边与文字 */
.ad-event-tab.active {
  border-color: rgb(var(--primary-color));
  background-color: rgb(var(--primary-50-color) / 0.5);
  color: rgb(var(--primary-color));
}
/* 停用态：整项灰显 + 标签删除线，配合常显的「已停用」徽标——不悬停也能一眼看出。
   刻意不降到看不清：仍要能读出事件名、仍可点击切换回启用。 */
.ad-event-tab.is-disabled {
  border-style: dashed;
  background-color: transparent;
  color: rgb(var(--text-secondary-color) / 0.55);
}
.ad-event-tab.is-disabled .ad-event-label {
  text-decoration: line-through;
  text-decoration-color: rgb(var(--text-secondary-color) / 0.5);
}
.ad-event-tab.is-disabled.active {
  border-color: rgb(var(--primary-color) / 0.5);
  background-color: rgb(var(--primary-50-color) / 0.25);
  color: rgb(var(--primary-color) / 0.6);
}
/* 「已停用」徽标：不悬停时常显（停用标识不能只挂在悬停才出现的操作区上）；悬停/删除确认期间
   隐藏，把位置让给三枚操作按钮（启停/重命名/删除），避免一行挤成两截——此时灰显 + 删除线仍在，
   停用态照样看得出来。 */
.ad-event-tab:hover .ad-event-disabled-tag,
.ad-event-tab.confirming .ad-event-disabled-tag {
  display: none;
}
.ad-event-disabled-tag {
  flex-shrink: 0;
  padding: 0 4px;
  border-radius: 3px;
  font-size: 11px;
  line-height: 16px;
  background-color: rgb(var(--text-secondary-color) / 0.12);
  color: rgb(var(--text-secondary-color) / 0.75);
}
.ad-event-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ad-event-tab.active .ad-event-label {
  font-weight: 500;
}
.ad-event-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background-color: rgb(var(--error-color));
  flex-shrink: 0;
}
/* 未保存修改：琥珀色小点（与红色错误点区分） */
.ad-event-dirty {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background-color: rgb(var(--warning-color));
  flex-shrink: 0;
}
/* 内联重命名输入框：占据标签位置 */
.ad-event-rename {
  flex: 1;
  min-width: 0;
}
/* 操作区（重命名 + 删除）：平时 display:none 完全不占位（标签可用满整行），悬停该项或删除确认
   浮层打开期间（.confirming，见 onDeleteConfirmToggle）才以 inline-flex 出现 */
.ad-event-actions {
  display: none;
  align-items: center;
  gap: 2px;
  flex-shrink: 0;
}
.ad-event-tab:hover .ad-event-actions,
.ad-event-tab.confirming .ad-event-actions {
  display: inline-flex;
}
.ad-event-action-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: transparent;
  line-height: 1;
  color: rgb(var(--base-text-color) / 0.45);
  cursor: pointer;
}
.ad-event-action-btn:disabled {
  opacity: 0.3;
  cursor: default;
}
.ad-event-toggle-btn:hover:not(:disabled) {
  background-color: rgb(var(--warning-color) / 0.18);
  color: rgb(var(--warning-color));
}
.ad-event-rename-btn:hover:not(:disabled) {
  background-color: rgb(var(--primary-color) / 0.14);
  color: rgb(var(--primary-color));
}
.ad-event-close {
  font-size: 14px;
}
.ad-event-close:hover:not(:disabled) {
  background-color: rgb(var(--error-color) / 0.16);
  color: rgb(var(--error-color));
}
/* 新增事件：高 32 虚线深色描边 + 加号图标居中 */
/* 新增事件虚线钮（NButton dashed），
   尺寸：32 高、14px、内边距 10（tiers 钉定）、图标与文字间距 5px；不伸缩。 */
.ad-event-add {
  flex-shrink: 0;
}
.ad-event-add-inner {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
/* 面板折叠把手：吊在面板左缘垂直居中，避让面板顶部的「动作」标题与搜索图标 */
.ad-collapse {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  z-index: 4;
  width: 16px;
  height: 40px;
  border: 1px solid rgb(var(--border-lighter-color));
  border-right: none;
  background-color: rgb(var(--container-bg-color));
  border-radius: 8px 0 0 8px;
  cursor: pointer;
  font-size: 12px;
  color: rgb(var(--text-secondary-color));
  padding: 0;
}
.ad-collapse:hover {
  color: rgb(var(--primary-color));
  border-color: rgb(var(--primary-color));
}
.ad-collapse-right {
  left: -15px;
}
</style>
