import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActionDesignerScope } from '../hostTypes';
import type { ActionBehaviorDocument, BehaviorCondition } from '../bundle';
import { createFakeHostApi } from './fakeHostApi';
import { useActionDesigner } from '../useActionDesigner';

/**
 * 单事件保存把编译产物合并进整份文档时（mergeEventIntoDoc / removeRootFromDoc）若只枚举四个键，
 * 文档级 conditions 池会被整个丢掉 ⇒ 后端「path 引用的条件不在池内」
 * ⇒「设计文件格式错误」。本守护钉死：保存当前事件后，本事件的条件在池内、其它事件的条件原样保留。
 */
const openActionDocument = vi.fn();
const saveActionDocument = vi.fn();
const listActionRegistry = vi.fn();
const listTemplateTables = vi.fn();
const listTemplateFields = vi.fn();
const hostApi = createFakeHostApi({ openActionDocument, saveActionDocument, listActionRegistry, listTemplateTables, listTemplateFields });

const scope: ActionDesignerScope = { appId: 'app_c', templateId: 'tpl_c', templateVersionNo: '1.0', designerType: 'spreadsheet' };

function condition(id: string, text: string): BehaviorCondition {
  return {
    condition_id: id,
    document: {
      schema_version: 'kimpo.report-expression/v4',
      mode: 'condition',
      expression: { expression_id: id, purpose: 'condition', source_text: text, refs: [] }
    },
    plan: { publication_id: `pub_${id}`, definition_id: `guard/${id}` }
  };
}

/** 两个事件根各带一个 V4 条件节点（then 分支一个动作），池里两条。 */
function twoRootDocument(): ActionBehaviorDocument {
  return {
    trigger_bindings: [
      { binding_id: 'tb_a__create-time', trigger_event_key: 'create-time', trigger_event_keys: ['create-time'], scopes: ['form'], ordered_group_ids: ['tb_a_g1'], seq: 1 },
      { binding_id: 'tb_b__after-save', trigger_event_key: 'after-save', trigger_event_keys: ['after-save'], scopes: ['form'], ordered_group_ids: ['tb_b_g1'], seq: 2 }
    ] as ActionBehaviorDocument['trigger_bindings'],
    action_groups: [
      { group_id: 'tb_a_g1', ordered_node_ids: ['n_a'], group_guard_id: 'tb_a_gd1' },
      { group_id: 'tb_b_g1', ordered_node_ids: ['n_b'], group_guard_id: 'tb_b_gd1' }
    ],
    action_nodes: [
      { node_id: 'n_a', action_name: 'ui.message', name: '提示', source: 'plugin', params: { text: 'A' } },
      { node_id: 'n_b', action_name: 'ui.message', name: '提示', source: 'plugin', params: { text: 'B' } }
    ] as ActionBehaviorDocument['action_nodes'],
    guards: [
      { guard_id: 'tb_a_gd1', condition: '', path: [{ condition_id: 'cond_aaaaaaaa' }] },
      { guard_id: 'tb_b_gd1', condition: '', path: [{ condition_id: 'cond_bbbbbbbb' }] }
    ],
    conditions: [condition('cond_aaaaaaaa', '[x]#{r1} > 1'), condition('cond_bbbbbbbb', '[y]#{r1} > 2')]
  };
}

describe('conditions 池随单事件保存往返', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listActionRegistry.mockResolvedValue({ data: { actions: [] } });
    listTemplateTables.mockResolvedValue({ data: { items: [] } });
    listTemplateFields.mockResolvedValue({ data: { items: [] } });
  });

  it('保存当前事件：本事件的条件回到池内（plan 透传），其它事件的条件原样保留', async () => {
    openActionDocument.mockResolvedValue({ data: { version_no: 7, actions: twoRootDocument() } });
    saveActionDocument.mockResolvedValue({ data: { version_no: 8 } });
    const controller = useActionDesigner({ scope, hostApi });
    await controller.load();
    expect(controller.events.value).toHaveLength(2);
    // 激活第一个事件（tb_a）并保存
    controller.activeEventId.value = controller.events.value[0].id;
    expect(await controller.saveActiveEvent()).toBe(true);

    const input = saveActionDocument.mock.calls[0][1] as { actions: ActionBehaviorDocument };
    const pool = input.actions.conditions ?? [];
    const ids = pool.map(c => c.condition_id).sort();
    expect(ids, '两个事件的条件都在池内').toEqual(['cond_aaaaaaaa', 'cond_bbbbbbbb']);
    expect(new Set(ids).size).toBe(ids.length);
    const a = pool.find(c => c.condition_id === 'cond_aaaaaaaa')!;
    expect(a.plan?.publication_id).toBe('pub_cond_aaaaaaaa');
    expect(a.document.expression.source_text).toBe('[x]#{r1} > 1');
    // guards 仍是 path 形态且引用得到池内条件
    const referenced = input.actions.guards.flatMap(g => (g.path ?? []).map(s => s.condition_id));
    for (const id of referenced) expect(ids).toContain(id);
  });

  it('文档无条件时保存产物不带 conditions 键', async () => {
    const doc = twoRootDocument();
    doc.action_groups = doc.action_groups.map(g => ({ group_id: g.group_id, ordered_node_ids: g.ordered_node_ids }));
    doc.guards = [];
    delete doc.conditions;
    openActionDocument.mockResolvedValue({ data: { version_no: 7, actions: doc } });
    saveActionDocument.mockResolvedValue({ data: { version_no: 8 } });
    const controller = useActionDesigner({ scope, hostApi });
    await controller.load();
    controller.activeEventId.value = controller.events.value[0].id;
    expect(await controller.saveActiveEvent()).toBe(true);
    const input = saveActionDocument.mock.calls[0][1] as { actions: ActionBehaviorDocument };
    expect('conditions' in input.actions).toBe(false);
  });
});
