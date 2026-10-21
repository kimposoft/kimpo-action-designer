/**
 * NodeConfigDialog 取数节点 V4 配置面路由。
 *
 * 背景：取数动作（data.extract_record）参数键从 3.4 的 expression 迁到 extract_v4，壳侧按新
 * x-editor:'extract-v4' 分流到独立分支——不再挂 3.4 <ExpressionEditor>，只承载 record-controllers
 * 插件的 action-config surface（本文件用 SurfaceProbe 桩替代，不依赖真实 bundle）。
 * 四条判据：
 *   ① schema x-editor:'extract-v4' → 参数键为 extract_v4（finalize 收口结果落在该键，不落 expression）；
 *   ② 无值时得到空文档（透传给 surface 的 modelValue 与 emptyExtractNodeDocument() 形状一致）；
 *   ③ 旧格式节点（仍带 expression、无 extract_v4）显示失效横幅；
 *   ④ 配置面挂载失败显示错误态（data-testid="ncd-v4-surface-error"），绝不静默回落 3.4 编辑器。
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

// 顶层 x-editor:'extract-v4' 命中取数动作 V4 配置面（取代 3.4 的 'expression'）。
const definition: ActionDefinition = {
  name: 'data.extract_record',
  title: '提取数据',
  source: 'builtin',
  capabilities: { asyncable: true, side_effecting: true, expression_based: true },
  params_schema: { 'x-editor': 'extract-v4' }
};

/** emptyExtractNodeDocument() 的预期形状（本文件按字段口径就地重建预期值，不深依赖
 *  `@kimposoft/expression-editor` 共享包的导出）。 */
const EMPTY_V4_DOC = {
  schema_version: 'kimpo.extract-node/v4',
  syntax_profile: 'kimposql.mssql/v1',
  query: { sources: [], joins: [], options: { distinct: false, business_timezone: 'UTC' } },
  targets: []
};

let wrapper: VueWrapper | undefined;
let restoreI18n: (() => void) | undefined;

afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
  restoreI18n?.();
  restoreI18n = undefined;
  document.body.innerHTML = '';
  delete window.$message;
});

beforeEach(() => {
  restoreI18n = installTestZhCn();
  window.$message = { success: vi.fn(), warning: vi.fn(), error: vi.fn() } as unknown as typeof window.$message;
});

/** 保存按钮：KDialogFooter 的确认按钮（data-kdlf="confirm"）。 */
async function clickSave(): Promise<void> {
  const button = document.body.querySelector<HTMLButtonElement>('[data-kdlf="confirm"]');
  expect(button).not.toBeNull();
  button!.click();
  await flushPromises();
}

function lastSavedParams(): Record<string, unknown> {
  const saves = wrapper!.emitted('saveAction') as Array<[Record<string, unknown>]> | undefined;
  expect(saves).toHaveLength(1);
  return saves![0][0].params as Record<string, unknown>;
}

describe('NodeConfigDialog 取数节点 V4 配置面路由', () => {
  it('① 参数键为 extract_v4：surface finalize 收口结果落在 extract_v4，不落 expression', async () => {
    const marker = { ...EMPTY_V4_DOC, targets: [{ target_id: 'marker-target' }] };
    const SurfaceProbe = defineComponent({
      props: { input: { type: Object, required: true } },
      setup(_props, { expose }) {
        expose({ finalize: () => marker });
        return () => h('div', { class: 'surface-probe' });
      }
    });
    const session = Object.freeze(createFakeInteractiveSession());
    const createActionConfigSurface = vi.fn(async () => ({
      component: SurfaceProbe,
      props: {},
      bridge: { interactiveSession: session, 'domain:expression': {}, i18n: vi.fn() }
    }));
    const hostApi = createFakeHostApi({ createActionConfigSurface });
    wrapper = mount(NodeConfigDialog, {
      props: {
        // show 从 false→true 触发 surface 加载 watch（非 immediate，见 NodeConfigDialog.vue 该 watch
        // 注释；直接以 show:true 挂载不会触发它，同 nodeConfigDialogFinalizeOnSave.spec.ts 既有写法）。
        show: false,
        node: createActionNode({ actionName: 'data.extract_record', params: {} }),
        definition,
        fields: [],
        scope,
        hostApi,
        interactiveSession: session
      },
      attachTo: document.body,
      global: { stubs: { SvgIcon: true, ExpressionEditor: true } }
    });
    await wrapper.setProps({ show: true });
    await flushPromises();
    expect(document.body.querySelector('.surface-probe')).not.toBeNull();

    await clickSave();

    const params = lastSavedParams();
    expect(params.extract_v4).toEqual(marker);
    expect(params).not.toHaveProperty('expression');
  });

  it('② 无值时得到空文档：透传给 surface 的 modelValue 与 emptyExtractNodeDocument() 形状一致', async () => {
    let receivedModel: unknown;
    const SurfaceProbe = defineComponent({
      props: { input: { type: Object, required: true } },
      setup(props) {
        receivedModel = (props.input as { props: { modelValue: unknown } }).props.modelValue;
        return () => h('div', { class: 'surface-probe' });
      }
    });
    // bridge.interactiveSession 必须与父 props.interactiveSession 同一对象（requireInheritedInteractiveSession
    // 校验），否则挂载会静默判定为「第二会话」而拒绝，见 nodeConfigDialogFinalizeOnSave.spec.ts 既有写法。
    const session = Object.freeze(createFakeInteractiveSession());
    const hostApi = createFakeHostApi({
      createActionConfigSurface: vi.fn(async () => ({ component: SurfaceProbe, props: {}, bridge: { interactiveSession: session } }))
    });
    wrapper = mount(NodeConfigDialog, {
      props: {
        show: false,
        // 新节点：params 里既无 expression 也无 extract_v4。
        node: createActionNode({ actionName: 'data.extract_record', params: {} }),
        definition,
        fields: [],
        scope,
        hostApi,
        interactiveSession: session
      },
      attachTo: document.body,
      global: { stubs: { SvgIcon: true, ExpressionEditor: true } }
    });
    await wrapper.setProps({ show: true });
    await flushPromises();

    expect(receivedModel).toEqual(EMPTY_V4_DOC);
  });

  it('③ 旧格式节点（仍带 expression、无 extract_v4）显示失效横幅', async () => {
    const hostApi = createFakeHostApi(); // 默认 createActionConfigSurface resolve null，无关本断言
    wrapper = mount(NodeConfigDialog, {
      props: {
        show: true,
        node: createActionNode({
          actionName: 'data.extract_record',
          params: { expression: { schema_version: 1, source: { tables: [], joins: [] }, target: { target_data_table_id: 'x', outputs: [] } } }
        }),
        definition,
        fields: [],
        scope,
        hostApi,
        interactiveSession: createFakeInteractiveSession()
      },
      attachTo: document.body,
      global: { stubs: { SvgIcon: true, ExpressionEditor: true } }
    });
    await flushPromises();

    const text = document.body.textContent ?? '';
    expect(text).toContain('此取数节点为旧格式配置，已停用；请重新配置后保存');
  });

  it('④ 配置面挂载失败显示错误态（ncd-v4-surface-error），不回落 3.4 编辑器', async () => {
    const hostApi = createFakeHostApi({
      createActionConfigSurface: vi.fn().mockRejectedValue(new Error('surface load boom'))
    });
    wrapper = mount(NodeConfigDialog, {
      props: {
        show: false,
        node: createActionNode({ actionName: 'data.extract_record', params: {} }),
        definition,
        fields: [],
        scope,
        hostApi,
        interactiveSession: createFakeInteractiveSession()
      },
      attachTo: document.body,
      global: {
        stubs: {
          SvgIcon: true,
          // 若代码回退到 3.4 编辑器会挂载这个桩——本用例要断言它绝不出现。
          ExpressionEditor: {
            name: 'ExpressionEditor',
            props: ['modelValue'],
            template: '<div data-testid="structured-expression-editor" />'
          }
        }
      }
    });
    await wrapper.setProps({ show: true });
    await flushPromises();

    expect(document.body.querySelector('[data-testid="ncd-v4-surface-error"]')).not.toBeNull();
    expect(document.body.querySelector('[data-testid="structured-expression-editor"]')).toBeNull();
  });
});

/**
 * 写动作（新增/修改/删除数据）V4 配置面路由。
 *
 * 背景：三写动作参数键从 3.4 的 expression 硬切到 write_v4（宿主匹配 surface 按
 * bind===definition.name，由 record-controllers 插件提供）。壳侧判定与取数 extract-v4 同一套
 * v4SurfaceEditor/V4_SURFACE_PARAM_KEY 机制驱动，本组用例镜像上方取数四条判据，验证写动作
 * 同样路由正确：
 *   ① schema x-editor:'write-v4' → 参数键为 write_v4（finalize 收口结果落在该键，不落 expression）；
 *   ② 无值时得到空文档（透传给 surface 的 modelValue 与 emptyWriteNodeDocument('insert') 形状一致）；
 *   ③ 旧格式节点（仍带 expression、无 write_v4）显示写动作专属失效横幅（与取数横幅文案不同）；
 *   ④ 配置面挂载失败显示错误态（data-testid="ncd-v4-surface-error"），绝不静默回落 3.4 编辑器。
 */
const writeScope = { appId: 'app-1', templateId: 'tpl-1' };

// 顶层 x-editor:'write-v4' 命中写动作 V4 配置面（同 kimpo-record-controllers/internal/actions/
// create/service.go 的 GetActions 声明口径：x-write-operation 与 x-editor 成对声明）。
const writeDefinition: ActionDefinition = {
  name: 'data.create_record',
  title: '新增数据',
  source: 'builtin',
  capabilities: { asyncable: true, side_effecting: true, expression_based: true },
  params_schema: { 'x-editor': 'write-v4', 'x-write-operation': 'insert' }
};

/** emptyWriteNodeDocument('insert') 的预期形状（就地重建，不依赖包导出，理由同上方 EMPTY_V4_DOC）。 */
const EMPTY_WRITE_V4_DOC = {
  schema_version: 'kimpo.write-node/v4',
  syntax_profile: 'kimposql.mssql/v1',
  query: { sources: [], joins: [], options: { distinct: false, business_timezone: 'UTC' } },
  operation: 'insert',
  target: {},
  assignments: []
};

describe('NodeConfigDialog 写动作 V4 配置面路由', () => {
  it('① 参数键为 write_v4：surface finalize 收口结果落在 write_v4，不落 expression', async () => {
    const marker = { ...EMPTY_WRITE_V4_DOC, assignments: [{ target_field_id: 'marker-field' }] };
    const SurfaceProbe = defineComponent({
      props: { input: { type: Object, required: true } },
      setup(_props, { expose }) {
        expose({ finalize: () => marker });
        return () => h('div', { class: 'surface-probe' });
      }
    });
    const session = Object.freeze(createFakeInteractiveSession());
    const createActionConfigSurface = vi.fn(async () => ({
      component: SurfaceProbe,
      props: {},
      bridge: { interactiveSession: session, 'domain:expression': {}, i18n: vi.fn() }
    }));
    const hostApi = createFakeHostApi({ createActionConfigSurface });
    wrapper = mount(NodeConfigDialog, {
      props: {
        show: false,
        node: createActionNode({ actionName: 'data.create_record', params: {} }),
        definition: writeDefinition,
        fields: [],
        scope: writeScope,
        hostApi,
        interactiveSession: session
      },
      attachTo: document.body,
      global: { stubs: { SvgIcon: true, ExpressionEditor: true } }
    });
    await wrapper.setProps({ show: true });
    await flushPromises();
    expect(document.body.querySelector('.surface-probe')).not.toBeNull();

    await clickSave();

    const params = lastSavedParams();
    expect(params.write_v4).toEqual(marker);
    expect(params).not.toHaveProperty('expression');
  });

  it('② 无值时得到空文档：透传给 surface 的 modelValue 与 emptyWriteNodeDocument(\'insert\') 形状一致', async () => {
    let receivedModel: unknown;
    const SurfaceProbe = defineComponent({
      props: { input: { type: Object, required: true } },
      setup(props) {
        receivedModel = (props.input as { props: { modelValue: unknown } }).props.modelValue;
        return () => h('div', { class: 'surface-probe' });
      }
    });
    const session = Object.freeze(createFakeInteractiveSession());
    const hostApi = createFakeHostApi({
      createActionConfigSurface: vi.fn(async () => ({ component: SurfaceProbe, props: {}, bridge: { interactiveSession: session } }))
    });
    wrapper = mount(NodeConfigDialog, {
      props: {
        show: false,
        // 新节点：params 里既无 expression 也无 write_v4。
        node: createActionNode({ actionName: 'data.create_record', params: {} }),
        definition: writeDefinition,
        fields: [],
        scope: writeScope,
        hostApi,
        interactiveSession: session
      },
      attachTo: document.body,
      global: { stubs: { SvgIcon: true, ExpressionEditor: true } }
    });
    await wrapper.setProps({ show: true });
    await flushPromises();

    expect(receivedModel).toEqual(EMPTY_WRITE_V4_DOC);
  });

  it('③ 旧格式节点（仍带 expression、无 write_v4）显示写动作专属失效横幅', async () => {
    const hostApi = createFakeHostApi(); // 默认 createActionConfigSurface resolve null，无关本断言
    wrapper = mount(NodeConfigDialog, {
      props: {
        show: true,
        node: createActionNode({
          actionName: 'data.create_record',
          params: { expression: { schema_version: 1, source: { tables: [], joins: [] }, target: { target_data_table_id: 'x', outputs: [] } } }
        }),
        definition: writeDefinition,
        fields: [],
        scope: writeScope,
        hostApi,
        interactiveSession: createFakeInteractiveSession()
      },
      attachTo: document.body,
      global: { stubs: { SvgIcon: true, ExpressionEditor: true } }
    });
    await flushPromises();

    const text = document.body.textContent ?? '';
    // 写动作专属文案（与取数 extractV4LegacyConfig 不同措辞），逐字摘自 testZhCnFixture.ts。
    expect(text).toContain('此节点使用旧配置格式（已退役），请重新配置写入规则');
  });

  it('④ 配置面挂载失败显示错误态（ncd-v4-surface-error），不回落 3.4 编辑器', async () => {
    const hostApi = createFakeHostApi({
      createActionConfigSurface: vi.fn().mockRejectedValue(new Error('surface load boom'))
    });
    wrapper = mount(NodeConfigDialog, {
      props: {
        show: false,
        node: createActionNode({ actionName: 'data.create_record', params: {} }),
        definition: writeDefinition,
        fields: [],
        scope: writeScope,
        hostApi,
        interactiveSession: createFakeInteractiveSession()
      },
      attachTo: document.body,
      global: {
        stubs: {
          SvgIcon: true,
          // 若代码回退到 3.4 编辑器会挂载这个桩——本用例要断言它绝不出现。
          ExpressionEditor: {
            name: 'ExpressionEditor',
            props: ['modelValue'],
            template: '<div data-testid="structured-expression-editor" />'
          }
        }
      }
    });
    await wrapper.setProps({ show: true });
    await flushPromises();

    expect(document.body.querySelector('[data-testid="ncd-v4-surface-error"]')).not.toBeNull();
    expect(document.body.querySelector('[data-testid="structured-expression-editor"]')).toBeNull();
  });
});
