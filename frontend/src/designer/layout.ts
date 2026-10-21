/**
 * 自动布局 walker（坐标只读模型树推导、绝不持久化）。
 *
 * 思维导图式（左→右）：父节点在左、其子节点在右侧**纵向排列**（兄弟纵向 = 执行顺序），父节点纵向居中于子节点。
 * - 触发根 / 动作节点的子节点 = 一条顺序动作带（自上而下即执行顺序）。
 * - 条件节点的子节点 = then 分支（上）+ else 分支（下）；空分支用占位 port 占一行。
 *
 * 重要：节点的「同步 / 异步」只是执行标志（async），**绝不影响布局位置**——位置只由父子/兄弟结构决定。
 */

import type { MindNode } from './model';

// 节点卡片 208×72：左侧分类图标块 + 名称单行约 10 字 + 「动作类型 · 关键配置」摘要行；列距 72、行距 28。
export const NODE_WIDTH = 208;
export const NODE_HEIGHT = 72;
/** 触发根（起始节点）卡片更高一档：底部固定一条触发字段 / 排期摘要栏。布局格子仍按 NODE_HEIGHT 推导，
 *  根卡片在交叉轴上居中于自身格子（纵向时底边对齐格子底边），见 layoutTree 的根尺寸修正。 */
export const ROOT_NODE_HEIGHT = 104;
export const H_GAP = 72;
export const V_GAP = 28;
export const ROW_HEIGHT = NODE_HEIGHT + V_GAP;
export const COL_WIDTH = NODE_WIDTH + H_GAP;
// 纵向朝向专用步距：depth(竖向)间距拉大、兄弟(横向)间距拉小（横向朝向不受影响）。
export const V_MAIN_STEP = NODE_HEIGHT + 64; // 竖向 depth 步距（间距 64 > 横向 V_GAP 24）
export const V_CROSS_STEP = NODE_WIDTH + 28; // 横向兄弟步距（间距 28 < 横向 H_GAP 88）

export type PositionedKind = MindNode['kind'] | 'empty-branch';

/** 画布朝向：horizontal=横向(父左子右，兄弟纵向)；vertical=纵向(父上子下，兄弟横向)。两者由同一模型树无损推导。 */
export type Orientation = 'horizontal' | 'vertical';

/** 连线类型：顺序(父子/兄弟链) / 条件 then / 条件 else / 出口分支(动作按 x-outcomes 分流)。
 *  出口分支按声明序号区分线型（与 then/else 的"成立实线/不成立虚线"同构）：
 *  'outcome' = 首个出口(序号0，正向/命中)实线；'outcome-alt' = 其余出口虚线。 */
export type LayoutEdgeKind = 'flow' | 'then' | 'else' | 'outcome' | 'outcome-alt';

/**
 * 分支标识（泛化为任意字符串）：条件节点固定用 'then'/'else'；出口分支节点用动作定义声明的
 * outcome key（如 "hit"/"miss"），数量不限于二——交叉轴堆叠布局算法（见下方 place()）与分支数无关，
 * 天然支持 N 个分支，本次首个消费者（打开表单）只声明了 2 个。
 */
export type BranchKey = string;

export interface PositionedNode {
  id: string;
  kind: PositionedKind;
  x: number;
  y: number;
  width: number;
  height: number;
  node?: MindNode;
  branchOf?: { ownerId: string; branch: BranchKey };
  parentId?: string;
  branch?: BranchKey;
  edge?: LayoutEdgeKind;
}

export interface LayoutEdge {
  fromId: string;
  toId: string;
  branch?: BranchKey;
  kind: LayoutEdgeKind;
}

export interface LayoutResult {
  nodes: PositionedNode[];
  edges: LayoutEdge[];
  width: number;
  height: number;
}

interface LayoutNode {
  id: string;
  kind: PositionedKind;
  depth: number;
  node?: MindNode;
  branchOf?: { ownerId: string; branch: BranchKey };
  parentId?: string;
  branch?: BranchKey;
  edge?: LayoutEdgeKind;
  children: LayoutNode[];
  x: number;
  y: number;
}

interface ChildSpec {
  node?: MindNode;
  stub?: boolean;
  branch?: BranchKey;
  edge: LayoutEdgeKind;
}

/** 取一个动作定义声明的出口分支集合（来自 params_schema['x-outcomes']）；未声明返回空数组。 */
export type OutcomesOfFn = (actionName: string | undefined) => string[];

const noOutcomes: OutcomesOfFn = () => [];

/** 节点是否处于「收起」态（分支收纳）：收起的节点不下钻——其真实子节点与空分支
 *  占位一并不参与布局（视图级剪枝，模型树不动）。判定由画布按会话覆盖表（用户手动收起）计算后传入；
 *  插件默认收起关键字 params_schema['x-collapse-default'] 已退役，默认态恒展开。 */
export type IsCollapsedFn = (node: MindNode) => boolean;

const neverCollapsed: IsCollapsedFn = () => false;

/** 一个节点在画布上显示的子节点列表（纵向排列）。 */
function displayChildren(node: MindNode, outcomesOf: OutcomesOfFn): ChildSpec[] {
  if (node.kind === 'action') {
    // 出口分支：动作定义声明了 x-outcomes 时，向右按声明顺序分叉为 N 条出口 band（与 condition
    // 的 then/else 同构：每个出口各自一条顺序 band，未落子节点时给占位 stub）。与普通续接（children）
    // 互斥——声明了出口即不再展示 children 续接槽（见 useActionDesigner.bandOf / dropSlots 的 box 落点抑制）。
    const outcomes = outcomesOf(node.actionName);
    if (outcomes.length > 0) {
      return outcomes.flatMap((outcome, index): ChildSpec[] => {
        // 按声明序号区分线型：第 0 个出口（正向/命中，如「有数据」）实线，其余（如「无数据」）虚线——
        // 不硬编码 filled/empty 等具体 key，任意动作的出口集合都按此序号规则统一处理。
        const edgeKind = index === 0 ? ('outcome' as const) : ('outcome-alt' as const);
        const band = node.outcomeChildren?.[outcome];
        if (band && band.length > 0) {
          return band.map(child => ({ node: child, branch: outcome, edge: edgeKind }));
        }
        return [{ stub: true, branch: outcome, edge: edgeKind }];
      });
    }
    // 普通动作：子流程（嵌套后续步骤）。
    return (node.children ?? []).map(child => ({ node: child, edge: 'flow' as const }));
  }
  if (node.kind === 'trigger-root') {
    return (node.children ?? []).map(child => ({ node: child, edge: 'flow' as const }));
  }
  if (node.kind === 'condition') {
    const thenKids: ChildSpec[] =
      node.thenChildren && node.thenChildren.length > 0
        ? node.thenChildren.map(child => ({ node: child, branch: 'then' as const, edge: 'then' as const }))
        : [{ stub: true, branch: 'then' as const, edge: 'then' as const }];
    const elseKids: ChildSpec[] =
      node.elseChildren && node.elseChildren.length > 0
        ? node.elseChildren.map(child => ({ node: child, branch: 'else' as const, edge: 'else' as const }))
        : [{ stub: true, branch: 'else' as const, edge: 'else' as const }];
    return [...thenKids, ...elseKids];
  }
  return [];
}

function build(
  node: MindNode,
  outcomesOf: OutcomesOfFn,
  isCollapsed: IsCollapsedFn,
  depth: number,
  parentId?: string,
  branch?: BranchKey,
  edge?: LayoutEdgeKind
): LayoutNode {
  const ln: LayoutNode = { id: node.id, kind: node.kind, depth, node, parentId, branch, edge, children: [], x: 0, y: 0 };
  // 收起态：整棵下游（真实子节点 + 空分支占位）不参与布局；展开/收起仅重排坐标，模型树不变。
  if (isCollapsed(node)) return ln;
  for (const spec of displayChildren(node, outcomesOf)) {
    if (spec.stub) {
      ln.children.push({
        id: `${node.id}:${spec.branch}-empty`,
        kind: 'empty-branch',
        depth: depth + 1,
        branchOf: { ownerId: node.id, branch: spec.branch! },
        parentId: node.id,
        branch: spec.branch,
        edge: spec.edge,
        children: [],
        x: 0,
        y: 0
      });
    } else {
      ln.children.push(build(spec.node!, outcomesOf, isCollapsed, depth + 1, node.id, spec.branch, spec.edge));
    }
  }
  return ln;
}

/**
 * layoutTree：MindNode 触发根 → 定位节点 + 连线 + 画布尺寸。
 * orientation 控制朝向：横向时主轴(父→子)=x、交叉轴(兄弟堆叠)=y；纵向时主轴=y、交叉轴=x。
 * 仅坐标映射不同，结构/连线/尺寸由同一模型树推导，故两朝向可无损切换。
 */
export function layoutTree(
  root: MindNode,
  orientation: Orientation = 'horizontal',
  outcomesOf: OutcomesOfFn = noOutcomes,
  isCollapsed: IsCollapsedFn = neverCollapsed
): LayoutResult {
  const rootLN = build(root, outcomesOf, isCollapsed, 0);

  const horizontal = orientation !== 'vertical';
  // 纵向用专用步距（竖间距大、横间距小）；横向保持原步距。
  const mainStep = horizontal ? COL_WIDTH : V_MAIN_STEP; // 流向步距（父→子）
  const crossStep = horizontal ? ROW_HEIGHT : V_CROSS_STEP; // 兄弟步距（堆叠方向）
  // 主轴/交叉轴坐标 → x/y 的映射：横向 main=x、cross=y；纵向 main=y、cross=x。
  const assign = (ln: LayoutNode, main: number, cross: number): void => {
    if (horizontal) {
      ln.x = main;
      ln.y = cross;
    } else {
      ln.x = cross;
      ln.y = main;
    }
  };
  const crossOf = (ln: LayoutNode): number => (horizontal ? ln.y : ln.x);

  let nextCross = 0;
  function place(ln: LayoutNode): void {
    const main = ln.depth * mainStep;
    if (ln.children.length === 0) {
      assign(ln, main, nextCross * crossStep);
      nextCross += 1;
      return;
    }
    ln.children.forEach(place);
    // 父节点在交叉轴居中于首末子节点。
    assign(ln, main, (crossOf(ln.children[0]) + crossOf(ln.children[ln.children.length - 1])) / 2);
  }
  place(rootLN);

  const nodes: PositionedNode[] = [];
  const edges: LayoutEdge[] = [];
  let maxX = 0;
  let maxY = 0;

  // 触发根卡片比格子高 ROOT_NODE_HEIGHT-NODE_HEIGHT。横向时上下各探出一半（中线不变，连线锚点
  // 仍落在格子中线）；纵向时整体向上探出（底边=格子底边，子节点间距不变）。探出可能产生负坐标，collect 后统一平移。
  const rootExtra = ROOT_NODE_HEIGHT - NODE_HEIGHT;
  function collect(ln: LayoutNode): void {
    const isRoot = ln.kind === 'trigger-root';
    const height = isRoot ? ROOT_NODE_HEIGHT : NODE_HEIGHT;
    const y = isRoot ? ln.y - (horizontal ? rootExtra / 2 : rootExtra) : ln.y;
    nodes.push({
      id: ln.id,
      kind: ln.kind,
      x: ln.x,
      y,
      width: NODE_WIDTH,
      height,
      node: ln.node,
      branchOf: ln.branchOf,
      parentId: ln.parentId,
      branch: ln.branch,
      edge: ln.edge
    });
    maxX = Math.max(maxX, ln.x + NODE_WIDTH);
    maxY = Math.max(maxY, y + height);
    for (const child of ln.children) {
      edges.push({ fromId: ln.id, toId: child.id, branch: child.branch, kind: child.edge ?? 'flow' });
      collect(child);
    }
  }
  collect(rootLN);

  // 根卡片探出导致的负坐标：整体下移，保证画布内容恒从 (0,0) 起（落点 / 连线都从 nodes 推导，随之一致）。
  const minY = Math.min(0, ...nodes.map(n => n.y));
  if (minY < 0) {
    for (const n of nodes) n.y -= minY;
    maxY -= minY;
  }

  return { nodes, edges, width: maxX, height: maxY };
}
