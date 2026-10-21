/**
 * 触发根「编辑触发」弹窗四项行为：
 * ① 触发事件下拉点选一项后直接关闭（受控 show，update:value 即收起）；
 * ③ 触发字段下拉按数据表分组、只显示表名与字段名（不带物理列名/字段 id）；
 * ④ 触发事件下拉与画布「＋事件」下拉同一份分组（打开/保存/删除三组 + 平铺，eventMenu.ts）。
 * ②（值变动/点击未设字段则该事件不触发）是编译/宿主既有口径（见 compile.test.ts「触发字段按事件分离」用例），本文件只验
 *   占位文案不宣称「整表单触发」——文案 key 不变，口径由宿主各语言译文承载。
 *
 * 挂载说明同 nodeConfigDialogJobMode.spec.ts：外壳 Teleport 到 body，断言查 findComponent 的 props。
 * 测试环境未注入宿主 i18n，$t 回退 key 原样，文案断言直接比 key。
 */
import { mount } from '@vue/test-utils';
import { h } from 'vue';
import { afterEach, describe, expect, it } from 'vitest';
import { NMessageProvider, NSelect } from 'naive-ui';
import { createFakeHostApi, createFakeInteractiveSession } from './fakeHostApi';
import { createTriggerRoot } from '../model';
import type { MindNode } from '../model';
import type { TemplateDataTable, TemplateField, TemplateFieldGroup } from '../hostTypes';
import NodeConfigDialog from '../NodeConfigDialog.vue';

const hostApi = createFakeHostApi();
const interactiveSession = createFakeInteractiveSession();

function field(id: string, name: string): TemplateField {
  return {
    field_id: id,
    field_code: id,
    field_name: name,
    data_type: 'text',
    display_style: 'default',
    sort_no: 0,
    is_searchable: false,
    is_filterable: false,
    is_sortable: false,
    is_list_visible: true
  };
}
function table(id: string, name: string, role: string): TemplateDataTable {
  return { data_table_id: id, table_code: id, table_name: name, physical_table_name: id, table_role: role, sort_no: 0, field_count: 0, version_no: 1 };
}
const mainFields = [field('fld_po_no', '采购单号'), field('fld_po_date', '采购日期')];
const detailFields = [field('fld_seq', '序号'), field('fld_item', '物料')];
const fieldGroups: TemplateFieldGroup[] = [
  { table: table('tbl_main', '采购单', 'main'), fields: mainFields },
  { table: table('tbl_detail', '采购明细', 'detail'), fields: detailFields }
];

// 挂载写法与 nodeConfigDialogJobMode.spec.ts 同：先 show:false 再翻 true（对齐真实时序，见该文件注释）；
// 外层包 NMessageProvider（对话框内嵌面板用 useMessage）。
async function mountDialog(props: { node: MindNode | null } & Record<string, unknown>) {
  const inner = { show: false, definition: null, fields: [...mainFields, ...detailFields], hostApi, interactiveSession, ...props };
  const wrapper = mount(
    {
      props: { inner: { type: Object, required: true } },
      setup: (p: { inner: Record<string, unknown> }) => () => h(NMessageProvider, null, { default: () => h(NodeConfigDialog, p.inner as never) })
    },
    { props: { inner }, attachTo: document.body, global: { stubs: { SvgIcon: true } } }
  );
  await wrapper.setProps({ inner: { ...inner, show: true } });
  await wrapper.vm.$nextTick();
  return wrapper;
}

afterEach(() => {
  document.body.innerHTML = '';
});

type GroupedOption = { type?: string; key?: string; label?: string; value?: string; children?: Array<{ label: string; value: string }> };

describe('编辑触发弹窗：触发事件下拉分组 + 点选即关 + 触发字段按表分组', () => {
  it('④ 触发事件下拉按「打开/保存/删除」三组 + 平铺，与画布「＋事件」下拉同一份分组', async () => {
    const dialog = await mountDialog({ node: createTriggerRoot({ eventKey: 'manual' }) });
    const eventSelect = dialog.findAllComponents(NSelect)[0];
    const options = eventSelect.props('options') as GroupedOption[];
    // 顶层顺序：「打开」组 → 「办理时」独立项 → 「保存」组（四档） → 「删除」组，
    // 平铺锚点在后；与画布「＋事件」下拉同一份分组（eventMenu.ts 单一事实源）。
    expect(options.map(o => o.key ?? o.value)).toEqual([
      'group:open',
      'handle-time',
      'group:save',
      'group:delete',
      'value-change',
      'field-click',
      'manual'
    ]);
    expect(options[0].type).toBe('group');
    expect(options[0].label).toBe('actionDesigner.canvas.eventMenuOpen');
    expect(options[0].children?.map(c => c.value)).toEqual(['create-time', 'edit-time', 'view-time']);
    // 打开组子项用短名键，与画布下拉一致。
    expect(options[0].children?.map(c => c.label)).toEqual([
      'actionDesigner.canvas.eventMenuOpenCreate',
      'actionDesigner.canvas.eventMenuOpenEdit',
      'actionDesigner.canvas.eventMenuOpenView'
    ]);
    expect(options[2].children?.map(c => c.value)).toEqual(['create-before-save', 'create-after-save', 'edit-before-save', 'edit-after-save']);
    expect(options[3].children?.map(c => c.value)).toEqual(['before-delete', 'after-delete']);
    // 平铺项不带 children，value 直接是事件键。
    expect(options[1]).toMatchObject({ value: 'handle-time' });
    expect(options[1].children).toBeUndefined();
    expect(options[4]).toMatchObject({ value: 'value-change' });
    expect(options[4].children).toBeUndefined();
    // 多选 + 受控展开态 + 自定义 tag 渲染（tag 显示事件全名，见 renderEventTag）。
    expect(eventSelect.props('multiple')).toBe(true);
    expect(typeof eventSelect.props('renderTag')).toBe('function');
  });

  it('① 触发事件下拉点选一项后直接关闭：展开 → update:value → show 翻回 false，且值已写入草稿', async () => {
    const dialog = await mountDialog({ node: createTriggerRoot({ eventKey: 'manual' }) });
    const eventSelect = dialog.findAllComponents(NSelect)[0];
    expect(eventSelect.props('show')).toBe(false);
    eventSelect.vm.$emit('update:show', true);
    await dialog.vm.$nextTick();
    expect(eventSelect.props('show')).toBe(true);

    eventSelect.vm.$emit('update:value', ['manual', 'create-time']);
    await dialog.vm.$nextTick();
    expect(eventSelect.props('show')).toBe(false);
    expect(eventSelect.props('value')).toEqual(['manual', 'create-time']);
  });

  it('③ 触发字段下拉按数据表分组：组头=表名、子项=字段名，不带字段 id；主表组在前', async () => {
    const dialog = await mountDialog({ node: createTriggerRoot({ eventKey: 'value-change' }), fieldGroups });
    // 触发根结构：触发事件多选（index0）→ 值变动触发字段多选（index1）。
    const fieldSelect = dialog.findAllComponents(NSelect)[1];
    expect(fieldSelect.props('multiple')).toBe(true);
    const options = fieldSelect.props('options') as GroupedOption[];
    expect(options.map(o => o.type)).toEqual(['group', 'group']);
    expect(options.map(o => o.label)).toEqual(['采购单', '采购明细']);
    expect(options[0].children).toEqual([
      { label: '采购单号', value: 'fld_po_no' },
      { label: '采购日期', value: 'fld_po_date' }
    ]);
    expect(options[1].children?.map(c => c.label)).toEqual(['序号', '物料']);
    // 任何标签都不再拼接字段 id（原「采购日期 (fld_xxx)」形态退役）。
    for (const child of options.flatMap(o => o.children ?? [])) expect(child.label).not.toContain(child.value);
  });

  it('③ 未传 fieldGroups（旧夹具/未接线）时回落 fields 平铺，同样只显示字段名', async () => {
    const dialog = await mountDialog({ node: createTriggerRoot({ eventKey: 'field-click' }) });
    const fieldSelect = dialog.findAllComponents(NSelect)[1];
    const options = fieldSelect.props('options') as GroupedOption[];
    expect(options.every(o => o.type === undefined)).toBe(true);
    expect(options.map(o => o.label)).toEqual(['采购单号', '采购日期', '序号', '物料']);
    expect(options.map(o => o.value)).toEqual(['fld_po_no', 'fld_po_date', 'fld_seq', 'fld_item']);
  });
});
