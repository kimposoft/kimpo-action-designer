/**
 * @vitest-environment happy-dom
 *
 * NodeConfigDialog 的 Esc 内层分流（窗口外壳是 KDialog，Esc 由弹层栈在 window 捕获阶段统一派发，
 * 先于输入框自带的 @keydown.esc，故窗内「比关窗更内层的 Esc 语义」必须经 escapeInterceptor 保留）。
 *
 * 覆盖：名称行重命名编辑态按 Esc 只取消重命名、不关窗，非编辑态 Esc 才关窗。
 * 挂载策略同 nodeConfigDialogAsyncBlocked.spec.ts（不传 scope，弹窗内容经 Teleport 挂 document.body）。
 */
import { DOMWrapper, flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeHostApi, createFakeInteractiveSession } from './fakeHostApi';
import { createActionNode } from '../model';
import type { ActionDefinition } from '../hostTypes';
import NodeConfigDialog from '../NodeConfigDialog.vue';

const hostApi = createFakeHostApi();
const interactiveSession = createFakeInteractiveSession();

const definition: ActionDefinition = {
  name: 'data.extract',
  title: '取数',
  source: 'builtin',
  capabilities: { asyncable: false, side_effecting: false, expression_based: true },
  params_schema: { 'x-editor': 'expression' }
};

let wrapper: VueWrapper | null = null;

async function mountDialog(): Promise<VueWrapper> {
  wrapper = mount(NodeConfigDialog, {
    props: {
      show: false,
      node: createActionNode({ actionName: 'data.extract', params: {} }),
      definition,
      fields: [],
      hostApi,
      interactiveSession
    },
    attachTo: document.body,
    global: { stubs: { SvgIcon: true } }
  });
  await wrapper.setProps({ show: true });
  await flushPromises();
  return wrapper;
}

const escape = () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
const renameInput = () => document.body.querySelector('.ncd-rename-input');

async function startRename(): Promise<void> {
  const link = document.body.querySelector('.ncd-rename-link') as HTMLElement | null;
  expect(link).not.toBeNull();
  await new DOMWrapper(link as HTMLElement).trigger('click');
  await flushPromises();
  expect(renameInput()).not.toBeNull();
}

// happy-dom 里 NInput 聚焦会触发 NModal 焦点陷阱抢焦点 → 输入框 blur → confirmRename 立刻退出编辑态，
// 与真实浏览器行为不同；这里把输入框的 focus / select 置空，让编辑态稳定停留，专测 Esc 分流。
beforeEach(() => {
  vi.spyOn(HTMLInputElement.prototype, 'focus').mockImplementation(() => undefined);
  vi.spyOn(HTMLInputElement.prototype, 'select').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  wrapper?.unmount();
  wrapper = null;
  document.body.innerHTML = '';
});

describe('NodeConfigDialog Esc 内层分流', () => {
  it('重命名编辑态按 Esc：只取消重命名并退出编辑，不关窗', async () => {
    const w = await mountDialog();
    await startRename();

    escape();
    await flushPromises();

    expect(renameInput()).toBeNull(); // 已退出编辑态
    expect(document.body.querySelector('.ncd-rename-link')).not.toBeNull();
    expect(w.emitted('update:show')).toBeUndefined(); // 窗口还在
  });

  it('非编辑态按 Esc：关窗；重命名取消后的下一次 Esc 同样关窗', async () => {
    const w = await mountDialog();
    await startRename();
    escape();
    await flushPromises();
    expect(w.emitted('update:show')).toBeUndefined();

    escape();
    await flushPromises();
    expect(w.emitted('update:show')).toEqual([[false]]);
  });

  it('从未进入编辑态时第一次 Esc 就关窗', async () => {
    const w = await mountDialog();
    escape();
    await flushPromises();
    expect(w.emitted('update:show')).toEqual([[false]]);
  });
});
