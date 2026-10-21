/**
 * 条件分支（guard）字段候选范围。
 *
 * 条件分支用 V4 判断表达式，由服务端宿主查询服务求值，`本报表.[表].[字段]` 可跨主表/明细解析，
 * 因此字段候选不收窄到主表：递给条件编辑器的表上下文是本模板全部表（主表在前 + 各扩展表），每表带自己
 * 的字段，来自 hostApi.listTemplateTables/listTemplateFields（不吃拍平后的 guardFields）。
 *
 * 本文件因此钉三件事：**全部表都在**（正向）、**别名与顺序**（bt0/bt1，setScope 信封按它对齐）、
 * **没有误伤触发字段多选**（反向判据原样保留——那两处仍是本组件自绘的下拉，吃的是 fields）。
 *
 * 条件页直接内嵌 AdvancedExpressionPanel（配置页本身就是表达式编辑界面，没有「编辑条件」按钮与弹窗），
 * 故判据直接读内嵌面板的 props。
 *
 * 挂载说明同 nodeConfigDialogJobMode.spec.ts 先例：先 show:false 再 setProps 翻 true（规避
 * resetDraft 的 TDZ 时序脆弱点），弹窗内容经 ActionDesignerDialog 的 Teleport 挂到 document.body。
 */
import { mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { h } from 'vue';
import { NMessageProvider, NSelect } from 'naive-ui';
import { AdvancedExpressionPanel } from '@kimposoft/expression-editor';
import { createFakeHostApi, createFakeInteractiveSession } from './fakeHostApi';
import { createConditionNode, createTriggerRoot } from '../model';
import type { MindNode } from '../model';
import type { TemplateDataTable, TemplateField } from '../hostTypes';
import NodeConfigDialog from '../NodeConfigDialog.vue';

const interactiveSession = createFakeInteractiveSession();
const scope = { appId: 'app-1', templateId: 'tpl-1', templateVersionNo: '1.0' };

// 主表字段 + 扩展表字段各一个：fields（全表，供触发字段沿用）含两者；条件编辑器则按表分开拿。
const mainField: TemplateField = {
  field_id: 'f_main',
  field_code: 'f_main',
  field_name: '主表字段',
  data_type: 'text',
  display_style: 'input',
  sort_no: 0,
  is_searchable: false,
  is_filterable: false,
  is_sortable: false,
  is_list_visible: true
};
const extField: TemplateField = { ...mainField, field_id: 'f_ext', field_code: 'f_ext', field_name: '明细字段' };

function table(id: string, name: string, role: 'main' | 'detail', sortNo: number): TemplateDataTable {
  return {
    data_table_id: id,
    table_code: id,
    table_name: name,
    physical_table_name: id,
    table_role: role,
    sort_no: sortNo,
    field_count: 1,
    version_no: 1
  };
}
const mainTable = table('tbl_main', '主表', 'main', 0);
const extTable = table('tbl_ext', '明细表', 'detail', 1);

/** 目录桩：按宿主接口序返回（后端已按「主表优先 → 设计器拖动排序位」下发），
 *  组件信任接口序不再自排——夹具因此必须模拟真实契约：主表在前。 */
function catalogHostApi() {
  return createFakeHostApi({
    listTemplateTables: vi.fn().mockResolvedValue({ data: { items: [mainTable, extTable] } }),
    listTemplateFields: vi.fn(async (_a: string, _t: string, _v: string | undefined, dataTableId: string) => ({
      data: { items: dataTableId === 'tbl_main' ? [mainField] : [extField] }
    }))
  } as never);
}

async function mountDialog(props: { node: MindNode | null } & Record<string, unknown>) {
  const inner = {
    show: false,
    definition: null,
    fields: [mainField, extField],
    scope,
    hostApi: catalogHostApi(),
    interactiveSession,
    ...props
  };
  const wrapper = mount(
    {
      props: { inner: { type: Object, required: true } },
      setup: (p: { inner: Record<string, unknown> }) => () => h(NMessageProvider, null, { default: () => h(NodeConfigDialog, p.inner as never) })
    },
    { props: { inner }, attachTo: document.body, global: { stubs: { SvgIcon: true } } }
  );
  await wrapper.setProps({ inner: { ...inner, show: true } });
  for (let i = 0; i < 6; i += 1) await wrapper.vm.$nextTick();
  return wrapper;
}

describe('NodeConfigDialog 条件分支字段候选范围', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('递给条件编辑器的表上下文含本模板全部表（主表在前 + 扩展表），不再收窄到主表', async () => {
    const cond = createConditionNode({});
    const wrapper = await mountDialog({ node: cond, guardFields: [mainField] });

    const dlg = wrapper.findComponent(AdvancedExpressionPanel);
    expect(dlg.exists(), '条件页应内嵌表达式面板').toBe(true);
    const formTables = dlg.props('formTables') as Array<{ table: TemplateDataTable; fields: TemplateField[]; alias: string }>;
    expect(formTables.map(t => t.table.data_table_id), '沿宿主接口序：主表在前，扩展表在后').toEqual(['tbl_main', 'tbl_ext']);
    expect(formTables.map(t => t.alias), '别名 bt0..n——同时是 setScope 信封里的 alias，两处必须逐字一致').toEqual(['bt0', 'bt1']);
    const fieldIds = formTables.flatMap(t => t.fields.map(f => f.field_id));
    expect(fieldIds).toContain('f_main');
    expect(fieldIds, '扩展表字段可用（V4 由服务端求值，可跨表解析）').toContain('f_ext');
    // 条件分支仍没有「取数来源表」概念：来源表恒空。
    expect(dlg.props('sourceTables')).toEqual([]);
  });

  it('反向判据：触发字段（值变化）多选仍能选到扩展表字段——未被条件分支的表目录改造误伤', async () => {
    const root = createTriggerRoot({ eventKey: 'value-change' });
    const wrapper = await mountDialog({ node: root, guardFields: [mainField] });

    // 触发根结构：触发事件多选 select（index0）→ 值变化触发字段 select（index1，multiple+filterable）。
    const selects = wrapper.findAllComponents(NSelect);
    const valueChangeFieldSelect = selects[1];
    expect(valueChangeFieldSelect.props('multiple')).toBe(true);
    const options = valueChangeFieldSelect.props('options') as Array<{ value: string }>;
    expect(options.map(o => o.value).sort()).toEqual(['f_ext', 'f_main']);
    expect(options.some(o => o.value === 'f_ext')).toBe(true);
  });
});
