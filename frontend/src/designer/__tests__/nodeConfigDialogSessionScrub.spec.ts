import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ComponentPublicInstance } from 'vue';
import NodeConfigDialog from '../NodeConfigDialog.vue';
import { createActionNode } from '../model';
import type { ActionDefinition } from '../hostTypes';
import { createFakeHostApi, createFakeInteractiveSession } from './fakeHostApi';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

function definition(
  name: string,
  paramsSchema: ActionDefinition['params_schema']
): ActionDefinition {
  return {
    name,
    title: name,
    source: 'plugin',
    capabilities: { asyncable: true, side_effecting: false, expression_based: true },
    params_schema: paramsSchema
  };
}

function setupState(wrapper: VueWrapper<ComponentPublicInstance>) {
  return (wrapper.vm as unknown as { $: { setupState: Record<string, any> } }).$.setupState;
}

function mountDialog(
  actionDefinition: ActionDefinition,
  hostApi = createFakeHostApi(),
  params: Record<string, unknown> = {}
) {
  return mount(NodeConfigDialog, {
    props: {
      show: false,
      node: createActionNode({ actionName: actionDefinition.name, params }),
      definition: actionDefinition,
      fields: [],
      scope: { appId: 'app-1', templateId: 'tpl-1', templateVersionNo: '1.0' },
      interactiveSession: createFakeInteractiveSession(),
      readonly: false,
      hostApi
    },
    attachTo: document.body,
    global: { stubs: { SvgIcon: true, ExpressionEditor: true } }
  });
}

describe('NodeConfigDialog 认证终态同步清洗', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('同步清空真实节点草稿中的参数、名称、guard 与选择态', async () => {
    const actionDefinition = definition('data.secret', { type: 'object', properties: {} });
    const node = createActionNode({
      actionName: actionDefinition.name,
      params: { password: 'draft-secret' },
      name: '未保存的敏感名称',
      async: true
    });
    // guard 草稿的唯一载体是 V4 判断表达式（旧 guardExpression/guardItems 已不再使用），故判据钉
    // draft.guardV4——它才是清洗后不能残留的敏感草稿。
    node.guardSpec = {
      mode: 'expression',
      v4: {
        conditionId: 'cond_deadbeef',
        expression: { expression_id: 'cond_deadbeef', purpose: 'condition', source_text: '[薪资]#{r1} > 100', refs: [] },
        readableText: '本报表.[主表].[薪资] > 100'
      }
    };
    node.eventKey = 'value-change';
    node.eventKeys = ['value-change', 'field-click'];
    node.eventFieldIds = { 'value-change': ['salary'], 'field-click': ['identity'] };
    node.scope = 'field:salary';
    node.blockable = true;

    const wrapper = mount(NodeConfigDialog, {
      props: {
        show: false,
        node,
        definition: actionDefinition,
        fields: [],
        scope: { appId: 'app-1', templateId: 'tpl-1', templateVersionNo: '1.0' },
        interactiveSession: createFakeInteractiveSession(),
        readonly: false,
        hostApi: createFakeHostApi()
      },
      attachTo: document.body,
      global: { stubs: { SvgIcon: true, ExpressionEditor: true } }
    });
    await wrapper.setProps({ show: true });
    await flushPromises();
    const state = setupState(wrapper);
    expect(state.draft.params).toEqual({ password: 'draft-secret' });
    expect(state.draft.name).toBe('未保存的敏感名称');
    expect(state.draft.guardV4?.readableText).toBe('本报表.[主表].[薪资] > 100');
    expect(state.draft.eventKeys).toEqual(['value-change', 'field-click']);

    (wrapper.vm as unknown as { scrubSensitiveState: () => void }).scrubSensitiveState();

    expect(state.draft.params).toEqual({});
    expect(state.draft.name).toBe('');
    expect(state.draft.guardV4).toBeNull();
    expect(state.draft.guardLegacy).toBe(false);
    expect(state.draft.eventKeys).toEqual([]);
    expect(state.draft.eventScopeFields).toEqual({ 'value-change': [], 'field-click': [] });
    expect(state.draft.blockable).toBe(false);
    wrapper.unmount();
  });

  it('清洗后忽略迟到的 Sheet 目录', async () => {
    const pending = deferred<{ data: { sheets: Array<Record<string, unknown>> } }>();
    const listSheetCatalog = vi.fn(() => pending.promise);
    const wrapper = mountDialog(
      definition('ui.switch_sheet', {
        type: 'object',
        properties: { sheet_id: { type: 'string', 'x-picker': 'sheet-switch' } }
      }),
      createFakeHostApi({ listSheetCatalog: listSheetCatalog as any })
    );
    await vi.waitFor(() => expect(listSheetCatalog).toHaveBeenCalledOnce());

    (wrapper.vm as unknown as { scrubSensitiveState: () => void }).scrubSensitiveState();
    pending.resolve({ data: { sheets: [{ sheet_id: 'late-secret-sheet', sheet_name: '迟到 Sheet' }] } });
    await flushPromises();

    expect(setupState(wrapper).sheetCatalog).toEqual([]);
    wrapper.unmount();
  });
});
