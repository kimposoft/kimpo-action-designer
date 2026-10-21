import { describe, expect, it } from 'vitest';

import { computeDropSlots, pickActiveSlot } from './dropSlots';
import { layoutTree } from './layout';
import { createActionNode, createConditionNode, createTriggerRoot } from './model';

function slotsOf(root: ReturnType<typeof createTriggerRoot>) {
  return computeDropSlots(layoutTree(root), root.id);
}

describe('computeDropSlots（纵向兄弟插入）', () => {
  it('多动作 band 给出 index 0..count 的横向插入条', () => {
    const root = createTriggerRoot({
      eventKey: 'manual',
      scope: 'form',
      children: [createActionNode({ id: 'a1', actionName: 'x' }), createActionNode({ id: 'a2', actionName: 'y' })]
    });
    // 仅看交叉轴兄弟插入条（排除流向间隙条 :flow，后者是另一朝向）。
    const bars = slotsOf(root).filter(s => s.mode === 'bar' && !s.id.endsWith(':flow'));
    expect(bars.map(s => s.index).sort()).toEqual([0, 1, 2]);
    for (const b of bars) expect(b.width).toBeGreaterThan(b.height); // 横条
  });

  it('空 band（仅触发根）给一个右侧大框落点', () => {
    const root = createTriggerRoot({ eventKey: 'manual', scope: 'form', children: [] });
    const slots = slotsOf(root);
    expect(slots.length).toBe(1);
    expect(slots[0].mode).toBe('box');
    expect(slots[0].index).toBe(0);
  });

  it('条件空分支给出 then/else 两个大框落点（branch 标识）', () => {
    const cond = createConditionNode({ condition: { fieldId: 'f', op: '=', value: 1 } });
    const root = createTriggerRoot({ eventKey: 'manual', scope: 'form', children: [cond] });
    const boxes = slotsOf(root).filter(s => s.ownerId === cond.id && s.mode === 'box');
    expect(boxes.map(s => s.branch).sort()).toEqual(['else', 'then']);
  });

  it('band 含条件时，条件之后也给出动作插入条（index = 数组末位，可在条件下方放动作）', () => {
    const root = createTriggerRoot({
      eventKey: 'manual',
      scope: 'form',
      children: [
        createActionNode({ id: 'a1', actionName: 'x' }),
        createConditionNode({ condition: { fieldId: 'f', op: '>', value: 0 } })
      ]
    });
    // 根 band seq=[a1, 条件]，插入条 index 应为 0/1/2，其中 index 2 落在条件之后（isEnd）。
    const rootBars = slotsOf(root).filter(s => s.mode === 'bar' && s.ownerId === root.id && !s.id.endsWith(':flow'));
    expect(rootBars.map(s => s.index).sort()).toEqual([0, 1, 2]);
    const afterCond = rootBars.find(s => s.index === 2);
    expect(afterCond?.isEnd).toBe(true);
  });

  it('纵向朝向：兄弟插入条转为竖条（height>width），且落点集合数量与横向一致', () => {
    const root = createTriggerRoot({
      eventKey: 'manual',
      scope: 'form',
      children: [createActionNode({ id: 'a1', actionName: 'x' }), createActionNode({ id: 'a2', actionName: 'y' })]
    });
    const h = computeDropSlots(layoutTree(root, 'horizontal'), root.id, 'horizontal');
    const v = computeDropSlots(layoutTree(root, 'vertical'), root.id, 'vertical');
    expect(v.length).toBe(h.length); // 落点结构无损（含等量流向间隙条）
    const vBars = v.filter(s => s.mode === 'bar' && !s.id.endsWith(':flow'));
    expect(vBars.map(s => s.index).sort()).toEqual([0, 1, 2]);
    for (const b of vBars) expect(b.height).toBeGreaterThan(b.width); // 竖条
  });
});

describe('出口分支落点（R5，动作声明 x-outcomes）', () => {
  const outcomesOf = (name?: string) => (name === 'ui.open_form' ? ['hit', 'miss'] : []);

  it('声明出口的动作给出各出口的大框落点（branch=出口 key），且不再有普通续接框（互斥）', () => {
    const probe = createActionNode({ id: 'probe', actionName: 'ui.open_form' });
    const root = createTriggerRoot({ eventKey: 'manual', scope: 'form', children: [probe] });
    const layout = layoutTree(root, 'horizontal', outcomesOf);
    const slots = computeDropSlots(layout, root.id, 'horizontal');
    const boxes = slots.filter(s => s.ownerId === 'probe' && s.mode === 'box');
    expect(boxes.map(s => s.branch).sort()).toEqual(['hit', 'miss']);
    // 普通续接框（无 branch）已被抑制：多出口节点不再展示「节点后直接续接」入口。
    expect(slots.some(s => s.ownerId === 'probe' && s.branch === undefined)).toBe(false);
  });

  it('出口 band 内已有动作时，给出该 band 的兄弟插入条（同普通 band 规则）', () => {
    const probe = {
      ...createActionNode({ id: 'probe', actionName: 'ui.open_form' }),
      outcomeChildren: { hit: [createActionNode({ id: 'hitA', actionName: 'a' })], miss: [] }
    };
    const root = createTriggerRoot({ eventKey: 'manual', scope: 'form', children: [probe] });
    const layout = layoutTree(root, 'horizontal', outcomesOf);
    const slots = computeDropSlots(layout, root.id, 'horizontal');
    const hitBars = slots.filter(s => s.ownerId === 'probe' && s.branch === 'hit' && s.mode === 'bar' && !s.id.endsWith(':flow'));
    expect(hitBars.map(s => s.index).sort()).toEqual([0, 1]); // 插到 hitA 之前/之后
    const missBox = slots.find(s => s.ownerId === 'probe' && s.branch === 'miss' && s.mode === 'box');
    expect(missBox).toBeDefined(); // miss 仍为空 band，给大框落点
  });
});

describe('pickActiveSlot', () => {
  const root = createTriggerRoot({
    eventKey: 'manual',
    scope: 'form',
    children: [createActionNode({ id: 'a1', actionName: 'x' }), createActionNode({ id: 'a2', actionName: 'y' })]
  });
  const slots = slotsOf(root).filter(s => s.mode === 'bar');

  it('光标离所有落点很远 → null（无合法落点）', () => {
    expect(pickActiveSlot(slots, 5000, 5000)).toBeNull();
  });

  it('光标贴近某落点矩形 → 命中该落点', () => {
    const s = slots[0];
    const picked = pickActiveSlot(slots, s.x + s.width / 2, s.y + s.height / 2);
    expect(picked?.id).toBe(s.id);
  });
});

// 「大框吃落点」回归：分支/子流程大框面积大，紧贴动作上下沿的精确插入条若被大框抢走，
// 会表现为「插不到动作前后、只能进分支」。pickActiveSlot 须让近距离插入条压过大框。
describe('pickActiveSlot：插入条优先于相邻大框（防大框吃落点）', () => {
  function build() {
    const p1 = createActionNode({ id: 'p1', actionName: 'a' });
    const p2 = createActionNode({ id: 'p2', actionName: 'b' });
    const cond = createConditionNode({
      condition: { fieldId: 'f', op: '>', value: 0 },
      thenChildren: [p1, p2],
      elseChildren: [] // else 为空 → 渲染一个大框 stub，正落在 then 末尾插入条下方
    });
    const root = createTriggerRoot({ eventKey: 'manual', scope: 'form', children: [cond] });
    const layout = layoutTree(root);
    const slots = computeDropSlots(layout, root.id);
    const p2n = layout.nodes.find(n => n.id === 'p2')!;
    return { slots, p2n, cond };
  }

  it('光标在 then 最后一个动作正下方（略偏入 else 框上沿）→ 选「其后插入条」而非 else 框', () => {
    const { slots, cond } = build();
    // 仅条件可落的候选（排除 owner 为动作的子流程框），模拟画布对条件拖拽的过滤。
    const layoutNodeKind = new Map(slots.map(s => [s.ownerId, s.ownerId]));
    void layoutNodeKind;
    const thenBars = slots.filter(s => s.mode === 'bar' && s.branch === 'then');
    const lastBar = thenBars.find(s => s.isEnd)!;
    // 光标落在末尾插入条下方 ~18px（已越过插入条、压在 else 大框上半区）。
    const picked = pickActiveSlot(slots, lastBar.x + lastBar.width / 2, lastBar.y + lastBar.height + 18);
    expect(picked?.mode).toBe('bar');
    expect(picked?.branch).toBe('then');
    expect(picked?.isEnd).toBe(true);
    expect(picked?.ownerId).toBe(cond.id);
  });

  it('光标在空 else 大框正中央 → 仍选中 else 框（进入空分支不受影响）', () => {
    const { slots } = build();
    const elseBox = slots.find(s => s.mode === 'box' && s.branch === 'else')!;
    const picked = pickActiveSlot(slots, elseBox.x + elseBox.width / 2, elseBox.y + elseBox.height / 2);
    expect(picked?.mode).toBe('box');
    expect(picked?.branch).toBe('else');
  });
});

// 「两个元素中间插入」回归：父节点与其子流程首子之间（沿流向的连线缺口）须有落点，
// 否则光标落在该缺口会误选到外层 band，导致「中间插不进去」。横/纵向都要覆盖。
describe('流向间隙插入（父↔首子之间，含纵向）', () => {
  function buildChain(orient: 'horizontal' | 'vertical') {
    const a = { ...createActionNode({ id: 'A', actionName: 'a' }), children: [createActionNode({ id: 'C', actionName: 'c' })] };
    const root = createTriggerRoot({ eventKey: 'manual', scope: 'form', children: [a, createActionNode({ id: 'B', actionName: 'b' })] });
    const layout = layoutTree(root, orient);
    return { slots: computeDropSlots(layout, root.id, orient), layout };
  }

  for (const orient of ['horizontal', 'vertical'] as const) {
    it(`${orient}：父 A 与首子 C 之间的流向缺口 → 落入 A 子流程 band 头部(index 0)`, () => {
      const { slots, layout } = buildChain(orient);
      const an = layout.nodes.find(n => n.id === 'A')!;
      const cn = layout.nodes.find(n => n.id === 'C')!;
      const [cx, cy] =
        orient === 'horizontal'
          ? [(an.x + an.width + cn.x) / 2, an.y + an.height / 2]
          : [an.x + an.width / 2, (an.y + an.height + cn.y) / 2];
      const picked = pickActiveSlot(slots, cx, cy);
      expect(picked?.mode).toBe('bar');
      expect(picked?.ownerId).toBe('A'); // 落入 A 的子流程 band
      expect(picked?.index).toBe(0); // 头部 = 父→新→原首子
    });
  }
});
