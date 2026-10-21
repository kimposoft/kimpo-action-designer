/**
 * NodeConfigDialog 对第三方数据动作的配置面板回落。
 *
 * 判据：
 *   ① 第三方 fetch / 写节点（x-editor 为 extract-v4 / write-v4，动作目录带 operation_kind）打开时，
 *      createActionConfigSurface 带上 actionName（第三方真实动作名）与 operationKind，由宿主按种类回落官方标准面板；
 *   ② 宿主解析不到任何面板（返回 null）时显示「标准配置面板不可用」提示，而不是空态；
 *   ③ 非数据动作不带 operationKind（宿主行为不变）；
 *   ④ 数据动作的插件附加业务参数（引擎键以外）在「选项」浮层用通用参数表单渲染，改值写回节点参数
 *      （浮层不能只有「异步执行」）；官方动作无附加参数不出该区。
 */
import { defineComponent, h } from 'vue';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeHostApi, createFakeInteractiveSession } from './fakeHostApi';
import { installTestZhCn } from './testZhCnFixture';
import { createActionNode } from '../model';
import type { ActionDefinition } from '../hostTypes';
import NodeConfigDialog from '../NodeConfigDialog.vue';

const scope = { appId: 'app-1', templateId: 'tpl-1' };

function thirdParty(name: string, kind: string, schema: Record<string, unknown>): ActionDefinition {
  return {
    name,
    title: '第三方数据动作',
    source: 'plugin',
    plugin_id: 'org.example.data-actions',
    capabilities: { asyncable: true, side_effecting: true, expression_based: true },
    params_schema: schema,
    operation_kind: kind
  };
}

let wrapper: VueWrapper | undefined;
let restoreI18n: (() => void) | undefined;

beforeEach(() => {
  restoreI18n = installTestZhCn();
  window.$message = { success: vi.fn(), warning: vi.fn(), error: vi.fn() } as unknown as typeof window.$message;
});
afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
  restoreI18n?.();
  document.body.innerHTML = '';
  delete window.$message;
});

async function open(
  definition: ActionDefinition,
  createActionConfigSurface: ReturnType<typeof vi.fn>,
  params: Record<string, unknown> = {},
  parentSession?: ReturnType<typeof createFakeInteractiveSession>
): Promise<void> {
  // 面板挂载要求 bridge 继承父会话 handle（requireInheritedInteractiveSession），需要真挂面板的用例传同一个会话。
  const session = parentSession ?? Object.freeze(createFakeInteractiveSession());
  wrapper = mount(NodeConfigDialog, {
    props: {
      show: false,
      node: createActionNode({ actionName: definition.name, params }),
      definition,
      fields: [],
      scope,
      hostApi: createFakeHostApi({ createActionConfigSurface }),
      interactiveSession: session
    },
    attachTo: document.body,
    global: { stubs: { SvgIcon: true, ExpressionEditor: true } }
  });
  await wrapper.setProps({ show: true });
  await flushPromises();
}

describe('NodeConfigDialog 第三方数据动作按种类回落官方标准面板', () => {
  it.each([
    ['org.example.data-actions.pull', 'fetch', { 'x-editor': 'extract-v4' }],
    ['org.example.data-actions.close', 'update', { 'x-editor': 'write-v4', 'x-write-operation': 'update' }]
  ])('① %s（%s）请求挂面板时带 actionName 与 operationKind', async (name, kind, schema) => {
    // 面板在弹窗（teleport 到 body）里渲染，探针在 setup 里记下收到的 :input 供断言。
    let seenInput: { bind?: string; hostContext?: Record<string, unknown> } | undefined;
    const SurfaceProbe = defineComponent({
      props: { input: { type: Object, required: true } },
      setup: props => {
        seenInput = props.input as typeof seenInput;
        return () => h('div', { class: 'surface-probe' });
      }
    });
    const session = Object.freeze(createFakeInteractiveSession());
    const createActionConfigSurface = vi.fn(async () => ({ component: SurfaceProbe, props: {}, bridge: { interactiveSession: session } }));
    await open(thirdParty(name, kind, schema), createActionConfigSurface, {}, session);
    expect(createActionConfigSurface).toHaveBeenCalledWith(expect.objectContaining({ actionName: name, operationKind: kind }));
    // 挂载后以响应式 :input 覆盖面板入参：hostContext 必须带种类，否则官方面板把第三方写节点当取数打开。
    expect(seenInput?.bind).toBe(name);
    expect(seenInput?.hostContext?.operationKind).toBe(kind);
  });

  it('② 宿主解析不到面板时显示标准面板不可用提示', async () => {
    const createActionConfigSurface = vi.fn(async () => null);
    await open(thirdParty('org.example.data-actions.pull', 'fetch', { 'x-editor': 'extract-v4' }), createActionConfigSurface);
    const hint = document.body.querySelector('[data-testid="ncd-standard-panel-missing"]');
    expect(hint).not.toBeNull();
    expect(hint?.textContent).toContain('未找到该数据动作的官方标准配置面板');
  });

  it('③ 非数据动作不带 operationKind', async () => {
    const createActionConfigSurface = vi.fn(async (_req: { actionName: string; operationKind?: string }) => null);
    const definition: ActionDefinition = {
      name: 'org.example.plain.notify',
      title: '通知',
      source: 'plugin',
      capabilities: { asyncable: true, side_effecting: false, expression_based: false },
      params_schema: { type: 'object', properties: {} }
    };
    await open(definition, createActionConfigSurface);
    expect(createActionConfigSurface).toHaveBeenCalledTimes(1);
    expect(createActionConfigSurface.mock.calls[0][0]).toMatchObject({ actionName: 'org.example.plain.notify', operationKind: undefined });
    expect(document.body.querySelector('[data-testid="ncd-standard-panel-missing"]')).toBeNull();
  });

  it('④ 选项浮层渲染数据动作附加参数，官方动作不出该区', async () => {
    const SurfaceProbe = defineComponent({ props: { input: { type: Object, required: true } }, setup: () => () => h('div', { class: 'surface-probe' }) });
    const session = createFakeInteractiveSession();
    const surface = vi.fn(async () => ({ component: SurfaceProbe, props: {}, bridge: { interactiveSession: session } }));
    const tabs = [{ key: 'fetch', label: '取数', primary: true }, { key: 'options', label: '选项', options: true }];
    await open(
      thirdParty('org.example.data-actions.fetch', 'fetch', {
        type: 'object',
        'x-editor': 'extract-v4',
        'x-tabs': tabs,
        properties: { extract_v4: { type: 'object' }, extract_v4_plans: { type: 'array' }, audit_note: { type: 'string', title: '审计备注' } }
      }),
      surface,
      { audit_note: 'note-1' }
    );
    (document.body.querySelector('.ncd-options-btn') as HTMLElement).click();
    await flushPromises();
    const extra = document.body.querySelector('[data-testid="ncd-data-action-extra-params"]');
    expect(extra).not.toBeNull();
    expect(extra?.textContent).toContain('插件参数');
    expect(extra?.textContent).toContain('审计备注');
    const input = extra?.querySelector('input') as HTMLInputElement;
    expect(input.value).toBe('note-1');
    wrapper?.unmount();
    wrapper = undefined;
    document.body.innerHTML = '';

    await open(
      { ...thirdParty('data.extract_record', 'fetch', { type: 'object', 'x-editor': 'extract-v4', 'x-tabs': tabs, properties: { extract_v4: { type: 'object' }, extract_v4_plans: { type: 'array' } } }), plugin_id: 'com.kimposoft.recordcontrollers' },
      surface
    );
    (document.body.querySelector('.ncd-options-btn') as HTMLElement).click();
    await flushPromises();
    expect(document.body.querySelector('[data-testid="ncd-data-action-extra-params"]')).toBeNull();
  });
});
