/**
 * NodeDetailPopover（画布节点右上角 ⓘ 指向详情）取数节点「定义表」视图的挂载用例
 *（版式：左标签列 + 网格线；来源表横向 tag、本报表不列；筛选/填充限高；
 *  目标级三项设置不展示；表达式按 refs 拼回 [表].[字段]）。
 *
 * 判据：
 *   ① 动作节点头部带图标（取数=ph:database，未登记动作=通用 ph:squares-four）+ 节点名 + 分类 tag；
 *   ② 取数节点渲染定义表三行：来源表 tag（不含本报表）/ 筛选条件代码块（带表名）/ 填充胶囊 tab + 三列输出表，
 *      不出现清空 / 自动按行列匹配 / 清理空行；点 tab 切换目标；
 *   ③ 普通动作仍走 nodeSummary 默认行（首行「动作」已由头部承载，去掉），不出现定义表。
 * SvgIcon 是宿主全局组件（宿主 plugin-runtime-components.ts 注册），测试里桩掉，断言只看桩上的 icon 属性。
 */
import { mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ActionDefinition } from '../hostTypes';
import { createActionNode } from '../model';
import NodeDetailPopover from '../nodes/NodeDetailPopover.vue';
import { installTestZhCn } from './testZhCnFixture';

let restoreI18n: () => void;
let wrapper: VueWrapper | undefined;
beforeEach(() => {
  restoreI18n = installTestZhCn();
});
afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
  restoreI18n();
});

const extractDefinition: ActionDefinition = {
  name: 'data.extract_record',
  title: '提取数据',
  source: 'builtin',
  capabilities: { asyncable: true, side_effecting: true, expression_based: true },
  params_schema: { 'x-editor': 'extract-v4' },
  category: '数据'
};

const REF = {
  src: (id: string, field: string) => ({ ref_id: id, kind: 'source_field', source_instance_id: 'cat-1', field_id: field, last_label: `[入库流水].[${field}]` }),
  rpt: (id: string, field: string) => ({ ref_id: id, kind: 'report_field', source_instance_id: 'rpt-1', table_id: 'dt-main', field_id: field, last_label: `[${field}]` })
};

function expr(id: string, text: string, refs: unknown[] = []) {
  return { expression_id: id, purpose: 'filter', source_text: text, refs };
}

const DOC = {
  schema_version: 'kimpo.extract-node/v4',
  syntax_profile: 'kimposql.mssql/v1',
  query: {
    sources: [
      { kind: 'catalog', instance_id: 'cat-1', alias: '入库流水', app_id: 'app', template_id: 'tpl-2', data_table_id: 'dt-src' },
      { kind: 'report', instance_id: 'rpt-1', alias: '采购订单', table_id: 'dt-main', table_role: 'main' },
      { kind: 'staging', instance_id: 'stg-1', alias: '上一步暂存区', producer_node_id: 'n0', output_schema_revision: 'v1' }
    ],
    joins: [],
    filter: expr('f', '[单号]#{r1} = [单号]#{r2}', [REF.src('r1', 'no'), REF.rpt('r2', 'no')]),
    options: { distinct: false, business_timezone: 'UTC' }
  },
  targets: [
    {
      target_id: 't-detail',
      target_data_table_id: 'dt-detail',
      table_role: 'detail',
      clear: { mode: 'mapped', timing: 'before' },
      auto_row_match: false,
      trim_empty_rows_after_fill: true,
      outputs: [{ target_field_id: 'fld_qty', expression: expr('o1', '[数量]#{r1}', [REF.src('r1', 'qty')]), fill_strategy: 'overwrite' }]
    },
    { target_id: 't-main', target_data_table_id: 'dt-main', table_role: 'main', outputs: [] }
  ],
  // column_id 与 name 分离——本夹具带上 column_id 保持与真实文档形状同步
  // （name 仍是显示名 'total'，断言不变）。
  staging_target: { columns: [{ column_id: 'col_total01', name: 'total', expression: expr('s1', 'SUM([金额]#{r1})', [REF.src('r1', 'amount')]) }] }
};

const tableName = (id: string) => ({ 'dt-main': '采购订单', 'dt-detail': '采购明细' })[id] ?? id;
const fieldName = (id: string) => ({ fld_qty: '数量' })[id] ?? id;

type PopoverProps = InstanceType<typeof NodeDetailPopover>['$props'];

function mountPopover(props: PopoverProps): VueWrapper {
  return mount(NodeDetailPopover, { props, global: { stubs: { SvgIcon: true } } });
}

describe('NodeDetailPopover 取数节点指向详情（定义表）', () => {
  it('① 头部：取数图标 + 节点名（自定义名与动作名不同时并列动作名）+ 分类 tag', () => {
    const node = createActionNode({ actionName: 'data.extract_record', name: '拉入库数', params: { extract_v4: DOC } });
    wrapper = mountPopover({ node, definition: extractDefinition, fieldName, tableName });
    const head = wrapper.find('[data-testid="nd-head"]');
    expect(head.exists()).toBe(true);
    expect(head.find('svg-icon-stub').attributes('icon')).toBe('ph:database');
    expect(head.find('.nd-head-title').text()).toBe('拉入库数');
    expect(head.find('.nd-head-sub').text()).toBe('提取数据');
    expect(head.find('.nd-head-cat').text()).toBe('数据');
  });

  it('② 定义表三行：来源表 tag（不含本报表）/ 筛选带表名 / 填充胶囊 tab + 输出表，不带目标级设置', async () => {
    const node = createActionNode({ actionName: 'data.extract_record', params: { extract_v4: DOC } });
    wrapper = mountPopover({ node, definition: extractDefinition, fieldName, tableName });
    expect(wrapper.find('[data-testid="nd-extract-ledger"]').exists()).toBe(true);
    // 左标签列：三段名 + 计数（本报表不计入来源数；填充计数含暂存 tab）
    const labels = wrapper
      .findAll('.nd-lg-k')
      .map(el => [el.find('span:not(.nd-lg-count)').text(), el.find('.nd-lg-count').exists() ? el.find('.nd-lg-count').text() : '']);
    expect(labels).toEqual([
      ['来源表', '2 张'],
      ['筛选条件', ''],
      ['填充', '3 个目标']
    ]);

    const sources = wrapper.find('[data-testid="nd-extract-sources"]');
    const chips = sources.findAll('.nd-chip');
    expect(chips.map(c => c.find('.nd-chip-name').text())).toEqual(['入库流水', '上一步暂存区']);
    expect(chips[0].find('svg-icon-stub').attributes('icon')).toBe('ph:table');
    expect(chips[0].find('.nd-tag').exists()).toBe(false);
    expect(chips[1].find('svg-icon-stub').attributes('icon')).toBe('ph:stack');
    expect(chips[1].find('.nd-tag').text()).toBe('暂存区');
    expect(sources.text()).not.toContain('采购订单');

    // 来源 tag 前置表主题色圆点：cat-1=ttc-0、stg-1=ttc-1（本报表 rpt-1 不占号）
    expect(chips[0].find('.ttc-dot').classes()).toContain('ttc-0');
    expect(chips[1].find('.ttc-dot').classes()).toContain('ttc-1');

    // 筛选：字段引用拼回 [表].[字段]（本报表来源虽不列，其字段仍拼回表名），整条引用一段着色（方案 A）：
    // 来源表带主题色类 ttc-N、本报表带独立色类 ttc-report；表名部件加粗、括号点号部件压暗
    const filter = wrapper.find('[data-testid="nd-extract-filter"] .nd-filter');
    expect(filter.text()).toBe('[入库流水].[单号] = [采购订单].[单号]');
    const segs = filter.findAll('.nd-seg');
    expect(segs.map(el => [el.text(), el.classes().filter(c => c !== 'nd-seg').join(' ')])).toEqual([
      ['[入库流水].[单号]', 'nd-seg-ref ttc-0'],
      ['=', 'nd-seg-text'],
      ['[采购订单].[单号]', 'nd-seg-ref ttc-report']
    ]);
    expect(segs[0].findAll('.nd-part-table').map(el => el.text())).toEqual(['入库流水']);
    expect(segs[0].findAll('.nd-part-punc').map(el => el.text())).toEqual(['[', '].[', ']']);

    const fill = wrapper.find('[data-testid="nd-extract-fill"]');
    const tabs = fill.findAll('.nd-chip-tab');
    expect(tabs.map(tab => tab.find('.nd-chip-tab-name').text())).toEqual(['采购明细', '采购订单', '暂存区']);
    expect(tabs.map(tab => tab.find('.nd-tag').exists() && tab.find('.nd-tag').text())).toEqual(['扩展表', '主表', false]);
    expect(tabs[0].classes()).toContain('is-active');
    // 首个目标：三列表头 + 一行输出；目标级设置三项不出现
    let pane = fill.find('[data-testid="nd-extract-pane"]');
    expect(pane.findAll('.nd-th').map(el => el.text())).toEqual(['目标字段', '表达式', '方式']);
    expect(pane.find('.nd-name').text()).toBe('数量');
    expect(pane.find('.nd-expr').text()).toBe('[入库流水].[数量]');
    expect(pane.find('.nd-expr .nd-seg-ref').classes()).toContain('ttc-0');
    expect(pane.find('.nd-td-strategy .nd-tag').text()).toBe('覆盖');
    expect(fill.text()).not.toContain('清空');
    expect(fill.text()).not.toContain('自动按行列匹配');
    expect(fill.text()).not.toContain('清理空行');
    // 切到主表目标：无输出 → 「未设置」
    await tabs[1].trigger('click');
    pane = fill.find('[data-testid="nd-extract-pane"]');
    expect(tabs[1].classes()).toContain('is-active');
    expect(pane.find('.nd-empty').text()).toBe('未设置');
    // 切到暂存区：两列表头「暂存列 / 表达式」，无填充方式列
    await tabs[2].trigger('click');
    pane = fill.find('[data-testid="nd-extract-pane"]');
    expect(pane.findAll('.nd-th').map(el => el.text())).toEqual(['暂存列', '表达式']);
    expect(pane.find('.nd-name').text()).toBe('total');
    expect(pane.find('.nd-expr').text()).toBe('SUM([入库流水].[金额])');
    expect(pane.find('.nd-td-strategy').exists()).toBe(false);
    // 取数视图不再逐键 JSON 倾倒 params（旧默认行）
    expect(wrapper.text()).not.toContain('schema_version');
  });

  it('取数节点尚未配置（空文档）时三行都显示「未设置」，不抛错', () => {
    const node = createActionNode({ actionName: 'data.extract_record', params: {} });
    wrapper = mountPopover({ node, definition: extractDefinition });
    expect(wrapper.findAll('.nd-empty').map(el => el.text())).toEqual(['未设置', '未设置', '未设置']);
    expect(wrapper.findAll('.nd-lg-count')).toHaveLength(0);
  });

  it('③ 普通动作：通用图标 + 默认行（去掉与头部重复的「动作」行），无定义表', () => {
    const node = createActionNode({ actionName: 'system.probe', source: 'plugin', async: true, params: { field_id: 'fld_qty' } });
    const definition: ActionDefinition = {
      name: 'system.probe',
      title: '探针',
      source: 'plugin',
      capabilities: { asyncable: true, side_effecting: true, expression_based: false }
    };
    wrapper = mountPopover({ node, definition, fieldName });
    expect(wrapper.find('[data-testid="nd-head"] svg-icon-stub').attributes('icon')).toBe('ph:squares-four');
    expect(wrapper.find('.nd-head-title').text()).toBe('探针');
    expect(wrapper.find('.nd-head-cat').text()).toBe('其他');
    expect(wrapper.find('[data-testid="nd-extract-ledger"]').exists()).toBe(false);
    const labels = wrapper.findAll('.nd-row .nd-label').map(el => el.text());
    expect(labels).toEqual(['来源', '执行', 'field_id']);
  });
});

// 第三方数据动作：头部图标按数据动作种类，第三方取数 / 写节点与官方同图标；
// 取数定义表照样按 x-editor 渲染。
describe('NodeDetailPopover 第三方数据动作按种类显示', () => {
  const thirdParty = (name: string, kind: string, editor: string): ActionDefinition => ({
    name,
    title: '第三方动作',
    source: 'plugin',
    plugin_id: 'org.example.data-actions',
    capabilities: { asyncable: true, side_effecting: true, expression_based: true },
    params_schema: { 'x-editor': editor },
    category: '数据',
    operation_kind: kind
  });

  it('第三方 fetch 节点：取数图标 + 定义表', () => {
    const node = createActionNode({ actionName: 'org.example.data-actions.pull', params: { extract_v4: DOC } });
    wrapper = mountPopover({ node, definition: thirdParty('org.example.data-actions.pull', 'fetch', 'extract-v4'), fieldName, tableName });
    expect(wrapper.find('[data-testid="nd-head"] svg-icon-stub').attributes('icon')).toBe('ph:database');
    expect(wrapper.find('[data-testid="nd-extract-ledger"]').exists()).toBe(true);
  });

  it.each([
    ['create', 'ph:plus-square'],
    ['update', 'ph:pencil-simple-line'],
    ['delete', 'ph:trash']
  ])('第三方 %s 节点：头部图标 %s', (kind, icon) => {
    const node = createActionNode({ actionName: 'org.example.data-actions.w', params: {} });
    wrapper = mountPopover({ node, definition: thirdParty('org.example.data-actions.w', kind, 'write-v4') });
    expect(wrapper.find('[data-testid="nd-head"] svg-icon-stub').attributes('icon')).toBe(icon);
  });

  it('不带种类的第三方动作仍用通用图标（不按名字猜）', () => {
    const node = createActionNode({ actionName: 'org.example.data-actions.other', params: {} });
    const definition = { ...thirdParty('org.example.data-actions.other', '', 'none'), operation_kind: undefined };
    wrapper = mountPopover({ node, definition });
    expect(wrapper.find('[data-testid="nd-head"] svg-icon-stub').attributes('icon')).toBe('ph:squares-four');
  });
});
