/**
 * NodeConfigDialog 通用参数表单（第三方动作）：biz.Targets 形状的参数渲染字段下拉（按表分组），
 * default 打开即预填并随保存写入，约束显示在控件下方，必填带标记；没有字段目录时字段目标回落 JSON 文本框。
 * 挂载方式沿用 nodeConfigDialogParamLabel.spec.ts（弹窗经 Teleport 挂到 document.body）。
 */
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { createFakeHostApi, createFakeInteractiveSession } from './fakeHostApi';
import { createActionNode } from '../model';
import type { ActionDefinition, TemplateFieldGroup } from '../hostTypes';
import NodeConfigDialog from '../NodeConfigDialog.vue';

const definition: ActionDefinition = {
  name: 'example.fill_field',
  title: 'Fill field',
  source: 'plugin',
  capabilities: { asyncable: false, side_effecting: false, expression_based: false },
  params_schema: {
    type: 'object',
    properties: {
      targets: {
        type: 'array',
        title: 'Target field',
        items: {
          type: 'object',
          properties: { data_table_id: { type: 'string', minLength: 1 }, field_id: { type: 'string', minLength: 1 } },
          required: ['data_table_id', 'field_id'],
          additionalProperties: false
        },
        minItems: 1,
        maxItems: 1
      },
      value: { type: 'string', maxLength: 500, default: 'tp10-default', title: 'Value' }
    },
    required: ['targets', 'value'],
    additionalProperties: false
  }
};

const fieldGroups = [
  {
    table: { data_table_id: 'tbl_main', table_code: 'main', table_name: '主表', physical_table_name: 'x', table_role: 'main', sort_no: 0, field_count: 2 },
    fields: [
      { field_id: 'fld_a', field_code: 'a', field_name: '客户', data_type: 'text', display_style: '101', sort_no: 0, is_searchable: true, is_filterable: true, is_sortable: true, is_list_visible: true },
      { field_id: 'fld_b', field_code: 'b', field_name: '备注', data_type: 'text', display_style: '101', sort_no: 1, is_searchable: true, is_filterable: true, is_sortable: true, is_list_visible: true }
    ]
  }
] as unknown as TemplateFieldGroup[];

async function open(params: Record<string, unknown>, groups?: TemplateFieldGroup[]) {
  const node = createActionNode({ actionName: 'example.fill_field', params });
  const wrapper = mount(NodeConfigDialog, {
    props: { show: false, definition: null, fields: [], fieldGroups: groups, hostApi: createFakeHostApi(), interactiveSession: createFakeInteractiveSession(), node },
    attachTo: document.body,
    global: { stubs: { SvgIcon: true } }
  });
  await wrapper.setProps({ show: true, definition });
  await flushPromises();
  return wrapper;
}

async function clickSave(): Promise<void> {
  const button = document.body.querySelector<HTMLButtonElement>('[data-kdlf="confirm"]');
  expect(button).not.toBeNull();
  button!.click();
  await flushPromises();
}

describe('NodeConfigDialog 通用参数表单', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('targets 渲染字段下拉并回显已选字段名；default 预填随保存写入；约束提示与必填标记', async () => {
    const wrapper = await open({ targets: [{ data_table_id: 'tbl_main', field_id: 'fld_b' }] }, fieldGroups);
    const select = document.body.querySelector('[data-testid="ncd-param-field-targets"]');
    expect(select).not.toBeNull();
    expect(select!.textContent).toContain('备注');
    const text = document.body.textContent ?? '';
    expect(text).toContain('actionDesigner.dialog.genericParam.exactItems');
    expect(text).toContain('actionDesigner.dialog.genericParam.maxLength');
    expect(document.body.querySelectorAll('.n-form-item-label__asterisk').length).toBe(2);
    await clickSave();
    const saves = wrapper.emitted('saveAction') as Array<[{ params: Record<string, unknown> }]> | undefined;
    expect(saves?.[0]?.[0].params).toEqual({ targets: [{ data_table_id: 'tbl_main', field_id: 'fld_b' }], value: 'tp10-default' });
    wrapper.unmount();
  });

  it('已有值不被 default 覆盖；没有字段目录时 targets 回落 JSON 文本框并提示', async () => {
    const wrapper = await open({ value: 'mine' });
    expect(document.body.querySelector('[data-testid="ncd-param-field-targets"]')).toBeNull();
    expect(document.body.querySelector('textarea')).not.toBeNull();
    expect(document.body.textContent).toContain('actionDesigner.dialog.genericParam.fieldTargetsUnavailable');
    await clickSave();
    const saves = wrapper.emitted('saveAction') as Array<[{ params: Record<string, unknown> }]> | undefined;
    expect(saves?.[0]?.[0].params).toEqual({ value: 'mine' });
    wrapper.unmount();
  });
});
