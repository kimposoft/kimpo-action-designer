<script setup lang="ts">
import { computed, nextTick, reactive, ref, watch } from 'vue';
import { NPopover } from 'naive-ui';
import type { ActionDefinition, WorkflowStepCatalogDefinition } from './hostTypes';
import Connectors from './Connectors.vue';
import ActionNode from './nodes/ActionNode.vue';
import ConditionNode from './nodes/ConditionNode.vue';
import TriggerRootNode from './nodes/TriggerRootNode.vue';
import NodeDetailPopover from './nodes/NodeDetailPopover.vue';
import { computeDropSlots, pickActiveSlot } from './dropSlots';
import { setCustomDragImage } from './dragImage';
import { actionOutcomes, conditionQuickLabel, outcomeLabel } from './labels';
import { resolveLocalized } from './localize';
import { t as $t } from '../i18n';
import { layoutTree } from './layout';
import type { Orientation, PositionedNode } from './layout';
import type { MindNode } from './model';
import type { DragPayload, DropTarget } from './useActionDesigner';

const props = defineProps<{
  root: MindNode;
  selectedId: string | null;
  registryByName: Map<string, ActionDefinition>;
  fieldName: (fieldId: string) => string;
  /** 数据表显示名解析口（可选）：节点指向详情按 data_table_id 显示取数目标表 / 本报表来源表名。 */
  tableName?: (tableId: string) => string;
  /** 应用显示名解析口 + 当前设计所在应用 ID，透传给
   *  NodeDetailPopover 供跨应用来源前缀「应用名 › 」使用。均可选，未传时不产出前缀。 */
  appName?: (appId: string) => string;
  currentAppId?: string;
  issues?: Map<string, 'error' | 'warn'>;
  dragSource?: DragPayload | null;
  /** job 模式（定时任务）——条件节点卡片改显示「不支持条件分支」，透传给 ConditionNode。 */
  jobMode?: boolean;
  /** 流程步骤目录，透传给 TriggerRootNode 供门徽标失效判定；null/undefined=未加载。 */
  workflowStepCatalog?: WorkflowStepCatalogDefinition[] | null;
}>();

const emit = defineEmits<{
  select: [id: string | null];
  edit: [id: string];
  drop: [value: { target: DropTarget; payload: DragPayload }];
  nodeDragStart: [nodeId: string];
  dragEnd: [];
}>();

const MIN_SCALE = 0.4;
const MAX_SCALE = 2;
const margin = 32;

const scrollRef = ref<HTMLElement>();
const activeSlotId = ref<string | null>(null);

// 画布朝向：横向(默认)/纵向，可经右下角按钮无损切换（仅重排坐标，模型树不变）。
const orientation = ref<Orientation>('horizontal');

// 视口：自由平移(x,y) + 缩放(scale)，作用在 canvas-inner 上（transform）。
const viewport = reactive({ x: margin, y: margin, scale: 1 });

// 出口分支：某动作是否声明 x-outcomes（由注册中心 params_schema['x-outcomes'] 决定），
// 供 layoutTree 判定该动作节点是否要按出口分叉渲染（与 condition 的 then/else 同构）。
function outcomesOf(actionName: string | undefined): string[] {
  return actionOutcomes(actionName ? props.registryByName.get(actionName) : undefined);
}

// ── 分支收起/展开：节点出边锚点的收纳按钮，视图级剪枝、模型树不动 ──
// 会话覆盖表：用户点过的节点记显式值；未点过的一律展开。文档保存/重开不持久化收起态（视图状态，非配置）。
// 打开已有动作时一律不折叠，哪怕没挂子动作——设计器不再读插件的
// params_schema['x-collapse-default']（按它默认收起会把已配置的子动作也藏起来）；该关键字已退役，声明方即使保留字段也不再生效。收起只剩用户本会话手动点出来的一种来源。
const collapsedOverrides = ref(new Map<string, boolean>());
/** 节点是否有可收纳的下游（真实子节点或分支占位）：条件恒有 then/else 带；动作看出口声明或子流程；
 *  触发根（执行时机）有子节点即可收。 */
function hasBranches(node: MindNode): boolean {
  if (node.kind === 'condition') return true;
  if (node.kind === 'action') {
    if (outcomesOf(node.actionName).length > 0) return true;
    return (node.children?.length ?? 0) > 0;
  }
  if (node.kind === 'trigger-root') return (node.children?.length ?? 0) > 0;
  return false;
}
function isCollapsed(node: MindNode): boolean {
  if (!hasBranches(node)) return false;
  return collapsedOverrides.value.get(node.id) === true;
}
// 收起/展开切换的位移动画抑制：切换瞬间视口做等量补偿（见 toggleCollapse），若节点 left/top 仍带
// 0.2s 过渡，被点节点会先跳后滑造成抖动——切换帧内关掉过渡，下一帧恢复。
const suppressNodeAnim = ref(false);
const layout = computed(() => layoutTree(props.root, orientation.value, outcomesOf, isCollapsed));
const nodeById = computed(() => Object.fromEntries(layout.value.nodes.map(n => [n.id, n])));

function toggleCollapse(node: MindNode): void {
  // 记录被点节点切换前坐标（画布内坐标系）。
  const before = nodeById.value[node.id];
  suppressNodeAnim.value = true;
  const next = new Map(collapsedOverrides.value);
  next.set(node.id, !isCollapsed(node));
  collapsedOverrides.value = next;
  // layout 是同步 computed：override 更新后立即重取即新布局。视口按被点节点位移做等量反向补偿，
  // 使其保持屏幕原位（收起/展开时母节点不移动，只有下游收纳/铺开）。
  const after = nodeById.value[node.id];
  if (before && after) {
    viewport.x -= (after.x - before.x) * viewport.scale;
    viewport.y -= (after.y - before.y) * viewport.scale;
  }
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      suppressNodeAnim.value = false;
    });
  });
}

// 本会话插入节点的识别：同一棵根树（root.id 不变）内新出现的节点 id = 本会话插入，
// 供下方「插入位置锚定」做视口补偿；根 id 变化（切事件/换文档）视为整树装载，全量登记为「存量」。
const seenIds = new Set<string>();
let seededRootId = '';
function collectIds(n: MindNode, out: Set<string>): void {
  out.add(n.id);
  (n.children ?? []).forEach(c => collectIds(c, out));
  (n.thenChildren ?? []).forEach(c => collectIds(c, out));
  (n.elseChildren ?? []).forEach(c => collectIds(c, out));
  for (const band of Object.values(n.outcomeChildren ?? {})) band.forEach(c => collectIds(c, out));
}
// 插入位置锚定（插入新节点时原有节点树不整体移动）：落点确定时选一个**既有参照
// 节点**（band 内被顶开的原成员，末尾追加取末成员，box 落点取属主节点）记下旧坐标；树变更后按该
// 参照节点自身的位移对视口做等量反向补偿——既有兄弟链整体钉在屏幕原位，新节点在空出的位置展开
//（祖先因交叉轴重居中的少量漂移是居中布局的固有代价，不强行冻结以免把位移转嫁给更多节点）。
let pendingInsertAnchor: { id: string; x: number; y: number } | null = null;
watch(
  () => props.root,
  root => {
    const ids = new Set<string>();
    collectIds(root, ids);
    if (seededRootId !== root.id) {
      seededRootId = root.id;
      seenIds.clear();
      ids.forEach(id => seenIds.add(id));
      pendingInsertAnchor = null;
      return;
    }
    const newIds: string[] = [];
    for (const id of ids) {
      if (seenIds.has(id)) continue;
      seenIds.add(id);
      newIds.push(id);
    }
    // 视口补偿：仅当本次变更确实是插入（出现新 id）且有待用锚点时执行；按参照节点自身位移
    // 反向补偿使其钉在屏幕原位，同帧抑制位移过渡防抖动。
    if (pendingInsertAnchor && newIds.length > 0) {
      const anchorNow = nodeById.value[pendingInsertAnchor.id];
      if (anchorNow) {
        suppressNodeAnim.value = true;
        viewport.x -= (anchorNow.x - pendingInsertAnchor.x) * viewport.scale;
        viewport.y -= (anchorNow.y - pendingInsertAnchor.y) * viewport.scale;
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            suppressNodeAnim.value = false;
          });
        });
      }
    }
    pendingInsertAnchor = null; // 无论是否命中都清，防陈旧锚点误补偿后续无关变更
  },
  { immediate: true, deep: true }
);

// 收起态节点集合：其自身的续接/分支带禁止作为落点（收起时不可在其右侧插入）。
const collapsedOwnerIds = computed(() => {
  const set = new Set<string>();
  for (const n of layout.value.nodes) {
    if (n.node && isCollapsed(n.node)) set.add(n.id);
  }
  return set;
});
// 出口分支图例用标签：图例改为动态两项——首个出口(实线)/其余出口(虚线)——按「画布上首个
// 出现的出口分支节点」的声明渲染，取舍见下：画布上可能同时存在多个声明了出口的动作节点（如
// 提取数据 filled/empty、打开表单 hit/miss），逐个都上图例会把图例撑爆，故只取拓扑序最先出现的
// 一个作代表；layout.edges 已按先序遍历生成，故首个 kind==='outcome' 的边即定位到该节点。
// 未出现任何出口边（含：节点收起、或画布内无出口分支节点）时不显示图例（legendOutcomeLabels 为 null）。
const legendOutcomeLabels = computed<{ primary: string; alt: string } | null>(() => {
  const firstOutcomeEdge = layout.value.edges.find(e => e.kind === 'outcome');
  if (!firstOutcomeEdge) return null;
  const ownerNode = nodeById.value[firstOutcomeEdge.fromId]?.node;
  const outcomes = outcomesOf(ownerNode?.actionName);
  if (outcomes.length === 0) return null;
  // 其余出口可能不止一个（N 分支），图例第二项统一取第 1 个（序号 1）代表虚线含义。
  return { primary: outcomeLabel(outcomes[0]), alt: outcomeLabel(outcomes[1] ?? outcomes[0]) };
});

const movingSubtree = computed(() => {
  const set = new Set<string>();
  if (props.dragSource?.kind !== 'move') return set;
  const childrenOf = new Map<string, string[]>();
  for (const n of layout.value.nodes) {
    if (n.parentId) {
      const arr = childrenOf.get(n.parentId) ?? [];
      arr.push(n.id);
      childrenOf.set(n.parentId, arr);
    }
  }
  const stack = [props.dragSource.nodeId];
  while (stack.length) {
    const id = stack.pop()!;
    set.add(id);
    for (const c of childrenOf.get(id) ?? []) stack.push(c);
  }
  return set;
});

const slots = computed(() => {
  if (!props.dragSource) return [];
  // 条件与动作一视同仁：任意 band 的任意成员间隙都可落（含动作子流程/续接 band、已有条件之间）。
  // 动作的 children band 含条件时编译为该动作的「续接组」。唯一限制：不能落进正在移动的子树。
  return computeDropSlots(layout.value, props.root.id, orientation.value).filter(
    // 不能落进正在移动的子树；收起态节点自身的续接/分支带也不给落点（下游被收纳，先展开再插）。
    slot => !movingSubtree.value.has(slot.ownerId) && !collapsedOwnerIds.value.has(slot.ownerId)
  );
});

const hiddenStubIds = computed(() => new Set(slots.value.map(s => s.replacesStubId).filter(Boolean)));

// 仅在光标附近显示落点：占位预览只在指针周围约 20px 内显现，避免铺满画布（激活落点始终高亮可见）。
const SLOT_REVEAL = 20;
const cursorInner = ref<{ x: number; y: number } | null>(null);
const visibleSlots = computed(() => {
  const cursor = cursorInner.value;
  if (!cursor) return [];
  return slots.value.filter(slot => {
    if (slot.id === activeSlotId.value) return true;
    const dx = slot.x + slot.width / 2 - cursor.x;
    const dy = slot.y + slot.height / 2 - cursor.y;
    return dx * dx + dy * dy <= SLOT_REVEAL * SLOT_REVEAL;
  });
});

interface SlotEdge {
  id: string;
  path: string;
}
const slotEdges = computed<SlotEdge[]>(() => {
  const out: SlotEdge[] = [];
  for (const slot of visibleSlots.value) {
    // box 落点始终画预览连线；插入条仅激活时画（避免一堆插入条都拖出连线）。
    if (slot.mode !== 'box' && slot.id !== activeSlotId.value) continue;
    const from = nodeById.value[slot.fromId];
    if (!from) continue;
    if (orientation.value === 'vertical') {
      const x1 = from.x + from.width / 2;
      const y1 = from.y + from.height;
      const x2 = slot.x + slot.width / 2;
      const y2 = slot.y;
      const dy = Math.max(32, (y2 - y1) / 2);
      out.push({ id: slot.id, path: `M ${x1} ${y1} C ${x1} ${y1 + dy}, ${x2} ${y2 - dy}, ${x2} ${y2}` });
    } else {
      const x1 = from.x + from.width;
      const y1 = from.y + from.height / 2;
      const x2 = slot.x;
      const y2 = slot.y + slot.height / 2;
      const dx = Math.max(32, (x2 - x1) / 2);
      out.push({ id: slot.id, path: `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}` });
    }
  }
  return out;
});

const contentWidth = computed(() => {
  const slotMax = slots.value.reduce((m, s) => Math.max(m, s.x + s.width), 0);
  return Math.max(layout.value.width, slotMax) + margin;
});
const contentHeight = computed(() => {
  const slotMax = slots.value.reduce((m, s) => Math.max(m, s.y + s.height), 0);
  return Math.max(layout.value.height, slotMax) + margin;
});

const innerStyle = computed(() => ({
  transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.scale})`,
  transformOrigin: '0 0'
}));

function clientToInner(clientX: number, clientY: number): { x: number; y: number } {
  const rect = scrollRef.value?.getBoundingClientRect();
  if (!rect) return { x: 0, y: 0 };
  return { x: (clientX - rect.left - viewport.x) / viewport.scale, y: (clientY - rect.top - viewport.y) / viewport.scale };
}

// ── 缩放 ──
function zoomAt(clientX: number, clientY: number, nextScale: number): void {
  const rect = scrollRef.value?.getBoundingClientRect();
  if (!rect) return;
  const ns = Math.min(MAX_SCALE, Math.max(MIN_SCALE, nextScale));
  const px = (clientX - rect.left - viewport.x) / viewport.scale;
  const py = (clientY - rect.top - viewport.y) / viewport.scale;
  viewport.x = clientX - rect.left - px * ns;
  viewport.y = clientY - rect.top - py * ns;
  viewport.scale = ns;
}
function zoomByCenter(factor: number): void {
  const rect = scrollRef.value?.getBoundingClientRect();
  if (!rect) return;
  zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, viewport.scale * factor);
}
function resetView(): void {
  viewport.x = margin;
  viewport.y = margin;
  viewport.scale = 1;
}
function fitView(): void {
  const rect = scrollRef.value?.getBoundingClientRect();
  if (!rect) return;
  const cw = Math.max(contentWidth.value, 1);
  const ch = Math.max(contentHeight.value, 1);
  // 适应画布只缩小、不放大（上限 100%），避免内容很少时被放大到失真。
  const s = Math.max(MIN_SCALE, Math.min(1, (rect.width - margin * 2) / cw, (rect.height - margin * 2) / ch));
  viewport.scale = s;
  viewport.x = (rect.width - cw * s) / 2;
  viewport.y = (rect.height - ch * s) / 2;
}
const zoomPercent = computed(() => Math.round(viewport.scale * 100));

// 将某节点平移到画布中央（保持当前缩放），供「警告明细」点击定位用。
function focusNode(nodeId: string): void {
  const rect = scrollRef.value?.getBoundingClientRect();
  const n = nodeById.value[nodeId];
  if (!rect || !n) return;
  const cx = n.x + n.width / 2;
  const cy = n.y + n.height / 2;
  viewport.x = rect.width / 2 - cx * viewport.scale;
  viewport.y = rect.height / 2 - cy * viewport.scale;
}

// 把触发根置于「画布正中偏左」（纵向居中、水平靠左留出向右生长空间），供新建动作初始定位。
// 仅平移不缩放（保持 100%），根节点纵向中心对齐视口纵向中心，水平定在视口宽度约 1/4 处。
function centerRootLeft(): void {
  const rect = scrollRef.value?.getBoundingClientRect();
  const root = nodeById.value[props.root.id];
  if (!rect || !root) return;
  viewport.scale = 1;
  // 水平：根节点左缘落在视口宽度约 1/4 处（正中偏左），但不小于常规 margin。
  viewport.x = Math.max(margin, rect.width / 4 - root.x);
  // 纵向：根节点垂直中心对齐视口垂直中心。
  const cy = root.y + root.height / 2;
  viewport.y = rect.height / 2 - cy;
}

// 横/纵向无损切换：仅改朝向触发重排，切换后下一帧自适应视图。
function toggleOrientation(): void {
  orientation.value = orientation.value === 'horizontal' ? 'vertical' : 'horizontal';
  void nextTick(() => fitView());
}

// 当前激活落点；用于浮动提示与预览连线。
const activeSlot = computed(() => slots.value.find(s => s.id === activeSlotId.value) ?? null);

// 落点语义文案：进入分支 / 插入 / 移动（位置仅决定结构，与同步异步无关）。
// branch 为 'then'/'else' → 条件分支；其余非空字符串 → 出口分支 key，走 outcomeLabel 本地化(未登记回落原文)。
function slotActionText(slot: { branch?: string }): string {
  const verb = props.dragSource?.kind === 'move' ? $t('actionDesigner.canvas.moveTo') : $t('actionDesigner.canvas.placeTo');
  if (slot.branch === 'then') return `${verb}「${$t('actionDesigner.canvas.branchThen')}」`;
  if (slot.branch === 'else') return `${verb}「${$t('actionDesigner.canvas.branchElse')}」`;
  if (slot.branch) return `${verb}「${outcomeLabel(slot.branch)}」`;
  return props.dragSource?.kind === 'move' ? $t('actionDesigner.canvas.moveHere') : $t('actionDesigner.canvas.insertHere');
}

// 空分支占位文案：条件 then/else 沿用既有专属文案；出口分支用通用「<出口名>·空」模板。
function emptyBranchLabel(branch: string | undefined): string {
  if (branch === 'then') return $t('actionDesigner.canvas.thenEmpty');
  if (branch === 'else') return $t('actionDesigner.canvas.elseEmpty');
  return $t('actionDesigner.canvas.outcomeEmpty', { label: outcomeLabel(branch ?? '') });
}

// 大框落点文案：未激活显示分支名/＋，激活显示动作语义。
function slotBoxLabel(slot: { branch?: string; id: string }): string {
  if (slot.id === activeSlotId.value) return slotActionText(slot);
  if (slot.branch === 'then') return $t('actionDesigner.canvas.branchThen');
  if (slot.branch === 'else') return $t('actionDesigner.canvas.branchElse');
  if (slot.branch) return outcomeLabel(slot.branch);
  return '＋';
}

// ── 拖拽落点（DnD） ──
function readPayload(e: DragEvent): DragPayload | null {
  const raw = e.dataTransfer?.getData('application/x-action-designer');
  if (!raw) return null;
  try {
    return JSON.parse(raw) as DragPayload;
  } catch {
    return null;
  }
}

function nodeLabel(item: PositionedNode): string {
  // 条件节点标签优先走 guardSpec 摘要（guided 多条/expression 模式也有可读文本），
  // 缺省节点（理论上不会出现）回落画布默认文案。
  if (item.kind === 'condition') return item.node ? conditionQuickLabel(item.node) : $t('actionDesigner.canvas.nodeDefault');
  if (item.kind === 'action') {
    return resolveLocalized(props.registryByName.get(item.node?.actionName ?? '')?.title) || item.node?.actionName || $t('actionDesigner.summary.action');
  }
  return $t('actionDesigner.canvas.nodeDefault');
}

function onNodeDragStart(e: DragEvent, item: PositionedNode): void {
  if (!e.dataTransfer) return;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('application/x-action-designer', JSON.stringify({ kind: 'move', nodeId: item.id }));
  setCustomDragImage(e, nodeLabel(item));
  emit('nodeDragStart', item.id);
}

function onDragOver(e: DragEvent): void {
  if (!props.dragSource) return;
  const cursor = clientToInner(e.clientX, e.clientY);
  cursorInner.value = cursor;
  // 用“光标到落点矩形”的最近 + 距离上限选激活落点：方向直觉、且远处不再误激活/误落。
  activeSlotId.value = pickActiveSlot(slots.value, cursor.x, cursor.y)?.id ?? null;
}

function onDrop(e: DragEvent): void {
  const payload = readPayload(e);
  const slot = slots.value.find(s => s.id === activeSlotId.value);
  activeSlotId.value = null;
  cursorInner.value = null;
  emit('dragEnd');
  if (payload && slot) {
    pendingInsertAnchor = insertAnchorFor(slot);
    emit('drop', { target: { ownerId: slot.ownerId, branch: slot.branch, index: slot.index }, payload });
  }
}

/** 选插入参照锚（既有节点，插入后须钉在屏幕原位）：
 *  - bar 插入条：优先被顶开的原 index 位成员（其后整段兄弟随之冻结）；末尾追加取末成员；
 *  - box 落点（空分支 stub / 挂子框 / 根框）与空 band：取属主节点。 */
function insertAnchorFor(slot: { mode: string; ownerId: string; branch?: string; index: number }): { id: string; x: number; y: number } | null {
  const horizontal = orientation.value !== 'vertical';
  let anchorNode: PositionedNode | undefined;
  if (slot.mode === 'bar') {
    const members = layout.value.nodes
      .filter(n => n.parentId === slot.ownerId && (n.branch ?? undefined) === slot.branch && (n.kind === 'action' || n.kind === 'condition'))
      .sort((a, b) => (horizontal ? a.y - b.y : a.x - b.x));
    anchorNode = members[slot.index] ?? members[members.length - 1];
  }
  anchorNode = anchorNode ?? nodeById.value[slot.ownerId];
  return anchorNode ? { id: anchorNode.id, x: anchorNode.x, y: anchorNode.y } : null;
}

// ── 平移画布（拖空白处）；滚轮平移；ctrl+滚轮缩放 ──
let panMoved = false;
function onBackgroundPointerDown(e: PointerEvent): void {
  if (e.button !== 0) return;
  const target = e.target as HTMLElement;
  if (target.closest('.node-wrap') || target.closest('.drop-slot') || target.closest('.canvas-zoom')) return;
  panMoved = false;
  const sx = e.clientX;
  const sy = e.clientY;
  const ox = viewport.x;
  const oy = viewport.y;
  scrollRef.value?.classList.add('panning');
  const move = (ev: PointerEvent) => {
    const dx = ev.clientX - sx;
    const dy = ev.clientY - sy;
    if (Math.abs(dx) + Math.abs(dy) > 3) panMoved = true;
    viewport.x = ox + dx;
    viewport.y = oy + dy;
  };
  const up = () => {
    scrollRef.value?.classList.remove('panning');
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

function onCanvasClick(): void {
  if (panMoved) {
    panMoved = false;
    return;
  }
  emit('select', null);
}

function onWheel(e: WheelEvent): void {
  e.preventDefault();
  if (e.ctrlKey || e.metaKey) {
    zoomAt(e.clientX, e.clientY, viewport.scale * (e.deltaY < 0 ? 1.12 : 1 / 1.12));
    return;
  }
  if (e.shiftKey) {
    viewport.x -= e.deltaY;
  } else {
    viewport.x -= e.deltaX;
    viewport.y -= e.deltaY;
  }
}

// 暴露给父组件：打开/最大化时自动适应画布、重置视图。
defineExpose({ fitView, resetView, focusNode, centerRootLeft });
</script>

<template>
  <div
    ref="scrollRef"
    class="canvas-scroll"
    @click="onCanvasClick"
    @pointerdown="onBackgroundPointerDown"
    @wheel="onWheel"
    @dragover.prevent="onDragOver"
    @drop.prevent="onDrop"
  >
    <div class="canvas-inner" :class="{ 'no-anim': suppressNodeAnim }" :style="innerStyle">
      <Connectors :nodes="layout.nodes" :edges="layout.edges" :width="contentWidth || 1" :height="contentHeight || 1" :orientation="orientation" />

      <svg v-if="dragSource" class="overlay-svg" :width="contentWidth" :height="contentHeight">
        <path v-for="edge in slotEdges" :key="edge.id" :d="edge.path" fill="none" class="slot-edge" :class="{ active: edge.id === activeSlotId }" />
      </svg>

      <div
        v-for="item in layout.nodes"
        v-show="!(item.kind === 'empty-branch' && hiddenStubIds.has(item.id))"
        :key="item.id"
        class="node-wrap"
        :class="{ dragging: dragSource?.kind === 'move' && dragSource.nodeId === item.id }"
        :style="{ left: `${item.x}px`, top: `${item.y}px`, width: `${item.width}px`, height: `${item.height}px` }"
        :draggable="item.kind === 'action' || item.kind === 'condition'"
        @click.stop="item.kind !== 'empty-branch' && emit('select', item.id)"
        @dblclick.stop="item.kind !== 'empty-branch' && emit('edit', item.id)"
        @dragstart="onNodeDragStart($event, item)"
        @dragend="emit('dragEnd')"
      >
        <TriggerRootNode
          v-if="item.kind === 'trigger-root'"
          :node="item.node!"
          :selected="item.id === selectedId"
          :workflow-step-catalog="workflowStepCatalog"
          :field-name="fieldName"
        />
        <ActionNode
          v-else-if="item.kind === 'action'"
          :node="item.node!"
          :selected="item.id === selectedId"
          :definition="item.node?.actionName ? registryByName.get(item.node.actionName) : undefined"
          :field-name="fieldName"
          :table-name="tableName"
        />
        <ConditionNode
          v-else-if="item.kind === 'condition'"
          :node="item.node!"
          :selected="item.id === selectedId"
          :field-name="fieldName"
          :job-mode="jobMode"
        />
        <!-- 空分支占位：胶囊贴在连线终点那一侧——横向连线落在格子左中（左对齐垂直居中），纵向落在格子上中
             （贴顶水平居中），否则纵向时箭头尖悬在胶囊上方一截。 -->
        <div v-else class="empty-branch-cell" :class="{ 'is-vertical': orientation === 'vertical' }">
          <span class="empty-pill" :class="`empty-${item.branchOf?.branch}`">
            {{ emptyBranchLabel(item.branchOf?.branch) }}
          </span>
        </div>
        <span
          v-if="item.kind !== 'empty-branch' && issues?.get(item.id)"
          class="node-issue"
          :class="`issue-${issues.get(item.id)}`"
          :title="issues.get(item.id) === 'error' ? $t('actionDesigner.canvas.hasError') : $t('actionDesigner.canvas.hasWarn')"
        />
        <!-- 指向详情图标（右上角，hover 显现）：动作/触发根可看「配置情况」，内容默认渲染、预留插件提供 -->
        <NPopover
          v-if="item.kind === 'action' || item.kind === 'trigger-root'"
          trigger="hover"
          placement="top"
          :show-arrow="true"
          :keep-alive-on-hover="true"
        >
          <template #trigger>
            <span
              class="node-detail-btn"
              :draggable="false"
              :title="$t('actionDesigner.canvas.viewConfigDetail')"
              @click.stop
              @dblclick.stop
              @pointerdown.stop
              @dragstart.prevent.stop
            >
              <SvgIcon icon="material-symbols:info-outline" />
            </span>
          </template>
          <NodeDetailPopover
            :node="item.node!"
            :definition="item.node?.actionName ? registryByName.get(item.node.actionName) : null"
            :field-name="fieldName"
            :table-name="tableName"
            :app-name="appName"
            :current-app-id="currentAppId"
          />
        </NPopover>
        <!-- 分支收起/展开按钮：出边锚点处（横向=右缘中点，纵向=下缘中点），有分支的动作/条件/触发根显示。
             展开态显 −（点击收起下游），收起态显 +（点击展开，样式与收起态一致）；不参与拖拽/选中/双击编辑。 -->
        <button
          v-if="item.kind !== 'empty-branch' && item.node && hasBranches(item.node)"
          class="collapse-btn"
          :class="orientation === 'vertical' ? 'pos-bottom' : 'pos-right'"
          :draggable="false"
          :title="isCollapsed(item.node) ? $t('actionDesigner.canvas.expandBranches') : $t('actionDesigner.canvas.collapseBranches')"
          @click.stop="toggleCollapse(item.node)"
          @dblclick.stop
          @pointerdown.stop
          @dragstart.prevent.stop
        >
          {{ isCollapsed(item.node) ? '+' : '−' }}
        </button>
      </div>

      <div
        v-for="slot in visibleSlots"
        :key="slot.id"
        class="drop-slot"
        :class="[`mode-${slot.mode}`, { active: slot.id === activeSlotId, 'is-move': dragSource?.kind === 'move' }]"
        :style="{ left: `${slot.x}px`, top: `${slot.y}px`, width: `${slot.width}px`, height: `${slot.height}px` }"
      >
        <span v-if="slot.mode === 'box'">{{ slotBoxLabel(slot) }}</span>
      </div>

      <!-- 激活插入条的浮动意图提示（细条内放不下文字，用浮标说明插入/移动语义） -->
      <div
        v-if="activeSlot && activeSlot.mode === 'bar'"
        class="slot-hint"
        :class="{ 'is-move': dragSource?.kind === 'move' }"
        :style="{ left: `${activeSlot.x + activeSlot.width / 2}px`, top: `${activeSlot.y}px` }"
      >
        {{ slotActionText(activeSlot) }}
      </div>
    </div>

    <!--
 图例（左上）：连线类型；同步/异步是节点标志（见节点上的「异步」徽标），不在此。
         出口分支图例仅当画布内确有出口分支边时才展示（legendOutcomeLabels 为 null 即不展示），
         避免无关流程也常驻噪音；两项标签取「画布上首个出现的出口分支节点」的声明动态渲染
         （见 legendOutcomeLabels 注释），不再是固定文案的 legendOutcome 单条图例。
-->
    <div class="canvas-legend">
      <span class="lg-item lg-item-flow"><i class="lg-line lg-flow"></i>{{ $t('actionDesigner.canvas.legendOrder') }}</span>
      <span class="lg-item lg-item-then"><i class="lg-line lg-then"></i>{{ $t('actionDesigner.canvas.branchThen') }}</span>
      <span class="lg-item lg-item-else"><i class="lg-line lg-else"></i>{{ $t('actionDesigner.canvas.branchElse') }}</span>
      <template v-if="legendOutcomeLabels">
        <span class="lg-item lg-item-outcome"><i class="lg-line lg-outcome"></i>{{ legendOutcomeLabels.primary }}</span>
        <span class="lg-item lg-item-outcome"><i class="lg-line lg-outcome-alt"></i>{{ legendOutcomeLabels.alt }}</span>
      </template>
    </div>

    <!-- 缩放控制条（右下）：−/百分比/＋ · 适应画布 | 排列朝向。图标为线稿。 -->
    <div class="canvas-zoom" @click.stop @pointerdown.stop>
      <div class="zoom-group">
        <button class="zoom-btn" :title="$t('actionDesigner.canvas.zoomOut')" @click="zoomByCenter(1 / 1.2)">
          <svg viewBox="0 0 12 12" width="12" height="12" fill="none">
            <path
              d="M10.5 5.625C10.7071 5.625 10.875 5.79289 10.875 6C10.875 6.20711 10.7071 6.375 10.5 6.375H1.5C1.29289 6.375 1.125 6.20711 1.125 6C1.125 5.79289 1.29289 5.625 1.5 5.625H10.5Z"
              fill="currentColor"
            />
          </svg>
        </button>
        <button class="zoom-pct" :title="$t('actionDesigner.canvas.zoomReset')" @click="resetView">{{ zoomPercent }}%</button>
        <button class="zoom-btn" :title="$t('actionDesigner.canvas.zoomIn')" @click="zoomByCenter(1.2)">
          <svg viewBox="0 0 12 12" width="12" height="12" fill="none">
            <path
              d="M6 1.125C6.20711 1.125 6.375 1.29289 6.375 1.5V5.625H10.5C10.7071 5.625 10.875 5.79289 10.875 6C10.875 6.20711 10.7071 6.375 10.5 6.375H6.375V10.5C6.375 10.7071 6.20711 10.875 6 10.875C5.79289 10.875 5.625 10.7071 5.625 10.5V6.375H1.5C1.29289 6.375 1.125 6.20711 1.125 6C1.125 5.79289 1.29289 5.625 1.5 5.625H5.625V1.5C5.625 1.29289 5.79289 1.125 6 1.125Z"
              fill="currentColor"
            />
          </svg>
        </button>
      </div>
      <button class="zoom-icon-btn" :title="$t('actionDesigner.canvas.fitCanvas')" @click="fitView">
        <svg viewBox="0 0 14 14" width="14" height="14" fill="none">
          <path
            d="M13.5882 14H0.41178C0.302569 14 0.197831 13.9566 0.120608 13.8794C0.0433838 13.8022 0 13.6974 0 13.5882V0.41178C0 0.302569 0.0433838 0.197831 0.120608 0.120608C0.197831 0.0433838 0.302569 0 0.41178 0L13.5882 0C13.6974 0 13.8022 0.0433838 13.8794 0.120608C13.9566 0.197831 14 0.302569 14 0.41178V13.5882C14 13.6974 13.9566 13.8022 13.8794 13.8794C13.8022 13.9566 13.6974 14 13.5882 14ZM0.82356 13.1764H13.1764V0.82356H0.82356V13.1764Z"
            fill="currentColor"
          />
          <path
            d="M5.84383 12.2274H2.18433C2.07512 12.2274 1.97038 12.184 1.89315 12.1068C1.81593 12.0296 1.77255 11.9248 1.77255 11.8156V8.32387C1.77143 8.2691 1.78125 8.21465 1.80144 8.16373C1.82163 8.1128 1.85178 8.06641 1.89012 8.02728C1.92846 7.98815 1.97422 7.95707 2.02472 7.93585C2.07523 7.91463 2.12946 7.90369 2.18424 7.90369C2.23902 7.90369 2.29325 7.91463 2.34376 7.93585C2.39426 7.95707 2.44003 7.98815 2.47836 8.02728C2.5167 8.06641 2.54685 8.1128 2.56704 8.16373C2.58723 8.21465 2.59705 8.2691 2.59594 8.32387V11.404H5.84383C5.95303 11.404 6.05775 11.4474 6.13496 11.5246C6.21216 11.6019 6.25554 11.7066 6.25554 11.8158C6.25554 11.925 6.21216 12.0297 6.13496 12.1069C6.05775 12.1842 5.95303 12.2275 5.84383 12.2276V12.2274ZM11.8155 6.2559C11.7063 6.2559 11.6015 6.21252 11.5243 6.1353C11.4471 6.05807 11.4037 5.95333 11.4037 5.84412V2.59691H8.15719C8.10242 2.59803 8.04797 2.5882 7.99705 2.56802C7.94612 2.54783 7.89973 2.51768 7.8606 2.47934C7.82147 2.441 7.79039 2.39524 7.76917 2.34473C7.74795 2.29423 7.73701 2.24 7.73701 2.18522C7.73701 2.13044 7.74795 2.0762 7.76917 2.0257C7.79039 1.9752 7.82147 1.92943 7.8606 1.89109C7.89973 1.85275 7.94612 1.82261 7.99705 1.80242C8.04797 1.78223 8.10242 1.77241 8.15719 1.77352H11.8167C11.9257 1.77389 12.0301 1.81743 12.107 1.89461C12.1839 1.9718 12.2271 2.07633 12.2271 2.1853V5.84481C12.2269 5.95387 12.1835 6.05841 12.1063 6.13548C12.0291 6.21255 11.9246 6.25586 11.8155 6.2559Z"
            fill="currentColor"
          />
        </svg>
      </button>
      <span class="zoom-sep" />
      <button
        class="zoom-icon-btn"
        :class="{ 'is-vertical': orientation === 'vertical' }"
        :title="orientation === 'horizontal' ? $t('actionDesigner.canvas.toVertical') : $t('actionDesigner.canvas.toHorizontal')"
        @click="toggleOrientation"
      >
        <!-- 排列朝向：纵向态复用同一图标旋转 90° -->
        <svg viewBox="0 0 16 16" width="16" height="16" fill="none">
          <path
            d="M10.1595 9.21367L13.7727 6.15236C13.9163 6.03543 14 5.86536 14 5.69529C14 5.52521 13.9163 5.35514 13.7727 5.23822L10.1595 2.17691C9.87238 1.93243 9.41775 1.94306 9.14257 2.19817C8.8674 2.45328 8.87936 2.8572 9.1665 3.10168L11.4875 5.06814H3.50748C3.11266 5.06814 2.78963 5.35514 2.78963 5.70592C2.78963 6.05669 3.11266 6.34369 3.50748 6.34369H11.4756L9.15454 8.31016C9.01097 8.43771 8.92722 8.60778 8.92722 8.76723C8.92722 8.92667 8.999 9.08611 9.13061 9.20304C9.41775 9.44752 9.87238 9.45815 10.1595 9.21367ZM4.95513 13.8482C5.19442 13.6462 5.19442 13.306 4.9671 13.0935L4.06979 12.275H6.61815C6.97707 12.275 7.26421 12.0199 7.26421 11.701C7.26421 11.3821 6.97707 11.127 6.61815 11.127H4.06979L4.9671 10.3085C5.19442 10.0959 5.19442 9.7664 4.95513 9.55381C4.71585 9.35185 4.34497 9.35185 4.10568 9.56444L2.1675 11.3183C2.04786 11.4246 2 11.5522 2 11.6904C2 11.8285 2.05982 11.9561 2.1675 12.0624L4.10568 13.8163C4.34497 14.0501 4.71585 14.0607 4.95513 13.8482ZM7.92223 11.7116C7.92223 11.3927 8.20937 11.1376 8.56829 11.1376H11.0329C11.3918 11.1376 11.679 11.3927 11.679 11.7116C11.679 12.0305 11.3918 12.2856 11.0329 12.2856H8.56829C8.20937 12.2856 7.92223 12.0305 7.92223 11.7116Z"
            fill="currentColor"
          />
        </svg>
      </button>
    </div>
  </div>
</template>

<style scoped>
.canvas-scroll {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
  cursor: grab;
  /* 画布为纯色背景（中性色/填充/背景），不再铺点阵 */
  background-color: rgb(var(--layout-bg-color));
}
.canvas-scroll.panning {
  cursor: grabbing;
  user-select: none;
}
.canvas-inner {
  position: absolute;
  left: 0;
  top: 0;
  will-change: transform;
}
.overlay-svg {
  position: absolute;
  left: 0;
  top: 0;
  pointer-events: none;
  overflow: visible;
}
.slot-edge {
  stroke: rgb(var(--base-text-color) / 0.42);
  stroke-width: 1.6;
  stroke-dasharray: 5 4;
  fill: none;
}
.slot-edge.active {
  stroke: rgb(var(--primary-color));
  stroke-dasharray: none;
}
.node-wrap {
  position: absolute;
  cursor: pointer;
  transition:
    left 0.2s ease,
    top 0.2s ease;
}
.node-wrap.dragging {
  opacity: 0.4;
}
/* 收起/展开切换帧：抑制节点位移过渡（配合视口等量补偿，被点节点保持屏幕原位不抖动） */
.canvas-inner.no-anim .node-wrap {
  transition: none;
}
/* 指向详情图标：默认隐藏，hover 节点时浮出右上角；不参与拖拽/选中 */
.node-detail-btn {
  position: absolute;
  top: -8px;
  right: -8px;
  width: 20px;
  height: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  border: 1px solid rgb(var(--base-text-color) / 0.12);
  background-color: rgb(var(--container-bg-color));
  color: rgb(var(--base-text-color) / 0.55);
  font-size: 14px;
  cursor: help;
  opacity: 0;
  transition: opacity 0.15s ease;
  z-index: 3;
  box-shadow: 0 1px 3px rgb(0 0 0 / 0.12);
}
.node-wrap:hover .node-detail-btn {
  opacity: 1;
}
.node-detail-btn:hover {
  color: rgb(var(--primary-color));
  border-color: rgb(var(--primary-color));
}
/* 分支收起/展开按钮：出边锚点小圆钮（与 node-detail-btn 同族样式）；收起态品牌色提示「有内容被收纳」 */
.collapse-btn {
  position: absolute;
  width: 18px;
  height: 18px;
  padding: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  border: 1px solid rgb(var(--base-text-color) / 0.18);
  background-color: rgb(var(--container-bg-color));
  color: rgb(var(--text-secondary-color));
  font-size: 13px;
  line-height: 1;
  cursor: pointer;
  z-index: 3;
  box-shadow: 0 1px 3px rgb(0 0 0 / 0.12);
}
/* 横向朝向：右缘中点（出边从右侧扇出）；纵向朝向：下缘中点（出边从底部扇出） */
.collapse-btn.pos-right {
  right: -9px;
  top: 50%;
  transform: translateY(-50%);
}
.collapse-btn.pos-bottom {
  bottom: -9px;
  left: 50%;
  transform: translateX(-50%);
}
/* 收起/展开两态同一外观（+ 号样式与收起按钮一致），仅 hover 提示可点。 */
.collapse-btn:hover {
  color: rgb(var(--primary-color));
  border-color: rgb(var(--primary-color));
}
/* 问题标记：左上角 16px 圆标，错误红底「!」、警告琥珀底「!」，白描边压在卡片边缘上。 */
.node-issue {
  position: absolute;
  top: -7px;
  left: -7px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  border: 2px solid rgb(var(--container-bg-color));
  z-index: 2;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  font-size: 11px;
  font-weight: 700;
  line-height: 1;
}
.node-issue::after {
  content: '!';
}
.issue-error {
  background-color: #f04438;
}
.issue-warn {
  background-color: #f79009;
}
/* 空分支占位：在节点尺寸的格子里放一颗小药丸，贴在连线终点那一侧——横向：左对齐垂直居中（连线落在格子左中）；
   纵向：贴顶水平居中（连线落在格子上中）。不再用满格大虚线框，降低画布视觉噪音；保留 layout footprint 以免落点坐标变化 */
.empty-branch-cell {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: flex-start;
}
.empty-branch-cell.is-vertical {
  align-items: flex-start;
  justify-content: center;
}
.empty-pill {
  display: inline-flex;
  align-items: center;
  height: 24px;
  padding: 0 10px;
  box-sizing: border-box;
  border: 1px dashed rgb(var(--base-text-color) / 0.3);
  border-radius: 12px;
  font-size: 11px;
  white-space: nowrap;
  color: rgb(var(--base-text-color) / 0.55);
  background-color: rgb(var(--base-text-color) / 0.03);
}
.empty-then {
  border-color: rgb(22 163 74 / 0.5);
  color: #15803d;
}
.drop-slot {
  position: absolute;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  justify-content: center;
  transition:
    border-color 0.12s ease,
    background-color 0.12s ease,
    transform 0.12s ease;
}
.drop-slot.mode-box {
  border: 2px dashed rgb(var(--base-text-color) / 0.3);
  border-radius: 10px;
  font-size: 13px;
  color: rgb(var(--base-text-color) / 0.45);
  background-color: rgb(var(--container-bg-color) / 0.5);
}
/* 插入条：未激活半透明、激活高亮 */
.drop-slot.mode-bar {
  border-radius: 6px;
  background-color: rgb(var(--base-text-color) / 0.3);
}
.drop-slot.mode-box.active {
  border-color: rgb(var(--primary-color));
  border-style: solid;
  background-color: rgb(var(--primary-color) / 0.16);
  color: rgb(var(--primary-color));
  font-weight: 600;
  transform: scale(1.06);
  box-shadow: 0 0 0 3px rgb(var(--primary-color) / 0.15);
  z-index: 3;
}
.drop-slot.mode-bar.active {
  background-color: rgb(var(--primary-color));
  box-shadow: 0 0 0 3px rgb(var(--primary-color) / 0.18);
  z-index: 3;
}
/* 移动既有节点：用琥珀色与“新增”（主色）区分 */
.drop-slot.is-move.mode-bar.active {
  background-color: #d48806;
  box-shadow: 0 0 0 3px rgb(250 173 20 / 0.2);
}
.drop-slot.is-move.mode-box.active {
  border-color: #d48806;
  color: #d48806;
  background-color: rgb(250 173 20 / 0.12);
  box-shadow: 0 0 0 3px rgb(250 173 20 / 0.16);
}
/* 插入条浮动意图提示 */
.slot-hint {
  position: absolute;
  transform: translate(-50%, -130%);
  padding: 2px 8px;
  border-radius: 8px;
  font-size: 11px;
  font-weight: 600;
  white-space: nowrap;
  color: #fff;
  background-color: rgb(var(--primary-color));
  box-shadow: 0 2px 6px rgb(0 0 0 / 0.18);
  pointer-events: none;
  z-index: 4;
}
.slot-hint.is-move {
  background-color: #d48806;
}
/* 图例胶囊：高 36 白底中圆角 + 卡片投影；各项文字随线色 */
.canvas-legend {
  position: absolute;
  left: 16px;
  top: 16px;
  display: flex;
  align-items: center;
  gap: 24px;
  height: 36px;
  padding: 0 12px;
  border-radius: 8px;
  background-color: rgb(var(--container-bg-color));
  box-shadow: 3px 4px 3.25px rgb(0 0 0 / 0.09);
  font-size: 12px;
  font-weight: 500;
  z-index: 6;
}
.lg-item {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.lg-item-flow,
.lg-item-else {
  color: rgb(var(--text-secondary-color));
}
.lg-item-then {
  /* 成立线改绿，图例同步 */
  color: #15803d;
}
.lg-item-outcome {
  color: rgb(var(--warning-color));
}
.lg-line {
  width: 24px;
  height: 0;
  display: inline-block;
}
.lg-then {
  border-top: 2px solid #16a34a;
}
.lg-else {
  border-top: 2px dashed rgb(var(--base-text-color));
}
.lg-flow {
  border-top: 2px solid rgb(var(--text-secondary-color));
}
/* 出口分支：与 then(成立)/else(不成立) 区分开的第三种线型——用琥珀色，
   因为出口是「按结果分流」而非布尔判断，颜色上不借用 primary/gray 语义避免混淆。
   首个出口(正向/命中)实线；其余出口(见 .lg-outcome-alt)虚线——与 then/else 的
   成立实线/不成立虚线同构。 */
.lg-outcome {
  border-top: 2px solid rgb(var(--warning-color, 240, 160, 30));
}
.lg-outcome-alt {
  border-top: 2px dashed rgb(var(--warning-color, 240, 160, 30));
}
/* 缩放控制条：高 36 白底中圆角 + 卡片投影 */
.canvas-zoom {
  position: absolute;
  right: 16px;
  bottom: 16px;
  display: flex;
  align-items: center;
  gap: 12px;
  height: 36px;
  padding: 0 12px;
  border-radius: 8px;
  background-color: rgb(var(--container-bg-color));
  box-shadow: 3px 4px 3.25px rgb(0 0 0 / 0.09);
  z-index: 6;
}
/* −/百分比/＋ 一组（间距 16） */
.zoom-group {
  display: flex;
  align-items: center;
  gap: 16px;
}
.zoom-btn,
.zoom-pct,
.zoom-icon-btn {
  border: none;
  background: transparent;
  cursor: pointer;
  padding: 0;
  border-radius: 4px;
  color: rgb(var(--text-secondary-color));
}
.zoom-btn {
  width: 20px;
  height: 20px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
/* 适应画布/朝向切换：20px 图标钮，取提示文字色（#999 线稿） */
.zoom-icon-btn {
  width: 20px;
  height: 20px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: rgb(var(--text-hint-color));
}
.zoom-icon-btn.is-vertical svg {
  transform: rotate(90deg);
}
/* 缩放工具条内的分隔线：区隔「适应画布」与「朝向切换」 */
.zoom-sep {
  width: 1px;
  height: 20px;
  background-color: rgb(var(--border-color));
}
.zoom-pct {
  min-width: 34px;
  height: 20px;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.zoom-btn:hover,
.zoom-pct:hover,
.zoom-icon-btn:hover {
  background-color: rgb(var(--base-text-color) / 0.06);
  color: rgb(var(--primary-color));
}
</style>
