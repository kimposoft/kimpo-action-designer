/**
 * 画布节点图标：插件自带的 24×24 线条图标路径表，由 NodeGlyph.vue 渲染。
 *
 * 不走宿主 iconify 离线集合：节点图标是画布核心视觉，自带路径可避免「宿主集合未收录 → 渲染为空」，
 * 也不给宿主增加图标收录负担。所有图形统一写成 path（圆/矩形用弧线/折线表达），描边色取 currentColor。
 */
import { resolveOperationKind, type DataActionKind } from '../dataActionKind';

/** 图标键 → path 列表。 */
export const NODE_ICON_PATHS: Record<string, string[]> = {
  database: ['M4 5a8 3 0 1 0 16 0a8 3 0 1 0 -16 0', 'M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5', 'M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6'],
  plus: ['M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z', 'M12 8v8', 'M8 12h8'],
  pencil: ['M12 20h9', 'M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z'],
  trash: ['M3 6h18', 'M8 6V4h8v2', 'M19 6l-1 14H6L5 6', 'M10 11v6', 'M14 11v6'],
  sort: ['M7 4v16', 'M4 7l3-3 3 3', 'M17 20V4', 'M14 17l3 3 3-3'],
  download: ['M12 3v12', 'M7 10l5 5 5-5', 'M5 21h14'],
  printer: ['M6 9V3h12v6', 'M6 17H5a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-1', 'M7 14h10v7H7z'],
  message: ['M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12Z'],
  form: ['M6 3h12a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z', 'M8 8h8', 'M8 12h8', 'M8 16h5'],
  link: ['M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7', 'M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7'],
  tabs: ['M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z', 'M3 9h18', 'M9 4v5'],
  sliders: ['M4 6h10', 'M18 6h2', 'M4 12h4', 'M12 12h8', 'M4 18h12', 'M14 4v4', 'M8 10v4', 'M16 16v4'],
  flow: ['M3 6a3 3 0 1 0 6 0a3 3 0 1 0 -6 0', 'M15 18a3 3 0 1 0 6 0a3 3 0 1 0 -6 0', 'M9 6h4a4 4 0 0 1 4 4v5'],
  grid: ['M4 4h7v7H4z', 'M13 4h7v7h-7z', 'M4 13h7v7H4z', 'M13 13h7v7h-7z'],
  bolt: ['M13 2 4 14h7l-1 8 9-12h-7Z'],
  clock: ['M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0', 'M12 7v5l3 2'],
  branch: ['M6 3v12', 'M15 6a3 3 0 1 0 6 0a3 3 0 1 0 -6 0', 'M3 18a3 3 0 1 0 6 0a3 3 0 1 0 -6 0', 'M18 9a9 9 0 0 1-9 9'],
  field: ['M4 7V5h16v2', 'M9 19h6', 'M12 5v14'],
  filter: ['M3 4h18l-7 8v6l-4 2v-8Z'],
  alert: ['M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0', 'M12 8v5', 'M12 16h.01']
};

/**
 * 数据动作种类 → 图标键：取数 / 新增 / 修改 / 删除
 * 按种类出图标，第三方数据动作与官方同图标；种类优先于动作名（官方四个名字经兼容表解析出种类）。
 */
const KIND_ICON: Record<DataActionKind, string> = {
  fetch: 'database',
  create: 'plus',
  update: 'pencil',
  delete: 'trash'
};

/** 已知动作 → 图标键（精确匹配，数据动作已改按种类见 KIND_ICON）。 */
const ACTION_ICON: Record<string, string> = {
  'data.extract': 'database',
  'data.sort_detail': 'sort',
  'data.export': 'download',
  'ui.print': 'printer',
  'ui.message': 'message',
  'ui.open_form': 'form',
  'ui.fill_form': 'form',
  'ui.linked_form': 'link',
  'ui.switch_sheet': 'tabs',
  'ui.form_control': 'sliders'
};

/** 动作名前缀 → 图标键（插件动作按命名空间兜底）。 */
const PREFIX_ICON: Array<[string, string]> = [
  ['workflow.', 'flow'],
  ['im.', 'message'],
  ['data.', 'database'],
  ['ui.', 'tabs']
];

/** 标准分类 → 图标键（与 categoryColors 的四分类对齐）。 */
const CATEGORY_ICON: Record<string, string> = { 数据: 'database', 流程: 'flow', 表单: 'form', 界面: 'tabs' };

/**
 * 动作节点图标：数据动作种类 → 精确动作名 → 名称前缀 → 功能分类 → 通用宫格。
 * operationKind 由调用方按动作目录解析（resolveOperationKind）；缺省时按官方兼容表解析种类，再按名字逐级兜底（旧调用方不变）。
 */
export function actionIconKey(
  actionName: string | undefined,
  category: string | undefined,
  operationKind?: DataActionKind
): string {
  const name = actionName ?? '';
  const kind = operationKind ?? resolveOperationKind(name);
  if (kind) return KIND_ICON[kind];
  if (ACTION_ICON[name]) return ACTION_ICON[name];
  const prefix = PREFIX_ICON.find(([p]) => name.startsWith(p));
  if (prefix) return prefix[1];
  return CATEGORY_ICON[(category ?? '').trim()] ?? 'grid';
}
