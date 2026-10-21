/**
 * 条件分支 V4 判断表达式（宿主查询服务求值）——前端编译/反编译面（条件节点 V4 形态）。
 *
 * 这条链路的分工：V4 表达式文档由「条件编辑器」（与取数②筛选条件同一个壳）产出，前端只负责
 * ①把整份文档落进动作文档的**文档级 conditions 池**、②让 guard 以 `path[]{condition_id,negate}`
 * 引用池内条件、③打开文档时按 path 逐步取回。求值（同一条件一次派发只算一次、逐行/标量形状、
 * 补集收窄）全在后端。
 *
 * 本文件因此只钉前端自己的四件事：**落哪种形态**、**池去重与身份透传**、**能不能原样拆回来**、
 * **新旧形态混用要报错不能静默丢门控**。
 */
import { describe, expect, it } from 'vitest';
import type { V4ExpressionDocument } from '@kimposoft/expression-editor';
import { compileEventsToBundle, compileMindmapToBundle, openBundleToTree, serializeGuardSpec } from '../compile';
import type { ActionBehaviorDocument } from '../bundle';
import { createActionNode, createConditionNode, createTriggerRoot, invertGuardSpec, newConditionId } from '../model';
import type { ConditionNodeGuard, ConditionV4Spec, MindNode } from '../model';

/** 一份最小 V4 表达式文档（token 化源码 + 空 refs——纯常量谓词也合法）。 */
function v4Doc(conditionId: string, sourceText: string): V4ExpressionDocument {
  return { expression_id: conditionId, purpose: 'condition', source_text: sourceText, refs: [] };
}

/** 一条 V4 形态的条件节点 guard（mode 恒 'expression'，v4 才是权威，见 model.ts）。 */
function v4Guard(conditionId: string, sourceText: string, extra: Partial<ConditionV4Spec> = {}): ConditionNodeGuard {
  return { mode: 'expression', v4: { conditionId, expression: v4Doc(conditionId, sourceText), ...extra } };
}

/** 一条旧形态（引导式单条）条件节点 guard，用于混用报错用例。 */
const legacyGuard: ConditionNodeGuard = { mode: 'guided', guided: { logic: 'and', items: [{ fieldId: 'fld_qty', op: '>', value: 0 }] } };

const act = (id: string) => createActionNode({ id, actionName: 'form-control' });

// 用新键 'create-before-save'（老 'before-save' 经 openBundleToTree 回读会被迁移为
// 新建/编辑两档，下方「round-trip：compile → open → compile 逐字节相等」用例逐字节比对 JSON，
// 迁移会改变 trigger_event_key/trigger_event_keys/binding_id，与 V4 条件池编译无关的
// 逻辑纠缠在一起）。
function rootWith(node: MindNode): MindNode {
  return createTriggerRoot({ eventKey: 'create-before-save', scope: 'form', bindingId: 'tb_fixed', children: [node] });
}

describe('V4 判断表达式编译', () => {
  it('单层 then/else：条件池 1 条 + 两条 path guard，negate 只出现在不成立侧', () => {
    const bundle = compileMindmapToBundle(
      rootWith(createConditionNode({ guardSpec: v4Guard('cond_11112222', '#{r1} > 0'), thenChildren: [act('n_then')], elseChildren: [act('n_else')] }))
    );

    // 池：一个条件节点只登记一条，document 三件套按后端 pipeline.BehaviorCondition 同形。
    expect(bundle.conditions).toEqual([
      {
        condition_id: 'cond_11112222',
        document: {
          schema_version: 'kimpo.report-expression/v4',
          mode: 'condition',
          expression: { expression_id: 'cond_11112222', purpose: 'condition', source_text: '#{r1} > 0', refs: [] }
        }
      }
    ]);

    // guard：两条（then/else 各一），三形态里只出 path；condition 串为空、无 condition_group。
    expect(bundle.guards).toHaveLength(2);
    expect(bundle.guards[0]).toEqual({ guard_id: 'tb_fixed_gd1', condition: '', path: [{ condition_id: 'cond_11112222' }] });
    expect(bundle.guards[1]).toEqual({ guard_id: 'tb_fixed_gd2', condition: '', path: [{ condition_id: 'cond_11112222', negate: true }] });
    // 成立侧**不写** negate 键（后端 omitempty 口径；多写零值会改变规范化字节）。
    expect('negate' in bundle.guards[0].path![0]).toBe(false);
    expect(bundle.guards.every(guard => guard.condition_group === undefined)).toBe(true);
  });

  it('嵌套两层：内层 band 的 guard path 有两步，按深度顺序', () => {
    const inner = createConditionNode({ guardSpec: v4Guard('cond_bbbbbbbb', '#{r2} = 1'), thenChildren: [act('n_inner_then')], elseChildren: [] });
    const outer = createConditionNode({ guardSpec: v4Guard('cond_aaaaaaaa', '#{r1} > 0'), thenChildren: [inner], elseChildren: [act('n_outer_else')] });
    const bundle = compileMindmapToBundle(rootWith(outer));

    const innerThenGuard = bundle.guards.find(guard => (guard.path?.length ?? 0) === 2 && !guard.path![1].negate);
    expect(innerThenGuard?.path).toEqual([{ condition_id: 'cond_aaaaaaaa' }, { condition_id: 'cond_bbbbbbbb' }]);
    // 池按 conditionId 去重：两个条件节点各一条，且顺序与首次登记顺序一致。
    expect(bundle.conditions?.map(entry => entry.condition_id)).toEqual(['cond_aaaaaaaa', 'cond_bbbbbbbb']);
  });

  it('同一条件被多条 guard 引用时池内仍只有一条', () => {
    const inner = createConditionNode({ guardSpec: v4Guard('cond_bbbbbbbb', '#{r2} = 1'), thenChildren: [act('n1')], elseChildren: [act('n2')] });
    const outer = createConditionNode({ guardSpec: v4Guard('cond_aaaaaaaa', '#{r1} > 0'), thenChildren: [inner], elseChildren: [act('n3')] });
    const bundle = compileMindmapToBundle(rootWith(outer));

    // 外层条件出现在 4 条 guard 的路径里（内层 then/else + 内层所在带 + 外层 else），池仍是 1 条。
    const outerRefCount = bundle.guards.filter(guard => guard.path?.some(step => step.condition_id === 'cond_aaaaaaaa')).length;
    expect(outerRefCount).toBeGreaterThan(1);
    expect(bundle.conditions?.filter(entry => entry.condition_id === 'cond_aaaaaaaa')).toHaveLength(1);
  });

  it('无条件节点时整键省略 conditions（不写空数组）', () => {
    const bundle = compileMindmapToBundle(rootWith(act('n_only')));
    expect('conditions' in bundle).toBe(false);
  });

  it('后端钉入的 plan 原样透传，不被前端改写', () => {
    const plan = { publication_id: 'pub_x1', definition_id: 'def_y1' };
    const bundle = compileMindmapToBundle(
      rootWith(createConditionNode({ guardSpec: v4Guard('cond_cccccccc', '#{r1} > 0', { plan }), thenChildren: [act('n_then')], elseChildren: [] }))
    );
    expect(bundle.conditions?.[0].plan).toEqual(plan);

    // 反编译带回 → 再编译原样写出（发布物身份不因一次「打开又保存」而丢失）。
    const reopened = openBundleToTree(bundle);
    const recompiled = compileMindmapToBundle(reopened);
    expect(recompiled.conditions?.[0].plan).toEqual(plan);
  });

  it('强制身份字段：expression_id 归一为 conditionId、purpose 归一为 condition', () => {
    const spec = v4Guard('cond_dddddddd', '#{r1} > 0');
    // 模拟编辑器产出的文档带着别的 expression_id / purpose（取数面复用同一个壳，容易漂）。
    spec.v4!.expression = { ...spec.v4!.expression, expression_id: 'expr_from_editor', purpose: 'filter' };
    const bundle = compileMindmapToBundle(rootWith(createConditionNode({ guardSpec: spec, thenChildren: [act('n')], elseChildren: [] })));
    expect(bundle.conditions?.[0].document.expression.expression_id).toBe('cond_dddddddd');
    expect(bundle.conditions?.[0].document.expression.purpose).toBe('condition');
  });

  it('round-trip：compile → open → compile 逐字节相等（含嵌套与 else 分支）', () => {
    const inner = createConditionNode({ guardSpec: v4Guard('cond_bbbbbbbb', '#{r2} = 1'), thenChildren: [act('n_inner_then')], elseChildren: [act('n_inner_else')] });
    const outer = createConditionNode({
      guardSpec: v4Guard('cond_aaaaaaaa', '#{r1} > 0'),
      thenChildren: [act('n_pre'), inner],
      elseChildren: [act('n_outer_else')]
    });
    const first = compileMindmapToBundle(rootWith(outer));
    const second = compileMindmapToBundle(openBundleToTree(first));
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it('反编译：guard.path 逐步还原成 V4 条件节点，negate 落到不成立侧', () => {
    const bundle = compileMindmapToBundle(
      rootWith(createConditionNode({ guardSpec: v4Guard('cond_eeeeeeee', '#{r1} > 0'), thenChildren: [act('n_then')], elseChildren: [act('n_else')] }))
    );
    const root = openBundleToTree(bundle);
    const cond = root.children![0];
    expect(cond.kind).toBe('condition');
    expect(cond.guardSpec?.v4?.conditionId).toBe('cond_eeeeeeee');
    // 条件节点本身持有的是「成立侧」规格：不带 negate。
    expect(cond.guardSpec?.v4?.negate).toBeUndefined();
    expect(cond.guardSpec?.v4?.expression.source_text).toBe('#{r1} > 0');
    expect(cond.thenChildren?.map(n => n.id)).toEqual(['n_then']);
    expect(cond.elseChildren?.map(n => n.id)).toEqual(['n_else']);
  });

  it('路径上新旧形态混用 → 具名报错（绝不挑一种落，那是静默放宽门控）', () => {
    const inner = createConditionNode({ guardSpec: legacyGuard, thenChildren: [act('n_inner')], elseChildren: [] });
    const outer = createConditionNode({ guardSpec: v4Guard('cond_ffffffff', '#{r1} > 0'), thenChildren: [inner], elseChildren: [] });
    expect(() => compileMindmapToBundle(rootWith(outer))).toThrow('actionDesigner.compile.conditionLegacyMixed');
  });

  it('反编译：guard.path 引用的条件不在池内 → 抛错，不静默丢步', () => {
    const orphan: ActionBehaviorDocument = {
      trigger_bindings: [
        { binding_id: 'tb_x', trigger_event_key: 'before-save', trigger_event_keys: ['before-save'], scopes: ['form'], ordered_group_ids: ['tb_x_g1'], seq: 1 }
      ],
      action_groups: [{ group_id: 'tb_x_g1', group_guard_id: 'tb_x_gd1', ordered_node_ids: [] }],
      action_nodes: [],
      guards: [{ guard_id: 'tb_x_gd1', condition: '', path: [{ condition_id: 'cond_missing1' }] }]
      // conditions 池整键缺失（存量文档 / 半截保存），逐步取回时必须炸而不是少一层条件。
    };
    expect(() => openBundleToTree(orphan)).toThrow('actionDesigner.compile.conditionNotInPool');
  });

  it('多事件根：条件池是文档级的（跨事件全局去重），guard id 仍按事件命名空间', () => {
    const shared = () => createConditionNode({ guardSpec: v4Guard('cond_99998888', '#{r1} > 0'), thenChildren: [act('n_a')], elseChildren: [] });
    const rootA = createTriggerRoot({ eventKey: 'before-save', scope: 'form', bindingId: 'tb_a', children: [shared()] });
    const rootB = createTriggerRoot({
      eventKey: 'after-save',
      scope: 'form',
      bindingId: 'tb_b',
      children: [createConditionNode({ guardSpec: v4Guard('cond_99998888', '#{r1} > 0'), thenChildren: [act('n_b')], elseChildren: [] })]
    });
    const bundle = compileEventsToBundle([rootA, rootB]);
    expect(bundle.conditions).toHaveLength(1);
    // 每个事件各产两条 guard（then + 固化的空 else，V4 恒可取反故空 else 照样固化以保结构可逆），
    // guard id 仍按各自 bindingId 命名空间从 1 计数。
    expect(bundle.guards.map(guard => guard.guard_id)).toEqual(['tb_a_gd1', 'tb_a_gd2', 'tb_b_gd1', 'tb_b_gd2']);
  });
});

describe('V4 判断表达式的规格运算', () => {
  it('serializeGuardSpec：`#v<conditionId>`，不成立侧加 `!` 后缀', () => {
    const spec = v4Guard('cond_12345678', '#{r1} > 0');
    expect(serializeGuardSpec(spec)).toBe('#vcond_12345678');
    expect(serializeGuardSpec(invertGuardSpec(spec))).toBe('#vcond_12345678!');
  });

  it('serializeGuardSpec：表达式文本变化不影响配对串（靠 conditionId 配对）', () => {
    expect(serializeGuardSpec(v4Guard('cond_12345678', '#{r1} > 0'))).toBe(serializeGuardSpec(v4Guard('cond_12345678', '#{r1} >= 99')));
  });

  it('invertGuardSpec：只翻 negate，表达式文档逐字不动；两次取反回到原形', () => {
    const spec = v4Guard('cond_12345678', '#{r1} > 0');
    const inverted = invertGuardSpec(spec);
    expect(inverted.v4?.negate).toBe(true);
    expect(inverted.v4?.expression).toBe(spec.v4!.expression);
    expect(invertGuardSpec(inverted).v4?.negate).toBe(false);
  });

  it('invertGuardSpec：v4 优先于 group/guided 分支', () => {
    const mixed: ConditionNodeGuard = { ...v4Guard('cond_12345678', '#{r1} > 0'), guided: legacyGuard.guided };
    const inverted = invertGuardSpec(mixed);
    expect(inverted.v4?.negate).toBe(true);
    // 旧字段原样带着（读兼容），没有被德摩根翻转。
    expect(inverted.guided).toEqual(legacyGuard.guided);
  });

  it('newConditionId：cond_ + 8 位十六进制，且不重复', () => {
    const ids = new Set(Array.from({ length: 200 }, () => newConditionId()));
    expect([...ids].every(id => /^cond_[0-9a-f]{8}$/.test(id))).toBe(true);
    expect(ids.size).toBeGreaterThan(190);
  });

  it('createConditionNode：v4 缺 conditionId 时补发，已给定时原样沿用（不断 guard.path 引用）', () => {
    const auto = createConditionNode({ guardSpec: { mode: 'expression', v4: { conditionId: '', expression: v4Doc('', '#{r1} > 0') } } });
    expect(auto.guardSpec?.v4?.conditionId).toMatch(/^cond_[0-9a-f]{8}$/);
    const fixed = createConditionNode({ guardSpec: v4Guard('cond_87654321', '#{r1} > 0') });
    expect(fixed.guardSpec?.v4?.conditionId).toBe('cond_87654321');
  });
});
