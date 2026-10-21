/**
 * NodeConfigDialog onSave 驱动表达式编辑器 finalize()。
 *
 * 背景：动作设计器的 V4 配置面挂载点为 action-config surface 的 <component :is>（经
 * actionConfigSurfaceRef 暴露 finalize）。本用例覆盖 onSave() 里的
 * 收口调用：surface 路径（取数/写动作）与联动表单面板路径——不改 SDK 契约，走 ref + defineExpose
 * 的 duck-typing（可选链保证零破坏）。
 *
 * 旧的顶层 x-editor:'expression' 判据没有插件声明，NodeConfigDialog.vue 已不再支持；「surface 路径」
 * 由本文件的写动作用例、以及 nodeConfigDialogExtractV4Routing.spec.ts 的取数/写动作①号用例覆盖。
 */
import { defineComponent, h } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeHostApi, createFakeInteractiveSession } from './fakeHostApi';
import { createActionNode } from '../model';
import type { ActionDefinition } from '../hostTypes';
import NodeConfigDialog from '../NodeConfigDialog.vue';

const scope = { appId: 'app-1', templateId: 'tpl-1' };

// 写动作（新增数据）顶层 x-editor:'write-v4'，与 kimpo-record-controllers
// create/service.go 的 GetActions 声明口径一致（x-write-operation 与 x-editor 成对声明）。
const writeDefinition: ActionDefinition = {
  name: 'data.create_record',
  title: '新增数据',
  source: 'builtin',
  capabilities: { asyncable: true, side_effecting: true, expression_based: true },
  params_schema: { 'x-editor': 'write-v4', 'x-write-operation': 'insert' }
};

// 联动表单动作：顶层 x-editor:'linked-form' 命中
// NodeConfigDialog.isLinkedFormAction，渲染专用面板 LinkedFormPanel（与上面的 surface 路径互斥）。
const linkedFormDefinition: ActionDefinition = {
  name: 'ui.linked_form',
  title: '联动表单',
  source: 'builtin',
  capabilities: { asyncable: false, side_effecting: true, expression_based: true },
  params_schema: { 'x-editor': 'linked-form' }
};

/** 保存按钮：KDialogFooter 的确认按钮（data-kdlf="confirm"）。 */
async function clickSave(): Promise<void> {
  const button = document.body.querySelector<HTMLButtonElement>('[data-kdlf="confirm"]');
  expect(button).not.toBeNull();
  button!.click();
  await flushPromises();
}

describe('NodeConfigDialog onSave 驱动表达式编辑器 finalize()', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('写动作 surface 路径：write-v4 配置面组件暴露 finalize，保存时用其收口结果写入 write_v4', async () => {
    // 与联动表单路径同一套 finalize 收口机制，验证 onSave 落库键正确指向 write_v4（而非 expression），
    // 呼应 finalizeActionParams 的 v4SurfaceEditor 分支——本用例聚焦「finalize 驱动+落库键」，与
    // nodeConfigDialogExtractV4Routing.spec.ts 写动作组的①号用例是同一断言点的两处覆盖
    // （该文件聚焦路由判定，本文件聚焦 onSave 生命周期）。
    const finalized = { schema_version: 'kimpo.write-node/v4', syntax_profile: 'kimposql.mssql/v1', query: { sources: [], joins: [] }, operation: 'insert', target: {}, assignments: [{ target_field_id: 'f1' }] };
    const SurfaceProbe = defineComponent({
      props: { input: { type: Object, required: true } },
      setup(_props, { expose }) {
        expose({ finalize: () => finalized });
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
    const wrapper = mount(NodeConfigDialog, {
      props: {
        show: false,
        node: createActionNode({ actionName: 'data.create_record', params: {} }),
        definition: writeDefinition,
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

    const saves = wrapper.emitted('saveAction') as Array<[Record<string, unknown>]> | undefined;
    expect(saves).toHaveLength(1);
    const params = saves![0][0].params as Record<string, unknown>;
    expect(params.write_v4).toEqual(finalized);
    expect(params).not.toHaveProperty('expression');
    wrapper.unmount();
  });

  it('联动表单面板路径：LinkedFormPanel 暴露 finalize，保存时用其收口结果写入 linked_form_v4', async () => {
    // 与上面 surface 路径同一套「保存前先收口」机制，但落库键不同：联动表单收口结果直接合并进
    // draft.params.linked_form_v4，不经 setExpressionModel（那会写进 expressionParamKey，键不对）。
    const finalizedDoc = {
      schema_version: 'kimpo.linked-form-node/v4',
      syntax_profile: 'kimposql.mssql/v1',
      query: { sources: [], joins: [], options: { distinct: false, business_timezone: 'UTC' } },
      target: { template_id: 'tpl-target', data_table_id: 'dt-target-main' },
      preview: [],
      prefill: [{ target_field_id: 'f1', fill_strategy: 'overwrite', expression: { expression_id: 'pf_f1', purpose: 'output', source_text: '[本表单主表].[备注]#{r1}', refs: [{ ref_id: 'r1', kind: 'report_field', source_instance_id: 'rpt-x', table_id: 't1', field_id: 'f_src', last_label: '[本表单主表].[备注]' }] } }]
    };
    const LinkedFormProbe = defineComponent({
      props: ['params'],
      setup(_props, { expose }) {
        expose({ finalize: async () => ({ ok: true, doc: finalizedDoc, diagnostics: [] }) });
        return () => h('div', { class: 'linked-form-probe' });
      }
    });
    const hostApi = createFakeHostApi();
    const wrapper = mount(NodeConfigDialog, {
      props: {
        show: true,
        node: createActionNode({ actionName: 'ui.linked_form', params: { link_mode: 'create' } }),
        definition: linkedFormDefinition,
        fields: [],
        scope,
        hostApi,
        interactiveSession: createFakeInteractiveSession()
      },
      attachTo: document.body,
      global: { stubs: { SvgIcon: true, LinkedFormPanel: LinkedFormProbe } }
    });
    await flushPromises();
    expect(document.body.querySelector('.linked-form-probe')).not.toBeNull();

    await clickSave();

    const saves = wrapper.emitted('saveAction') as Array<[Record<string, unknown>]> | undefined;
    expect(saves).toHaveLength(1);
    const params = saves![0][0].params as Record<string, unknown>;
    expect(params.linked_form_v4).toEqual(finalizedDoc);
    wrapper.unmount();
  });

  it('联动表单面板路径：finalize 收口失败（ok:false）时 onSave 中止，不 emit saveAction', async () => {
    const LinkedFormProbe = defineComponent({
      props: ['params'],
      setup(_props, { expose }) {
        expose({
          finalize: async () => ({
            ok: false,
            doc: { schema_version: 'kimpo.linked-form-node/v4', syntax_profile: 'kimposql.mssql/v1', query: { sources: [], joins: [], options: { distinct: false, business_timezone: 'UTC' } }, target: { template_id: '', data_table_id: '' }, preview: [], prefill: [] },
            diagnostics: [{ source: '打开条件', diagnostic: { code: 'BIND_FAILED', phase: 'bind', severity: 'error', message: '本报表下找不到数据表' } }]
          })
        });
        return () => h('div', { class: 'linked-form-probe' });
      }
    });
    const hostApi = createFakeHostApi();
    const wrapper = mount(NodeConfigDialog, {
      props: {
        show: true,
        node: createActionNode({ actionName: 'ui.linked_form', params: { link_mode: 'create' } }),
        definition: linkedFormDefinition,
        fields: [],
        scope,
        hostApi,
        interactiveSession: createFakeInteractiveSession()
      },
      attachTo: document.body,
      global: { stubs: { SvgIcon: true, LinkedFormPanel: LinkedFormProbe } }
    });
    await flushPromises();

    await clickSave();

    // 收口失败：就地报错、不提交保存——不应有 saveAction 事件（不能带着坏文本去
    // 撞后端拿 400，前端此处应先行拦下）。
    expect(wrapper.emitted('saveAction')).toBeUndefined();
    wrapper.unmount();
  });
});
