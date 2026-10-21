/**
 * 切换Sheet（ui.switch_sheet）专用面板挂载级回归。
 *
 * 卡片网格与预览图用共用的 SheetCardGrid / useSheetThumbnails（打印单据复用），
 * 切换 Sheet 目标按分区口径判定：
 * - 「仅显示可见Sheet」默认开：隐藏 sheet 不显示；关掉后隐藏 sheet 以置灰卡出现（唯一置灰档）；
 * - 分区成员（堆叠分区 / 页签组成员）**一律可选**，面板不再读 switchable——旧二进制回的 false 是
 *   旧口径（只放行主分区/独立 sheet），读了会把本该可选的成员锁死；
 * - 状态文字按处境分档：切换目标 / 切换页签 / 切到该页签 · 第 N 页 / 定位到该分区 / 已隐藏；
 *   旧二进制（无分区上下文）回落「点击选择」；
 * - 卡片按页签（容器）分组，组标题取 container_label；
 * - 已选目标在目录里定位不到时出「配置已失效」提示条且不自动清空；
 * - 置灰卡**不带**悬停提示（切换面板不传 lockedTip）；
 * - 点可选卡 emit update:value，点置灰卡不 emit；预览图经 hostApi 生成。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { NTooltip } from 'naive-ui';
import SwitchSheetPanel from '../SwitchSheetPanel.vue';
import type { SheetCatalogEntry } from '../hostTypes';
import { createFakeHostApi } from './fakeHostApi';
import { installTestZhCn } from './testZhCnFixture';

let restoreI18n: () => void;
beforeEach(() => {
  restoreI18n = installTestZhCn();
});
afterEach(() => {
  restoreI18n();
});

// 夹具：一个「主分区 + 堆叠分区」容器 + 一个页签组容器 + 一条无分区上下文的旧二进制条目。
// stacked/tabMember 的 switchable 刻意留 false（旧口径值），用来锁住「面板不再读它」。
const sheets: SheetCatalogEntry[] = [
  {
    id: 'main', name: '主表', index: 0, visible: true, printable: false, switchable: true,
    region_role: 'primary', container_id: 'c1', container_index: 0, container_label: '主表',
    region_index: 0, region_count: 2, region_kind: 'leaf', tab_index: -1, tab_count: 0
  },
  {
    id: 'hidden', name: '隐藏页', index: 1, visible: false, printable: false, switchable: true,
    region_role: 'stacked', container_id: 'c1', container_index: 0, container_label: '主表',
    region_index: 1, region_count: 2, region_kind: 'leaf', tab_index: -1, tab_count: 0
  },
  {
    id: 'stacked', name: '堆叠分区', index: 2, visible: true, printable: false, switchable: false,
    region_role: 'stacked', container_id: 'c1', container_index: 0, container_label: '主表',
    region_index: 1, region_count: 2, region_kind: 'leaf', tab_index: -1, tab_count: 0
  },
  {
    id: 'tabMember', name: '页签组第二页', index: 4, visible: true, printable: false, switchable: false,
    region_role: 'tab-member', container_id: 'c2', container_index: 1, container_label: '明细',
    region_index: 0, region_count: 1, region_kind: 'tabs', tab_index: 1, tab_count: 2
  },
  { id: 'legacy', name: '旧二进制', index: 3, visible: true, printable: false }
];
const scope = { appId: 'app1', templateId: 'tpl1', templateVersionNo: '1.0', pluginId: 'com.kimposoft.sheet' };

function mountPanel(props: Record<string, unknown> = {}, hostApi = createFakeHostApi()) {
  return mount(SwitchSheetPanel, { props: { sheets, value: '', scope, hostApi, ...props } });
}
const card = (w: ReturnType<typeof mountPanel>, id: string) => w.find(`[data-testid="sheet-switch-card-${id}"]`);

describe('SwitchSheetPanel（切换Sheet 专用面板）· 抽取共用卡片后行为不变', () => {
  it('默认仅显示可见 sheet；关闭过滤后隐藏 sheet 以置灰卡出现', async () => {
    const wrapper = mountPanel();
    expect(card(wrapper, 'hidden').exists()).toBe(false);
    await wrapper.find('[data-testid="sheet-switch-only-visible"]').trigger('click');
    expect(card(wrapper, 'hidden').exists()).toBe(true);
    expect(card(wrapper, 'hidden').attributes('disabled')).toBeDefined();
    expect(card(wrapper, 'hidden').find('.scg-card-status').text()).toBe('已隐藏');
  });

  it('分区成员一律可选（面板不读 switchable），只有隐藏是置灰档；状态文字按处境分档', () => {
    const wrapper = mountPanel({ value: 'main' });
    // switchable=false 是旧口径遗留值，新面板不读它——堆叠分区与页签组成员都必须可点
    expect(card(wrapper, 'stacked').attributes('disabled')).toBeUndefined();
    expect(card(wrapper, 'tabMember').attributes('disabled')).toBeUndefined();
    expect(card(wrapper, 'legacy').attributes('disabled')).toBeUndefined();
    expect(card(wrapper, 'main').find('.scg-card-status').text()).toBe('切换目标');
    expect(card(wrapper, 'stacked').find('.scg-card-status').text()).toBe('定位到该分区');
    expect(card(wrapper, 'tabMember').find('.scg-card-status').text()).toBe('切到该页签 · 第 2 页');
    // 单条缺分区上下文（混排夹具里的 legacy）按「独立表」处理 = 切换页签；
    // 「整份目录都没有分区上下文」才整体回落通用措辞，见下面旧二进制专用用例。
    expect(card(wrapper, 'legacy').find('.scg-card-status').text()).toBe('切换页签');
    expect(card(wrapper, 'main').classes()).toContain('selected');
  });

  it('主分区（容器首分区代表叶）的状态文字是「切换页签」', () => {
    const wrapper = mountPanel();
    expect(card(wrapper, 'main').find('.scg-card-status').text()).toBe('切换页签');
  });

  it('卡片按页签（容器）分组，组标题取 container_label；无分区上下文的条目归到末尾扁平组', () => {
    const wrapper = mountPanel();
    const labels = wrapper.findAll('.ssp-group-label').map(el => el.text());
    expect(labels).toEqual(['主表', '明细']);
    // 三组：c1（主表/堆叠）、c2（页签组成员）、扁平组（旧二进制）
    const groups = wrapper.findAll('.ssp-group');
    expect(groups).toHaveLength(3);
    expect(groups[0]!.find('[data-testid="sheet-switch-card-main"]').exists()).toBe(true);
    expect(groups[1]!.find('[data-testid="sheet-switch-card-tabMember"]').exists()).toBe(true);
    expect(groups[2]!.find('[data-testid="sheet-switch-card-legacy"]').exists()).toBe(true);
  });

  it('每张表各自独立成容器（常规多 sheet 表单）时不分组——组标题与卡名逐字相同没有信息量', () => {
    const wrapper = mountPanel({
      sheets: [
        {
          id: 'a', name: 'A', index: 0, visible: true, printable: false, switchable: true,
          region_role: 'standalone', container_id: 'ca', container_index: 0, container_label: 'A',
          region_index: 0, region_count: 1, region_kind: 'leaf', tab_index: -1, tab_count: 0
        },
        {
          id: 'b', name: 'B', index: 1, visible: true, printable: false, switchable: true,
          region_role: 'standalone', container_id: 'cb', container_index: 1, container_label: 'B',
          region_index: 0, region_count: 1, region_kind: 'leaf', tab_index: -1, tab_count: 0
        }
      ]
    });
    expect(wrapper.findAll('.ssp-group-label')).toHaveLength(0);
    expect(wrapper.findAll('.ssp-group')).toHaveLength(1);
    // 分区上下文仍在，故状态文字照旧分档（独立表 = 切换页签），只是不分组
    expect(card(wrapper, 'b').find('.scg-card-status').text()).toBe('切换页签');
  });

  it('全部条目都无分区上下文（旧插件二进制）时不分组、不出组标题', () => {
    const wrapper = mountPanel({
      sheets: [
        { id: 'a', name: 'A', index: 0, visible: true, printable: false },
        { id: 'b', name: 'B', index: 1, visible: true, printable: false }
      ]
    });
    expect(wrapper.findAll('.ssp-group-label')).toHaveLength(0);
    expect(wrapper.findAll('.ssp-group')).toHaveLength(1);
    expect(card(wrapper, 'b').attributes('disabled')).toBeUndefined();
    // 整份目录都没有分区上下文：状态文字回落通用措辞（不假装知道处境）
    expect(card(wrapper, 'b').find('.scg-card-status').text()).toBe('点击选择');
  });

  it('已选目标在目录里定位不到时出「配置已失效」提示条，且不自动清空', () => {
    const wrapper = mountPanel({ value: 'deleted_sheet' });
    const banner = wrapper.find('[data-testid="sheet-switch-invalid-target"]');
    expect(banner.exists()).toBe(true);
    expect(banner.text()).toContain('不存在或已被删除');
    // 面板不代用户改值：没有任何 update:value 被 emit
    expect(wrapper.emitted('update:value')).toBeUndefined();
  });

  it('已选目标正常时不出失效提示条', () => {
    const wrapper = mountPanel({ value: 'stacked' });
    expect(wrapper.find('[data-testid="sheet-switch-invalid-target"]').exists()).toBe(false);
  });

  it('置灰卡不带悬停提示（切换面板不传 lockedTip）', () => {
    const wrapper = mountPanel();
    expect(wrapper.findAllComponents(NTooltip).every(t => t.props('disabled') === true)).toBe(true);
  });

  it('点可选卡 emit update:value（含分区成员），点置灰的隐藏卡不 emit', async () => {
    const wrapper = mountPanel();
    await card(wrapper, 'stacked').trigger('click');
    await card(wrapper, 'tabMember').trigger('click');
    await card(wrapper, 'legacy').trigger('click');
    expect(wrapper.emitted('update:value')).toEqual([['stacked'], ['tabMember'], ['legacy']]);

    // 隐藏卡（关掉过滤后才出现）点不动
    await wrapper.find('[data-testid="sheet-switch-only-visible"]').trigger('click');
    await card(wrapper, 'hidden').trigger('click');
    expect(wrapper.emitted('update:value')).toHaveLength(3);
  });

  it('预览图经 hostApi.createSheetThumbnailRenderer 生成（含过滤掉的隐藏 sheet，切换过滤不重渲）', async () => {
    const render = vi.fn(async (sheetId: string) => `data:image/png;base64,${sheetId}`);
    const hostApi = createFakeHostApi({ createSheetThumbnailRenderer: vi.fn().mockResolvedValue(render) } as never);
    const wrapper = mountPanel({}, hostApi);
    await flushPromises();
    expect(render.mock.calls.map(c => c[0])).toEqual(['main', 'hidden', 'stacked', 'legacy', 'tabMember']);
    await wrapper.find('[data-testid="sheet-switch-only-visible"]').trigger('click');
    await flushPromises();
    expect(render).toHaveBeenCalledTimes(5);
    expect(card(wrapper, 'main').find('img.scg-thumb-img').attributes('src')).toBe('data:image/png;base64,main');
  });
});
