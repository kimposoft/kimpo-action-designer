/**
 * NodeConfigDialog 通用参数表单的标签取 schema title。
 *
 * 宿主动作目录已按当前界面语言把插件声明的 x-kimpo-title 四语注解选成参数节点的 title；
 * 通用参数表单（无专用面板的第三方动作）用 title 作标签，没有 title 的参数回落参数键名（旧插件零回归）。
 * 挂载方式沿用 nodeConfigDialogAsyncBlocked.spec.ts（不传 scope，弹窗经 Teleport 挂到 document.body）。
 */
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { createFakeHostApi, createFakeInteractiveSession } from './fakeHostApi';
import { createActionNode } from '../model';
import type { ActionDefinition } from '../hostTypes';
import NodeConfigDialog from '../NodeConfigDialog.vue';

const definition: ActionDefinition = {
  name: 'storage.demo',
  title: 'Storage demo',
  source: 'plugin',
  capabilities: { asyncable: false, side_effecting: false, expression_based: false },
  params_schema: {
    type: 'object',
    properties: {
      scope: { type: 'string', enum: ['both', 'instance', 'app'], title: 'Scope', 'x-kimpo-title': { 'en-US': 'Scope' } },
      note: { type: 'string' }
    }
  }
};

describe('NodeConfigDialog 通用参数表单标签', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('有 title 用 title，没有 title 回落参数键名', async () => {
    const node = createActionNode({ actionName: 'storage.demo', params: {} });
    const wrapper = mount(NodeConfigDialog, {
      props: {
        show: false,
        definition: null,
        fields: [],
        hostApi: createFakeHostApi(),
        interactiveSession: createFakeInteractiveSession(),
        node
      },
      attachTo: document.body,
      global: { stubs: { SvgIcon: true } }
    });
    await wrapper.setProps({ show: true, definition });
    await flushPromises();
    const labels = Array.from(document.body.querySelectorAll('.n-form-item-label__text')).map(el => el.textContent?.trim());
    expect(labels).toContain('Scope');
    expect(labels).toContain('note');
    expect(labels).not.toContain('scope');
    wrapper.unmount();
  });
});
