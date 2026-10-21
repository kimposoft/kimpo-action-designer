/**
 * NodeConfigDialog before-save 根下写动作强制同步。
 *
 * 背景：三写动作（新增/修改/删除数据，由数据动作插件 kimpo-record-controllers 提供，
 * capabilities.asyncable=true）全部默认同步、异步可选；但落在 before-save 触发根下的
 * 写节点必须同步执行（失败要能阻断保存），其异步开关须置灰并提示——本文件覆盖 NodeConfigDialog
 * 这一层：显示态（disabled + 提示，二者与「无能力支持」提示互斥展示）与提交态（emit saveAction 的
 * async 字段）。编译期还有 compile.ts 的独立兜底（见 compile.test.ts「before-save 根下写动作强制同步（编译期兜底）」用例组），二者是两道
 * 独立防线，互不替代。
 *
 * 挂载策略沿用 nodeConfigDialogGuidedAutoRowMatch.spec.ts 先例：刻意不传 scope——
 * useExpressionEditor 需要 scope 才为真，缺 scope 时 <ExpressionEditor> 分支不会挂载，规避真拉起
 * 表达式编辑器需要的宿主接线；topLevelExpressionEditor/isWriteAction/asyncBlockedByBeforeSave 均不
 * 依赖 scope，「选项」浮层本身与其内的异步开关照常渲染。弹窗内容经 ActionDesignerDialog + NPopover
 * 两层 Teleport 挂到 document.body，断言一律查 document.body（同上例）。
 */
import { DOMWrapper, flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { createFakeHostApi, createFakeInteractiveSession } from './fakeHostApi';
import { createActionNode } from '../model';
import type { ActionTriggerEventKey, MindNode } from '../model';
import type { ActionDefinition } from '../hostTypes';
import NodeConfigDialog from '../NodeConfigDialog.vue';

const hostApi = createFakeHostApi();
const interactiveSession = createFakeInteractiveSession();

// 三写动作之一（新增数据）：x-write-operation 声明写模式，x-editor/x-tabs 与
// kimpo-record-controllers 后端 internal/actions/create/service.go 的 GetActions 声明对齐
// （x-tabs 声明 options 组，故「选项」浮层会渲染出异步开关）。capabilities.asyncable=true 对齐
// 后端声明（本文件不依赖该字段真实取值，asyncBlockedByBeforeSave 的判定
// 只看 isWriteAction + bandEventKeys，与 asyncable 是两个独立闸）。
const writeActionDefinition: ActionDefinition = {
  name: 'data.create_record',
  title: '新增数据',
  source: 'builtin',
  capabilities: { asyncable: true, side_effecting: true, expression_based: true },
  params_schema: {
    'x-editor': 'expression',
    'x-write-operation': 'insert',
    'x-tabs': [
      { key: 'write', label: '写入', primary: true },
      { key: 'options', label: '选项', options: true }
    ]
  }
};

// 非写动作对照组：无 x-write-operation，同 nodeConfigDialogFinalizeOnSave.spec.ts 既有取数动作定义。
const fetchActionDefinition: ActionDefinition = {
  name: 'data.extract',
  title: '取数',
  source: 'builtin',
  capabilities: { asyncable: false, side_effecting: false, expression_based: true },
  params_schema: { 'x-editor': 'expression' }
};

async function mountDialog(props: { node: MindNode | null } & Record<string, unknown>): Promise<VueWrapper> {
  const wrapper = mount(NodeConfigDialog, {
    props: { show: false, definition: null, fields: [], hostApi, interactiveSession, ...props },
    attachTo: document.body,
    global: { stubs: { SvgIcon: true } }
  });
  await wrapper.setProps({ show: true });
  await flushPromises();
  return wrapper;
}

/** 打开「选项」浮层：点击头部按钮，等待 NPopover 内容落地（同 nodeConfigDialogGuidedAutoRowMatch.spec.ts）。 */
async function openOptionsPopover(): Promise<void> {
  const btn = document.body.querySelector('.ncd-options-btn') as HTMLElement | null;
  expect(btn).not.toBeNull();
  await new DOMWrapper(btn as HTMLElement).trigger('click');
  await Promise.resolve();
  await Promise.resolve();
}

/**
 * 异步开关所在行的根元素：无论写动作（2 行：行数阈值 + 异步执行）还是取数动作
 * （4 行：排除重复/仅限前 N 条/自动按行列匹配 + 异步执行），异步开关恒是「选项」浮层里最后一个
 * .ncd-opt-row（见 NodeConfigDialog.vue 模板顺序），取最后一个即稳定命中，不依赖前面行数。
 */
function findAsyncSwitchEl(): HTMLElement {
  const rows = document.body.querySelectorAll('.ncd-options-pop .ncd-opt-row');
  const row = rows[rows.length - 1] as HTMLElement | undefined;
  expect(row).toBeTruthy();
  const el = row!.querySelector('.n-switch') as HTMLElement | null;
  expect(el).not.toBeNull();
  return el as HTMLElement;
}

/** 保存按钮：KDialogFooter 的确认按钮（data-kdlf="confirm"）。 */
async function clickSave(): Promise<void> {
  const button = document.body.querySelector<HTMLButtonElement>('[data-kdlf="confirm"]');
  expect(button).not.toBeNull();
  button!.click();
  await flushPromises();
}

describe('NodeConfigDialog before-save 根下写动作强制同步', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('写动作 + bandEventKeys 含 before-save：异步开关 disabled 且展示为关，阻断提示可见（与无能力提示互斥）', async () => {
    const node = createActionNode({ actionName: 'data.create_record', params: {}, async: true });
    await mountDialog({ node, definition: writeActionDefinition, bandEventKeys: ['before-save'] as ActionTriggerEventKey[] });
    await openOptionsPopover();

    const sw = findAsyncSwitchEl();
    expect(sw.classList.contains('n-switch--disabled')).toBe(true);
    expect(sw.getAttribute('aria-checked')).toBe('false');
    expect(document.body.textContent).toContain('actionDesigner.dialog.asyncBlockedBeforeSave');
    expect(document.body.textContent).not.toContain('actionDesigner.dialog.noAsyncSupport');
  });

  it('写动作 + bandEventKeys 含 before-save：保存提交的 async 字段强制为 false（即使节点原带 async:true）', async () => {
    const node = createActionNode({ actionName: 'data.create_record', params: {}, async: true });
    const wrapper = await mountDialog({ node, definition: writeActionDefinition, bandEventKeys: ['before-save'] as ActionTriggerEventKey[] });

    await clickSave();

    const saves = wrapper.emitted('saveAction') as Array<[Record<string, unknown>]> | undefined;
    expect(saves).toHaveLength(1);
    expect(saves![0][0].async).toBe(false);
  });

  it('同一写动作在 after-save 根：异步开关可用，展示原值（未被阻断）', async () => {
    const node = createActionNode({ actionName: 'data.create_record', params: {}, async: true });
    await mountDialog({ node, definition: writeActionDefinition, bandEventKeys: ['after-save'] as ActionTriggerEventKey[] });
    await openOptionsPopover();

    const sw = findAsyncSwitchEl();
    expect(sw.classList.contains('n-switch--disabled')).toBe(false);
    expect(sw.getAttribute('aria-checked')).toBe('true');
    expect(document.body.textContent).not.toContain('actionDesigner.dialog.asyncBlockedBeforeSave');
  });

  it('未传 bandEventKeys（缺省）：不阻断，行为等同改动前', async () => {
    const node = createActionNode({ actionName: 'data.create_record', params: {}, async: true });
    await mountDialog({ node, definition: writeActionDefinition });
    await openOptionsPopover();

    const sw = findAsyncSwitchEl();
    expect(sw.classList.contains('n-switch--disabled')).toBe(false);
    expect(sw.getAttribute('aria-checked')).toBe('true');
  });

  it('非写动作在 before-save 根：不受影响，异步开关维持原能力判定（asyncable=false → 仍是无能力支持提示）', async () => {
    const node = createActionNode({ actionName: 'data.extract', params: {}, async: false });
    await mountDialog({ node, definition: fetchActionDefinition, bandEventKeys: ['before-save'] as ActionTriggerEventKey[] });
    await openOptionsPopover();

    expect(document.body.textContent).toContain('actionDesigner.dialog.noAsyncSupport');
    expect(document.body.textContent).not.toContain('actionDesigner.dialog.asyncBlockedBeforeSave');
  });
});
