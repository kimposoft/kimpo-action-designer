/**
 * 打印单据（ui.print）专用面板挂载级回归：
 * - 第一步用与切换Sheet 同款的 Sheet 卡片网格 + 预览图（共用 SheetCardGrid / useSheetThumbnails），不是下拉；
 * - 列出当前模板**全部** sheet（含隐藏、含「可打印」策略位关闭的），按目录顺序；
 * - 只有设置了打印区域（print_area 非空）的卡可选，其余置灰禁点，悬停提示「未设置打印区域」；
 * - 旧插件二进制不产 print_area ⇒ 按「未设置」处理（置灰），不回落放行；
 * - 已选目标即便后来没了打印区域也照样带选中角标（置灰），不自动清空；
 * - 预览图经 hostApi.createSheetThumbnailRenderer 逐张生成，与切换Sheet 同一通路。
 *
 * 反例（典型模板形态，如「销售订单」）：设了打印区域 A1:L30、runtimeAllowPrint 未设置
 * ⇒ 若按 printable 过滤，整个列表为空。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { NTooltip } from 'naive-ui';
import PrintPanel from '../PrintPanel.vue';
import SheetCardGrid from '../SheetCardGrid.vue';
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

/** 目录夹具：覆盖「只设区域」「只开可打印」「隐藏带区域」「旧二进制缺字段」「空白区域」五种形态（index 故意乱序）。 */
const sheets: SheetCatalogEntry[] = [
  { id: 's-allow', name: '只开可打印', index: 1, visible: true, printable: true, print_area: '' },
  { id: 's-area', name: '销售订单', index: 0, visible: true, printable: false, print_area: 'A1:L30' },
  { id: 's-hidden', name: '隐藏打印页', index: 2, visible: false, printable: false, print_area: 'B2:C3' },
  { id: 's-legacy', name: '旧二进制', index: 3, visible: true, printable: true },
  { id: 's-blank', name: '空白区域', index: 4, visible: true, printable: false, print_area: '   ' }
];

const scope = { appId: 'app1', templateId: 'tpl1', templateVersionNo: '1.0', pluginId: 'com.kimposoft.sheet' };

function mountPanel(props: Record<string, unknown> = {}, hostApi = createFakeHostApi()) {
  return mount(PrintPanel, { props: { sheets, params: {}, scope, hostApi, ...props } });
}

const card = (w: ReturnType<typeof mountPanel>, id: string) => w.find(`[data-testid="print-sheet-card-${id}"]`);

describe('PrintPanel（打印单据专用面板）· 打印目标卡片', () => {
  it('第一步是 Sheet 卡片网格（不是下拉），按目录顺序列出全部 sheet', () => {
    const wrapper = mountPanel();
    expect(wrapper.find('[data-testid="print-sheet-select"]').exists()).toBe(false);
    const ids = wrapper.findAll('.scg-card').map(el => el.attributes('data-testid'));
    expect(ids).toEqual([
      'print-sheet-card-s-area',
      'print-sheet-card-s-allow',
      'print-sheet-card-s-hidden',
      'print-sheet-card-s-legacy',
      'print-sheet-card-s-blank'
    ]);
  });

  it('只有设了打印区域的卡可选，其余置灰禁点；状态文字按口径', () => {
    const wrapper = mountPanel();
    const locked = (id: string) => card(wrapper, id).attributes('disabled') !== undefined;
    expect([locked('s-area'), locked('s-allow'), locked('s-hidden'), locked('s-legacy'), locked('s-blank')]).toEqual([
      false,
      true,
      false,
      true,
      true
    ]);
    expect(card(wrapper, 's-area').find('.scg-card-status').text()).toBe('打印区域 A1:L30');
    expect(card(wrapper, 's-allow').find('.scg-card-status').text()).toBe('未设置打印区域');
    expect(card(wrapper, 's-hidden').find('.scg-card-status').text()).toBe('已隐藏 · 打印区域 B2:C3');
  });

  it('置灰卡的 NTooltip 启用并提示「未设置打印区域」，可选卡不启用提示', () => {
    const wrapper = mountPanel();
    const tips = wrapper.findAllComponents(NTooltip);
    // 顺序与卡片一致：s-area / s-allow / s-hidden / s-legacy / s-blank
    expect(tips.map(t => t.props('disabled'))).toEqual([true, false, true, false, false]);
    const grid = wrapper.findComponent(SheetCardGrid);
    const lockedTip = grid.props('lockedTip') as (s: SheetCatalogEntry) => string;
    expect(lockedTip(sheets[0])).toBe('未设置打印区域');
  });

  it('点可选卡：patch sheet_id；点置灰卡不产生 patch', async () => {
    const wrapper = mountPanel();
    await card(wrapper, 's-allow').trigger('click');
    await card(wrapper, 's-area').trigger('click');
    expect(wrapper.emitted('patch')).toEqual([[{ sheet_id: 's-area' }]]);
  });

  it('已选目标后来没了打印区域：仍带选中角标（置灰），不自动清空参数', () => {
    const wrapper = mountPanel({ params: { sheet_id: 's-allow' } });
    const c = card(wrapper, 's-allow');
    expect(c.classes()).toEqual(expect.arrayContaining(['selected', 'locked']));
    expect(c.find('.scg-card-check').exists()).toBe(true);
    expect(wrapper.emitted('patch')).toBeUndefined();
  });

  it('已选可选目标：状态文字为「打印目标」', () => {
    const wrapper = mountPanel({ params: { sheet_id: 's-area' } });
    expect(card(wrapper, 's-area').find('.scg-card-status').text()).toBe('打印目标');
  });

  it('预览图：经 hostApi.createSheetThumbnailRenderer 按目录序逐张生成并上屏', async () => {
    const render = vi.fn(async (sheetId: string) => `data:image/png;base64,${sheetId}`);
    const hostApi = createFakeHostApi({ createSheetThumbnailRenderer: vi.fn().mockResolvedValue(render) } as never);
    const wrapper = mountPanel({}, hostApi);
    await flushPromises();
    expect(hostApi.createSheetThumbnailRenderer).toHaveBeenCalledWith({
      appId: 'app1',
      templateId: 'tpl1',
      templateVersionNo: '1.0',
      pluginId: 'com.kimposoft.sheet'
    });
    expect(render.mock.calls.map(c => c[0])).toEqual(['s-area', 's-allow', 's-hidden', 's-legacy', 's-blank']);
    expect(card(wrapper, 's-area').find('img.scg-thumb-img').attributes('src')).toBe('data:image/png;base64,s-area');
  });

  it('目录为空：不渲染卡片，给空态', () => {
    const wrapper = mountPanel({ sheets: [] });
    expect(wrapper.find('.scg-cards').exists()).toBe(false);
    expect(wrapper.find('.pp-sheet-empty').exists()).toBe(true);
  });
});
