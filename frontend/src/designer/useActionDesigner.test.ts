import { describe, expect, it, vi } from 'vitest';

// scope 类型取插件本地 hostTypes.ts 的声明；useActionDesigner 要求必传 hostApi——本文件除
// supportedTriggers 一组外只走画布拓扑/多事件相关方法，不触发 .load()/.saveActiveEvent()，用
// createFakeHostApi() 的默认全空桩即可，不影响任何断言。
import { createFakeHostApi } from './__tests__/fakeHostApi';
import type { ActionDesignerScope, TemplateDataTable, TemplateField } from './hostTypes';
import { createActionNode, createConditionNode, createTriggerRoot } from './model';
import type { MindNode } from './model';
import { useActionDesigner } from './useActionDesigner';

const scope: ActionDesignerScope = {
  appId: 'app_1',
  templateId: 'tpl_1',
  templateVersionNo: '1.0',
  designerType: 'spreadsheet'
};

// 空白起步：设计器不再自动种事件，测试显式装配一个当前事件树。返回 ctrl 与该 root（root 即 ctrl.root.value）。
function setup(children: MindNode[]): { ctrl: ReturnType<typeof useActionDesigner>; root: MindNode } {
  const ctrl = useActionDesigner({ scope, hostApi: createFakeHostApi() });
  // D2：root 现为 activeRoot 的只读别名，改经 events/activeEventId 设置当前事件树。
  const root = createTriggerRoot({ eventKey: 'manual', scope: 'form', children });
  ctrl.events.value = [root];
  ctrl.activeEventId.value = root.id;
  return { ctrl, root };
}

describe('useActionDesigner drop / move', () => {
  it('inserts an action at a specific index (between siblings)', () => {
    const { ctrl, root } = setup([createActionNode({ id: 'a1', actionName: 'x' }), createActionNode({ id: 'a2', actionName: 'y' })]);
    // 插到 a1 与 a2 之间（动作索引 1）→ [a1, new, a2]
    ctrl.applyDrop({ ownerId: root.id, index: 1 }, { kind: 'action', name: 'system.probe' });
    const ids = (root.children ?? []).map(n => n.id);
    expect(ids.length).toBe(3);
    expect(ids[0]).toBe('a1');
    expect(ids[2]).toBe('a2');
  });

  it('reparents an existing node into a condition then-branch', () => {
    const cond = createConditionNode({ condition: { fieldId: 'f', op: '>', value: 0 }, thenChildren: [], elseChildren: [] });
    const { ctrl, root } = setup([createActionNode({ id: 'a1', actionName: 'x' }), cond]);
    ctrl.applyDrop({ ownerId: cond.id, branch: 'then', index: 0 }, { kind: 'move', nodeId: 'a1' });
    expect((root.children ?? []).map(n => n.id)).toEqual([cond.id]);
    expect((cond.thenChildren ?? []).map(n => n.id)).toEqual(['a1']);
  });

  it('prevents dropping a node into its own subtree (cycle)', () => {
    const cond = createConditionNode({ condition: { fieldId: 'f', op: '>', value: 0 }, thenChildren: [], elseChildren: [] });
    const { ctrl, root } = setup([cond]);
    ctrl.applyDrop({ ownerId: cond.id, branch: 'then', index: 0 }, { kind: 'move', nodeId: cond.id });
    // cond stays at root, not moved into itself.
    expect((root.children ?? []).map(n => n.id)).toEqual([cond.id]);
    expect((cond.thenChildren ?? []).length).toBe(0);
  });

  it('在末尾依次插入条件 → 多个同级顺序条件（末尾无后续，不吸收，成立分支为空）', () => {
    const { ctrl, root } = setup([createActionNode({ id: 'a', actionName: 'x' })]);
    // 在末尾插入两个条件（每次 index = 当前长度，其后无成员）。
    ctrl.applyDrop({ ownerId: root.id, index: 1 }, { kind: 'condition' });
    const len = (root.children ?? []).length;
    ctrl.applyDrop({ ownerId: root.id, index: len }, { kind: 'condition' });
    const band = root.children ?? [];
    expect(band.filter(n => n.kind === 'condition').length).toBe(2);
    for (const c of band.filter(n => n.kind === 'condition')) expect((c.thenChildren ?? []).length).toBe(0);
  });

  it('在中间插入条件 → 落点之后的所有节点移入「成立」分支', () => {
    const { ctrl, root } = setup([
      createActionNode({ id: 'a', actionName: 'x' }),
      createActionNode({ id: 'b', actionName: 'y' }),
      createActionNode({ id: 'c', actionName: 'z' })
    ]);
    // 在 a 之后(index 1)插入条件 → b、c 移入成立分支，根 band = [a, 条件]。
    ctrl.applyDrop({ ownerId: root.id, index: 1 }, { kind: 'condition' });
    const band = root.children ?? [];
    expect(band.map(n => (n.kind === 'condition' ? 'cond' : n.id))).toEqual(['a', 'cond']);
    const cond = band.find(n => n.kind === 'condition')!;
    expect((cond.thenChildren ?? []).map(n => n.id)).toEqual(['b', 'c']);
    expect((cond.elseChildren ?? []).length).toBe(0);
  });

  it('在头部插入条件 → 整段流程移入「成立」分支', () => {
    const { ctrl, root } = setup([createActionNode({ id: 'a', actionName: 'x' }), createActionNode({ id: 'b', actionName: 'y' })]);
    ctrl.applyDrop({ ownerId: root.id, index: 0 }, { kind: 'condition' });
    const band = root.children ?? [];
    expect(band.length).toBe(1);
    expect(band[0].kind).toBe('condition');
    expect((band[0].thenChildren ?? []).map(n => n.id)).toEqual(['a', 'b']);
  });

  it('条件可放入动作子流程（动作右侧续接条件分支）', () => {
    const a = createActionNode({ id: 'a1', actionName: 'x' });
    const { ctrl } = setup([a]);
    // 向动作 a 的子流程放条件 → 进 a.children（编译为 a 的续接组）。
    ctrl.applyDrop({ ownerId: a.id, index: 0 }, { kind: 'condition' });
    expect((a.children ?? []).length).toBe(1);
    expect(a.children?.[0].kind).toBe('condition');
  });
});

describe('useActionDesigner 动作子流程 (向右挂载嵌套子节点)', () => {
  it('动作可向右挂载子动作（owner 为动作 → 进 action.children）', () => {
    const parent = createActionNode({ id: 'p', actionName: 'x' });
    const { ctrl, root } = setup([parent]);
    ctrl.applyDrop({ ownerId: parent.id, index: 0 }, { kind: 'action', name: 'system.probe' });
    expect((parent.children ?? []).length).toBe(1);
    expect(parent.children?.[0].kind).toBe('action');
    // 顶层 band 仍只有父节点。
    expect((root.children ?? []).map(n => n.id)).toEqual(['p']);
  });

  it('条件可拖进动作子流程（动作右侧续接条件分支）', () => {
    const parent = createActionNode({ id: 'p', actionName: 'x' });
    const { ctrl } = setup([parent]);
    ctrl.applyDrop({ ownerId: parent.id, index: 0 }, { kind: 'condition' });
    expect((parent.children ?? []).length).toBe(1);
    expect(parent.children?.[0].kind).toBe('condition');
  });

  it('已有条件可被移动进动作子流程', () => {
    const parent = createActionNode({ id: 'p', actionName: 'x' });
    const cond = createConditionNode({ condition: { fieldId: 'f', op: '>', value: 0 } });
    const { ctrl, root } = setup([parent, cond]);
    ctrl.applyDrop({ ownerId: parent.id, index: 0 }, { kind: 'move', nodeId: cond.id });
    // 条件移入父的子流程；顶层 band 不再含该条件。
    expect((parent.children ?? []).some(n => n.id === cond.id)).toBe(true);
    expect((root.children ?? []).some(n => n.id === cond.id)).toBe(false);
  });
});

describe('useActionDesigner 出口分支 (R5)', () => {
  it('outcomesOf 从注册中心 params_schema.x-outcomes 读出出口 key 集合；未声明/未登记回落空数组', () => {
    const ctrl = useActionDesigner({ scope, hostApi: createFakeHostApi() });
    ctrl.registry.value = [
      { name: 'ui.open_form', title: '打开表单', params_schema: { 'x-outcomes': ['hit', 'miss'] } } as any,
      { name: 'get-value', title: '取值' } as any
    ];
    expect(ctrl.outcomesOf('ui.open_form')).toEqual(['hit', 'miss']);
    expect(ctrl.outcomesOf('get-value')).toEqual([]);
    expect(ctrl.outcomesOf(undefined)).toEqual([]);
  });

  it('落点带 branch(出口 key) 时惰性挂进动作节点的 outcomeChildren，不污染普通续接 children', () => {
    const probe = createActionNode({ id: 'n_probe', actionName: 'ui.open_form' });
    const { ctrl } = setup([probe]);
    ctrl.applyDrop({ ownerId: probe.id, branch: 'hit', index: 0 }, { kind: 'action', name: 'system.probe' });
    expect(probe.outcomeChildren?.hit?.length).toBe(1);
    expect(probe.outcomeChildren?.hit?.[0].actionName).toBe('system.probe');
    expect(probe.children ?? []).toEqual([]);
  });

  it('可将条件节点拖入出口分支 band（与普通 band 同规则）', () => {
    const probe = createActionNode({ id: 'n_probe', actionName: 'ui.open_form' });
    const { ctrl } = setup([probe]);
    ctrl.applyDrop({ ownerId: probe.id, branch: 'miss', index: 0 }, { kind: 'condition' });
    expect(probe.outcomeChildren?.miss?.[0].kind).toBe('condition');
  });

  it('已有节点可在两个出口 band 之间移动（reparent）', () => {
    const probe = createActionNode({ id: 'n_probe', actionName: 'ui.open_form' });
    probe.outcomeChildren = { hit: [createActionNode({ id: 'n_hit', actionName: 'a' })], miss: [] };
    const { ctrl } = setup([probe]);
    ctrl.applyDrop({ ownerId: probe.id, branch: 'miss', index: 0 }, { kind: 'move', nodeId: 'n_hit' });
    expect(probe.outcomeChildren?.hit ?? []).toEqual([]);
    expect(probe.outcomeChildren?.miss?.map(n => n.id)).toEqual(['n_hit']);
  });

  it('环路防护覆盖 outcomeChildren：不能把出口节点移入自身出口分支后代', () => {
    const probe = createActionNode({ id: 'n_probe', actionName: 'ui.open_form' });
    probe.outcomeChildren = { hit: [createActionNode({ id: 'n_hit', actionName: 'a' })], miss: [] };
    const { ctrl, root } = setup([probe]);
    ctrl.applyDrop({ ownerId: 'n_hit', index: 0 }, { kind: 'move', nodeId: probe.id });
    // probe 仍留在根 band，未被移入自己出口分支的后代（会成环）。
    expect((root.children ?? []).map(n => n.id)).toEqual([probe.id]);
  });
});

describe('useActionDesigner 多动作事件 (D2)', () => {
  it('空白起步：初始无动作事件，root 为 null', () => {
    const ctrl = useActionDesigner({ scope, hostApi: createFakeHostApi() });
    expect(ctrl.events.value.length).toBe(0);
    expect(ctrl.root.value).toBeNull();
    expect(ctrl.activeEventId.value).toBe('');
  });

  it('addEvent 从空白新增首个事件并切为当前；root 随之指向新事件', () => {
    const ctrl = useActionDesigner({ scope, hostApi: createFakeHostApi() });
    const created = ctrl.addEvent({ eventKey: 'before-save', scope: 'form' });
    expect(created).toBe(true);
    expect(ctrl.events.value.length).toBe(1);
    expect(ctrl.root.value?.eventKey).toBe('before-save');
    expect(ctrl.activeEventId.value).toBe(ctrl.root.value?.id);
  });

  it('允许同类型多个事件：addEvent 同 eventKey 也新增（各自稳定 bindingId）', () => {
    const ctrl = useActionDesigner({ scope, hostApi: createFakeHostApi() });
    ctrl.addEvent({ eventKey: 'manual' });
    ctrl.addEvent({ eventKey: 'manual' });
    expect(ctrl.events.value.filter(e => e.eventKey === 'manual').length).toBe(2);
    // 每个事件都有稳定且唯一的 bindingId。
    const ids = ctrl.events.value.map(e => e.bindingId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every(Boolean)).toBe(true);
  });

  it('重命名：renameEvent 设置自定义名，空名回落（清空 name）', () => {
    const ctrl = useActionDesigner({ scope, hostApi: createFakeHostApi() });
    ctrl.addEvent({ eventKey: 'manual' });
    const id = ctrl.activeEventId.value;
    ctrl.renameEvent(id, '  提交按钮  ');
    expect(ctrl.events.value.find(e => e.id === id)?.name).toBe('提交按钮');
    ctrl.renameEvent(id, '   ');
    expect(ctrl.events.value.find(e => e.id === id)?.name).toBeUndefined();
  });

  it('removeEvent 可删到 0（回到空白态）；删当前则切到相邻', () => {
    const ctrl = useActionDesigner({ scope, hostApi: createFakeHostApi() });
    ctrl.addEvent({ eventKey: 'manual' });
    ctrl.addEvent({ eventKey: 'before-save', scope: 'form' });
    const second = ctrl.activeEventId.value;
    ctrl.removeEvent(second);
    expect(ctrl.events.value.length).toBe(1);
    expect(ctrl.events.value.some(e => e.id === second)).toBe(false);
    // 删除最后一个事件 → 回到空白态（events 为空、root 为 null）。
    const last = ctrl.events.value[0].id;
    ctrl.removeEvent(last);
    expect(ctrl.events.value.length).toBe(0);
    expect(ctrl.root.value).toBeNull();
  });

  it('多事件各自独立编排，互不串扰', () => {
    const ctrl = useActionDesigner({ scope, hostApi: createFakeHostApi() });
    ctrl.addEvent({ eventKey: 'manual' });
    const firstId = ctrl.activeEventId.value;
    ctrl.applyDrop({ ownerId: ctrl.root.value!.id, index: 0 }, { kind: 'action', name: 'system.probe' });
    expect(ctrl.root.value?.children?.length).toBe(1);
    ctrl.addEvent({ eventKey: 'before-save', scope: 'form' });
    // 新事件为空。
    expect(ctrl.root.value?.children?.length ?? 0).toBe(0);
    // 切回第一个事件，编排仍在。
    ctrl.setActiveEvent(firstId);
    expect(ctrl.root.value?.children?.length).toBe(1);
  });
});

// 条件分支（guard）字段候选收窄到主表——guardFields 必须在 allFields 拍平之前
// 按 tableRoleOf 过滤（tables/fieldsByTable 均为 useActionDesigner 暴露的原始 shallowRef，测试直接
// 装配二者，等价于 load() 拉取完成后的状态，无需真的打桩 hostApi.listTemplateTables/listTemplateFields）。
describe('useActionDesigner guardFields（条件分支字段候选只含主表）', () => {
  const mainTable: TemplateDataTable = {
    data_table_id: 't_main',
    table_code: 'main',
    table_name: '主表',
    physical_table_name: 'p_main',
    table_role: 'main',
    sort_no: 0,
    field_count: 1,
    version_no: 1
  };
  const extTable: TemplateDataTable = {
    data_table_id: 't_ext',
    table_code: 'ext',
    table_name: '明细表',
    physical_table_name: 'p_ext',
    table_role: 'extension',
    sort_no: 1,
    field_count: 1,
    version_no: 1
  };
  const mainField: TemplateField = {
    field_id: 'f_main',
    field_code: 'f_main',
    field_name: '主表字段',
    data_type: 'text',
    display_style: 'input',
    sort_no: 0,
    is_searchable: false,
    is_filterable: false,
    is_sortable: false,
    is_list_visible: true
  };
  const extField: TemplateField = {
    field_id: 'f_ext',
    field_code: 'f_ext',
    field_name: '明细字段',
    data_type: 'text',
    display_style: 'input',
    sort_no: 0,
    is_searchable: false,
    is_filterable: false,
    is_sortable: false,
    is_list_visible: true
  };

  it('guardFields 只含主表字段；allFields（触发字段候选源）不受影响仍含扩展表字段', () => {
    const ctrl = useActionDesigner({ scope, hostApi: createFakeHostApi() });
    ctrl.tables.value = [mainTable, extTable];
    ctrl.fieldsByTable.value = { t_main: [mainField], t_ext: [extField] };

    expect(ctrl.guardFields.value.map(f => f.field_id)).toEqual(['f_main']);
    // 反向判据：allFields 是触发字段（值变化/点击）多选的候选源，收窄不应波及它。
    expect(ctrl.allFields.value.map(f => f.field_id).sort()).toEqual(['f_ext', 'f_main']);
  });

  it('新建条件节点（addCondition）不再种默认字段：种空的 V4 判断表达式（旧式 condition 会被配置页判成「旧格式」）', () => {
    const ctrl = useActionDesigner({ scope, hostApi: createFakeHostApi() });
    ctrl.tables.value = [extTable, mainTable];
    ctrl.fieldsByTable.value = { t_main: [mainField], t_ext: [extField] };
    ctrl.addEvent({ eventKey: 'manual' });
    ctrl.addCondition();
    const cond = ctrl.root.value?.children?.[0];
    expect(cond?.kind).toBe('condition');
    expect(cond?.condition).toBeUndefined();
    expect(cond?.guardSpec?.v4?.expression.source_text).toBe('');
    expect(cond?.guardSpec?.v4?.expression.purpose).toBe('condition');
  });

  it('仅后端未下发 table_role 时才回落 sort_no 最小者为主表（与 tableRoleOf 权威口径一致）', () => {
    const ctrl = useActionDesigner({ scope, hostApi: createFakeHostApi() });
    const noRoleMain: TemplateDataTable = { ...mainTable, table_role: undefined, sort_no: 0 };
    const noRoleExt: TemplateDataTable = { ...extTable, table_role: undefined, sort_no: 1 };
    ctrl.tables.value = [noRoleMain, noRoleExt];
    ctrl.fieldsByTable.value = { t_main: [mainField], t_ext: [extField] };
    expect(ctrl.guardFields.value.map(f => f.field_id)).toEqual(['f_main']);
  });
});

// supportedTriggers 的记录页事件（before-delete/after-delete）并集规则——
// 「（载体声明 ∩ 全集）∪ 记录页事件」，且仅模板模式；job 模式恒排除。与本文件其余用例不同，
// 这组用例需要真实触发 loadSupportedTriggers（未对外暴露、只能经 ctrl.load() 间接驱动），
// 为验证交集/并集逻辑，这条路径无法绕开。
describe('useActionDesigner supportedTriggers（记录页事件载体无关并集 + job 模式排除）', () => {
  // 模拟渲染载体 manifest 的 capabilities.runtimeActionCapabilities.supportedTriggers 只声明 8 个既有
  // 触发点（不含 scheduled/记录页事件/四档保存新键），即"载体尚未声明新事件"的情形。
  const DECLARED_8 = ['value-change', 'field-click', 'manual', 'before-save', 'after-save', 'create-time', 'edit-time', 'view-time'];

  it('模板模式：载体只声明 8 个既有触发点时，supportedTriggers 仍并集含 before-delete/after-delete（记录页事件与渲染载体无关，恒可见）+ 老保存键兼容映射为四档新键', async () => {
    const ctrl = useActionDesigner({
      scope: { ...scope, pluginId: 'example-sheet-carrier' },
      hostApi: createFakeHostApi({ getSupportedTriggers: vi.fn().mockResolvedValue(DECLARED_8) })
    });
    await ctrl.load();
    // 交集运算使用 SELECTABLE_TRIGGER_EVENT_KEYS——载体声明里的老保存键 before-save/
    // after-save 本身不经交集漏回可选事件集（只保留读兼容）；但做"老键兼容"——声明了
    // before-save 视同声明 create-before-save + edit-before-save，声明了 after-save 视同声明
    // create-after-save + edit-after-save，故这四档新键随之补入，保存类事件不会因载体 manifest
    // 未及时跟进新四档声明而整组消失。
    expect(new Set(ctrl.supportedTriggers.value)).toEqual(
      new Set([
        ...DECLARED_8.filter(key => key !== 'before-save' && key !== 'after-save'),
        'create-before-save',
        'create-after-save',
        'edit-before-save',
        'edit-after-save',
        'before-delete',
        'after-delete'
      ])
    );
    expect(ctrl.supportedTriggers.value).not.toContain('before-save');
    expect(ctrl.supportedTriggers.value).not.toContain('after-save');
    // scheduled 不在载体声明里、也不属于记录页事件的恒定并集，交集运算天然排除。
    expect(ctrl.supportedTriggers.value).not.toContain('scheduled');
  });

  it('载体老键兼容仅单向映射所声明的那一档：只声明 before-save 时只补前保存两档，不补后保存、不补 handle-time', async () => {
    const ctrl = useActionDesigner({
      scope: { ...scope, pluginId: 'example-sheet-carrier' },
      hostApi: createFakeHostApi({ getSupportedTriggers: vi.fn().mockResolvedValue(['manual', 'before-save']) })
    });
    await ctrl.load();
    expect(ctrl.supportedTriggers.value).toContain('create-before-save');
    expect(ctrl.supportedTriggers.value).toContain('edit-before-save');
    expect(ctrl.supportedTriggers.value).not.toContain('create-after-save');
    expect(ctrl.supportedTriggers.value).not.toContain('edit-after-save');
    // handle-time 与老键无对应关系，不做任何映射，必须由载体显式声明。
    expect(ctrl.supportedTriggers.value).not.toContain('handle-time');
  });

  it('job 模式：supportedTriggers 不含记录页事件（定时任务没有"记录删除"语义）', () => {
    // job 模式下 loadSupportedTriggers 对 kind==='job' 早退，构造完成时的初值
    // （defaultSupportedTriggers()）即为该会话生命周期内的定值，无需 .load() 也可断言。
    const ctrl = useActionDesigner({ kind: 'job', appId: 'app_1', jobId: 'job_1', hostApi: createFakeHostApi() });
    expect(ctrl.supportedTriggers.value).not.toContain('before-delete');
    expect(ctrl.supportedTriggers.value).not.toContain('after-delete');
    // 本用例只锁记录页事件的排除；job 模式其余事件（含 scheduled）仍保留全量。
    expect(ctrl.supportedTriggers.value).toContain('scheduled');
  });
});

describe('useActionDesigner moveEvent（画布顺序 = 同一触发下多动作执行顺序）', () => {
  function threeEventsCtrl() {
    const ctrl = useActionDesigner({ scope, hostApi: createFakeHostApi() });
    const a = createTriggerRoot({ eventKey: 'manual', scope: 'form', children: [] });
    const b = createTriggerRoot({ eventKey: 'after-save', scope: 'form', children: [] });
    const c = createTriggerRoot({ eventKey: 'before-save', scope: 'form', children: [] });
    ctrl.events.value = [a, b, c];
    ctrl.activeEventId.value = a.id;
    return { ctrl, a, b, c };
  }

  it('下移/上移交换相邻事件，当前事件不变', async () => {
    const { ctrl, a, b, c } = threeEventsCtrl();
    expect(await ctrl.moveEvent(a.id, 1)).toBe(true);
    expect(ctrl.events.value.map(e => e.id)).toEqual([b.id, a.id, c.id]);
    expect(await ctrl.moveEvent(c.id, -1)).toBe(true);
    expect(ctrl.events.value.map(e => e.id)).toEqual([b.id, c.id, a.id]);
    expect(ctrl.activeEventId.value).toBe(a.id);
  });

  it('越界（首个上移 / 末个下移）与未知 id 返回 false 且顺序不变', async () => {
    const { ctrl, a, b, c } = threeEventsCtrl();
    expect(await ctrl.moveEvent(a.id, -1)).toBe(false);
    expect(await ctrl.moveEvent(c.id, 1)).toBe(false);
    expect(await ctrl.moveEvent('nope', 1)).toBe(false);
    expect(ctrl.events.value.map(e => e.id)).toEqual([a.id, b.id, c.id]);
  });

  // 左侧列表用指针拖动排序：拖动落位调用 moveEventTo(id, 目标下标)，跨多格一次到位。
  it('moveEventTo 跨格移动：摘出插入、其余相对顺序不变，当前事件不变', async () => {
    const { ctrl, a, b, c } = threeEventsCtrl();
    expect(await ctrl.moveEventTo(a.id, 2)).toBe(true);
    expect(ctrl.events.value.map(e => e.id)).toEqual([b.id, c.id, a.id]);
    expect(await ctrl.moveEventTo(a.id, 0)).toBe(true);
    expect(ctrl.events.value.map(e => e.id)).toEqual([a.id, b.id, c.id]);
    expect(ctrl.activeEventId.value).toBe(a.id);
  });

  it('moveEventTo 越界 / 原位 / 未知 id 返回 false 且顺序不变', async () => {
    const { ctrl, a, b, c } = threeEventsCtrl();
    expect(await ctrl.moveEventTo(a.id, -1)).toBe(false);
    expect(await ctrl.moveEventTo(a.id, 3)).toBe(false);
    expect(await ctrl.moveEventTo(b.id, 1)).toBe(false);
    expect(await ctrl.moveEventTo('nope', 0)).toBe(false);
    expect(ctrl.events.value.map(e => e.id)).toEqual([a.id, b.id, c.id]);
  });
});

describe('useActionDesigner 条件节点 V4 形态', () => {
  it('新建条件节点直接种一份空的 V4 判断表达式，不再种旧式 condition（旧式会被配置页判成「旧格式」）', () => {
    const { ctrl, root } = setup([createActionNode({ id: 'a1', actionName: 'x' })]);
    ctrl.applyDrop({ ownerId: root.id, index: 0 }, { kind: 'condition' });
    const node = (root.children ?? []).find(n => n.kind === 'condition');
    expect(node).toBeTruthy();
    expect(node!.condition).toBeUndefined();
    expect(node!.guardSpec?.mode).toBe('expression');
    expect(node!.guardSpec?.v4?.conditionId).toMatch(/^cond_[0-9a-f]{8}$/);
    expect(node!.guardSpec?.v4?.expression).toEqual({
      expression_id: node!.guardSpec?.v4?.conditionId,
      purpose: 'condition',
      source_text: '',
      refs: []
    });
    expect(node!.guardSpec?.guided).toBeUndefined();
    expect(node!.guardSpec?.group).toBeUndefined();
  });
});
