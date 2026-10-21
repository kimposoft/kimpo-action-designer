/**
 * 拖拽「合法落点」计算（纵向思维导图）：每条 band 在各兄弟之间 + 末尾给出插入位（带索引），
 * 条件节点的 then/else 各自成 band，空分支占位 port 作为落点。
 * - 同步/异步只是节点执行标志，**不影响落点位置**；落点只决定结构（兄弟次序 / 分支归属）。
 * - 兄弟之间用横向插入条（bar）；空 band / 空分支用大框（box）。
 * - 选中：pickActiveSlot 用「光标到落点矩形」最近 + 距离上限，方向直觉、远处不误激活。
 */

import { COL_WIDTH, NODE_HEIGHT, NODE_WIDTH, V_MAIN_STEP } from './layout';
import type { LayoutResult, Orientation, PositionedNode } from './layout';

const BAR = 10;

export interface DropSlot {
  id: string;
  mode: 'bar' | 'box';
  x: number;
  y: number;
  width: number;
  height: number;
  ownerId: string;
  /** 分支归属：条件用 'then'/'else'；出口分支节点用动作声明的 outcome key；无分支(普通兄弟序列)为空。 */
  branch?: string;
  index: number;
  /** 预览连线起点（父节点 id）。 */
  fromId: string;
  isEnd: boolean;
  /** 占用某空分支 stub 位置（拖拽时隐藏该 stub）。 */
  replacesStubId?: string;
}

export function computeDropSlots(layout: LayoutResult, rootId: string, orientation: Orientation = 'horizontal'): DropSlot[] {
  const horizontal = orientation !== 'vertical';
  // 主轴=流向(父→子)，交叉轴=兄弟堆叠。横向：main=x、cross=y；纵向：main=y、cross=x。
  const crossPos = (n: PositionedNode): number => (horizontal ? n.y : n.x);
  const crossExtent = horizontal ? NODE_HEIGHT : NODE_WIDTH; // 节点在交叉轴上的尺寸
  const mainStepFwd = horizontal ? COL_WIDTH : V_MAIN_STEP; // 流向一步（用于子框/根框）

  // 插入条所在交叉轴位置（gap 中心线）：队首贴首节点前沿、队尾贴末节点后沿，避免悬浮在内容外。
  const gapCross = (seq: PositionedNode[], index: number): number => {
    if (seq.length === 0) return 0;
    if (index === 0) return crossPos(seq[0]) - 2;
    if (index < seq.length) return (crossPos(seq[index - 1]) + crossExtent + crossPos(seq[index])) / 2;
    return crossPos(seq[seq.length - 1]) + crossExtent + 2;
  };

  // 插入条矩形：沿主轴铺满节点尺寸、沿交叉轴细条(BAR)居于 gap。
  const barRect = (mainBase: number, g: number): { x: number; y: number; width: number; height: number } =>
    horizontal
      ? { x: mainBase, y: g - BAR / 2, width: NODE_WIDTH, height: BAR }
      : { x: g - BAR / 2, y: mainBase, width: BAR, height: NODE_HEIGHT };
  const mainBaseOf = (n: PositionedNode): number => (horizontal ? n.x : n.y);

  // 沿流向前一步放置的整框落点（子流程框 / 根框）。
  // 触发根卡片比格子高，按「交叉轴中线 / 流向末端」换算回格子位置，普通节点结果不变。
  const boxAhead = (base: PositionedNode): { x: number; y: number } =>
    horizontal
      ? { x: base.x + mainStepFwd, y: base.y + (base.height - NODE_HEIGHT) / 2 }
      : { x: base.x, y: base.y + (base.height - NODE_HEIGHT) + mainStepFwd };

  const nodeById = new Map(layout.nodes.map(n => [n.id, n] as const));

  const groups = new Map<string, PositionedNode[]>();
  for (const node of layout.nodes) {
    if (!node.parentId) continue;
    const key = `${node.parentId}|${node.branch ?? ''}`;
    const arr = groups.get(key);
    if (arr) arr.push(node);
    else groups.set(key, [node]);
  }

  const slots: DropSlot[] = [];
  for (const [key, members] of groups) {
    const sep = key.indexOf('|');
    const parentId = key.slice(0, sep);
    const branchStr = key.slice(sep + 1);
    const branch = branchStr === '' ? undefined : branchStr;
    members.sort((a, b) => crossPos(a) - crossPos(b));

    const onlyStub = members.length === 1 && members[0].kind === 'empty-branch';
    if (onlyStub) {
      const stub = members[0];
      slots.push({
        id: `slot:${key}:0`,
        mode: 'box',
        x: stub.x,
        y: stub.y,
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
        ownerId: parentId,
        branch,
        index: 0,
        fromId: parentId,
        isEnd: true,
        replacesStubId: stub.id
      });
      continue;
    }

    // seq = 该 band 的全部成员（动作 + 任意数量条件），顺序即数组顺序。
    // 在每个成员间隙给插入条：index 为 band 数组插入位，故动作/条件可插在任意位置（含条件之间）。
    const seq = members.filter(m => m.kind === 'action' || m.kind === 'condition');
    const mainBase = seq.length > 0 ? mainBaseOf(seq[0]) : 0;

    for (let index = 0; index <= seq.length; index += 1) {
      slots.push({
        id: `slot:${key}:${index}`,
        mode: 'bar',
        ...barRect(mainBase, gapCross(seq, index)),
        ownerId: parentId,
        branch,
        index,
        fromId: parentId,
        isEnd: index === seq.length
      });
    }

    // 「流向间隙」插入条：父节点与其首个子成员之间（沿流向）的缺口处，落入该 band 头部(index 0)，
    // 即「在两个元素中间插入」(父→新→原首子)。横向=竖条(贴缺口)、纵向=横条；与交叉轴 index0 条互补、
    // 更贴近用户在连线缺口处的拖放直觉。空 band/空分支不需要（已有大框落点）。
    const parent = nodeById.get(parentId);
    if (parent && seq.length > 0) {
      const parentMainEnd = mainBaseOf(parent) + (horizontal ? parent.width : parent.height);
      const gapMid = (parentMainEnd + mainBaseOf(seq[0])) / 2;
      const firstCross = crossPos(seq[0]);
      const flowRect = horizontal
        ? { x: gapMid - BAR / 2, y: firstCross, width: BAR, height: NODE_HEIGHT }
        : { x: firstCross, y: gapMid - BAR / 2, width: NODE_WIDTH, height: BAR };
      slots.push({
        id: `slot:${key}:flow`,
        mode: 'bar',
        ...flowRect,
        ownerId: parentId,
        branch,
        index: 0,
        fromId: parentId,
        isEnd: false
      });
    }
  }

  // 每个动作节点流向前一步给一个「挂子节点」整框落点（普通续接子流程）。
  // 已有任意 band（含出口分支：`${id}|hit` 等，即便只是空 stub）的动作节点已自带落点，不再额外加框——
  // 出口分支节点尤其要靠这条抑制普通续接槽，保证「有 outcomeChildren 就不再展示节点后直接续接」的互斥。
  for (const node of layout.nodes) {
    if (node.kind !== 'action') continue;
    const hasAnyBand = [...groups.keys()].some(key => key.startsWith(`${node.id}|`));
    if (hasAnyBand) continue;
    slots.push({
      id: `slot:${node.id}:child`,
      mode: 'box',
      ...boxAhead(node),
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
      ownerId: node.id,
      index: 0,
      fromId: node.id,
      isEnd: true
    });
  }

  // 根 band 为空：触发根流向前一步给一个整框落点。
  const hasRootBand = [...groups.keys()].some(key => key.startsWith(`${rootId}|`));
  if (!hasRootBand) {
    const rootNode = layout.nodes.find(node => node.id === rootId);
    if (rootNode) {
      slots.push({
        id: 'slot:root',
        mode: 'box',
        ...boxAhead(rootNode),
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
        ownerId: rootId,
        index: 0,
        fromId: rootId,
        isEnd: true
      });
    }
  }

  return slots;
}

/** 光标（画布内坐标）到落点矩形的最短距离；光标在矩形内则为 0。 */
function distToSlot(slot: DropSlot, cx: number, cy: number): number {
  const dx = Math.max(slot.x - cx, 0, cx - (slot.x + slot.width));
  const dy = Math.max(slot.y - cy, 0, cy - (slot.y + slot.height));
  return Math.hypot(dx, dy);
}

/** 落点激活距离上限（画布内坐标）：超出视为「无合法落点」，避免远处误激活/误落。 */
export const SLOT_ACTIVE_MAX_DIST = 200;

/**
 * 插入条优先半径：光标距某「插入条」(bar) 在此半径内时，优先选插入条而非「大框」(box)。
 * 解决「大框吃落点」——分支/子流程大框面积大，光标稍偏即落入框内(距离0)，会抢走紧贴节点上下沿
 * 那条只有 BAR(10px) 高的精确插入位，导致「插不到动作前后/只能进分支」。精确序列插入应压过进入分支。
 */
export const BAR_PRIORITY_DIST = 30;

/**
 * 按光标选「当前激活落点」：用光标到落点**矩形**的距离（非中心距离），方向直觉。
 * 选择优先级：
 *   1) 若存在距光标 ≤ BAR_PRIORITY_DIST 的插入条(bar)，选最近的插入条（精确插入优先于进入分支/子流程框）；
 *   2) 否则取全体落点中最近者（让用户能进入分支/子流程大框）；
 *   3) 最近距离仍超过 maxDist → null（无落点）。
 */
export function pickActiveSlot(slots: DropSlot[], cursorX: number, cursorY: number, maxDist = SLOT_ACTIVE_MAX_DIST): DropSlot | null {
  let best: DropSlot | null = null;
  let bestDist = Infinity;
  let bestBar: DropSlot | null = null;
  let bestBarDist = Infinity;
  for (const slot of slots) {
    const d = distToSlot(slot, cursorX, cursorY);
    if (d < bestDist) {
      bestDist = d;
      best = slot;
    }
    if (slot.mode === 'bar' && d < bestBarDist) {
      bestBarDist = d;
      bestBar = slot;
    }
  }
  // 插入条在优先半径内 → 压过大框，保证动作/条件能精确插到任意节点的前后位。
  if (bestBar && bestBarDist <= BAR_PRIORITY_DIST) return bestBar;
  return best && bestDist <= maxDist ? best : null;
}
