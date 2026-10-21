import { beforeEach, describe, expect, it, vi } from 'vitest';

// 插件经 hostApi 注入面访问宿主（不直连宿主模块），本文件把用到的 5 个函数逐一对应到 ActionDesignerHostApi 的
// openActionDocument/saveActionDocument/listActionRegistry/listTemplateTables/listTemplateFields，
// 经 createFakeHostApi 的 overrides 直接注入 useActionDesigner（而非 vi.mock 模块）。
// scope.pluginId 未设置，loadSupportedTriggers 会提前返回、不调用
// hostApi.getSupportedTriggers，故无需为其单独打桩。
import type { ActionDesignerScope } from './hostTypes';
import type { ActionBehaviorDocument } from './bundle';
import { createFakeHostApi } from './__tests__/fakeHostApi';

const openActionDocument = vi.fn();
const saveActionDocument = vi.fn();
const listActionRegistry = vi.fn();
const listTemplateTables = vi.fn();
const listTemplateFields = vi.fn();

const hostApi = createFakeHostApi({
  openActionDocument,
  saveActionDocument,
  listActionRegistry,
  listTemplateTables,
  listTemplateFields
});

import { useActionDesigner } from './useActionDesigner';

const scope: ActionDesignerScope = {
  appId: 'app_i226',
  templateId: 'tpl_i226',
  templateVersionNo: '1.0',
  designerType: 'spreadsheet'
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

// 第二个事件用新键 'edit-after-save'——老 'before-save'/'after-save' 经
// openBundleToTrees 回读会被迁移拆成新建/编辑两档（见 compile.test.ts「流程步骤门编译/回读」
// 描述块的专门覆盖），本夹具测的是"旧格式合并 binding 重存时的 outcome 子图清理"，与保存键迁移
// 语义无关，沿用旧键会让多个既有断言（eventKeys 长度、binding_id 后缀）被迁移行为污染。
function legacyOutcomeDocument(): ActionBehaviorDocument {
  return {
    trigger_bindings: [
      {
        binding_id: 'tb_legacy',
        trigger_event_key: 'create-time',
        trigger_event_keys: ['create-time', 'edit-after-save'],
        scopes: ['form'],
        ordered_group_ids: ['tb_legacy_g1']
      }
    ],
    action_groups: [
      { group_id: 'tb_legacy_g1', ordered_node_ids: ['node_parent'] },
      { group_id: 'tb_legacy_g2', ordered_node_ids: ['node_child'] }
    ],
    action_nodes: [
      {
        node_id: 'node_parent',
        action_name: 'data.extract_record',
        params: {
          expression: {
            schema_version: 1,
            source: { tables: [], joins: [] },
            target: {
              target_template_id: 'tpl_i226',
              target_data_table_id: 'table_detail',
              outputs: []
            }
          }
        },
        outcome_continuation_group_ids: { filled: ['tb_legacy_g2'] }
      },
      { node_id: 'node_child', action_name: 'system.probe' }
    ],
    guards: []
  };
}

/**
 * 存量孤儿夹具：`tb_legacy_g9` / `orphan_node` 落在 tb_legacy 的命名空间里，却不被任何 binding 的
 * ordered_group_ids 引用，也不挂在任何节点的 children/续接/出口边上——即「可达遍历够不着」的残留。
 * 历史来源是 compile.ts 在「value-change/field-click 尚未选触发字段」时产组不产 binding（已治本）。
 * 它们能存进库（后端图校验只查引用完整性与无环，不拒孤儿），而旧的 removeRootFromDoc 只从 binding
 * 出发遍历，永远删不掉；下次保存追加同名组/同 id 节点，后端就判 duplicate 整份 400。
 */
function documentWithOrphans(): ActionBehaviorDocument {
  const doc = legacyOutcomeDocument();
  doc.action_groups.push({ group_id: 'tb_legacy_g9', ordered_node_ids: ['orphan_node'] });
  doc.action_nodes.push({ node_id: 'orphan_node', action_name: 'system.probe' });
  doc.guards.push({ guard_id: 'tb_legacy_gd9', condition: '' });
  return doc;
}

describe('useActionDesigner 单事件持久化迁移', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listActionRegistry.mockResolvedValue({ data: { actions: [] } });
    listTemplateTables.mockResolvedValue({
      data: {
        items: [
          {
            data_table_id: 'table_detail',
            table_code: 'detail',
            table_name: '明细',
            physical_table_name: 'detail',
            table_role: 'extension',
            extension_mode: 'detail',
            sort_no: 1,
            field_count: 0,
            version_no: 1
          }
        ]
      }
    });
    listTemplateFields.mockResolvedValue({ data: { items: [] } });
  });

  it('旧多事件 binding 重存时完整移除 outcome 子图，不产生重复 group/node', async () => {
    openActionDocument.mockResolvedValue({
      data: { version_no: 31, actions: legacyOutcomeDocument() }
    });
    saveActionDocument.mockResolvedValue({ data: { version_no: 32 } });

    const controller = useActionDesigner({ scope, hostApi });
    await controller.load();
    expect(controller.events.value).toHaveLength(1);
    expect(controller.events.value[0].eventKeys).toEqual(['create-time', 'edit-after-save']);
    expect(await controller.saveActiveEvent()).toBe(true);

    const input = saveActionDocument.mock.calls[0][1] as {
      actions: ActionBehaviorDocument;
      expectedVersionNo: number;
    };
    expect(input.expectedVersionNo).toBe(31);
    expect(input.actions.trigger_bindings.map(binding => binding.binding_id)).toEqual([
      'tb_legacy__create-time',
      'tb_legacy__edit-after-save'
    ]);
    const groupIds = input.actions.action_groups.map(group => group.group_id);
    const nodeIds = input.actions.action_nodes.map(node => node.node_id);
    expect(new Set(groupIds).size).toBe(groupIds.length);
    expect(new Set(nodeIds).size).toBe(nodeIds.length);
    expect(groupIds).toEqual(['tb_legacy_g2', 'tb_legacy_g1']);
    expect(nodeIds).toEqual(['node_child', 'node_parent']);
    const parent = input.actions.action_nodes.find(node => node.node_id === 'node_parent');
    const expression = parent?.params?.expression as
      | { target?: { target_table_role?: string } }
      | undefined;
    expect(expression?.target?.target_table_role).toBe('detail');
  });

  it('重存时连命名空间内的孤儿组/节点/guard 一并清扫（存量残留，可达遍历够不着）', async () => {
    openActionDocument.mockResolvedValue({
      data: { version_no: 31, actions: documentWithOrphans() }
    });
    saveActionDocument.mockResolvedValue({ data: { version_no: 32 } });

    const controller = useActionDesigner({ scope, hostApi });
    await controller.load();
    expect(await controller.saveActiveEvent()).toBe(true);

    const input = saveActionDocument.mock.calls[0][1] as { actions: ActionBehaviorDocument };
    const groupIds = input.actions.action_groups.map(group => group.group_id);
    const nodeIds = input.actions.action_nodes.map(node => node.node_id);
    // 孤儿被带走：留下来的都是本次编译重新产出的实体。
    expect(groupIds).not.toContain('tb_legacy_g9');
    expect(nodeIds).not.toContain('orphan_node');
    expect(input.actions.guards.map(guard => guard.guard_id)).not.toContain('tb_legacy_gd9');
    // 且不因清扫顺序产生任何重复（后端对 duplicate 一律整份拒绝保存）。
    expect(new Set(groupIds).size).toBe(groupIds.length);
    expect(new Set(nodeIds).size).toBe(nodeIds.length);
  });

  it('auth_ended scrub 清空动作文档、目录、字段与未保存树，不保留业务内容', async () => {
    openActionDocument.mockResolvedValue({
      data: {
        version_no: 31,
        actions: legacyOutcomeDocument(),
        unauthorized_source_apps: ['foreign-app']
      }
    });
    listActionRegistry.mockResolvedValue({ data: { actions: [{ name: 'system.probe' }] } });

    const controller = useActionDesigner({ scope, hostApi });
    await controller.load();
    const root = controller.root.value!;
    controller.applyDrop(
      { ownerId: root.id, index: root.children?.length ?? 0 },
      { kind: 'action', name: 'system.unsaved' }
    );
    expect(controller.dirty.value).toBe(true);

    controller.scrubSensitiveState();

    expect(controller.events.value).toEqual([]);
    expect(controller.registry.value).toEqual([]);
    expect(controller.tables.value).toEqual([]);
    expect(controller.fieldsByTable.value).toEqual({});
    expect(controller.unauthorizedSourceApps.value).toEqual([]);
    expect(controller.dirty.value).toBe(false);
    expect(controller.errorText.value).toBe('');
  });

  it('终态推进后丢弃在途 load 回填', async () => {
    const opened = deferred<{ data: { version_no: number; actions: ActionBehaviorDocument } }>();
    openActionDocument.mockReturnValue(opened.promise);
    const controller = useActionDesigner({ scope, hostApi });

    const loading = controller.load();
    await vi.waitFor(() => expect(openActionDocument).toHaveBeenCalledOnce());
    controller.scrubSensitiveState();
    opened.resolve({ data: { version_no: 41, actions: legacyOutcomeDocument() } });
    await loading;

    expect(controller.events.value).toEqual([]);
    expect(controller.tables.value).toEqual([]);
    expect(controller.loading.value).toBe(false);
  });

  it('终态推进后丢弃在途 save 回填，不接受返回的新版本基线', async () => {
    openActionDocument.mockResolvedValue({ data: { version_no: 31, actions: legacyOutcomeDocument() } });
    const saved = deferred<{ data: { version_no: number } }>();
    saveActionDocument.mockReturnValueOnce(saved.promise);
    const controller = useActionDesigner({ scope, hostApi });
    await controller.load();

    const firstSave = controller.saveActiveEvent();
    await vi.waitFor(() => expect(saveActionDocument).toHaveBeenCalledOnce());
    controller.invalidateAsyncBackfill();
    saved.resolve({ data: { version_no: 99 } });
    await expect(firstSave).resolves.toBe(false);

    saveActionDocument.mockResolvedValueOnce({ data: { version_no: 32 } });
    await expect(controller.saveActiveEvent()).resolves.toBe(true);
    expect(saveActionDocument.mock.calls[1][1].expectedVersionNo).toBe(31);
  });
});

describe('useActionDesigner 画布顺序 seq 持久化（取数「接收影响区间」第①段）', () => {
  function seqDocument(): ActionBehaviorDocument {
    const binding = (id: string, event: string, seq: number, group: string) => ({
      binding_id: id, trigger_event_key: event, trigger_event_keys: [event], scopes: ['form'], ordered_group_ids: [group], seq
    });
    return {
      // tb_b/tb_c 用新键 'edit-after-save'/'edit-before-save'——老 'after-save'/
      // 'before-save' 经 openBundleToTrees 回读会被迁移拆成两档，单事件根变多事件根，
      // 单事件保存也会因此拆成两条带后缀的 binding，破坏本组「单事件 = 单条 binding」的既有假设
      // （这层假设与保存键迁移无关，是 seq 持久化测试本身要的前提）。
      trigger_bindings: [
        binding('tb_a', 'manual', 1, 'tb_a_g1'),
        binding('tb_b', 'edit-after-save', 2, 'tb_b_g1'),
        binding('tb_c', 'edit-before-save', 3, 'tb_c_g1')
      ],
      action_groups: [
        { group_id: 'tb_a_g1', ordered_node_ids: ['n_a'] },
        { group_id: 'tb_b_g1', ordered_node_ids: ['n_b'] },
        { group_id: 'tb_c_g1', ordered_node_ids: ['n_c'] }
      ],
      action_nodes: [
        { node_id: 'n_a', action_name: 'system.probe' },
        { node_id: 'n_b', action_name: 'system.probe' },
        { node_id: 'n_c', action_name: 'system.probe' }
      ],
      guards: []
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    listActionRegistry.mockResolvedValue({ data: { actions: [] } });
    listTemplateTables.mockResolvedValue({ data: { items: [] } });
    listTemplateFields.mockResolvedValue({ data: { items: [] } });
  });

  it('打开按 seq 排序；上移第三个事件后重写全部 binding 的 seq（1 起连续）并保存', async () => {
    openActionDocument.mockResolvedValue({ data: { version_no: 7, actions: seqDocument() } });
    saveActionDocument.mockResolvedValue({ data: { version_no: 8 } });

    const controller = useActionDesigner({ scope, hostApi });
    await controller.load();
    expect(controller.events.value.map(e => e.bindingId)).toEqual(['tb_a', 'tb_b', 'tb_c']);

    expect(await controller.moveEvent(controller.events.value[2].id, -1)).toBe(true);
    expect(controller.events.value.map(e => e.bindingId)).toEqual(['tb_a', 'tb_c', 'tb_b']);

    const input = saveActionDocument.mock.calls[0][1] as { actions: ActionBehaviorDocument; expectedVersionNo: number };
    expect(input.expectedVersionNo).toBe(7);
    const seqById = Object.fromEntries(input.actions.trigger_bindings.map(b => [b.binding_id, b.seq]));
    expect(seqById).toEqual({ tb_a: 1, tb_c: 2, tb_b: 3 });
    // 其它实体不变
    expect(input.actions.action_groups.map(g => g.group_id)).toEqual(['tb_a_g1', 'tb_b_g1', 'tb_c_g1']);
  });

  it('单事件保存把该事件在列表中的下标写成 seq', async () => {
    openActionDocument.mockResolvedValue({ data: { version_no: 7, actions: seqDocument() } });
    saveActionDocument.mockResolvedValue({ data: { version_no: 8 } });

    const controller = useActionDesigner({ scope, hostApi });
    await controller.load();
    controller.setActiveEvent(controller.events.value[1].id);
    expect(await controller.saveActiveEvent()).toBe(true);

    const input = saveActionDocument.mock.calls[0][1] as { actions: ActionBehaviorDocument };
    const saved = input.actions.trigger_bindings.find(b => b.binding_id === 'tb_b');
    expect(saved?.seq).toBe(2);
    // 未被保存的其它事件的 seq 原样保留
    expect(input.actions.trigger_bindings.find(b => b.binding_id === 'tb_a')?.seq).toBe(1);
    expect(input.actions.trigger_bindings.find(b => b.binding_id === 'tb_c')?.seq).toBe(3);
  });
});

// 动作事件启用/停用：点击即落盘——已落盘事件切换后立刻写回文档，无需再点保存。
describe('useActionDesigner 动作事件启用/停用', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listActionRegistry.mockResolvedValue({ data: { actions: [] } });
    listTemplateTables.mockResolvedValue({ data: { items: [] } });
    listTemplateFields.mockResolvedValue({ data: { items: [] } });
  });

  it('已落盘事件停用：立刻保存，且该事件名下全部 binding 都写 disabled', async () => {
    // 多事件根 tb_legacy 拆产两条 binding（create-time / edit-after-save，用新键——见 legacyOutcomeDocument 头注释），停用要同时覆盖两条。
    openActionDocument.mockResolvedValue({ data: { version_no: 31, actions: legacyOutcomeDocument() } });
    saveActionDocument.mockResolvedValue({ data: { version_no: 32 } });

    const controller = useActionDesigner({ scope, hostApi });
    await controller.load();
    const eventId = controller.events.value[0].id;

    expect(await controller.toggleEventEnabled(eventId)).toBe(true);
    expect(controller.events.value[0].enabled).toBe(false);
    expect(saveActionDocument).toHaveBeenCalledOnce();
    const saved = saveActionDocument.mock.calls[0][1] as { actions: ActionBehaviorDocument };
    expect(saved.actions.trigger_bindings).toHaveLength(1);
    expect(saved.actions.trigger_bindings.every(b => b.disabled === true)).toBe(true);
    // 停用不改动文档其余内容：组与节点原样保留（重新启用即恢复，不需重配）。
    expect(saved.actions.action_groups.map(g => g.group_id)).toEqual(['tb_legacy_g1', 'tb_legacy_g2']);
    expect(saved.actions.action_nodes.map(n => n.node_id)).toEqual(['node_parent', 'node_child']);
  });

  it('重新启用：写盘的 binding 不得留下 disabled 键（零值会破坏宿主规范化校验和）', async () => {
    const disabledDoc = legacyOutcomeDocument();
    disabledDoc.trigger_bindings[0].disabled = true;
    openActionDocument.mockResolvedValue({ data: { version_no: 31, actions: disabledDoc } });
    saveActionDocument.mockResolvedValue({ data: { version_no: 32 } });

    const controller = useActionDesigner({ scope, hostApi });
    await controller.load();
    expect(controller.events.value[0].enabled).toBe(false);

    expect(await controller.toggleEventEnabled(controller.events.value[0].id)).toBe(true);
    const saved = saveActionDocument.mock.calls[0][1] as { actions: ActionBehaviorDocument };
    expect('disabled' in saved.actions.trigger_bindings[0]).toBe(false);
    expect(controller.events.value[0].enabled).toBe(true);
  });

  it('未落盘的新事件停用：只改内存并标脏，不发保存请求', async () => {
    openActionDocument.mockResolvedValue({ data: { version_no: 31, actions: legacyOutcomeDocument() } });
    const controller = useActionDesigner({ scope, hostApi });
    await controller.load();
    controller.addEvent({ eventKey: 'manual' });
    const fresh = controller.events.value[controller.events.value.length - 1];

    expect(await controller.toggleEventEnabled(fresh.id)).toBe(false);
    expect(fresh.enabled).toBe(false);
    expect(saveActionDocument).not.toHaveBeenCalled();
    expect(controller.dirtyEventIds.value.has(fresh.id)).toBe(true);
  });
});

// 第三方数据动作：保存链路按数据动作种类识别写节点，
// 保存闸 DATA_ACTION_KIND_UNRESOLVED 直接展示后端 message 并定位节点。
describe('useActionDesigner 第三方数据动作保存', () => {
  function thirdPartyWriteDocument(): ActionBehaviorDocument {
    return {
      trigger_bindings: [
        {
          binding_id: 'tb_bs',
          trigger_event_key: 'create-before-save',
          trigger_event_keys: ['create-before-save'],
          scopes: ['form'],
          ordered_group_ids: ['tb_bs_g1']
        }
      ],
      action_groups: [{ group_id: 'tb_bs_g1', ordered_node_ids: ['n_tp'] }],
      action_nodes: [{ node_id: 'n_tp', action_name: 'org.example.data-actions.close', async: true }],
      guards: []
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    listTemplateTables.mockResolvedValue({ data: { items: [] } });
    listTemplateFields.mockResolvedValue({ data: { items: [] } });
    openActionDocument.mockResolvedValue({ data: { version_no: 5, actions: thirdPartyWriteDocument() } });
  });

  it('动作目录声明 operation_kind=update 的第三方写节点在保存前根下被强制同步', async () => {
    listActionRegistry.mockResolvedValue({
      data: { actions: [{ name: 'org.example.data-actions.close', title: '关闭订单', source: 'plugin', operation_kind: 'update', capabilities: {} }] }
    });
    saveActionDocument.mockResolvedValue({ data: { version_no: 6 } });
    const controller = useActionDesigner({ scope, hostApi });
    await controller.load();
    expect(await controller.saveActiveEvent()).toBe(true);
    const input = saveActionDocument.mock.calls[0][1] as { actions: ActionBehaviorDocument };
    expect(input.actions.action_nodes.find(n => n.node_id === 'n_tp')?.async).toBeUndefined();
  });

  it('动作目录未声明种类的同名动作不强制同步（不按名字猜）', async () => {
    listActionRegistry.mockResolvedValue({
      data: { actions: [{ name: 'org.example.data-actions.close', title: '关闭订单', source: 'plugin', capabilities: {} }] }
    });
    saveActionDocument.mockResolvedValue({ data: { version_no: 6 } });
    const controller = useActionDesigner({ scope, hostApi });
    await controller.load();
    expect(await controller.saveActiveEvent()).toBe(true);
    const input = saveActionDocument.mock.calls[0][1] as { actions: ActionBehaviorDocument };
    expect(input.actions.action_nodes.find(n => n.node_id === 'n_tp')?.async).toBe(true);
  });

  it('保存被 DATA_ACTION_KIND_UNRESOLVED 拒绝：展示后端 message，并选中出错节点', async () => {
    listActionRegistry.mockResolvedValue({ data: { actions: [] } });
    const message = '动作节点 关闭订单 引用的数据动作 org.example.data-actions.close 未被任何已安装插件声明';
    saveActionDocument.mockResolvedValue({
      data: undefined,
      error: { code: 'DATA_ACTION_KIND_UNRESOLVED', message, params: { node_id: 'n_tp', node: '关闭订单', action: 'org.example.data-actions.close' } }
    });
    const controller = useActionDesigner({ scope, hostApi });
    await controller.load();
    expect(await controller.saveActiveEvent()).toBe(false);
    expect(controller.errorText.value).toBe(message);
    expect(controller.selectedId.value).toBe('n_tp');
    expect(controller.saveErrorNodeId.value).toBe('n_tp');
  });

  it('旧宿主透传请求库错误对象时也取后端信封里的 message 与 node_id', async () => {
    listActionRegistry.mockResolvedValue({ data: { actions: [] } });
    saveActionDocument.mockResolvedValue({
      data: undefined,
      error: {
        message: 'Request failed with status code 400',
        response: { data: { error: { code: 'DATA_ACTION_KIND_UNRESOLVED', message: 'Node close: unresolved', params: { node_id: 'n_tp' } } } }
      }
    });
    const controller = useActionDesigner({ scope, hostApi });
    await controller.load();
    expect(await controller.saveActiveEvent()).toBe(false);
    expect(controller.errorText.value).toBe('Node close: unresolved');
    expect(controller.saveErrorNodeId.value).toBe('n_tp');
  });
});
