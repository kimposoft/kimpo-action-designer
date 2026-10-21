/**
 * 动作功能分类色盘：动作面板分类页签、动作行分类 tag、画布节点右上角分类 tag
 * 三处共用同一映射，保证同一分类处处同色。
 *
 * 映射规则：四个标准分类（数据/流程/表单/界面）固定占位色盘前四色（语义稳定，不随插件装载
 * 顺序漂移）；插件自定义分类按名称哈希取色盘（确定性——同名分类在任何入口/任何会话同色）。
 * 当前仅提供明亮模式配色。
 */

interface CategoryColor {
  /** 文字/描边色 */
  text: string;
  /** 浅色底（tag 背景） */
  bg: string;
}

/** 色盘（8 色，与表达式 token 配色同族的低饱和文字色 + 同色低透明度底）。 */
const PALETTE: CategoryColor[] = [
  { text: '#2061c4', bg: 'rgba(32, 128, 240, 0.14)' }, // 蓝（数据）
  { text: '#6b41d8', bg: 'rgba(124, 77, 255, 0.14)' }, // 紫（流程）
  { text: '#18914f', bg: 'rgba(24, 160, 88, 0.14)' }, // 绿（表单）
  { text: '#c47d10', bg: 'rgba(240, 160, 32, 0.16)' }, // 橙（界面）
  { text: '#c0357a', bg: 'rgba(214, 51, 132, 0.14)' }, // 粉
  { text: '#0d8f89', bg: 'rgba(16, 185, 178, 0.14)' }, // 青
  { text: '#4f46e5', bg: 'rgba(79, 70, 229, 0.14)' }, // 靛
  { text: '#b3541e', bg: 'rgba(232, 79, 79, 0.14)' } // 红棕
];

/** 标准分类固定占位（与宿主 canonicalActionCategories 的四分类对齐）。 */
const KNOWN_INDEX: Record<string, number> = {
  数据: 0,
  流程: 1,
  表单: 2,
  界面: 3
};

/** 名称稳定哈希（FNV-1a 简化版）：同名分类恒同色。 */
function hashOf(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

/** 取分类颜色：空分类（「其他」兜底）也参与色盘，保证所有 tag 都有色。 */
export function categoryColor(category: string): CategoryColor {
  const key = (category ?? '').trim() || '其他';
  const idx = KNOWN_INDEX[key] ?? hashOf(key) % PALETTE.length;
  return PALETTE[idx];
}
