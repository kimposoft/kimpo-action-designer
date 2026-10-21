/**
 * NodeConfigDialog 触发根「流程步骤门」区（界面层）。
 *
 * 背景：动作设计器设计层的触发根附加门控——「仅当命中门内某流程步骤（按到达方式）/ 未发起时
 * 才触发」。模型/编译层另有测试，本文件只覆盖界面层：目录为空且门为空整区不渲染、
 * 勾选步骤 + 切到达方式、失效条目渲染 + 「替换为同名」、切回「不限」清空草稿。
 *
 * 挂载写法与 nodeConfigDialogTriggerMenu.spec.ts 同：先 show:false 再翻 true（对齐真实时序，
 * 规避该文件注释描述的 resetDraft 前置声明 TDZ 时序脆弱点）；外层包 NMessageProvider。
 * 测试环境未注入宿主 i18n，$t 回退 key 原样（含插值参数——参数不影响回退串，与既有用例同口径），
 * 断言直接比对 key 文本是否出现。
 * 弹窗内容经 ActionDesignerDialog 两层 Teleport 挂到 document.body（不在 wrapper 自身 DOM 子树内），
 * 故 CSS 选择器类断言一律走 document.body.querySelector(All)（与本目录其余弹窗用例同一约定）；
 * 组件级断言（findComponent/findAllComponents）走 VTU 的组件实例树，不受 Teleport 影响，两者互补。
 */
import { mount, flushPromises } from '@vue/test-utils';
import { h } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NCheckbox, NMessageProvider, NRadioGroup, NTag } from 'naive-ui';
import { createFakeHostApi, createFakeInteractiveSession } from './fakeHostApi';
import { createTriggerRoot } from '../model';
import type { MindNode } from '../model';
import type { WorkflowStepCatalogDefinition } from '../hostTypes';
import NodeConfigDialog from '../NodeConfigDialog.vue';

const interactiveSession = createFakeInteractiveSession();
const scope = { appId: 'app-1', templateId: 'tpl-1' };

const catalogWithOneDef: WorkflowStepCatalogDefinition[] = [
  {
    definition_id: 'wf1',
    name: '采购审批',
    status: 'enabled',
    latest_version_no: 2,
    steps: [
      { node_id: 'n1', node_kind: 'START', node_name: '发起' },
      { node_id: 'n2', node_kind: 'APPROVE', node_name: '审批' }
    ]
  }
];

async function mountDialog(hostApi: ReturnType<typeof createFakeHostApi>, props: { node: MindNode | null } & Record<string, unknown>) {
  const inner = { show: false, definition: null, fields: [], scope, hostApi, interactiveSession, ...props };
  const wrapper = mount(
    {
      props: { inner: { type: Object, required: true } },
      setup: (p: { inner: Record<string, unknown> }) => () => h(NMessageProvider, null, { default: () => h(NodeConfigDialog, p.inner as never) })
    },
    { props: { inner }, attachTo: document.body, global: { stubs: { SvgIcon: true } } }
  );
  await wrapper.setProps({ inner: { ...inner, show: true } });
  await flushPromises();
  await wrapper.vm.$nextTick();
  return wrapper;
}

/** 保存按钮：KDialogFooter 的确认按钮（data-kdlf="confirm"）。 */
async function clickSave(): Promise<void> {
  const button = document.body.querySelector<HTMLButtonElement>('[data-kdlf="confirm"]');
  expect(button).not.toBeNull();
  button!.click();
  await flushPromises();
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('NodeConfigDialog 触发根流程步骤门', () => {
  it('① 目录为空（模板未绑定任何流程）且门也为空：整区不渲染', async () => {
    const hostApi = createFakeHostApi({ listTemplateWorkflows: vi.fn().mockResolvedValue({ data: { definitions: [] } }) });
    const dialog = await mountDialog(hostApi, { node: createTriggerRoot({ eventKey: 'manual' }) });
    expect(document.body.textContent).not.toContain('actionDesigner.dialog.gate.title');
  });

  it('② 切到「仅在所选步骤」勾两步、把一步切到仅回退 ⇒ 保存时 draft.workflowGate 正确', async () => {
    const hostApi = createFakeHostApi({ listTemplateWorkflows: vi.fn().mockResolvedValue({ data: { definitions: catalogWithOneDef } }) });
    const dialog = await mountDialog(hostApi, { node: createTriggerRoot({ eventKey: 'manual' }) });
    expect(document.body.textContent).toContain('actionDesigner.dialog.gate.title');

    // 切到「仅在所选步骤」。
    const radioGroup = dialog.findComponent(NRadioGroup);
    radioGroup.vm.$emit('update:value', 'only');
    await dialog.vm.$nextTick();

    // 勾选框顺序：0=「未发起」，1=n1（START），2=n2（APPROVE）。
    const checkboxes = dialog.findAllComponents(NCheckbox);
    expect(checkboxes.length).toBe(3);
    checkboxes[1].vm.$emit('update:checked', true);
    await dialog.vm.$nextTick();
    checkboxes[2].vm.$emit('update:checked', true);
    await dialog.vm.$nextTick();

    // 把 n2 的到达方式切到仅「回退」：两步均已勾选后，门内按 n1→n2 顺序各出一对到达方式胶囊
    // （NTag checkable，提交在前、回退在后）；用 checkable 这一自定义属性把它们与页面其它 NTag
    // （事件多选的已选 tag 等）区分开——内容经 Teleport 挂到 body，故走组件树而非 CSS 选择器定位。
    const arrivalTags = dialog.findAllComponents(NTag).filter(tag => tag.props('checkable'));
    expect(arrivalTags.length).toBe(4);
    // index 2 = n2 的「提交」胶囊（n1 两枚在前，n2 两枚在后）。
    arrivalTags[2].vm.$emit('update:checked', false);
    await dialog.vm.$nextTick();

    await clickSave();
    const saves = dialog.findComponent(NodeConfigDialog).emitted('saveTrigger') as Array<[Record<string, unknown>]>;
    expect(saves).toHaveLength(1);
    const gate = saves[0][0].workflowGate as { notStarted: boolean; steps: Array<{ definitionId: string; nodeId: string; arrivals: string[] }> };
    expect(gate.notStarted).toBe(false);
    const byNodeId = new Map(gate.steps.map(s => [s.nodeId, s]));
    expect(byNodeId.get('n1')?.arrivals).toEqual(['submitted', 'returned']);
    expect(byNodeId.get('n2')?.arrivals).toEqual(['returned']);
    expect(byNodeId.get('n1')?.definitionId).toBe('wf1');
  });

  it('③ 失效条目渲染（删除线 + deadStep 徽标）+「替换为同名」把 nodeId 换绑成目录里的同名节点', async () => {
    const hostApi = createFakeHostApi({ listTemplateWorkflows: vi.fn().mockResolvedValue({ data: { definitions: catalogWithOneDef } }) });
    // 既有门引用了 wf1 的 'n2-old'（目录里已不存在），快照名「审批」与目录 n2（APPROVE·审批）同名，
    // 唯一候选 ⇒ 应渲染「替换为同名」。
    const node = createTriggerRoot({ eventKey: 'manual' });
    node.workflowGate = {
      notStarted: false,
      steps: [{ definitionId: 'wf1', nodeId: 'n2-old', definitionName: '采购审批', nodeName: '审批', arrivals: ['submitted', 'returned'] }]
    };
    const dialog = await mountDialog(hostApi, { node });

    expect(document.body.textContent).toContain('actionDesigner.dialog.gate.deadStep');
    expect(document.body.textContent).toContain('actionDesigner.dialog.gate.replaceWith');
    expect(document.querySelector('.ncd-gate-row-dead-name')).not.toBeNull();

    const deadRow = document.body.querySelector('.ncd-gate-row.is-dead');
    expect(deadRow).not.toBeNull();
    const replaceBtn = Array.from(deadRow!.querySelectorAll<HTMLButtonElement>('button')).find(btn =>
      (btn.textContent ?? '').includes('actionDesigner.dialog.gate.replaceWith')
    );
    expect(replaceBtn).toBeTruthy();
    replaceBtn!.click();
    await dialog.vm.$nextTick();
    await flushPromises();

    // 换绑后不再失效：deadStep 徽标消失。
    expect(document.body.textContent).not.toContain('actionDesigner.dialog.gate.deadStep');

    await clickSave();
    const saves = dialog.findComponent(NodeConfigDialog).emitted('saveTrigger') as Array<[Record<string, unknown>]>;
    const gate = saves[saves.length - 1][0].workflowGate as { steps: Array<{ nodeId: string; nodeName?: string }> };
    expect(gate.steps).toEqual([
      { definitionId: 'wf1', nodeId: 'n2', definitionName: '采购审批', nodeName: '审批', arrivals: ['submitted', 'returned'] }
    ]);
  });

  it('④ 切回「不限」清空既有门：保存时 workflowGate 为 undefined', async () => {
    const hostApi = createFakeHostApi({ listTemplateWorkflows: vi.fn().mockResolvedValue({ data: { definitions: catalogWithOneDef } }) });
    const node = createTriggerRoot({ eventKey: 'manual' });
    node.workflowGate = { notStarted: true, steps: [{ definitionId: 'wf1', nodeId: 'n1', nodeName: '发起', arrivals: ['submitted', 'returned'] }] };
    const dialog = await mountDialog(hostApi, { node });
    expect(document.body.textContent).toContain('actionDesigner.dialog.gate.title');

    const radioGroup = dialog.findComponent(NRadioGroup);
    radioGroup.vm.$emit('update:value', 'any');
    await dialog.vm.$nextTick();

    await clickSave();
    const saves = dialog.findComponent(NodeConfigDialog).emitted('saveTrigger') as Array<[Record<string, unknown>]>;
    expect(saves[saves.length - 1][0].workflowGate).toBeUndefined();
  });
});
