import { defineComponent, h, nextTick } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InteractiveSessionHandle, InteractiveSessionSnapshot } from '@kimposoft/plugin-sdk';
import DesignerRoot from '../../DesignerRoot.vue';
import ActionDesigner from '../ActionDesigner.vue';
import NodeConfigDialog from '../NodeConfigDialog.vue';
import { createActionNode } from '../model';
import type { ActionDefinition } from '../hostTypes';
import { createFakeHostApi } from './fakeHostApi';

function snapshot(
  state: InteractiveSessionSnapshot['state'],
  patch: Partial<InteractiveSessionSnapshot> = {}
): InteractiveSessionSnapshot {
  return {
    mode: 'edit',
    state,
    lossReason: null,
    dirty: false,
    epoch: 7,
    expiresAt: null,
    serverTime: null,
    transportCredentialRevision: 1,
    conflict: null,
    canAdminRelease: false,
    canRequestEdit: false,
    ...patch
  };
}

function controllableSession(initial = snapshot('active')) {
  let current = initial;
  const listeners = new Set<(next: Readonly<InteractiveSessionSnapshot>) => void>();
  const handle = Object.freeze({
    get snapshot() {
      return current;
    },
    markDirty: vi.fn(),
    onChange: vi.fn(listener => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    requestEdit: vi.fn(async () => undefined),
    adminRelease: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined)
  } satisfies InteractiveSessionHandle);
  return {
    handle,
    publish(next: InteractiveSessionSnapshot) {
      current = next;
      for (const listener of listeners) listener(next);
    }
  };
}

// 用 x-editor:'extract-v4'（V4 取数配置面）触发 action-config surface 加载，来测本用例真正关心的
// 东西——父子 interactiveSession handle 是否同一对象。
const expressionAction: ActionDefinition = {
  name: 'data.extract_record',
  title: 'Extract record',
  source: 'plugin',
  capabilities: { asyncable: false, side_effecting: false, expression_based: true },
  params_schema: { 'x-editor': 'extract-v4' }
};

describe('action-designer 真实交互会话挂载链', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('DesignerRoot 经真实 ActionDesigner 把同一 handle 传到 NodeConfigDialog，终态立即只读且不 close', async () => {
    const session = controllableSession();
    const hostApi = createFakeHostApi();
    const wrapper = mount(DesignerRoot, {
      props: {
        input: {
          kind: 'template',
          scope: { appId: 'app-1', templateId: 'tpl-1', templateVersionNo: '1.0' },
          visible: true,
          interactiveSessionOwnership: 'inherited',
          requestClose: vi.fn(async () => true)
        },
        hostApi,
        interactiveSession: session.handle
      },
      attachTo: document.body,
      global: {
        // 保留真实 DesignerRoot/ActionDesigner/NodeConfigDialog，只隔离与会话链无关的画布和右栏。
        stubs: { ActionDesignerCanvas: true, ActionPanel: true, SvgIcon: true }
      }
    });
    await flushPromises();

    const designer = wrapper.findComponent(ActionDesigner);
    const nodeConfig = wrapper.findComponent(NodeConfigDialog);
    expect(designer.exists()).toBe(true);
    expect(nodeConfig.exists()).toBe(true);
    expect(designer.props('interactiveSession')).toBe(session.handle);
    expect(nodeConfig.props('interactiveSession')).toBe(session.handle);
    expect(nodeConfig.props('readonly')).toBe(false);

    session.publish(snapshot('lost', { lossReason: 'offline' }));
    await nextTick();
    expect(wrapper.findComponent(NodeConfigDialog).props('readonly')).toBe(true);

    session.publish(snapshot('auth_ended', { lossReason: 'auth-ended' }));
    await nextTick();
    expect(wrapper.findComponent(NodeConfigDialog).props('readonly')).toBe(true);
    expect(session.handle.close).not.toHaveBeenCalled();
    wrapper.unmount();
    expect(session.handle.close).not.toHaveBeenCalled();
  });

  it('NodeConfigDialog 真实挂载 action-config 时只接受父 handle 同一对象，readonly 即卸载子面', async () => {
    const session = controllableSession();
    const ActionConfigProbe = defineComponent({
      props: { input: { type: Object, required: true } },
      setup(props) {
        return () => h('div', {
          class: 'action-config-session-probe',
          'data-same-handle': (props.input as any).hostBridge.interactiveSession === session.handle ? 'yes' : 'no'
        });
      }
    });
    const createActionConfigSurface = vi.fn(async () => ({
      component: ActionConfigProbe,
      props: {},
      bridge: { interactiveSession: session.handle, 'domain:expression': {}, i18n: vi.fn() }
    }));
    const hostApi = createFakeHostApi({ createActionConfigSurface });
    const wrapper = mount(NodeConfigDialog, {
      props: {
        show: false,
        node: createActionNode({ actionName: expressionAction.name, params: {} }),
        definition: expressionAction,
        fields: [],
        scope: { appId: 'app-1', templateId: 'tpl-1', templateVersionNo: '1.0' },
        interactiveSession: session.handle,
        readonly: false,
        hostApi
      },
      attachTo: document.body,
      global: { stubs: { SvgIcon: true, ExpressionEditor: true } }
    });

    await wrapper.setProps({ show: true });
    await flushPromises();
    expect(createActionConfigSurface).toHaveBeenCalledOnce();
    const probe = document.body.querySelector('.action-config-session-probe');
    expect(probe?.getAttribute('data-same-handle')).toBe('yes');

    await wrapper.setProps({ readonly: true });
    await flushPromises();
    expect(document.body.querySelector('.action-config-session-probe')).toBeNull();
    expect(session.handle.close).not.toHaveBeenCalled();
    expect(createActionConfigSurface).toHaveBeenCalledOnce();
    wrapper.unmount();
  });
});
