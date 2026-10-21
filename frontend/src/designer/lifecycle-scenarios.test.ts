import { describe, expect, it } from 'vitest';

// scope 类型用插件本地 hostTypes.ts 的 ActionDesignerScope；useActionDesigner 必传 hostApi，本文件唯一一处调用（参数编辑用例）
// 只走画布拓扑相关方法（selectNode/updateSelected/deleteSelected），不触发 .load()/
// .saveActiveEvent()，用 createFakeHostApi() 的默认全空桩即可。
import { createFakeHostApi } from './__tests__/fakeHostApi';
import type { ActionDesignerScope } from './hostTypes';
import { compileEventsToBundle, compileMindmapToBundle, openBundleToTrees } from './compile';
import { createActionNode, createConditionNode, createTriggerRoot } from './model';
import { useActionDesigner } from './useActionDesigner';

const scope: ActionDesignerScope = {
  appId: 'lifecycle-app',
  templateId: 'purchase-order',
  templateVersionNo: '1.0',
  designerType: 'spreadsheet'
};

describe('典型业务生命周期的动作设计态行为', () => {
  it('字段变更取数与保存后写回+提示编译为互相隔离的真实事件绑定', () => {
    const supplierChanged = createTriggerRoot({
      eventKey: 'value-change',
      eventFieldIds: { 'value-change': ['supplier_id'] },
      children: [
        createActionNode({
          id: 'extract-price',
          actionName: 'data.extract_record',
          params: {
            expression: { schema_version: 1 },
            target_data_table_id: 'purchase_main',
            outputs: [{ target_field_id: 'unit_price' }]
          }
        })
      ]
    });
    // 用新键 'edit-after-save'（老 'after-save' 经 openBundleToTrees 回读会被迁移为
    // 新建/编辑两档，eventKey 不再是 'after-save' 字面量，下方 find(... === 'after-save') 会落空——
    // 本用例测的是「保存后事件的结构可逆」，不是迁移语义本身，用新键规避这层干扰）。
    const saved = createTriggerRoot({
      eventKey: 'edit-after-save',
      children: [
        createActionNode({
          id: 'write-total',
          actionName: 'data.update_record',
          params: { expression: { schema_version: 1, target_template_id: 'supplier_statistics' } }
        }),
        createActionNode({
          id: 'show-success',
          actionName: 'ui.message',
          params: { level: 'success', text: '保存成功' }
        })
      ]
    });

    const bundle = compileEventsToBundle([supplierChanged, saved]);
    const valueBinding = bundle.trigger_bindings.find(binding => binding.trigger_event_key === 'value-change');
    const afterSaveBinding = bundle.trigger_bindings.find(binding => binding.trigger_event_key === 'edit-after-save');
    expect(valueBinding?.scopes).toEqual(['field:supplier_id']);
    expect(afterSaveBinding?.scopes).toEqual(['form']);

    const groupById = new Map(bundle.action_groups.map(group => [group.group_id, group]));
    expect(valueBinding?.ordered_group_ids.flatMap(id => groupById.get(id)?.ordered_node_ids ?? [])).toEqual(['extract-price']);
    expect(afterSaveBinding?.ordered_group_ids.flatMap(id => groupById.get(id)?.ordered_node_ids ?? [])).toEqual([
      'write-total',
      'show-success'
    ]);

    const reopened = openBundleToTrees(bundle);
    expect(reopened.find(root => root.eventKey === 'value-change')?.children?.[0].params).toEqual(
      supplierChanged.children?.[0].params
    );
    expect(reopened.find(root => root.eventKey === 'edit-after-save')?.children?.map(node => node.actionName)).toEqual([
      'data.update_record',
      'ui.message'
    ]);
  });

  it('金额条件 A/B 二选一，且命中分支内的一层子流程结构可逆', () => {
    const branch = createConditionNode({
      condition: { fieldId: 'amount', op: '>', value: 10_000 },
      thenChildren: [
        {
          ...createActionNode({ id: 'route-a', actionName: 'ui.message', params: { level: 'warning', text: 'A' } }),
          children: [createActionNode({ id: 'route-a-child', actionName: 'workflow.start', params: { workflow_id: 'approval-a' } })]
        }
      ],
      elseChildren: [
        {
          ...createActionNode({ id: 'route-b', actionName: 'ui.message', params: { level: 'info', text: 'B' } }),
          children: [createActionNode({ id: 'route-b-child', actionName: 'workflow.start', params: { workflow_id: 'approval-b' } })]
        }
      ]
    });
    const root = createTriggerRoot({ eventKey: 'before-save', children: [branch] });
    const bundle = compileMindmapToBundle(root);

    const guardById = new Map(bundle.guards.map(guard => [guard.guard_id, guard.condition]));
    const guardedGroups = bundle.action_groups.map(group => ({
      nodes: group.ordered_node_ids,
      guard: group.group_guard_id ? guardById.get(group.group_guard_id) : undefined
    }));
    expect(guardedGroups).toEqual([
      { nodes: ['route-a'], guard: '{{field:amount}} > 10000' },
      { nodes: ['route-b'], guard: '{{field:amount}} <= 10000' }
    ]);
    expect(bundle.action_nodes.find(node => node.node_id === 'route-a')?.children_node_ids).toEqual(['route-a-child']);
    expect(bundle.action_nodes.find(node => node.node_id === 'route-b')?.children_node_ids).toEqual(['route-b-child']);

    const reopened = openBundleToTrees(bundle)[0];
    const reopenedBranch = reopened.children?.[0];
    if (!reopenedBranch) {
      throw new Error('reopened condition branch is missing');
    }
    expect(reopenedBranch.kind).toBe('condition');
    expect(reopenedBranch.thenChildren?.[0].children?.[0].actionName).toBe('workflow.start');
    expect(reopenedBranch.elseChildren?.[0].children?.[0].actionName).toBe('workflow.start');
  });

  it('同一事件的节点顺序与同步/异步标志在保存回显后保持确定', () => {
    const root = createTriggerRoot({
      eventKey: 'manual',
      children: [
        createActionNode({ id: 'sync-first', actionName: 'data.sort_detail', async: false }),
        createActionNode({ id: 'async-second', actionName: 'ui.message', async: true, params: { text: 'done' } })
      ]
    });
    const bundle = compileMindmapToBundle(root);
    expect(bundle.action_groups[0].ordered_node_ids).toEqual(['sync-first', 'async-second']);
    expect(bundle.action_nodes.find(node => node.node_id === 'sync-first')?.async).toBeUndefined();
    expect(bundle.action_nodes.find(node => node.node_id === 'async-second')?.async).toBe(true);

    const reopened = openBundleToTrees(bundle)[0];
    expect(reopened.children?.map(node => `${node.id}:${node.async === true ? 'async' : 'sync'}`)).toEqual([
      'sync-first:sync',
      'async-second:async'
    ]);
  });

  it('参数编辑可保存回显；删除节点后模型与编译产物同步移除', () => {
    const controller = useActionDesigner({ scope, hostApi: createFakeHostApi() });
    const action = createActionNode({
      id: 'editable-message',
      actionName: 'ui.message',
      params: { level: 'info', text: 'old' }
    });
    const root = createTriggerRoot({ eventKey: 'after-save', children: [action] });
    controller.events.value = [root];
    controller.activeEventId.value = root.id;
    controller.selectNode(action.id);
    controller.updateSelected({ params: { level: 'success', text: '保存成功' } });

    let bundle = compileMindmapToBundle(root);
    expect(openBundleToTrees(bundle)[0].children?.[0].params).toEqual({ level: 'success', text: '保存成功' });

    controller.deleteSelected();
    expect(root.children).toEqual([]);
    bundle = compileMindmapToBundle(root);
    expect(bundle.action_nodes).toEqual([]);
    expect(bundle.action_groups).toEqual([]);
  });
});
