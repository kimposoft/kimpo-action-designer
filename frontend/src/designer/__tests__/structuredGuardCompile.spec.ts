/**
 * 条件分支使用 V3.4 结构化条件——前端编译/反编译面。
 *
 * 这条链路的分工：结构化条件由「筛选条件」编辑器产出，前端只负责把它原样落进动作文档
 * （guards[].condition_group）、以及打开文档时按层拆回各个条件节点；求值能力（NOT/形如/属于/
 * 为空 + 任意嵌套）由宿主后端负责，并由宿主侧测试走真实宿主查询服务链路验证。
 *
 * 本文件因此只钉前端自己的三件事：**落哪种形态**、**能不能原样拆回来**、**旧条件零回归**。
 */
import { describe, expect, it } from 'vitest';
import type { ConditionGroup } from '@kimposoft/expression-editor';
import { compileMindmapToBundle, openBundleToTree, guardSpecToConditionGroup, serializeGuardSpec } from '../compile';
import { createActionNode, createConditionNode, createTriggerRoot, invertGuardSpec } from '../model';
import type { ConditionNodeGuard, MindNode, SimpleCondition } from '../model';

/** 一条最小结构化条件：<field> = <value>。 */
function group(fieldId: string, value: string | number): ConditionGroup {
  return {
    logic: 'and',
    items: [{ predicate: { left: { kind: 'form_field', field_id: fieldId }, op: 'eq', right: { kind: 'const', value } } }]
  };
}

/** 一条 guard 文法根本写不出来的结构化条件：形如 + 属于 + 取反 + 嵌套。 */
function richGroup(): ConditionGroup {
  return {
    logic: 'and',
    negate: true,
    items: [
      { predicate: { left: { kind: 'form_field', field_id: 'name' }, op: 'like', right: { kind: 'const', value: 'ali%' } } },
      {
        group: {
          logic: 'or',
          items: [
            // 「属于」的右值这里写单值：前端 ValueRef.value 目前只声明了标量（string|number|boolean|null），
            // 表达不了多值列表——这是 @kimposoft/expression-editor 共享包的既有类型缺口。宿主后端已
            // 支持数组常量（按数组/标量两形拆），等前端类型放开即可用。
            { predicate: { left: { kind: 'form_field', field_id: 'status' }, op: 'in', right: { kind: 'const', value: 'open' } } },
            { predicate: { left: { kind: 'form_field', field_id: 'closed_at' }, op: 'is_null', right: { kind: 'const' } } }
          ]
        }
      }
    ]
  };
}

const structuredGuard = (g: ConditionGroup): ConditionNodeGuard => ({ mode: 'guided', group: g });
const act = (id: string) => createActionNode({ id, actionName: 'form-control' });

function rootWith(node: MindNode) {
  return createTriggerRoot({ eventKey: 'before-save', scope: 'form', children: [node] });
}

describe('结构化 guard 编译', () => {
  it('结构化条件落 condition_group，不落 KimpoSQL 串', () => {
    const g = richGroup();
    const bundle = compileMindmapToBundle(
      rootWith(createConditionNode({ guardSpec: structuredGuard(g), thenChildren: [act('n_then')], elseChildren: [] }))
    );

    const guards = bundle.guards.filter(x => x.guard_id);
    expect(guards.length).toBeGreaterThan(0);
    for (const guard of guards) {
      expect(guard.condition_group).toBeTruthy();
      // 串必须留空：后端按 condition_group 存在与否独占选路，留个半吊子串只会让人误以为它还生效。
      expect(guard.condition).toBe('');
    }
    expect(guards[0].condition_group).toEqual(g);
  });

  it('round-trip：编译 → 打开，条件节点的结构化条件精确还原，分支结构不变', () => {
    const g = richGroup();
    const bundle = compileMindmapToBundle(
      rootWith(
        createConditionNode({
          guardSpec: structuredGuard(g),
          thenChildren: [act('n_then')],
          elseChildren: [act('n_else')]
        })
      )
    );
    const reopened = openBundleToTree(bundle);

    const cond = reopened.children?.find(n => n.kind === 'condition');
    expect(cond).toBeTruthy();
    expect(cond!.guardSpec?.group).toEqual(g);
    expect(cond!.thenChildren?.map(n => n.id)).toEqual(['n_then']);
    expect(cond!.elseChildren?.map(n => n.id)).toEqual(['n_else']);
  });

  it('历史限制解除：结构化条件的「不成立」分支可用（取反=翻转 negate，不再要求空 else）', () => {
    const g = group('status', 'open');
    // 旧的 expression 串形态：非空 else 会被编译期拒绝（KimpoSQL 文法无 NOT）。
    expect(() =>
      compileMindmapToBundle(
        rootWith(
          createConditionNode({
            guardSpec: { mode: 'expression', expression: '{{field:status}} = 1' },
            thenChildren: [act('a')],
            elseChildren: [act('b')]
          })
        )
      )
    ).toThrow();

    // 结构化形态：同样的 then/else 结构编译通过，且 else 段是取反后的条件。
    const bundle = compileMindmapToBundle(
      rootWith(createConditionNode({ guardSpec: structuredGuard(g), thenChildren: [act('a')], elseChildren: [act('b')] }))
    );
    const conditions = bundle.guards.map(x => x.condition_group);
    expect(conditions).toHaveLength(2);
    expect(conditions[0]).toEqual({ ...g, negate: undefined as never }); // then 段：原条件（negate 未设）
    expect(conditions[1]?.negate).toBe(true); // else 段：取反
    // 反向：打开后 else 分支被还原出来（不是被静默丢掉）。
    const cond = openBundleToTree(bundle).children?.find(n => n.kind === 'condition');
    expect(cond?.elseChildren?.map(n => n.id)).toEqual(['b']);
  });

  it('嵌套条件：多层路径按层拆回，不把同层的多个谓词误拆成多层', () => {
    const outer = group('a', 1);
    const inner = group('b', 2);
    const bundle = compileMindmapToBundle(
      rootWith(
        createConditionNode({
          guardSpec: structuredGuard(outer),
          thenChildren: [createConditionNode({ guardSpec: structuredGuard(inner), thenChildren: [act('deep')], elseChildren: [] })],
          elseChildren: []
        })
      )
    );
    const reopened = openBundleToTree(bundle);
    const outerNode = reopened.children?.find(n => n.kind === 'condition');
    expect(outerNode?.guardSpec?.group).toEqual(outer);
    const innerNode = outerNode?.thenChildren?.find(n => n.kind === 'condition');
    expect(innerNode?.guardSpec?.group).toEqual(inner);
    expect(innerNode?.thenChildren?.map(n => n.id)).toEqual(['deep']);
  });

  it('陷阱回归：单层里的 and 组（多个谓词）不能被当成「多层路径外壳」拆开', () => {
    // 这棵树 logic='and' 且有两项——与「两层路径的 AND 外壳」形状极像，区别只在项是谓词而不是子组。
    // 只看 logic 就拆，会把一个条件节点的两个谓词错拆成两层条件，分支结构在打开时直接散架。
    const multiPredicate: ConditionGroup = {
      logic: 'and',
      items: [
        { predicate: { left: { kind: 'form_field', field_id: 'a' }, op: 'gt', right: { kind: 'const', value: 0 } } },
        { predicate: { left: { kind: 'form_field', field_id: 'b' }, op: 'eq', right: { kind: 'const', value: 1 } } }
      ]
    };
    const bundle = compileMindmapToBundle(
      rootWith(createConditionNode({ guardSpec: structuredGuard(multiPredicate), thenChildren: [act('x')], elseChildren: [] }))
    );
    const reopened = openBundleToTree(bundle);

    const conditions = (reopened.children ?? []).filter(n => n.kind === 'condition');
    expect(conditions).toHaveLength(1); // 恰好一层，不是两层
    expect(conditions[0].guardSpec?.group).toEqual(multiPredicate);
    expect(conditions[0].thenChildren?.map(n => n.id)).toEqual(['x']);
  });

  it('混合路径：旧 guided 层与新结构化层同在一条路径上时，整条统一成结构化（旧层被无损升级）', () => {
    const legacy: SimpleCondition = { fieldId: 'amount', op: '>', value: 100 };
    const bundle = compileMindmapToBundle(
      rootWith(
        createConditionNode({
          guardSpec: { mode: 'guided', guided: { logic: 'and', items: [legacy] } },
          thenChildren: [createConditionNode({ guardSpec: structuredGuard(group('status', 'open')), thenChildren: [act('deep')], elseChildren: [] })],
          elseChildren: []
        })
      )
    );

    // 深层组的 guard 路径含两层（旧 + 新）：必须整条落结构化，不能只落一半。
    const deepGuard = bundle.guards.find(g => (g.condition_group?.items?.length ?? 0) === 2);
    expect(deepGuard, '两层路径应产出一个 AND 外壳的结构化 guard').toBeTruthy();
    expect(deepGuard!.condition).toBe('');
    // 旧 guided 层被机械升级：字段引用 → form_field，比较符 > → gt，右值 → const。
    const upgraded = deepGuard!.condition_group!.items[0].group!;
    expect(upgraded.items[0].predicate).toEqual({
      left: { kind: 'form_field', field_id: 'amount' },
      op: 'gt',
      right: { kind: 'const', value: 100 }
    });
  });

  it('零回归：纯旧 guided 路径仍落 KimpoSQL 串，不被顺手升级', () => {
    const bundle = compileMindmapToBundle(
      rootWith(
        createConditionNode({
          guardSpec: { mode: 'guided', guided: { logic: 'and', items: [{ fieldId: 'amount', op: '>', value: 100 }] } },
          thenChildren: [act('a')],
          elseChildren: [act('b')]
        })
      )
    );
    expect(bundle.guards.map(g => g.condition)).toEqual(['{{field:amount}} > 100', '{{field:amount}} <= 100']);
    for (const guard of bundle.guards) {
      expect(guard.condition_group).toBeUndefined();
    }
  });
});

describe('结构化 guard 的取反与规范串', () => {
  it('invertGuardSpec 翻转组级 negate，两次取反回到原样', () => {
    const spec = structuredGuard(group('a', 1));
    const inverted = invertGuardSpec(spec);
    expect(inverted.group?.negate).toBe(true);
    expect(invertGuardSpec(inverted).group?.negate).toBe(false);
  });

  it('serializeGuardSpec 对结构化条件产出稳定规范串——键序不同的同一棵树必须得到同一个串', () => {
    // then/else 配对是逐字节比串。同一条件经不同路径构造（新配 / 反解回来 / 取反重建）键的插入
    // 顺序可能不同，键序一漂，同一条件的两段会被判成两个不同条件，分支结构在 round-trip 中散架。
    const a: ConditionGroup = { logic: 'and', items: [{ predicate: { left: { kind: 'form_field', field_id: 'f' }, op: 'eq', right: { kind: 'const', value: 1 } } }] };
    const b: ConditionGroup = { items: [{ predicate: { right: { value: 1, kind: 'const' }, op: 'eq', left: { field_id: 'f', kind: 'form_field' } } }], logic: 'and' } as ConditionGroup;
    expect(serializeGuardSpec(structuredGuard(a))).toBe(serializeGuardSpec(structuredGuard(b)));
    // 反向判据：内容真不同的两棵树必须得到不同的串（否则上面的相等是"什么都相等"的空转）。
    expect(serializeGuardSpec(structuredGuard(a))).not.toBe(serializeGuardSpec(structuredGuard(group('other', 9))));
  });

  it('guardSpecToConditionGroup：结构化原样返回、guided 无损升级、旧 expression 串明确表达不了', () => {
    const g = group('a', 1);
    expect(guardSpecToConditionGroup(structuredGuard(g))).toBe(g);
    expect(guardSpecToConditionGroup({ mode: 'guided', guided: { logic: 'or', items: [{ fieldId: 'x', op: '<=', value: 3 }] } })).toEqual({
      logic: 'or',
      items: [{ predicate: { left: { kind: 'form_field', field_id: 'x' }, op: 'lte', right: { kind: 'const', value: 3 } } }]
    });
    expect(guardSpecToConditionGroup({ mode: 'expression', expression: '{{field:a}} > 1' })).toBeNull();
    expect(guardSpecToConditionGroup(undefined)).toBeNull();
  });
});

// ─────────────────── V4 判断表达式与结构化条件互不串台 ───────────────────
// 两条通道的落库位置不同（condition_group vs conditions 池 + path），后端也按不同分支求值。
// 这里只钉「不会误落到对方通道」，V4 自身的形态断言在 conditionV4Compile.spec.ts。
describe('V4 判断表达式不落结构化通道', () => {
  it('guardSpecToConditionGroup 对 V4 规格返回 null', () => {
    const spec: ConditionNodeGuard = {
      mode: 'expression',
      v4: {
        conditionId: 'cond_12345678',
        expression: { expression_id: 'cond_12345678', purpose: 'condition', source_text: '#{r1} > 0', refs: [] }
      }
    };
    expect(guardSpecToConditionGroup(spec)).toBeNull();
  });

  it('V4 条件节点编译后 guard 只有 path，不产 condition_group', () => {
    const spec: ConditionNodeGuard = {
      mode: 'expression',
      v4: {
        conditionId: 'cond_12345678',
        expression: { expression_id: 'cond_12345678', purpose: 'condition', source_text: '#{r1} > 0', refs: [] }
      }
    };
    const bundle = compileMindmapToBundle(rootWith(createConditionNode({ guardSpec: spec, thenChildren: [act('n_then')], elseChildren: [] })));
    expect(bundle.guards.every(guard => guard.condition_group === undefined)).toBe(true);
    expect(bundle.guards.every(guard => (guard.path?.length ?? 0) > 0)).toBe(true);
  });
});
