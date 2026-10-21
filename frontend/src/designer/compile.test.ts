import { describe, expect, it } from 'vitest';

import type { ActionBehaviorDocument } from './bundle';
import {
  compileEventsToBundle,
  compileMindmapToBundle,
  openBundleToTree,
  openBundleToTrees,
  parseCondition,
  parseGuardPath,
  serializeCondition,
  serializeGuardPath,
  serializeGuardSpec,
  tryConvertExpressionToGuidedGroup
} from './compile';
import { createActionNode, createConditionNode, createTriggerRoot, invertCondition, invertGuardSpec } from './model';
import type { ConditionNodeGuard, MindNode, SimpleCondition } from './model';

// 结构归一化：丢弃 root/condition 的合成 id（反向打开会重新生成），保留 action id（= node_id 可逆）。
function shape(node: MindNode): unknown {
  if (node.kind === 'trigger-root') {
    // blockable 是 before-save 的设计期 uiHint，不进 bundle（bundle schema 无该字段），故不参与编译可逆比对。
    return {
      kind: node.kind,
      eventKey: node.eventKey,
      scope: node.scope,
      children: (node.children ?? []).map(shape)
    };
  }
  if (node.kind === 'condition') {
    return {
      kind: node.kind,
      condition: node.condition,
      // guardSpec 参与可逆比对（guided 单条/多条/expression 均需精确往返）。
      guardSpec: node.guardSpec,
      thenChildren: (node.thenChildren ?? []).map(shape),
      elseChildren: (node.elseChildren ?? []).map(shape)
    };
  }
  return {
    kind: node.kind,
    id: node.id,
    actionName: node.actionName,
    source: node.source,
    async: node.async ?? false,
    params: node.params,
    nodeGuard: node.nodeGuard,
    // 子流程（向右挂载的嵌套子节点）也参与可逆比对。
    children: (node.children ?? []).map(shape),
    // 出口分支：逐 outcome 递归归一化，参与可逆比对。
    outcomeChildren: node.outcomeChildren
      ? Object.fromEntries(Object.entries(node.outcomeChildren).map(([outcome, band]) => [outcome, band.map(shape)]))
      : undefined
  };
}

function assertRoundTrip(root: MindNode) {
  const bundle = compileMindmapToBundle(root);
  const reopened = openBundleToTree(bundle);
  expect(shape(reopened)).toEqual(shape(root));
  // 产物绝不含坐标。
  const serialized = JSON.stringify(bundle);
  expect(serialized).not.toMatch(/"x"|"y"|"zoom"|"viewport"|"collapsed"/);
  return bundle;
}

describe('serialize / parse condition', () => {
  it('round-trips number / string / boolean literals', () => {
    const cases: SimpleCondition[] = [
      { fieldId: 'fld_qty', op: '>', value: 0 },
      { fieldId: 'fld_name', op: '=', value: "o'brien" },
      { fieldId: 'fld_flag', op: '!=', value: true }
    ];
    for (const c of cases) {
      expect(parseCondition(serializeCondition(c))).toEqual(c);
    }
  });

  it('serializes an AND-chain guard path (pre-serialized segments) and parses it back as guided segments', () => {
    // serializeGuardPath/parseGuardPath 的 path 元素是「已括号安全的 guard 片段串」
    // （而非裸 SimpleCondition），配合 guardSpec 的引导式多条/表达式模式。这里验证最简单的旧场景——
    // 两条单条件逐条序列化后 AND 拼接，往返得到两段 guided 单条 ConditionNodeGuard。
    const c1: SimpleCondition = { fieldId: 'fld_x', op: '=', value: 1 };
    const c2: SimpleCondition = { fieldId: 'fld_y', op: '>', value: 5 };
    const segments = [serializeCondition(c1), serializeCondition(c2)];
    const text = serializeGuardPath(segments);
    expect(text).toBe('{{field:fld_x}} = 1 AND {{field:fld_y}} > 5');
    expect(parseGuardPath(text)).toEqual([
      { mode: 'guided', guided: { logic: 'and', items: [c1] } },
      { mode: 'guided', guided: { logic: 'and', items: [c2] } }
    ]);
  });
});

describe('compileMindmapToBundle round-trips', () => {
  it('single action under a field-scoped trigger', () => {
    const root = createTriggerRoot({
      eventKey: 'value-change',
      scope: 'field:fld_matCode',
      // value-change 的编译权威来源是 eventFieldIds（scope 仅展示兼容，需与之一致才能通过
      // 下方基于 shape() 的往返比对——shape() 仍读 root.scope，而 scope 现由 compile 派生回填）。
      eventFieldIds: { 'value-change': ['fld_matCode'] },
      children: [createActionNode({ id: 'n_get', actionName: 'get-value', source: 'builtin', params: { data_table_id: 'tbl_mat' } })]
    });
    const bundle = assertRoundTrip(root);
    expect(bundle.action_groups).toHaveLength(1);
    expect(bundle.action_groups[0].group_guard_id).toBeUndefined();
    expect(bundle.action_nodes[0].node_id).toBe('n_get');
  });

  it('condition then/else with empty else (before-save block)', () => {
    // 用新键 'create-before-save'（老 'before-save' 经 assertRoundTrip 的
    // openBundleToTree 会触发迁移，eventKey 变成迁移后的两档之一，污染这里纯粹测「条件分支结构
    // 可逆」的断言；新键不受迁移影响，语义仍是"保存前可阻断"）。
    const cond: SimpleCondition = { fieldId: 'fld_amount', op: '>', value: 5000 };
    const root = createTriggerRoot({
      eventKey: 'create-before-save',
      scope: 'form',
      blockable: true,
      children: [
        createConditionNode({
          condition: cond,
          thenChildren: [createActionNode({ id: 'n_block', actionName: 'form-control', source: 'builtin', params: { op: 'block-save' } })],
          elseChildren: []
        })
      ]
    });
    const bundle = assertRoundTrip(root);
    // then 先 else 后；else guard = 取反操作符。
    expect(bundle.action_groups).toHaveLength(2);
    const guardOf = (gid?: string) => bundle.guards.find(g => g.guard_id === gid)?.condition;
    expect(guardOf(bundle.action_groups[0].group_guard_id)).toBe('{{field:fld_amount}} > 5000');
    expect(guardOf(bundle.action_groups[1].group_guard_id)).toBe('{{field:fld_amount}} <= 5000');
    expect(bundle.action_groups[1].ordered_node_ids).toHaveLength(0);
  });

  it('leading action then condition with two non-empty branches', () => {
    // 同上，用新键避免 assertRoundTrip 的回读迁移干扰纯结构断言。
    const root = createTriggerRoot({
      eventKey: 'create-before-save',
      scope: 'form',
      children: [
        createActionNode({ id: 'n_dup', actionName: 'get-value', source: 'builtin' }),
        createConditionNode({
          condition: { fieldId: 'fld_dup', op: '>', value: 0 },
          thenChildren: [createActionNode({ id: 'n_block', actionName: 'form-control' })],
          elseChildren: [
            createActionNode({ id: 'n_ledger', actionName: 'create-record', source: 'builtin' }),
            createActionNode({ id: 'n_pass', actionName: 'form-control' })
          ]
        })
      ]
    });
    const bundle = assertRoundTrip(root);
    expect(bundle.action_groups.map(g => g.ordered_node_ids)).toEqual([['n_dup'], ['n_block'], ['n_ledger', 'n_pass']]);
  });

  it('nested condition (three-way branch) preserves structure and AND-chain guards', () => {
    const c1: SimpleCondition = { fieldId: 'fld_hit', op: '=', value: 1 };
    const c2: SimpleCondition = { fieldId: 'fld_hit', op: '>', value: 1 };
    const root = createTriggerRoot({
      eventKey: 'manual',
      scope: 'form',
      children: [
        createActionNode({ id: 'n_rel', actionName: 'related-form', source: 'builtin' }),
        createConditionNode({
          condition: c1,
          thenChildren: [createActionNode({ id: 'n_getCust', actionName: 'get-value' }), createActionNode({ id: 'n_open', actionName: 'navigate-page' })],
          elseChildren: [
            createConditionNode({
              condition: c2,
              thenChildren: [createActionNode({ id: 'n_nav', actionName: 'navigate-page' })],
              elseChildren: [createActionNode({ id: 'n_info', actionName: 'form-control' })]
            })
          ]
        })
      ]
    });
    const bundle = assertRoundTrip(root);
    const guardOf = (gid?: string) => bundle.guards.find(g => g.guard_id === gid)?.condition;
    const guards = bundle.action_groups.map(g => guardOf(g.group_guard_id));
    expect(guards).toEqual([
      undefined,
      '{{field:fld_hit}} = 1',
      '{{field:fld_hit}} != 1 AND {{field:fld_hit}} > 1',
      '{{field:fld_hit}} != 1 AND {{field:fld_hit}} <= 1'
    ]);
  });

  it('条件之后挂动作（汇合后续）：band 顺序 [前, 条件, 后] 可逆，后置组同 path 无分支 guard', () => {
    const root = createTriggerRoot({
      eventKey: 'manual',
      scope: 'form',
      children: [
        createActionNode({ id: 'n_pre', actionName: 'get-value', source: 'builtin' }),
        createConditionNode({
          condition: { fieldId: 'fld_q', op: '>', value: 0 },
          thenChildren: [createActionNode({ id: 'n_then', actionName: 'form-control' })],
          elseChildren: [createActionNode({ id: 'n_else', actionName: 'form-control' })]
        }),
        createActionNode({ id: 'n_post', actionName: 'navigate-page', source: 'builtin' })
      ]
    });
    const bundle = assertRoundTrip(root);
    // 组顺序：前置(无 guard) → then → else → 后置(无 guard，入序于两分支之后)。
    expect(bundle.action_groups.map(g => g.ordered_node_ids)).toEqual([['n_pre'], ['n_then'], ['n_else'], ['n_post']]);
    const guardOf = (gid?: string) => bundle.guards.find(g => g.guard_id === gid)?.condition;
    const postGroup = bundle.action_groups.find(g => g.ordered_node_ids.includes('n_post'));
    expect(guardOf(postGroup?.group_guard_id)).toBeUndefined(); // 后置组无分支 guard → 汇合后恒执行
  });

  it('仅条件 + 条件之后动作（无前置）可逆：band = [条件, 后]', () => {
    const root = createTriggerRoot({
      eventKey: 'manual',
      scope: 'form',
      children: [
        createConditionNode({
          condition: { fieldId: 'fld_q', op: '=', value: 1 },
          thenChildren: [createActionNode({ id: 'n_t', actionName: 'a' })],
          elseChildren: []
        }),
        createActionNode({ id: 'n_after', actionName: 'b' })
      ]
    });
    assertRoundTrip(root);
  });

  it('同 band 多个顺序条件可逆：[条件A, 条件B]（条件紧邻，无中间动作）', () => {
    const root = createTriggerRoot({
      eventKey: 'manual',
      scope: 'form',
      children: [
        createConditionNode({
          condition: { fieldId: 'fld_a', op: '>', value: 0 },
          thenChildren: [createActionNode({ id: 'n_a_then', actionName: 'form-control' })],
          elseChildren: [createActionNode({ id: 'n_a_else', actionName: 'form-control' })]
        }),
        createConditionNode({
          condition: { fieldId: 'fld_b', op: '=', value: 1 },
          thenChildren: [createActionNode({ id: 'n_b_then', actionName: 'navigate-page' })],
          elseChildren: []
        })
      ]
    });
    const bundle = assertRoundTrip(root);
    const guardOf = (gid?: string) => bundle.guards.find(g => g.guard_id === gid)?.condition;
    // 两个条件各自分叉（A 的 then/else 在前，B 的 then/else 在后），互不串扰。
    expect(bundle.action_groups.map(g => guardOf(g.group_guard_id))).toEqual([
      '{{field:fld_a}} > 0',
      '{{field:fld_a}} <= 0',
      '{{field:fld_b}} = 1',
      '{{field:fld_b}} != 1'
    ]);
  });

  it('同 band 动作与多条件任意交错可逆：[动作, 条件A, 动作, 条件B, 动作]', () => {
    const root = createTriggerRoot({
      eventKey: 'manual',
      scope: 'form',
      children: [
        createActionNode({ id: 'n_0', actionName: 'get-value' }),
        createConditionNode({
          condition: { fieldId: 'fld_a', op: '>', value: 0 },
          thenChildren: [createActionNode({ id: 'n_a_t', actionName: 'form-control' })],
          elseChildren: [createActionNode({ id: 'n_a_e', actionName: 'form-control' })]
        }),
        createActionNode({ id: 'n_mid', actionName: 'create-record' }),
        createConditionNode({
          condition: { fieldId: 'fld_b', op: '<', value: 9 },
          thenChildren: [createActionNode({ id: 'n_b_t', actionName: 'navigate-page' })],
          elseChildren: []
        }),
        createActionNode({ id: 'n_last', actionName: 'navigate-page' })
      ]
    });
    const bundle = assertRoundTrip(root);
    // 入序：动作0 → A.then → A.else → 汇合动作 → B.then → B.else(空) → 末尾动作。
    expect(bundle.action_groups.map(g => g.ordered_node_ids)).toEqual([
      ['n_0'],
      ['n_a_t'],
      ['n_a_e'],
      ['n_mid'],
      ['n_b_t'],
      [],
      ['n_last']
    ]);
  });

  it('分支内再含多个顺序条件可逆（嵌套 band 同样支持多条件）', () => {
    const root = createTriggerRoot({
      eventKey: 'manual',
      scope: 'form',
      children: [
        createConditionNode({
          condition: { fieldId: 'fld_a', op: '>', value: 0 },
          thenChildren: [
            createConditionNode({
              condition: { fieldId: 'fld_x', op: '=', value: 1 },
              thenChildren: [createActionNode({ id: 'n_x_t', actionName: 'a' })],
              elseChildren: []
            }),
            createConditionNode({
              condition: { fieldId: 'fld_y', op: '=', value: 2 },
              thenChildren: [createActionNode({ id: 'n_y_t', actionName: 'b' })],
              elseChildren: [createActionNode({ id: 'n_y_e', actionName: 'c' })]
            })
          ],
          elseChildren: []
        })
      ]
    });
    assertRoundTrip(root);
  });

  it('动作右侧续接条件分支（子流程含条件→continuation_group_ids）可逆', () => {
    // 语义：探针动作执行后，下一步条件分支，判断后执行后续动作。
    const probe = {
      ...createActionNode({ id: 'n_probe', actionName: 'probe', source: 'builtin' }),
      children: [
        createConditionNode({
          condition: { fieldId: 'fld_q', op: '>', value: 0 },
          thenChildren: [createActionNode({ id: 'n_then', actionName: 'form-control' })],
          elseChildren: [createActionNode({ id: 'n_else', actionName: 'navigate-page' })]
        }),
        createActionNode({ id: 'n_after', actionName: 'create-record' })
      ]
    };
    const root = createTriggerRoot({ eventKey: 'manual', scope: 'form', children: [probe] });
    const bundle = assertRoundTrip(root);
    // probe 用续接组表达分支（而非 children_node_ids）。
    const probeNode = bundle.action_nodes.find(n => n.node_id === 'n_probe');
    expect(probeNode?.children_node_ids).toBeUndefined();
    expect(probeNode?.continuation_group_ids?.length).toBe(3); // then / else / 汇合后续
    // 续接组的 then/else guard 为「自包含」单条件（不与父路径 AND，因运行时结构性嵌在节点之后）。
    const guardOf = (gid?: string) => bundle.guards.find(g => g.guard_id === gid)?.condition;
    const contGroups = probeNode!.continuation_group_ids!.map(id => bundle.action_groups.find(g => g.group_id === id)!);
    expect(contGroups.map(g => guardOf(g.group_guard_id))).toEqual([
      '{{field:fld_q}} > 0',
      '{{field:fld_q}} <= 0',
      undefined // 汇合后续无 guard
    ]);
    expect(contGroups[2].ordered_node_ids).toEqual(['n_after']);
  });

  it('纯动作子流程仍用 children_node_ids（无条件时不变，向后兼容）', () => {
    const parent = {
      ...createActionNode({ id: 'n_p', actionName: 'get-value' }),
      children: [createActionNode({ id: 'n_c', actionName: 'navigate-page' })]
    };
    const root = createTriggerRoot({ eventKey: 'manual', scope: 'form', children: [parent] });
    const bundle = assertRoundTrip(root);
    const p = bundle.action_nodes.find(n => n.node_id === 'n_p');
    expect(p?.children_node_ids).toEqual(['n_c']);
    expect(p?.continuation_group_ids).toBeUndefined();
  });

  it('preserves node-level guard and async flags', () => {
    const root = createTriggerRoot({
      eventKey: 'manual',
      scope: 'form',
      children: [
        createActionNode({
          id: 'n_async',
          actionName: 'sync-record',
          source: 'plugin',
          async: true,
          nodeGuard: { fieldId: 'fld_status', op: '=', value: 'open' }
        })
      ]
    });
    assertRoundTrip(root);
  });
});

describe('compileEventsToBundle 多动作事件可逆', () => {
  // 三个不同事件：值变动取值 / 保存前条件分支 / 手动多步。
  // 第二个事件用 'create-before-save'（新键）——本描述块含一条回读结构比对用例
  // （下方「多事件编译 → 反向打开」），若用老 'before-save' 会被 openBundleToTrees 迁移成两档，
  // eventKey 与原树不再逐字相等，污染这里纯粹测「多事件结构可逆」的断言。
  function buildEvents(): MindNode[] {
    return [
      createTriggerRoot({
        eventKey: 'value-change',
        scope: 'field:fld_matCode',
        // eventFieldIds 才是 value-change 的编译权威来源（scope 仅展示兼容）。
        eventFieldIds: { 'value-change': ['fld_matCode'] },
        children: [createActionNode({ id: 'n_get', actionName: 'get-value', source: 'plugin', params: { data_table_id: 'tbl_mat' } })]
      }),
      createTriggerRoot({
        eventKey: 'create-before-save',
        scope: 'form',
        children: [
          createConditionNode({
            condition: { fieldId: 'fld_amount', op: '>', value: 5000 },
            thenChildren: [createActionNode({ id: 'n_block', actionName: 'form-control', source: 'plugin' })],
            elseChildren: []
          })
        ]
      }),
      createTriggerRoot({
        eventKey: 'manual',
        scope: 'form',
        children: [
          createActionNode({ id: 'n_a', actionName: 'related-form', source: 'plugin' }),
          createActionNode({ id: 'n_b', actionName: 'navigate-page', source: 'plugin' })
        ]
      })
    ];
  }

  it('多事件编译 → 反向打开，逐事件结构完全一致', () => {
    const events = buildEvents();
    const bundle = compileEventsToBundle(events);
    expect(bundle.trigger_bindings).toHaveLength(3);
    const reopened = openBundleToTrees(bundle);
    expect(reopened).toHaveLength(3);
    reopened.forEach((tree, i) => expect(shape(tree)).toEqual(shape(events[i])));
  });

  it('每条 binding 的 trigger_event_key / scope / ordered_group_ids 正确隔离', () => {
    const bundle = compileEventsToBundle(buildEvents());
    expect(bundle.trigger_bindings.map(b => b.trigger_event_key)).toEqual(['value-change', 'create-before-save', 'manual']);
    // 新写入不再写旧单值 scope 字段到 binding，权威改走 scopes 集合。
    expect(bundle.trigger_bindings.map(b => b.scopes)).toEqual([['field:fld_matCode'], ['form'], ['form']]);
    // 各 binding 引用的组互不重叠，且并集 = 全部组。
    const refs = bundle.trigger_bindings.flatMap(b => b.ordered_group_ids);
    expect(new Set(refs).size).toBe(refs.length);
    expect(new Set(refs)).toEqual(new Set(bundle.action_groups.map(g => g.group_id)));
  });

  it('跨事件 group_id / guard_id 全局唯一无冲突', () => {
    const bundle = compileEventsToBundle(buildEvents());
    const gids = bundle.action_groups.map(g => g.group_id);
    const gdids = bundle.guards.map(g => g.guard_id);
    expect(new Set(gids).size).toBe(gids.length);
    expect(new Set(gdids).size).toBe(gdids.length);
    // binding_id 也唯一（按各自触发根 id 派生）。
    const bids = bundle.trigger_bindings.map(b => b.binding_id);
    expect(new Set(bids).size).toBe(bids.length);
  });

  it('空事件集 → 空 bundle；openBundleToTrees 返回空数组', () => {
    const bundle = compileEventsToBundle([]);
    expect(bundle.trigger_bindings).toHaveLength(0);
    expect(bundle.action_groups).toHaveLength(0);
    expect(openBundleToTrees(bundle)).toEqual([]);
  });

  it('单事件版与多事件版对同一根产出一致（向后兼容）', () => {
    const root = createTriggerRoot({
      eventKey: 'manual',
      scope: 'form',
      children: [createActionNode({ id: 'n_x', actionName: 'get-value' })]
    });
    expect(compileMindmapToBundle(root)).toEqual(compileEventsToBundle([root]));
    // openBundleToTree = openBundleToTrees[0]
    const bundle = compileEventsToBundle([root]);
    expect(shape(openBundleToTree(bundle))).toEqual(shape(openBundleToTrees(bundle)[0]));
  });
});

describe('嵌套子流程可逆 (向右挂载子节点)', () => {
  it('单个动作带一个子节点：children_node_ids 落库、ordered_node_ids 仅顶层、结构可逆', () => {
    const root = createTriggerRoot({
      eventKey: 'manual',
      scope: 'form',
      children: [
        {
          ...createActionNode({ id: 'n_parent', actionName: 'get-value', source: 'plugin' }),
          children: [createActionNode({ id: 'n_child', actionName: 'navigate-page', source: 'plugin' })]
        }
      ]
    });
    const bundle = assertRoundTrip(root);
    // 顶层组只引用父节点；子节点经父的 children_node_ids 可达。
    expect(bundle.action_groups[0].ordered_node_ids).toEqual(['n_parent']);
    const parent = bundle.action_nodes.find(n => n.node_id === 'n_parent');
    expect(parent?.children_node_ids).toEqual(['n_child']);
    // 子节点平铺在节点池中。
    expect(bundle.action_nodes.map(n => n.node_id).sort()).toEqual(['n_child', 'n_parent']);
  });

  it('多级嵌套 A→B→C 前序可逆', () => {
    const root = createTriggerRoot({
      eventKey: 'manual',
      scope: 'form',
      children: [
        {
          ...createActionNode({ id: 'n_a', actionName: 'get-value' }),
          children: [
            {
              ...createActionNode({ id: 'n_b', actionName: 'navigate-page' }),
              children: [createActionNode({ id: 'n_c', actionName: 'form-control' })]
            }
          ]
        }
      ]
    });
    const bundle = assertRoundTrip(root);
    expect(bundle.action_groups[0].ordered_node_ids).toEqual(['n_a']);
    expect(bundle.action_nodes.find(n => n.node_id === 'n_a')?.children_node_ids).toEqual(['n_b']);
    expect(bundle.action_nodes.find(n => n.node_id === 'n_b')?.children_node_ids).toEqual(['n_c']);
    expect(bundle.action_nodes.find(n => n.node_id === 'n_c')?.children_node_ids).toBeUndefined();
  });

  it('动作带多个子节点 + band 内还有兄弟动作：顶层只含顶层动作', () => {
    const root = createTriggerRoot({
      eventKey: 'manual',
      scope: 'form',
      children: [
        {
          ...createActionNode({ id: 'n_p', actionName: 'get-value' }),
          children: [createActionNode({ id: 'n_c1', actionName: 'navigate-page' }), createActionNode({ id: 'n_c2', actionName: 'form-control' })]
        },
        createActionNode({ id: 'n_sib', actionName: 'create-record' })
      ]
    });
    const bundle = assertRoundTrip(root);
    // 顶层 band 只有 n_p 与 n_sib；两个子节点不在 ordered_node_ids。
    expect(bundle.action_groups[0].ordered_node_ids).toEqual(['n_p', 'n_sib']);
    expect(bundle.action_nodes.find(n => n.node_id === 'n_p')?.children_node_ids).toEqual(['n_c1', 'n_c2']);
  });

  it('子节点保留自身 async / nodeGuard', () => {
    const root = createTriggerRoot({
      eventKey: 'manual',
      scope: 'form',
      children: [
        {
          ...createActionNode({ id: 'n_p', actionName: 'get-value' }),
          children: [
            createActionNode({
              id: 'n_c',
              actionName: 'sync-record',
              async: true,
              nodeGuard: { fieldId: 'fld_s', op: '=', value: 'on' }
            })
          ]
        }
      ]
    });
    assertRoundTrip(root);
  });
});

describe('动作事件身份与命名（稳定 bindingId + name）', () => {
  it('bindingId 与 name 经 compile→open 往返保留；binding_id 即 bindingId', () => {
    const root = createTriggerRoot({
      eventKey: 'manual',
      scope: 'form',
      name: '提交按钮',
      children: [createActionNode({ id: 'n1', actionName: 'get-value' })]
    });
    const bundle = compileMindmapToBundle(root);
    const binding = bundle.trigger_bindings[0];
    expect(binding.binding_id).toBe(root.bindingId);
    expect(binding.name).toBe('提交按钮');
    const reopened = openBundleToTree(bundle);
    expect(reopened.bindingId).toBe(root.bindingId);
    expect(reopened.name).toBe('提交按钮');
  });

  it('多个同类型事件：group/guard id 按 bindingId 命名空间化、跨事件唯一', () => {
    const mk = (name: string) =>
      createTriggerRoot({
        eventKey: 'manual',
        scope: 'form',
        name,
        children: [
          createConditionNode({
            condition: { fieldId: 'f', op: '>', value: 0 },
            thenChildren: [createActionNode({ id: `n_${name}`, actionName: 'a' })],
            elseChildren: []
          })
        ]
      });
    const a = mk('A');
    const b = mk('B');
    const bundle = compileEventsToBundle([a, b]);
    expect(bundle.trigger_bindings.map(x => x.binding_id)).toEqual([a.bindingId, b.bindingId]);
    const gids = bundle.action_groups.map(g => g.group_id);
    const gdids = bundle.guards.map(g => g.guard_id);
    expect(new Set(gids).size).toBe(gids.length); // group id 全局唯一
    expect(new Set(gdids).size).toBe(gdids.length); // guard id 全局唯一
    expect(gids.every(id => id.startsWith(`${a.bindingId}_`) || id.startsWith(`${b.bindingId}_`))).toBe(true);
    // 反向打开还原两个事件，名称保留。
    expect(openBundleToTrees(bundle).map(t => t.name)).toEqual(['A', 'B']);
  });
});

describe('invertCondition', () => {
  it('flips operators symmetrically', () => {
    const c: SimpleCondition = { fieldId: 'f', op: '>=', value: 3 };
    expect(invertCondition(c)).toEqual({ fieldId: 'f', op: '<', value: 3 });
    expect(invertCondition(invertCondition(c))).toEqual(c);
  });
});

describe('多触发事件（trigger_event_keys 按事件拆分为独立 binding）', () => {
  it('多事件根（无 manual）编译为多条单事件 binding，各加后缀；反向打开合并回 eventKeys 并集', () => {
    // 第二个事件用 'edit-after-save'（新键）——本用例测的是多事件拆分/合并结构，
    // 不是保存键迁移语义，沿用旧 'after-save' 会在回读时触发迁移（专门测试见下方「流程步骤门编译/
    // 回读」描述块），污染这里的 eventKeys 断言。
    const root = createTriggerRoot({
      eventKey: 'create-time',
      eventKeys: ['create-time', 'edit-after-save'],
      scope: 'form',
      children: [createActionNode({ actionName: 'system.probe' })]
    });
    const bundle = compileEventsToBundle([root]);
    // 两个生命周期事件都非 manual，且 root 是多事件根 → 都加后缀（见 compile.ts binding_id 稳定性规则）。
    expect(bundle.trigger_bindings).toHaveLength(2);
    expect(bundle.trigger_bindings.map(b => b.trigger_event_keys)).toEqual([['create-time'], ['edit-after-save']]);
    expect(bundle.trigger_bindings.map(b => b.trigger_event_key)).toEqual(['create-time', 'edit-after-save']);
    expect(bundle.trigger_bindings.map(b => b.binding_id)).toEqual([
      `${root.bindingId}__create-time`,
      `${root.bindingId}__edit-after-save`
    ]);
    // 两条 binding 共享同一批组（walkBand 只算一次）。
    expect(bundle.trigger_bindings[0].ordered_group_ids).toEqual(bundle.trigger_bindings[1].ordered_group_ids);

    const reopened = openBundleToTrees(bundle)[0];
    expect(reopened.eventKeys).toEqual(['create-time', 'edit-after-save']);
    expect(reopened.eventKey).toBe('create-time');
    expect(reopened.bindingId).toBe(root.bindingId); // 还原为基名，供下次保存重新按规则派生

    // 旧文档（单 binding 内直接持有多个 trigger_event_keys、无后缀）读回：合并为同一 root，eventKeys 原样展开。
    const legacy: ActionBehaviorDocument = {
      ...bundle,
      trigger_bindings: [
        {
          binding_id: root.bindingId!,
          trigger_event_key: 'create-time',
          trigger_event_keys: ['create-time', 'edit-after-save'],
          scopes: ['form'],
          ordered_group_ids: bundle.trigger_bindings[0].ordered_group_ids
        }
      ]
    };
    const fromLegacy = openBundleToTrees(legacy)[0];
    expect(fromLegacy.eventKeys).toEqual(['create-time', 'edit-after-save']);
    expect(fromLegacy.eventKey).toBe('create-time');
  });

  it('旧单值字段（仅 trigger_event_key，无 trigger_event_keys）回读：eventKeys 回落 [单值]', () => {
    const legacy: ActionBehaviorDocument = {
      trigger_bindings: [{ binding_id: 'tb_legacy', trigger_event_key: 'manual', scopes: ['form'], ordered_group_ids: [] }],
      action_groups: [],
      action_nodes: [],
      guards: []
    };
    const fromLegacy = openBundleToTrees(legacy)[0];
    expect(fromLegacy.eventKeys).toEqual(['manual']);
    expect(fromLegacy.eventKey).toBe('manual');
  });
});

// 记录页事件（before-delete/after-delete）不在 compile.ts 的 FIELD_SCOPED_EVENTS
// 集合里（该集合只含 value-change/field-click），故走与生命周期事件（create-time 等）完全相同的
// else 分支——恒 scopes:['form']；本节用既有编译链证明这一点。
describe('记录页事件（before-delete / after-delete）编译为 scopes:["form"]', () => {
  it('单事件根：before-delete 编译出 1 条 binding，event_keys 与根一致、scopes 恒为 ["form"]（同生命周期事件）', () => {
    const root = createTriggerRoot({
      eventKey: 'before-delete',
      scope: 'form',
      children: [createActionNode({ actionName: 'system.probe' })]
    });
    const bundle = compileEventsToBundle([root]);
    expect(bundle.trigger_bindings).toHaveLength(1);
    expect(bundle.trigger_bindings[0].trigger_event_key).toBe('before-delete');
    expect(bundle.trigger_bindings[0].trigger_event_keys).toEqual(['before-delete']);
    expect(bundle.trigger_bindings[0].scopes).toEqual(['form']);
  });

  it('单事件根：after-delete 同上（scopes 恒为 ["form"]）', () => {
    const root = createTriggerRoot({
      eventKey: 'after-delete',
      scope: 'form',
      children: [createActionNode({ actionName: 'system.probe' })]
    });
    const bundle = compileEventsToBundle([root]);
    expect(bundle.trigger_bindings).toHaveLength(1);
    expect(bundle.trigger_bindings[0].trigger_event_key).toBe('after-delete');
    expect(bundle.trigger_bindings[0].scopes).toEqual(['form']);
  });

  it('多事件根同时勾选 before-delete/after-delete：按事件拆分为两条独立 binding（无 manual 均加后缀），均 scopes:["form"]，反向打开可还原', () => {
    const root = createTriggerRoot({
      eventKey: 'before-delete',
      eventKeys: ['before-delete', 'after-delete'],
      scope: 'form',
      children: [createActionNode({ actionName: 'system.probe' })]
    });
    const bundle = compileEventsToBundle([root]);
    expect(bundle.trigger_bindings).toHaveLength(2);
    expect(bundle.trigger_bindings.map(b => b.trigger_event_keys)).toEqual([['before-delete'], ['after-delete']]);
    expect(bundle.trigger_bindings.map(b => b.binding_id)).toEqual([`${root.bindingId}__before-delete`, `${root.bindingId}__after-delete`]);
    for (const binding of bundle.trigger_bindings) {
      expect(binding.scopes).toEqual(['form']);
    }
    // 两条 binding 共享同一批组（walkBand 只算一次），同「多触发事件」节的既有断言写法一致。
    expect(bundle.trigger_bindings[0].ordered_group_ids).toEqual(bundle.trigger_bindings[1].ordered_group_ids);

    const reopened = openBundleToTrees(bundle)[0];
    expect(reopened.eventKeys).toEqual(['before-delete', 'after-delete']);
    expect(reopened.bindingId).toBe(root.bindingId);
  });
});

describe('触发字段分事件独立集合 (eventFieldIds)', () => {
  it('root.eventFieldIds 驱动编译：value-change 用其字段集合生成 scopes，编译不再读旧 scope/scopes 字段', () => {
    const root = createTriggerRoot({
      eventKey: 'value-change',
      eventFieldIds: { 'value-change': ['a', 'b'] },
      children: [createActionNode({ actionName: 'system.probe' })]
    });
    const bundle = compileEventsToBundle([root]);
    expect(bundle.trigger_bindings).toHaveLength(1);
    expect(bundle.trigger_bindings[0].scopes).toEqual(['field:a', 'field:b']);
    expect(bundle.trigger_bindings[0].scope).toBeUndefined();
  });

  it('字段未设置（eventFieldIds 缺省/空数组）→ 该事件不产出 binding（废除 form 兜底），且组/节点/guard 一并不产', () => {
    const root = createTriggerRoot({ eventKey: 'value-change', children: [createActionNode({ actionName: 'system.probe' })] });
    const bundle = compileEventsToBundle([root]);
    expect(bundle.trigger_bindings).toHaveLength(0);
    // 孤儿实体回归闸：旧实现先 walkBand 再判触发字段，于是组/节点已进池而 binding 一条没有，
    // 产出一批谁也引用不到的孤儿——它们能存进库、反向打开时又不还原成画布事件（隐身），下次
    // 保存时删不掉又被追加同名实体，后端判 duplicate group_id / node_id 整份 400。
    // 一个 binding 都产不出的根，一个实体也不能产。
    expect(bundle.action_groups).toHaveLength(0);
    expect(bundle.action_nodes).toHaveLength(0);
    expect(bundle.guards).toHaveLength(0);
  });

  it('往返：编译→反向打开，root.eventFieldIds 精确还原，无迁移提示', () => {
    const root = createTriggerRoot({
      eventKey: 'value-change',
      eventFieldIds: { 'value-change': ['a'] },
      children: [createActionNode({ actionName: 'system.probe' })]
    });
    const bundle = compileEventsToBundle([root]);
    const reopened = openBundleToTrees(bundle)[0];
    expect(reopened.eventFieldIds?.['value-change']).toEqual(['a']);
    expect(reopened.needsFieldSelection).toBeUndefined();
  });
});

describe('出口分支（动作声明 x-outcomes → outcome_continuation_group_ids）', () => {
  it('两个出口各挂一个动作：产出 outcome_continuation_group_ids，且与 children_node_ids/continuation_group_ids 互斥', () => {
    // 语义：打开表单动作执行后，按查到(hit)/查不到(miss)分流到各自的后续动作。
    const probe = {
      ...createActionNode({ id: 'n_open', actionName: 'ui.open_form', source: 'plugin' }),
      outcomeChildren: {
        hit: [createActionNode({ id: 'n_hit', actionName: 'form-control' })],
        miss: [createActionNode({ id: 'n_miss', actionName: 'navigate-page' })]
      }
    };
    const root = createTriggerRoot({ eventKey: 'manual', scope: 'form', children: [probe] });
    const bundle = assertRoundTrip(root);

    const openNode = bundle.action_nodes.find(n => n.node_id === 'n_open');
    expect(openNode?.outcome_continuation_group_ids).toBeDefined();
    expect(Object.keys(openNode!.outcome_continuation_group_ids!).sort()).toEqual(['hit', 'miss']);
    // 互斥：普通续接字段不产出。
    expect(openNode?.children_node_ids).toBeUndefined();
    expect(openNode?.continuation_group_ids).toBeUndefined();

    const hitGroupId = openNode!.outcome_continuation_group_ids!.hit[0];
    const missGroupId = openNode!.outcome_continuation_group_ids!.miss[0];
    expect(bundle.action_groups.find(g => g.group_id === hitGroupId)?.ordered_node_ids).toEqual(['n_hit']);
    expect(bundle.action_groups.find(g => g.group_id === missGroupId)?.ordered_node_ids).toEqual(['n_miss']);
  });

  it('出口 band 内可再挂条件分支（与普通 band 同规则），可逆保留 guard AND 链', () => {
    const probe = {
      ...createActionNode({ id: 'n_open', actionName: 'ui.open_form', source: 'plugin' }),
      outcomeChildren: {
        hit: [
          createConditionNode({
            condition: { fieldId: 'fld_amt', op: '>', value: 100 },
            thenChildren: [createActionNode({ id: 'n_big', actionName: 'form-control' })],
            elseChildren: [createActionNode({ id: 'n_small', actionName: 'form-control' })]
          })
        ],
        miss: []
      }
    };
    const root = createTriggerRoot({ eventKey: 'manual', scope: 'form', children: [probe] });
    const bundle = assertRoundTrip(root);
    const openNode = bundle.action_nodes.find(n => n.node_id === 'n_open');
    // hit 出口内的条件分叉为两个组（成立/不成立）；miss 出口为空、group id 列表为空数组（键仍保留）。
    expect(openNode!.outcome_continuation_group_ids!.hit.length).toBe(2);
    expect(openNode!.outcome_continuation_group_ids!.miss).toEqual([]);
    const guardOf = (gid?: string) => bundle.guards.find(g => g.guard_id === gid)?.condition;
    const hitGroups = openNode!.outcome_continuation_group_ids!.hit.map(id => bundle.action_groups.find(g => g.group_id === id)!);
    expect(hitGroups.map(g => guardOf(g.group_guard_id))).toEqual(['{{field:fld_amt}} > 100', '{{field:fld_amt}} <= 100']);
  });

  it('未声明 outcomeChildren 的动作不受影响，仍走原有 children_node_ids/continuation_group_ids 路径', () => {
    const parent = {
      ...createActionNode({ id: 'n_p', actionName: 'get-value' }),
      children: [createActionNode({ id: 'n_c', actionName: 'navigate-page' })]
    };
    const root = createTriggerRoot({ eventKey: 'manual', scope: 'form', children: [parent] });
    const bundle = assertRoundTrip(root);
    const p = bundle.action_nodes.find(n => n.node_id === 'n_p');
    expect(p?.children_node_ids).toEqual(['n_c']);
    expect(p?.outcome_continuation_group_ids).toBeUndefined();
  });

  it('compile → open → 再 compile 幂等：出口 group/guard id 序列一致（按 outcome key 排序遍历）', () => {
    const probe = {
      ...createActionNode({ id: 'n_open', actionName: 'ui.open_form', source: 'plugin' }),
      outcomeChildren: {
        hit: [createActionNode({ id: 'n_hit', actionName: 'form-control' })],
        miss: [createActionNode({ id: 'n_miss', actionName: 'navigate-page' })]
      }
    };
    const root = createTriggerRoot({ eventKey: 'manual', scope: 'form', children: [probe] });
    const bundle1 = compileMindmapToBundle(root);
    const reopened = openBundleToTree(bundle1);
    const bundle2 = compileMindmapToBundle(reopened);
    expect(bundle2).toEqual(bundle1);
  });
});

// 触发字段按事件分离（field-click / value-change 各自独立字段集，无 form 兜底）。
// 用例按①-⑦编号，便于逐项核对。
describe('触发字段按事件分离（field-click / value-change 各自独立字段集）', () => {
  it('① 双事件各自字段 → 两条 binding（各单事件+各自 scopes），组共享 ordered_group_ids', () => {
    const root = createTriggerRoot({
      eventKey: 'value-change',
      eventKeys: ['value-change', 'field-click'],
      eventFieldIds: { 'value-change': ['a', 'b'], 'field-click': ['c'] },
      children: [createActionNode({ id: 'n1', actionName: 'system.probe' })]
    });
    const bundle = compileEventsToBundle([root]);
    expect(bundle.trigger_bindings).toHaveLength(2);
    expect(bundle.trigger_bindings.map(b => b.trigger_event_keys)).toEqual([['value-change'], ['field-click']]);
    expect(bundle.trigger_bindings.map(b => b.scopes)).toEqual([['field:a', 'field:b'], ['field:c']]);
    // 多事件根、都非 manual → 都加后缀。
    expect(bundle.trigger_bindings.map(b => b.binding_id)).toEqual([
      `${root.bindingId}__value-change`,
      `${root.bindingId}__field-click`
    ]);
    // 组只算一次，两条 binding 共享同一批（同一序列）。
    expect(bundle.trigger_bindings[0].ordered_group_ids).toEqual(bundle.trigger_bindings[1].ordered_group_ids);
    expect(bundle.action_groups).toHaveLength(1); // 未被重复产出
  });

  it('② value-change 有字段 + field-click 空 → 只产 value-change 一条 binding', () => {
    const root = createTriggerRoot({
      eventKey: 'value-change',
      eventKeys: ['value-change', 'field-click'],
      eventFieldIds: { 'value-change': ['a'] },
      children: [createActionNode({ actionName: 'system.probe' })]
    });
    const bundle = compileEventsToBundle([root]);
    expect(bundle.trigger_bindings).toHaveLength(1);
    expect(bundle.trigger_bindings[0].trigger_event_keys).toEqual(['value-change']);
    // binding_id 的多事件后缀按**原始** eventKeys 判定，不随「实际产出几条」变化：否则本例的
    // binding_id 会从 `${base}__value-change` 退化成 `${base}`，破坏存量文档身份与交互按钮的
    // target_binding_id 引用。
    expect(bundle.trigger_bindings[0].binding_id).toBe(`${root.bindingId}__value-change`);
  });

  it('③ 单事件根 binding_id 无后缀；多事件根中 manual 保原 id、其余事件加后缀', () => {
    const single = createTriggerRoot({ eventKey: 'manual', children: [createActionNode({ actionName: 'a' })] });
    const singleBundle = compileEventsToBundle([single]);
    expect(singleBundle.trigger_bindings).toHaveLength(1);
    expect(singleBundle.trigger_bindings[0].binding_id).toBe(single.bindingId);

    const multi = createTriggerRoot({
      eventKey: 'manual',
      eventKeys: ['manual', 'before-save'],
      children: [createActionNode({ actionName: 'a' })]
    });
    const multiBundle = compileEventsToBundle([multi]);
    const byEvent = new Map(multiBundle.trigger_bindings.map(b => [b.trigger_event_keys?.[0], b.binding_id]));
    expect(byEvent.get('manual')).toBe(multi.bindingId); // 交互按钮 target_binding_id 引用手动流程，恒不变
    expect(byEvent.get('before-save')).toBe(`${multi.bindingId}__before-save`);
  });

  it('④ 回读合并幂等：compile → open → 再 compile 结构/id 完全一致', () => {
    const root = createTriggerRoot({
      eventKey: 'value-change',
      eventKeys: ['value-change', 'field-click'],
      eventFieldIds: { 'value-change': ['a', 'b'], 'field-click': ['c'] },
      children: [createActionNode({ id: 'n1', actionName: 'system.probe' })]
    });
    const bundle1 = compileEventsToBundle([root]);
    const reopened = openBundleToTrees(bundle1)[0];
    expect(reopened.eventKeys).toEqual(['value-change', 'field-click']);
    expect(reopened.eventFieldIds?.['value-change']).toEqual(['a', 'b']);
    expect(reopened.eventFieldIds?.['field-click']).toEqual(['c']);
    const bundle2 = compileEventsToBundle([reopened]);
    expect(bundle2).toEqual(bundle1);
  });

  it('⑤ 旧文档（value-change/field-click 共享一条 binding、共享 scopes）回读 → 两事件各得同份字段（复制语义）', () => {
    const legacy: ActionBehaviorDocument = {
      trigger_bindings: [
        {
          binding_id: 'tb_legacy',
          trigger_event_keys: ['value-change', 'field-click'],
          scopes: ['field:a', 'field:b'],
          ordered_group_ids: []
        }
      ],
      action_groups: [],
      action_nodes: [],
      guards: []
    };
    const root = openBundleToTrees(legacy)[0];
    expect(root.eventKeys).toEqual(['value-change', 'field-click']);
    expect(root.eventFieldIds?.['value-change']).toEqual(['a', 'b']);
    expect(root.eventFieldIds?.['field-click']).toEqual(['a', 'b']);
    expect(root.needsFieldSelection).toBeUndefined();
  });

  it('⑥ 旧 form-scope value-change 回读 → needsFieldSelection 标记 + 该事件字段为空数组', () => {
    const legacy: ActionBehaviorDocument = {
      trigger_bindings: [
        { binding_id: 'tb_legacy2', trigger_event_keys: ['value-change'], scopes: ['form'], ordered_group_ids: [] }
      ],
      action_groups: [],
      action_nodes: [],
      guards: []
    };
    const root = openBundleToTrees(legacy)[0];
    // 不静默丢弃：事件仍在（eventKeys 保留），只是字段为空 + 打迁移提示标记。
    expect(root.eventKeys).toEqual(['value-change']);
    expect(root.eventFieldIds?.['value-change']).toEqual([]);
    expect(root.needsFieldSelection).toEqual(['value-change']);
  });

  it('⑦ 生命周期事件（如 before-save）仍固定 scopes=["form"]，不受 eventFieldIds 影响', () => {
    const root = createTriggerRoot({ eventKey: 'before-save', children: [createActionNode({ actionName: 'a' })] });
    const bundle = compileEventsToBundle([root]);
    expect(bundle.trigger_bindings).toHaveLength(1);
    expect(bundle.trigger_bindings[0].scopes).toEqual(['form']);
    expect(bundle.trigger_bindings[0].binding_id).toBe(root.bindingId); // 单事件根，无后缀
  });
});

// 条件分支双判断模式（引导式单层且/或 + 表达式）。用例按①-⑥编号
// （⑦labels 摘要见 labels.test.ts）。
describe('条件节点双判断模式（guided 引导式 / expression 表达式）', () => {
  it('① guided 单条：guardSpec 序列化与旧版 SimpleCondition 输出逐字节一致（零回归锚）', () => {
    const cond: SimpleCondition = { fieldId: 'fld_amount', op: '>', value: 5000 };
    const spec: ConditionNodeGuard = { mode: 'guided', guided: { logic: 'and', items: [cond] } };
    expect(serializeGuardSpec(spec)).toBe(serializeCondition(cond));
    expect(serializeGuardSpec(spec)).toBe('{{field:fld_amount}} > 5000');
    // createConditionNode 从旧 API（仅 condition）合成的 guardSpec 与显式构造的等价。
    const node = createConditionNode({ condition: cond });
    expect(node.guardSpec).toEqual(spec);
    expect(node.condition).toEqual(cond); // 镜像不变
  });

  it('② guided 多条：AND/OR 整体括号包裹序列化，else 分支按单层德摩根取反', () => {
    const p1: SimpleCondition = { fieldId: 'fld_a', op: '>', value: 0 };
    const p2: SimpleCondition = { fieldId: 'fld_b', op: '=', value: 1 };
    const andSpec: ConditionNodeGuard = { mode: 'guided', guided: { logic: 'and', items: [p1, p2] } };
    expect(serializeGuardSpec(andSpec)).toBe('({{field:fld_a}} > 0 AND {{field:fld_b}} = 1)');
    // 德摩根：!(P1 AND P2) = !P1 OR !P2。
    expect(invertGuardSpec(andSpec)).toEqual({
      mode: 'guided',
      guided: { logic: 'or', items: [invertCondition(p1), invertCondition(p2)] }
    });
    expect(serializeGuardSpec(invertGuardSpec(andSpec))).toBe('({{field:fld_a}} <= 0 OR {{field:fld_b}} != 1)');

    const orSpec: ConditionNodeGuard = { mode: 'guided', guided: { logic: 'or', items: [p1, p2] } };
    expect(serializeGuardSpec(orSpec)).toBe('({{field:fld_a}} > 0 OR {{field:fld_b}} = 1)');
    // 德摩根：!(P1 OR P2) = !P1 AND !P2。
    expect(serializeGuardSpec(invertGuardSpec(orSpec))).toBe('({{field:fld_a}} <= 0 AND {{field:fld_b}} != 1)');

    // 编译产物：group_guard_id 的 condition 串即上面校验过的括号形式；then 先 else 后。
    const root = createTriggerRoot({
      eventKey: 'before-save',
      scope: 'form',
      children: [
        createConditionNode({
          guardSpec: andSpec,
          thenChildren: [createActionNode({ id: 'n_then', actionName: 'form-control' })],
          elseChildren: [createActionNode({ id: 'n_else', actionName: 'form-control' })]
        })
      ]
    });
    const bundle = compileMindmapToBundle(root);
    const guardOf = (gid?: string) => bundle.guards.find(g => g.guard_id === gid)?.condition;
    expect(bundle.action_groups.map(g => guardOf(g.group_guard_id))).toEqual([
      '({{field:fld_a}} > 0 AND {{field:fld_b}} = 1)',
      '({{field:fld_a}} <= 0 OR {{field:fld_b}} != 1)'
    ]);
  });

  it('③ round-trip：guided 多条组 compile→open→再 compile 幂等，结构/guardSpec 精确还原', () => {
    const p1: SimpleCondition = { fieldId: 'fld_a', op: '>', value: 0 };
    const p2: SimpleCondition = { fieldId: 'fld_b', op: '=', value: 1 };
    const root = createTriggerRoot({
      eventKey: 'manual',
      scope: 'form',
      children: [
        createConditionNode({
          guardSpec: { mode: 'guided', guided: { logic: 'or', items: [p1, p2] } },
          thenChildren: [createActionNode({ id: 'n_t', actionName: 'a' })],
          elseChildren: [createActionNode({ id: 'n_e', actionName: 'b' })]
        })
      ]
    });
    const bundle1 = compileMindmapToBundle(root);
    const reopened = openBundleToTree(bundle1);
    expect(shape(reopened)).toEqual(shape(root));
    const bundle2 = compileMindmapToBundle(reopened);
    expect(bundle2).toEqual(bundle1); // 幂等：group/guard id 序列完全一致
  });

  it('④ 裸旧串（未加括号的 AND 链）回读兼容：仍逐段还原为 guided 单条（旧文档兼容）', () => {
    // 模拟双判断模式之前保存的旧文档：嵌套条件的 guard 串是纯 AND 链裸条件（无括号），与现有嵌套条件
    // round-trip 测试（见上方"nested condition"用例）产出的串完全一致格式。
    const legacyGuard = '{{field:fld_hit}} != 1 AND {{field:fld_hit}} > 1';
    const parsed = parseGuardPath(legacyGuard);
    expect(parsed).toEqual([
      { mode: 'guided', guided: { logic: 'and', items: [{ fieldId: 'fld_hit', op: '!=', value: 1 }] } },
      { mode: 'guided', guided: { logic: 'and', items: [{ fieldId: 'fld_hit', op: '>', value: 1 }] } }
    ]);
  });

  it('⑤ 不可解析串（如裸 OR、无括号）回落 expression 模式，不 throw（graceful 降级）', () => {
    // 顶层没有 AND，parseGuardPath 视为单一片段；该片段既非裸单条也非合法括号分组 → 回落 expression。
    const foreign = '{{field:fld_a}} > 0 OR {{field:fld_b}} > 0';
    expect(() => parseGuardPath(foreign)).not.toThrow();
    expect(parseGuardPath(foreign)).toEqual([{ mode: 'expression', expression: foreign }]);

    // 端到端：openBundleToTrees 遇到这种历史/外来 guard 串不再抛错丢文档，而是把该分支还原为
    // 一个 expression 模式的条件节点（旧行为在 guardParseFailed 处直接 throw，中断整份文档加载）。
    const legacy: ActionBehaviorDocument = {
      trigger_bindings: [{ binding_id: 'tb_x', trigger_event_key: 'manual', scopes: ['form'], ordered_group_ids: ['g1', 'g2'] }],
      action_groups: [
        { group_id: 'g1', group_guard_id: 'gd1', ordered_node_ids: ['n1'] },
        { group_id: 'g2', ordered_node_ids: [] }
      ],
      action_nodes: [{ node_id: 'n1', action_name: 'form-control' }],
      guards: [{ guard_id: 'gd1', condition: foreign }]
    };
    let trees: MindNode[] = [];
    expect(() => {
      trees = openBundleToTrees(legacy);
    }).not.toThrow();
    const cond = trees[0].children?.[0];
    expect(cond?.kind).toBe('condition');
    expect(cond?.guardSpec).toEqual({ mode: 'expression', expression: foreign });
  });

  it('⑥ expression 模式：序列化恒括号包裹；空 else 可编译，非空 else 因无 NOT 而编译报错', () => {
    const expr = '{{field:fld_a}} > 0 OR {{field:fld_b}} > 0';
    const spec: ConditionNodeGuard = { mode: 'expression', expression: expr };
    expect(serializeGuardSpec(spec)).toBe(`(${expr})`);

    // 空 else：正常编译，只产出 then 一个组（无 else 组，因无法生成安全取反 guard）。
    const rootOk = createTriggerRoot({
      eventKey: 'manual',
      scope: 'form',
      children: [
        createConditionNode({
          guardSpec: spec,
          thenChildren: [createActionNode({ id: 'n_t', actionName: 'a' })],
          elseChildren: []
        })
      ]
    });
    const bundleOk = compileMindmapToBundle(rootOk);
    expect(bundleOk.action_groups).toHaveLength(1);
    const guardOf = (gid?: string) => bundleOk.guards.find(g => g.guard_id === gid)?.condition;
    expect(guardOf(bundleOk.action_groups[0].group_guard_id)).toBe(`(${expr})`);

    // 非空 else：编译期报错（后端 guard 文法/求值器均无 NOT，已读 predicate.go + evaluator.go 确认）。
    const rootBad = createTriggerRoot({
      eventKey: 'manual',
      scope: 'form',
      children: [
        createConditionNode({
          guardSpec: spec,
          thenChildren: [createActionNode({ id: 'n_t2', actionName: 'a' })],
          elseChildren: [createActionNode({ id: 'n_e2', actionName: 'b' })]
        })
      ]
    });
    expect(() => compileMindmapToBundle(rootBad)).toThrow();
  });

  it('NodeConfigDialog「表达式→引导式」迁移辅助：能归约的裸串（无需外层括号）转换成功，混用/裸解析失败返回 null', () => {
    expect(tryConvertExpressionToGuidedGroup('{{field:fld_a}} > 0')).toEqual({
      logic: 'and',
      items: [{ fieldId: 'fld_a', op: '>', value: 0 }]
    });
    expect(tryConvertExpressionToGuidedGroup('{{field:fld_a}} > 0 AND {{field:fld_b}} = 1')).toEqual({
      logic: 'and',
      items: [
        { fieldId: 'fld_a', op: '>', value: 0 },
        { fieldId: 'fld_b', op: '=', value: 1 }
      ]
    });
    expect(tryConvertExpressionToGuidedGroup('{{field:fld_a}} > 0 OR {{field:fld_b}} = 1')).toEqual({
      logic: 'or',
      items: [
        { fieldId: 'fld_a', op: '>', value: 0 },
        { fieldId: 'fld_b', op: '=', value: 1 }
      ]
    });
    // AND/OR 混用：超出单层引导式表达能力。
    expect(tryConvertExpressionToGuidedGroup('{{field:fld_a}} > 0 AND {{field:fld_b}} = 1 OR {{field:fld_c}} < 2')).toBeNull();
    expect(tryConvertExpressionToGuidedGroup('')).toBeNull();
  });
});

// before-save 触发根下的写动作（新增/修改/删除数据，插件 kimpo-record-controllers）
// 必须同步执行——本组是保存链路的编译期最后一道闸，覆盖 draft.async 在设计器层被置 true 却未经
// NodeConfigDialog.asyncBlockedByBeforeSave 那道闸重置的场景（如节点从别的触发根拖拽/复制而来）。
// 三写动作字面量清单见 compile.ts WRITE_ACTION_NAMES 注释（与 kimpo-record-controllers 插件
// internal/actions/{create,update,delete}/service.go 的 ActionName 常量一一对应）。
describe('before-save 根下写动作强制同步（编译期兜底）', () => {
  const WRITE_ACTION_NAMES = ['data.create_record', 'data.update_record', 'data.delete_record'];

  it.each(WRITE_ACTION_NAMES)('%s 在 before-save 根下即使 async:true 也编译为不产出 async 字段（等价 false）', actionName => {
    const root = createTriggerRoot({
      eventKey: 'before-save',
      scope: 'form',
      children: [createActionNode({ id: 'n_w', actionName, async: true })]
    });
    const bundle = compileMindmapToBundle(root);
    const node = bundle.action_nodes.find(n => n.node_id === 'n_w');
    expect(node?.async).toBeUndefined();
  });

  it('同一写动作节点（data.update_record）在 after-save 根下不受影响，async:true 原样编译', () => {
    const root = createTriggerRoot({
      eventKey: 'after-save',
      scope: 'form',
      children: [createActionNode({ id: 'n_w', actionName: 'data.update_record', async: true })]
    });
    const bundle = compileMindmapToBundle(root);
    const node = bundle.action_nodes.find(n => n.node_id === 'n_w');
    expect(node?.async).toBe(true);
  });

  it('before-save 根下的非写动作节点不受影响，async:true 原样编译（判定精确到三写动作，不误伤其它动作）', () => {
    const root = createTriggerRoot({
      eventKey: 'before-save',
      scope: 'form',
      children: [createActionNode({ id: 'n_other', actionName: 'form-control', async: true })]
    });
    const bundle = compileMindmapToBundle(root);
    const node = bundle.action_nodes.find(n => n.node_id === 'n_other');
    expect(node?.async).toBe(true);
  });

  it('多事件根（eventKeys 含 before-save + 其它事件）：写动作节点仍被阻断——只要事件集合含 before-save 即阻断', () => {
    const root = createTriggerRoot({
      eventKey: 'manual',
      eventKeys: ['manual', 'before-save'],
      children: [createActionNode({ id: 'n_w', actionName: 'data.delete_record', async: true })]
    });
    const bundle = compileEventsToBundle([root]);
    const node = bundle.action_nodes.find(n => n.node_id === 'n_w');
    expect(node?.async).toBeUndefined();
  });

  it('向右挂载的嵌套子节点（continuation band）内的写动作同样被阻断——currentRootBlocksWriteAsync 在递归中持续生效', () => {
    const root = createTriggerRoot({
      eventKey: 'before-save',
      scope: 'form',
      children: [
        createConditionNode({
          condition: { fieldId: 'fld_amount', op: '>', value: 0 },
          thenChildren: [createActionNode({ id: 'n_w', actionName: 'data.create_record', async: true })],
          elseChildren: []
        })
      ]
    });
    const bundle = compileMindmapToBundle(root);
    const node = bundle.action_nodes.find(n => n.node_id === 'n_w');
    expect(node?.async).toBeUndefined();
  });

  it('async:false（默认同步）不受影响：before-save 根下的写动作本就不产出 async 字段', () => {
    const root = createTriggerRoot({
      eventKey: 'before-save',
      scope: 'form',
      children: [createActionNode({ id: 'n_w', actionName: 'data.create_record', async: false })]
    });
    const bundle = compileMindmapToBundle(root);
    const node = bundle.action_nodes.find(n => n.node_id === 'n_w');
    expect(node?.async).toBeUndefined();
  });

  it('不同触发根之间互不影响：同一批多事件编译中，before-save 根阻断写动作，manual 根不受影响', () => {
    const events: MindNode[] = [
      createTriggerRoot({
        eventKey: 'before-save',
        scope: 'form',
        bindingId: 'tb_bs',
        children: [createActionNode({ id: 'n_bs', actionName: 'data.update_record', async: true })]
      }),
      createTriggerRoot({
        eventKey: 'manual',
        scope: 'form',
        bindingId: 'tb_manual',
        children: [createActionNode({ id: 'n_manual', actionName: 'data.update_record', async: true })]
      })
    ];
    const bundle = compileEventsToBundle(events);
    expect(bundle.action_nodes.find(n => n.node_id === 'n_bs')?.async).toBeUndefined();
    expect(bundle.action_nodes.find(n => n.node_id === 'n_manual')?.async).toBe(true);
  });

  // before-save 已细分为 create-before-save/edit-before-save 两档，新配置只会产出新键
  // （老键仅存量文档回读兼容）——本组锁死新键同样触发这道闸，否则写动作强制同步对新写的触发根会静默失效。
  it.each(['create-before-save', 'edit-before-save'] as const)(
    '%s 根下写动作同样被阻断（新建/编辑保存前两档都要生效，不止老 before-save）',
    eventKey => {
      const root = createTriggerRoot({ eventKey, scope: 'form', children: [createActionNode({ id: 'n_w', actionName: 'data.create_record', async: true })] });
      const bundle = compileMindmapToBundle(root);
      expect(bundle.action_nodes.find(n => n.node_id === 'n_w')?.async).toBeUndefined();
    }
  );

  it.each(['create-after-save', 'edit-after-save'] as const)(
    '%s 根下写动作不受影响（"保存后"不阻断保存，语义同老 after-save）',
    eventKey => {
      const root = createTriggerRoot({ eventKey, scope: 'form', children: [createActionNode({ id: 'n_w', actionName: 'data.update_record', async: true })] });
      const bundle = compileMindmapToBundle(root);
      expect(bundle.action_nodes.find(n => n.node_id === 'n_w')?.async).toBe(true);
    }
  );
});

// 写节点识别按数据动作种类：第三方经 SDK 声明为 create / update / delete 的动作
// 与官方写节点同口径被强制同步。
describe('before-save 根下写节点按数据动作种类强制同步', () => {
  const kinds: Record<string, 'fetch' | 'create' | 'update' | 'delete'> = {
    'org.example.data-actions.close_order': 'update',
    'org.example.data-actions.new_order': 'create',
    'org.example.data-actions.drop_order': 'delete',
    'org.example.data-actions.pull_order': 'fetch'
  };
  const operationKindOf = (name: string | undefined) => (name ? kinds[name] : undefined);

  function compileOne(actionName: string, eventKey: 'create-before-save' | 'create-after-save' = 'create-before-save') {
    const root = createTriggerRoot({ eventKey, scope: 'form', children: [createActionNode({ id: 'n_tp', actionName, async: true })] });
    return compileEventsToBundle([root], { operationKindOf }).action_nodes.find(n => n.node_id === 'n_tp');
  }

  it.each(['org.example.data-actions.close_order', 'org.example.data-actions.new_order', 'org.example.data-actions.drop_order'])(
    '第三方写类种类动作 %s 在保存前根下被强制同步',
    actionName => {
      expect(compileOne(actionName)?.async).toBeUndefined();
    }
  );

  it('第三方 fetch 种类不是写动作：保存前根下 async 原样保留', () => {
    expect(compileOne('org.example.data-actions.pull_order')?.async).toBe(true);
  });

  it('第三方写节点在保存后根下不受影响', () => {
    expect(compileOne('org.example.data-actions.close_order', 'create-after-save')?.async).toBe(true);
  });

  it('未注入种类解析时：第三方动作不被识别（无种类）、官方写动作仍按兼容表被强制同步', () => {
    const root = createTriggerRoot({
      eventKey: 'create-before-save',
      scope: 'form',
      children: [
        createActionNode({ id: 'n_tp', actionName: 'org.example.data-actions.close_order', async: true }),
        createActionNode({ id: 'n_off', actionName: 'data.update_record', async: true })
      ]
    });
    const nodes = compileEventsToBundle([root]).action_nodes;
    expect(nodes.find(n => n.node_id === 'n_tp')?.async).toBe(true);
    expect(nodes.find(n => n.node_id === 'n_off')?.async).toBeUndefined();
  });
});

describe('画布顺序 seq（取数「接收影响区间」第①段）', () => {
  // 第三个事件用 'edit-after-save'（新键，非迁移退役键）——本描述块测的是 seq/回读
  // 顺序，不是保存键迁移语义，若沿用旧 'after-save' 会在 openBundleToTrees 触发迁移（见下方专门的
  // 「流程步骤门编译/回读」描述块），eventKey 在回读后变成两档，污染本组的顺序断言。
  function threeEvents(): MindNode[] {
    return [
      createTriggerRoot({ eventKey: 'value-change', eventFieldIds: { 'value-change': ['f1'] }, children: [createActionNode({ id: 'n_1', actionName: 'get-value', source: 'plugin' })] }),
      createTriggerRoot({ eventKey: 'manual', scope: 'form', children: [createActionNode({ id: 'n_2', actionName: 'get-value', source: 'plugin' })] }),
      createTriggerRoot({ eventKey: 'edit-after-save', scope: 'form', children: [createActionNode({ id: 'n_3', actionName: 'get-value', source: 'plugin' })] })
    ];
  }

  it('compileEventsToBundle 按根下标写 seq（1 起连续），seqStart 可指定单事件保存的下标', () => {
    expect(compileEventsToBundle(threeEvents()).trigger_bindings.map(b => b.seq)).toEqual([1, 2, 3]);
    expect(compileEventsToBundle(threeEvents().slice(0, 1), { seqStart: 3 }).trigger_bindings.map(b => b.seq)).toEqual([3]);
  });

  it('多事件根拆产的多条 binding 共享同一 seq', () => {
    const root = createTriggerRoot({
      eventKey: 'manual',
      eventKeys: ['manual', 'value-change'],
      eventFieldIds: { 'value-change': ['f1'] },
      children: [createActionNode({ id: 'n_m', actionName: 'get-value', source: 'plugin' })]
    });
    const bundle = compileEventsToBundle([createTriggerRoot({ eventKey: 'edit-after-save', scope: 'form', children: [] }), root]);
    expect(bundle.trigger_bindings.map(b => [b.binding_id, b.seq])).toEqual([
      [expect.stringMatching(/^tb_/), 1],
      [root.bindingId ?? `tb_${root.id}`, 2],
      [`${root.bindingId ?? `tb_${root.id}`}__value-change`, 2]
    ]);
  });

  it('openBundleToTrees 按 seq 回读顺序（文档顺序与 seq 相反时以 seq 为准）；无 seq 的旧 binding 排在有 seq 之后保持文档序', () => {
    const bundle = compileEventsToBundle(threeEvents());
    const reversed: ActionBehaviorDocument = { ...bundle, trigger_bindings: [...bundle.trigger_bindings].reverse() };
    const trees = openBundleToTrees(reversed);
    expect(trees.map(t => t.eventKey)).toEqual(['value-change', 'manual', 'edit-after-save']);

    const legacy: ActionBehaviorDocument = {
      ...bundle,
      trigger_bindings: [
        { ...bundle.trigger_bindings[2], seq: undefined },
        { ...bundle.trigger_bindings[1], seq: 1 },
        { ...bundle.trigger_bindings[0], seq: undefined }
      ]
    };
    expect(openBundleToTrees(legacy).map(t => t.eventKey)).toEqual(['manual', 'edit-after-save', 'value-change']);
  });

  it('seq 往返：编译 → 打开 → 再编译，seq 与顺序一致', () => {
    const bundle = compileEventsToBundle(threeEvents());
    const reopened = openBundleToTrees(bundle);
    expect(compileEventsToBundle(reopened).trigger_bindings.map(b => b.seq)).toEqual([1, 2, 3]);
  });
});

// 动作事件启用/停用：触发根的 enabled 与 binding.disabled 双向对应。
describe('动作事件停用标记编译/回读', () => {
  it('停用的触发根写 disabled=true，启用态不写该键（宿主规范化对零值敏感）', () => {
    const on = createTriggerRoot({ eventKey: 'manual', scope: 'form', children: [createActionNode({ id: 'n_on', actionName: 'noop' })] });
    const off = createTriggerRoot({ eventKey: 'create-time', scope: 'form', children: [createActionNode({ id: 'n_off', actionName: 'noop' })] });
    off.enabled = false;
    const bundle = compileEventsToBundle([on, off]);
    expect(bundle.trigger_bindings).toHaveLength(2);
    // 启用态：键必须完全缺席（不是 disabled:false）。
    expect('disabled' in bundle.trigger_bindings[0]).toBe(false);
    expect(bundle.trigger_bindings[1].disabled).toBe(true);
  });

  it('多事件根停用时，拆产的每条 binding 都带上 disabled（停一个事件 = 停它的全部触发条件）', () => {
    const root = createTriggerRoot({
      eventKey: 'value-change',
      scope: 'form',
      eventFieldIds: { 'value-change': ['fld_a'] },
      children: [createActionNode({ id: 'n_x', actionName: 'noop' })]
    });
    root.eventKeys = ['value-change', 'manual'];
    root.enabled = false;
    const bundle = compileEventsToBundle([root]);
    expect(bundle.trigger_bindings.length).toBeGreaterThan(1);
    expect(bundle.trigger_bindings.every(b => b.disabled === true)).toBe(true);
  });

  it('回读：disabled=true → enabled=false；缺字段的旧文档 → enabled=true', () => {
    const disabledDoc: ActionBehaviorDocument = {
      trigger_bindings: [{ binding_id: 'tb_1', trigger_event_key: 'manual', scopes: ['form'], ordered_group_ids: ['g_1'], disabled: true }],
      action_groups: [{ group_id: 'g_1', ordered_node_ids: ['n_1'] }],
      action_nodes: [{ node_id: 'n_1', action_name: 'noop' }],
      guards: []
    };
    expect(openBundleToTree(disabledDoc).enabled).toBe(false);

    const legacyDoc: ActionBehaviorDocument = {
      ...disabledDoc,
      trigger_bindings: [{ binding_id: 'tb_1', trigger_event_key: 'manual', scopes: ['form'], ordered_group_ids: ['g_1'] }]
    };
    expect(openBundleToTree(legacyDoc).enabled).toBe(true);
  });

  it('停用态经「编译 → 回读 → 再编译」往返不丢失', () => {
    const root = createTriggerRoot({ eventKey: 'manual', scope: 'form', children: [createActionNode({ id: 'n_1', actionName: 'noop' })] });
    root.enabled = false;
    const once = compileEventsToBundle([root]);
    const reopened = openBundleToTrees(once);
    expect(reopened[0].enabled).toBe(false);
    const twice = compileEventsToBundle(reopened);
    expect(twice.trigger_bindings[0].disabled).toBe(true);
  });
});

// ─────────────────── 旧形态编译产物零回归锚 ───────────────────
// V4 条件（conditions 池 + guard.path）是新增通道，**不得**渗进不含 V4 条件的文档：多写一个
// conditions 空数组或给 guard 补一个 path 空数组，都会改变宿主规范化字节、破坏文档校验和。
describe('无 V4 条件的文档不出现 conditions / path 键', () => {
  it('纯动作文档：conditions 键整键缺席', () => {
    const root = createTriggerRoot({ eventKey: 'manual', scope: 'form', children: [createActionNode({ id: 'n_1', actionName: 'noop' })] });
    expect('conditions' in compileEventsToBundle([root])).toBe(false);
  });

  it('旧引导式条件文档：guard 仍是 condition 串 / condition_group，无 path 键、无 conditions 键', () => {
    const root = createTriggerRoot({
      eventKey: 'manual',
      scope: 'form',
      children: [
        createConditionNode({
          condition: { fieldId: 'fld_qty', op: '>', value: 0 },
          thenChildren: [createActionNode({ id: 'n_then', actionName: 'noop' })],
          elseChildren: [createActionNode({ id: 'n_else', actionName: 'noop' })]
        })
      ]
    });
    const bundle = compileEventsToBundle([root]);
    expect('conditions' in bundle).toBe(false);
    expect(bundle.guards.length).toBeGreaterThan(0);
    expect(bundle.guards.every(guard => !('path' in guard))).toBe(true);
  });
});

// ─────────────────── 触发根流程步骤门（workflow_gate）+ 老保存键退役迁移 ───────────────────
describe('流程步骤门编译/回读', () => {
  it('① 带门根：编译 → 打开 → 再编译字节相同（含 notStarted + 多步骤，验证排序去重的确定性）', () => {
    const root = createTriggerRoot({
      eventKey: 'manual',
      scope: 'form',
      children: [createActionNode({ id: 'n_1', actionName: 'noop' })]
    });
    // 故意乱序 + 重复登记同一步骤，编译侧应稳定排序去重（见 buildWorkflowGate）。
    root.workflowGate = {
      notStarted: true,
      steps: [
        { definitionId: 'wf_b', nodeId: 'n2', arrivals: ['submitted', 'returned'] },
        { definitionId: 'wf_a', nodeId: 'n1', definitionName: '采购申请', nodeName: '经理审批', arrivals: ['submitted'] },
        { definitionId: 'wf_a', nodeId: 'n1', arrivals: ['submitted'] } // 重复步骤，去重后只留首次登记
      ]
    };
    const bundle1 = compileEventsToBundle([root]);
    const gate = bundle1.trigger_bindings[0].workflow_gate;
    expect(gate).toEqual({
      not_started: true,
      steps: [
        { definition_id: 'wf_a', node_id: 'n1', definition_name: '采购申请', node_name: '经理审批', arrivals: ['submitted'] },
        { definition_id: 'wf_b', node_id: 'n2' } // 两档全选，arrivals 键省略
      ]
    });
    const reopened = openBundleToTrees(bundle1);
    expect(reopened[0].workflowGate).toEqual({
      notStarted: true,
      steps: [
        { definitionId: 'wf_a', nodeId: 'n1', definitionName: '采购申请', nodeName: '经理审批', arrivals: ['submitted'] },
        // 回读时缺省 arrivals 补全为显式两档（内存态不变式）。
        { definitionId: 'wf_b', nodeId: 'n2', definitionName: undefined, nodeName: undefined, arrivals: ['submitted', 'returned'] }
      ]
    });
    const bundle2 = compileEventsToBundle(reopened);
    expect(bundle2).toEqual(bundle1);
  });

  it('② 两档全选省略 arrivals 键；单档（含 notStarted 单独为 true 但无 steps）分别写出', () => {
    const withBothArrivals = createTriggerRoot({ eventKey: 'manual', scope: 'form', children: [] });
    withBothArrivals.workflowGate = { notStarted: false, steps: [{ definitionId: 'd1', nodeId: 's1', arrivals: ['submitted', 'returned'] }] };
    const bundle1 = compileEventsToBundle([withBothArrivals]);
    expect('arrivals' in bundle1.trigger_bindings[0].workflow_gate!.steps[0]).toBe(false);
    expect('not_started' in bundle1.trigger_bindings[0].workflow_gate!).toBe(false);

    const withSingleArrival = createTriggerRoot({ eventKey: 'manual', scope: 'form', children: [] });
    withSingleArrival.workflowGate = { notStarted: false, steps: [{ definitionId: 'd1', nodeId: 's1', arrivals: ['returned'] }] };
    const bundle2 = compileEventsToBundle([withSingleArrival]);
    expect(bundle2.trigger_bindings[0].workflow_gate!.steps[0].arrivals).toEqual(['returned']);

    // 空 steps + notStarted=true：仍是有效门（只放行"未发起"档）。
    const notStartedOnly = createTriggerRoot({ eventKey: 'manual', scope: 'form', children: [] });
    notStartedOnly.workflowGate = { notStarted: true, steps: [] };
    const bundle3 = compileEventsToBundle([notStartedOnly]);
    expect(bundle3.trigger_bindings[0].workflow_gate).toEqual({ not_started: true, steps: [] });
  });

  it('③ 旧 before-save/after-save 文档打开：迁移为新建/编辑两档 + legacySaveMigrated 提示', () => {
    const legacyDoc: ActionBehaviorDocument = {
      trigger_bindings: [{ binding_id: 'tb_1', trigger_event_key: 'before-save', scopes: ['form'], ordered_group_ids: ['g_1'] }],
      action_groups: [{ group_id: 'g_1', ordered_node_ids: ['n_1'] }],
      action_nodes: [{ node_id: 'n_1', action_name: 'noop' }],
      guards: []
    };
    const reopened = openBundleToTree(legacyDoc);
    expect(reopened.eventKeys).toEqual(['create-before-save', 'edit-before-save']);
    expect(reopened.eventKey).toBe('create-before-save');
    expect(reopened.legacySaveMigrated).toBe(true);

    const legacyAfterDoc: ActionBehaviorDocument = {
      ...legacyDoc,
      trigger_bindings: [{ binding_id: 'tb_1', trigger_event_key: 'after-save', scopes: ['form'], ordered_group_ids: ['g_1'] }]
    };
    const reopenedAfter = openBundleToTree(legacyAfterDoc);
    expect(reopenedAfter.eventKeys).toEqual(['create-after-save', 'edit-after-save']);
    expect(reopenedAfter.legacySaveMigrated).toBe(true);

    // 非迁移场景（新键/其它事件）：legacySaveMigrated 不置位。
    const freshDoc: ActionBehaviorDocument = {
      ...legacyDoc,
      trigger_bindings: [{ binding_id: 'tb_1', trigger_event_key: 'create-before-save', scopes: ['form'], ordered_group_ids: ['g_1'] }]
    };
    expect(openBundleToTree(freshDoc).legacySaveMigrated).toBeUndefined();
  });

  it('④ 无门文档：编译产物不出现 workflow_gate 键（与改动前逐字节一致）', () => {
    const root = createTriggerRoot({ eventKey: 'manual', scope: 'form', children: [createActionNode({ id: 'n_1', actionName: 'noop' })] });
    const bundle = compileEventsToBundle([root]);
    expect(bundle.trigger_bindings.every(b => !('workflow_gate' in b))).toBe(true);
    expect(JSON.stringify(bundle)).not.toMatch(/workflow_gate/);
    // 反向打开同样不产出 workflowGate 键。
    expect(openBundleToTree(bundle).workflowGate).toBeUndefined();
  });
});
