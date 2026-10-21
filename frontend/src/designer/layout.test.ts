import { describe, expect, it } from 'vitest';

import { NODE_HEIGHT, ROOT_NODE_HEIGHT, V_MAIN_STEP, layoutTree } from './layout';
import { createActionNode, createConditionNode, createTriggerRoot } from './model';

describe('layoutTree（纵向思维导图）', () => {
  it('触发根在左，band 兄弟在右侧同列纵向排列（执行顺序自上而下），父纵向居中', () => {
    const root = createTriggerRoot({
      eventKey: 'manual',
      scope: 'form',
      children: [createActionNode({ id: 'a1', actionName: 'x' }), createActionNode({ id: 'a2', actionName: 'y' })]
    });
    const { nodes, edges } = layoutTree(root);
    const byId = Object.fromEntries(nodes.map(n => [n.id, n]));
    expect(byId[root.id].x).toBe(0);
    expect(byId.a1.x).toBeGreaterThan(byId[root.id].x);
    expect(byId.a1.x).toBe(byId.a2.x); // 同列
    expect(byId.a1.y).toBeLessThan(byId.a2.y); // 纵向、自上而下
    // 父居中（按中线比：触发根卡片比动作卡片高，比较 y 中线而非上沿）。
    const mid = (n: { y: number; height: number }): number => n.y + n.height / 2;
    expect(mid(byId[root.id])).toBeCloseTo((mid(byId.a1) + mid(byId.a2)) / 2, 5);
    expect(edges.find(e => e.toId === 'a1')?.kind).toBe('flow');
  });

  it('同步/异步不影响布局位置：async 与同步动作同列纵向排列', () => {
    const root = createTriggerRoot({
      eventKey: 'manual',
      scope: 'form',
      children: [createActionNode({ id: 'a1', actionName: 'x' }), createActionNode({ id: 'a2', actionName: 'y', async: true })]
    });
    const byId = Object.fromEntries(layoutTree(root).nodes.map(n => [n.id, n]));
    expect(byId.a2.x).toBe(byId.a1.x); // 异步不右移
    expect(byId.a2.y).toBeGreaterThan(byId.a1.y); // 仍是纵向兄弟（按数组顺序）
  });

  it('动作可带子节点（嵌套子流程），子节点在其右侧', () => {
    const child = createActionNode({ id: 'c1', actionName: 'next' });
    const parent = createActionNode({ id: 'a1', actionName: 'x' });
    parent.children = [child];
    const root = createTriggerRoot({ eventKey: 'manual', scope: 'form', children: [parent] });
    const byId = Object.fromEntries(layoutTree(root).nodes.map(n => [n.id, n]));
    expect(byId.c1.x).toBeGreaterThan(byId.a1.x); // 子节点在父右侧
    expect(byId.c1.parentId).toBe('a1');
  });

  it('条件向右分叉 then(上)/else(下)，条件居中于两者', () => {
    const root = createTriggerRoot({
      eventKey: 'before-save',
      scope: 'form',
      children: [
        createConditionNode({
          condition: { fieldId: 'f', op: '>', value: 1 },
          thenChildren: [createActionNode({ id: 'tA', actionName: 'a' })],
          elseChildren: [createActionNode({ id: 'eA', actionName: 'b' })]
        })
      ]
    });
    const { nodes, edges } = layoutTree(root);
    const byId = Object.fromEntries(nodes.map(n => [n.id, n]));
    const cond = nodes.find(n => n.kind === 'condition')!;
    expect(byId.tA.x).toBe(byId.eA.x);
    expect(byId.tA.y).toBeLessThan(byId.eA.y);
    expect(cond.y).toBeCloseTo((byId.tA.y + byId.eA.y) / 2, 5);
    expect(edges.find(e => e.toId === 'tA')?.kind).toBe('then');
    expect(edges.find(e => e.toId === 'eA')?.kind).toBe('else');
  });

  it('空分支给出占位 port（带 branch 与 else 连线）', () => {
    const root = createTriggerRoot({
      eventKey: 'before-save',
      scope: 'form',
      children: [
        createConditionNode({
          condition: { fieldId: 'f', op: '>', value: 1 },
          thenChildren: [createActionNode({ id: 'tA', actionName: 'a' })],
          elseChildren: []
        })
      ]
    });
    const { nodes, edges } = layoutTree(root);
    const stub = nodes.find(n => n.kind === 'empty-branch');
    expect(stub?.branchOf?.branch).toBe('else');
    expect(edges.some(e => e.toId === stub?.id && e.kind === 'else')).toBe(true);
  });

  it('纵向朝向：主轴/交叉轴对调（父在上、子在下；兄弟同行横向，父横向居中）', () => {
    const root = createTriggerRoot({
      eventKey: 'manual',
      scope: 'form',
      children: [createActionNode({ id: 'a1', actionName: 'x' }), createActionNode({ id: 'a2', actionName: 'y' })]
    });
    const byId = Object.fromEntries(layoutTree(root, 'vertical').nodes.map(n => [n.id, n]));
    expect(byId[root.id].y).toBe(0);
    expect(byId.a1.y).toBeGreaterThan(byId[root.id].y); // 子在父下方（主轴=y）
    expect(byId.a1.y).toBe(byId.a2.y); // 同行
    expect(byId.a1.x).toBeLessThan(byId.a2.x); // 兄弟横向、自左而右（交叉轴=x）
    expect(byId[root.id].x).toBeCloseTo((byId.a1.x + byId.a2.x) / 2, 5); // 父横向居中
  });

  it('横向/纵向无损：节点集合与连线结构一致，仅坐标映射不同', () => {
    const root = createTriggerRoot({
      eventKey: 'before-save',
      scope: 'form',
      children: [
        createConditionNode({
          condition: { fieldId: 'f', op: '>', value: 1 },
          thenChildren: [createActionNode({ id: 'tA', actionName: 'a' })],
          elseChildren: [createActionNode({ id: 'eA', actionName: 'b' })]
        })
      ]
    });
    const h = layoutTree(root, 'horizontal');
    const v = layoutTree(root, 'vertical');
    const ids = (r: typeof h) => r.nodes.map(n => n.id).sort();
    const edgeKeys = (r: typeof h) => r.edges.map(e => `${e.fromId}->${e.toId}:${e.kind}`).sort();
    expect(ids(v)).toEqual(ids(h)); // 同一套节点
    expect(edgeKeys(v)).toEqual(edgeKeys(h)); // 同一套连线（结构无损）
  });

  it('出口分支节点（R5）：声明 x-outcomes 的动作向右分叉 N 条出口 band，交叉轴堆叠、父居中（与 then/else 同构）', () => {
    const outcomesOf = (name?: string) => (name === 'ui.open_form' ? ['hit', 'miss'] : []);
    const probe = {
      ...createActionNode({ id: 'probe', actionName: 'ui.open_form' }),
      outcomeChildren: {
        hit: [createActionNode({ id: 'hitA', actionName: 'a' })],
        miss: [createActionNode({ id: 'missA', actionName: 'b' })]
      }
    };
    const root = createTriggerRoot({ eventKey: 'manual', scope: 'form', children: [probe] });
    const { nodes, edges } = layoutTree(root, 'horizontal', outcomesOf);
    const byId = Object.fromEntries(nodes.map(n => [n.id, n]));
    expect(byId.hitA.x).toBe(byId.missA.x); // 同列
    expect(byId.hitA.y).toBeLessThan(byId.missA.y); // 按声明顺序纵向堆叠（hit 在上）
    expect(byId.probe.y).toBeCloseTo((byId.hitA.y + byId.missA.y) / 2, 5); // 父居中
    // 出口按声明序号区分线型——第 0 个(hit)='outcome' 实线，其余(miss)='outcome-alt' 虚线。
    expect(edges.find(e => e.toId === 'hitA')).toMatchObject({ kind: 'outcome', branch: 'hit' });
    expect(edges.find(e => e.toId === 'missA')).toMatchObject({ kind: 'outcome-alt', branch: 'miss' });
  });

  it('出口分支节点：未落子节点的出口给占位 stub（同 condition 空分支同构）', () => {
    const outcomesOf = (name?: string) => (name === 'ui.open_form' ? ['hit', 'miss'] : []);
    const root = createTriggerRoot({
      eventKey: 'manual',
      scope: 'form',
      children: [createActionNode({ id: 'probe', actionName: 'ui.open_form' })]
    });
    const { nodes } = layoutTree(root, 'horizontal', outcomesOf);
    const stubs = nodes.filter(n => n.kind === 'empty-branch');
    expect(stubs.map(s => s.branchOf?.branch).sort()).toEqual(['hit', 'miss']);
  });

  it('outcomesOf 缺省（默认回落空数组）时不影响原有 children 续接语义', () => {
    const child = createActionNode({ id: 'c1', actionName: 'next' });
    const parent = createActionNode({ id: 'a1', actionName: 'plain' });
    parent.children = [child];
    const root = createTriggerRoot({ eventKey: 'manual', scope: 'form', children: [parent] });
    const byId = Object.fromEntries(layoutTree(root).nodes.map(n => [n.id, n]));
    expect(byId.c1.parentId).toBe('a1');
  });

  it('isCollapsed：收起节点的下游（真实子节点与出口占位）整体不参与布局', () => {
    const child = createActionNode({ id: 'c1', actionName: 'next' });
    const branched = createActionNode({ id: 'a1', actionName: 'extract' });
    branched.children = [child];
    const plain = createActionNode({ id: 'a2', actionName: 'plain' });
    const root = createTriggerRoot({ eventKey: 'manual', scope: 'form', children: [branched, plain] });
    const outcomesOf = (name?: string) => (name === 'extract' ? ['filled', 'empty'] : []);

    // 展开：a1 按出口分叉产出两个空占位（children 与出口互斥，c1 不展示——既有语义）。
    const expanded = layoutTree(root, 'horizontal', outcomesOf);
    expect(expanded.nodes.some(n => n.kind === 'empty-branch')).toBe(true);

    // 收起 a1：占位与下游全部消失，其余节点照常。
    const collapsed = layoutTree(root, 'horizontal', outcomesOf, node => node.id === 'a1');
    expect(collapsed.nodes.some(n => n.kind === 'empty-branch')).toBe(false);
    expect(collapsed.nodes.some(n => n.id === 'c1')).toBe(false);
    expect(collapsed.nodes.some(n => n.id === 'a1')).toBe(true);
    expect(collapsed.nodes.some(n => n.id === 'a2')).toBe(true);
    // 收起后画布高度收窄（a1 不再为两个占位撑行）。
    expect(collapsed.height).toBeLessThan(expanded.height);
  });

  it('确定性：同树 → 同布局', () => {
    const build = () =>
      createTriggerRoot({
        eventKey: 'manual',
        scope: 'form',
        children: [
          createActionNode({ id: 'a1', actionName: 'x' }),
          createConditionNode({
            condition: { fieldId: 'f', op: '=', value: 1 },
            thenChildren: [createActionNode({ id: 't1', actionName: 'a' })],
            elseChildren: [createActionNode({ id: 'e1', actionName: 'b' })]
          })
        ]
      });
    const strip = (r: ReturnType<typeof layoutTree>) => r.nodes.map(n => ({ kind: n.kind, x: n.x, y: n.y }));
    expect(strip(layoutTree(build()))).toEqual(strip(layoutTree(build())));
    expect(layoutTree(build()).height).toBeGreaterThanOrEqual(NODE_HEIGHT);
  });
});

// 触发根卡片 ROOT_NODE_HEIGHT 高于格子——横向居中探出、纵向向上探出，统一平移后无负坐标。
describe('layoutTree：触发根卡片尺寸', () => {
  it('横向：根中线与单个子节点中线对齐，坐标不为负', () => {
    const root = createTriggerRoot({ eventKey: 'manual', scope: 'form', children: [createActionNode({ id: 'a1', actionName: 'x' })] });
    const { nodes } = layoutTree(root);
    const byId = Object.fromEntries(nodes.map(n => [n.id, n]));
    expect(byId[root.id].height).toBe(ROOT_NODE_HEIGHT);
    expect(byId.a1.height).toBe(NODE_HEIGHT);
    expect(byId[root.id].y + ROOT_NODE_HEIGHT / 2).toBe(byId.a1.y + NODE_HEIGHT / 2);
    expect(Math.min(...nodes.map(n => n.y))).toBe(0);
  });

  it('纵向：根底边与普通格子底边一致，子节点间距不变', () => {
    const root = createTriggerRoot({ eventKey: 'manual', scope: 'form', children: [createActionNode({ id: 'a1', actionName: 'x' })] });
    const byId = Object.fromEntries(layoutTree(root, 'vertical').nodes.map(n => [n.id, n]));
    expect(byId[root.id].y).toBe(0);
    expect(byId.a1.y - (byId[root.id].y + ROOT_NODE_HEIGHT)).toBe(V_MAIN_STEP - NODE_HEIGHT);
  });
});
