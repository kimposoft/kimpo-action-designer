/**
 * 触发事件菜单的分组与排序（单一事实源）。
 *
 * 画布「＋事件」下拉按同类锚点收成带子菜单的父项；触发根「触发事件」多选下拉也按
 * 同一份分组显示——两处共用本模块，不各自维护一份。分组与顺序：
 *   新建时/编辑时/查看时 → 「打开」▸ 新建/编辑/查看（子项用短名，父项已表达「打开时」语境）；
 *   办理时 → 独立一项，不进组（紧跟「打开」组之后，语义上是介于"打开"与"保存"之间的独立锚点）；
 *   新建保存前/新建保存后/修改保存前/修改保存后 → 「保存」▸ 四档（子项用事件全名，不再是「保存前/
 *     保存后」这种依赖父项语境的短名——四档并列时短名会撞名，必须各自说清"新建"还是"修改"）；
 *   删除前/删除后       → 「删除」▸ 删除前/删除后；
 *   其余锚点（值变动/点击字段时/手动触发）平铺，排在四组之后。
 * 组内成员按调用方给的 allowed 集合过滤，全被过滤则整组不出现；allowed 里未被顺序表覆盖的锚点
 * （将来新增时）按 SELECTABLE_TRIGGER_EVENT_KEYS 原序补在末尾，不会静默丢失——注意这里改用
 * SELECTABLE 而非 ACTION_TRIGGER_EVENT_KEYS 全量：老保存键 before-save/after-save 已退役出「可选
 * 事件集」，哪怕调用方误把它们塞进 allowed（如载体 manifest 尚未更新声明），也绝不能通过这条兜底
 * 通道漏进菜单——老键只用于读兼容，不再是可选项。scheduled 是否可选由调用方决定（模板侧从 allowed
 * 剔除即可，本模块不做特判）。
 *
 * 本模块只产出「结构 + 文案」的中立条目，由两个消费方各自映射成 NDropdown（children 子菜单，
 * ActionDesigner.vue addEventOptions）或 NSelect（type:'group' 分组，NodeConfigDialog.vue
 * eventOptions）的 options 形状。
 */
import { SELECTABLE_TRIGGER_EVENT_KEYS } from './model';
import type { ActionTriggerEventKey } from './model';
import { eventLabel } from './labels';
import { t as $t } from '../i18n';

/** 组内成员：事件键 + 在组内展示的文案（打开组用短名，其余沿用事件本名）。 */
export interface EventMenuMember {
  key: ActionTriggerEventKey;
  label: string;
}

/** 分组条目：父项文案 + 组内成员（已按 allowed 过滤，至少一项）。 */
export interface EventMenuGroupEntry {
  kind: 'group';
  /** 组键（`group:<名>`），供消费方作 option key；与事件键不同域，不会撞名。 */
  key: string;
  label: string;
  members: EventMenuMember[];
}

/** 平铺条目：单个事件。 */
export interface EventMenuFlatEntry {
  kind: 'flat';
  key: ActionTriggerEventKey;
  label: string;
}

export type EventMenuEntry = EventMenuGroupEntry | EventMenuFlatEntry;

const EVENT_MENU_GROUPS: ReadonlyArray<{
  key: string;
  labelKey: string;
  members: ReadonlyArray<{ key: ActionTriggerEventKey; labelKey?: string }>;
}> = [
  {
    key: 'group:open',
    labelKey: 'actionDesigner.canvas.eventMenuOpen',
    members: [
      { key: 'create-time', labelKey: 'actionDesigner.canvas.eventMenuOpenCreate' },
      { key: 'edit-time', labelKey: 'actionDesigner.canvas.eventMenuOpenEdit' },
      { key: 'view-time', labelKey: 'actionDesigner.canvas.eventMenuOpenView' }
    ]
  },
  {
    key: 'group:save',
    labelKey: 'actionDesigner.canvas.eventMenuSave',
    // 保存组细分四档（新建/修改 × 保存前/保存后）。不设 labelKey 覆盖——四档并列时
    // 必须各自说清"新建"还是"修改"，用事件自身全名（eventLabel 回落）而非组内短名。
    members: [{ key: 'create-before-save' }, { key: 'create-after-save' }, { key: 'edit-before-save' }, { key: 'edit-after-save' }]
  },
  { key: 'group:delete', labelKey: 'actionDesigner.canvas.eventMenuDelete', members: [{ key: 'before-delete' }, { key: 'after-delete' }] }
];

/** 展示顺序：「打开」组 → 「办理时」独立项 → 「保存」组 → 「删除」组，平铺锚点在后。 */
const EVENT_MENU_ORDER: ReadonlyArray<{ group: string } | { key: ActionTriggerEventKey }> = [
  { group: 'group:open' },
  { key: 'handle-time' },
  { group: 'group:save' },
  { group: 'group:delete' },
  { key: 'value-change' },
  { key: 'field-click' },
  { key: 'manual' }
];

/**
 * 按上述分组与顺序产出菜单条目：只含 allowed 里的事件；组内全被过滤则整组不出现；
 * 未被顺序表覆盖的 allowed 事件按 ACTION_TRIGGER_EVENT_KEYS 原序平铺补在末尾。
 * 文案在调用时解析（随语言切换），不缓存。
 */
export function buildEventMenuEntries(allowed: ReadonlySet<ActionTriggerEventKey>): EventMenuEntry[] {
  const groupByKey = new Map(EVENT_MENU_GROUPS.map(group => [group.key, group] as const));
  const covered = new Set<ActionTriggerEventKey>();
  const entries: EventMenuEntry[] = [];
  const pushFlat = (key: ActionTriggerEventKey): void => {
    covered.add(key);
    if (allowed.has(key)) entries.push({ kind: 'flat', key, label: eventLabel(key) });
  };
  const pushGroup = (groupKey: string): void => {
    const group = groupByKey.get(groupKey);
    if (!group) return;
    for (const member of group.members) covered.add(member.key);
    const members = group.members
      .filter(member => allowed.has(member.key))
      .map(member => ({ key: member.key, label: member.labelKey ? $t(member.labelKey) : eventLabel(member.key) }));
    if (members.length > 0) entries.push({ kind: 'group', key: group.key, label: $t(group.labelKey), members });
  };
  for (const entry of EVENT_MENU_ORDER) {
    if ('group' in entry) pushGroup(entry.group);
    else pushFlat(entry.key);
  }
  // 兜底：顺序表没覆盖到的锚点按原序补在末尾——用 SELECTABLE 而非全量，老保存键绝不经此通道漏进菜单
  // （见文件头注释）。
  for (const key of SELECTABLE_TRIGGER_EVENT_KEYS) if (!covered.has(key)) pushFlat(key);
  return entries;
}

/** 把条目摊平成事件键序列（组内按成员顺序），供「某事件是否可选」判定与测试用。 */
export function flattenEventMenuKeys(entries: readonly EventMenuEntry[]): ActionTriggerEventKey[] {
  return entries.flatMap(entry => (entry.kind === 'group' ? entry.members.map(member => member.key) : [entry.key]));
}
