/**
 * 明细排序（data.sort_detail）专用面板挂载级回归（空态 / 已配置态）：
 * - 未选表：步骤②圆点不点亮、「添加排序字段」禁用、缺省页占位（icon-缺省页2）；
 * - 选表/编辑：patch 产物恒为网关旧形态 targets[]{data_table_id, field_id, order}
 *   （每行冗余携带 data_table_id，换表重置为一条空键）；
 * - 行操作：上下移交换数组序（数组序=优先级）、首行禁上移末行禁下移、
 *   删除到空时 targets=undefined（删键语义，由 patchDetailSortParams 落地）。
 *
 * DetailSortPanel.vue 经 hostApi.listTemplateTables/listTemplateFields 取数（见组件文件头注释），
 * 本文件经 fakeHostApi 的 overrides 提供返回值。
 */
import { describe, expect, it } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { NSelect } from 'naive-ui';
import DetailSortPanel from '../DetailSortPanel.vue';
import { createFakeHostApi } from './fakeHostApi';

const hostApi = createFakeHostApi({
  listTemplateTables: async () => ({
    data: {
      items: [
        { data_table_id: 'dt-main', table_name: '主表', table_role: 'main', sort_no: 0 },
        { data_table_id: 'dt-detail', table_name: '付款计划', table_role: 'extension', extension_mode: 'detail', sort_no: 1 }
      ]
    }
  }) as any,
  listTemplateFields: async () => ({
    data: {
      items: [
        { field_id: 'f1', field_name: '序号' },
        { field_id: 'f2', field_name: '物料名称' },
        { field_id: 'f3', field_name: '金额' }
      ]
    }
  }) as any
});

async function mountPanel(props: Record<string, unknown> = {}) {
  const wrapper = mount(DetailSortPanel, {
    props: { appId: 'app1', templateId: 'tpl1', params: {}, hostApi, ...props },
    global: { stubs: { SvgIcon: true } }
  });
  await flushPromises();
  return wrapper;
}

/** 两条已配置排序键（f1 升序、f2 降序）的 targets 参数。 */
const twoKeys = {
  targets: [
    { data_table_id: 'dt-detail', field_id: 'f1', order: 'asc' },
    { data_table_id: 'dt-detail', field_id: 'f2', order: 'desc' }
  ]
};

describe('DetailSortPanel（明细排序专用面板）', () => {
  it('未选表：步骤②圆点不点亮、添加按钮禁用、缺省页占位', async () => {
    const wrapper = await mountPanel();
    const dots = wrapper.findAll('.ds-dot');
    expect(dots[0].classes()).toContain('active');
    expect(dots[1].classes()).not.toContain('active');
    expect((wrapper.find('[data-testid="add-detail-sort-key"]').element as HTMLButtonElement).disabled).toBe(true);
    expect(wrapper.find('.ds-empty').exists()).toBe(true);
    expect(wrapper.findAll('[data-testid^="detail-sort-key-"]').length).toBe(0);
  });

  it('明细表下拉只列 detail 角色表；选表 patch 重置为一条空排序键', async () => {
    const wrapper = await mountPanel();
    const tableSelect = wrapper.findComponent(NSelect);
    expect(tableSelect.props('options')).toEqual([{ label: '付款计划', value: 'dt-detail' }]);
    const nodeProps = tableSelect.props('nodeProps') as (option: Record<string, unknown>) => Record<string, unknown>;
    expect(nodeProps({ label: '付款计划', value: 'dt-detail' })).toEqual({ 'data-option-value': 'dt-detail' });
    expect(nodeProps({ label: 'dt-label-is-not-an-id' })).toEqual({});
    expect(nodeProps({ label: '空 ID', value: '' })).toEqual({});
    tableSelect.vm.$emit('update:value', 'dt-detail');
    expect(wrapper.emitted('patch')).toEqual([[{ targets: [{ data_table_id: 'dt-detail', field_id: '', order: 'asc' }] }]]);
  });

  it('已配置态：行数/圆点/连线点亮，首行禁上移、末行禁下移', async () => {
    const wrapper = await mountPanel({ params: twoKeys });
    expect(wrapper.findAll('[data-testid^="detail-sort-key-"]').length).toBe(2);
    expect(wrapper.findAll('.ds-dot')[1].classes()).toContain('active');
    expect(wrapper.find('.ds-line').classes()).toContain('active');
    const row0Btns = wrapper.find('[data-testid="detail-sort-key-0"]').findAll('.ds-move-btn');
    const row1Btns = wrapper.find('[data-testid="detail-sort-key-1"]').findAll('.ds-move-btn');
    expect((row0Btns[0].element as HTMLButtonElement).disabled).toBe(true);
    expect((row0Btns[1].element as HTMLButtonElement).disabled).toBe(false);
    expect((row1Btns[1].element as HTMLButtonElement).disabled).toBe(true);
  });

  it('下移首行：patch 交换数组序（数组序=优先级）', async () => {
    const wrapper = await mountPanel({ params: twoKeys });
    await wrapper.find('[data-testid="detail-sort-key-0"]').findAll('.ds-move-btn')[1].trigger('click');
    expect(wrapper.emitted('patch')).toEqual([
      [
        {
          targets: [
            { data_table_id: 'dt-detail', field_id: 'f2', order: 'desc' },
            { data_table_id: 'dt-detail', field_id: 'f1', order: 'asc' }
          ]
        }
      ]
    ]);
  });

  it('字段下拉：被其他排序键占用的字段禁用', async () => {
    const wrapper = await mountPanel({ params: twoKeys });
    const row1FieldSelect = wrapper.find('[data-testid="detail-sort-key-1"]').findComponent(NSelect);
    expect(row1FieldSelect.props('options')).toEqual([
      { label: '序号', value: 'f1', disabled: true },
      { label: '物料名称', value: 'f2', disabled: false },
      { label: '金额', value: 'f3', disabled: false }
    ]);
  });

  it('删除仅剩一行：patch targets=undefined（删键语义，不留空数组）', async () => {
    const wrapper = await mountPanel({
      params: { targets: [{ data_table_id: 'dt-detail', field_id: 'f1', order: 'asc' }] }
    });
    await wrapper.find('[data-testid="detail-sort-key-0"] .ds-key-remove').trigger('click');
    expect(wrapper.emitted('patch')).toEqual([[{ targets: undefined }]]);
  });
});
