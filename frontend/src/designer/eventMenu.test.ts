/**
 * 触发事件菜单分组（eventMenu.ts）：画布「＋事件」下拉与触发根「触发事件」下拉共用的单一事实源
 * （保存四档细分 + 「办理时」独立项；老保存键不在可选事件集内）。测试环境未注入宿主 i18n，$t 回退 key 原样，文案断言直接比 key。
 */
import { describe, expect, it } from 'vitest';
import { buildEventMenuEntries, flattenEventMenuKeys } from './eventMenu';
import { ACTION_TRIGGER_EVENT_KEYS, SELECTABLE_TRIGGER_EVENT_KEYS } from './model';
import type { ActionTriggerEventKey } from './model';

describe('buildEventMenuEntries', () => {
  it('全量可选锚点（不含 scheduled）：「打开」组→「办理时」独立项→「保存」组（四档全名）→「删除」组，值变动/点击/手动平铺在后', () => {
    const allowed = new Set(SELECTABLE_TRIGGER_EVENT_KEYS.filter(key => key !== 'scheduled'));
    const entries = buildEventMenuEntries(allowed);
    expect(entries.map(e => e.key)).toEqual([
      'group:open',
      'handle-time',
      'group:save',
      'group:delete',
      'value-change',
      'field-click',
      'manual'
    ]);
    expect(entries[0].kind === 'group' && entries[0].members.map(m => m.key)).toEqual(['create-time', 'edit-time', 'view-time']);
    // 打开组子项用短名键；保存组子项用事件全名键（不再套一层组内短名——四档并列时
    // 短名会撞名，必须各自说清"新建"还是"修改"）；删除组沿用事件本名键。
    expect(entries[0].kind === 'group' && entries[0].members.map(m => m.label)).toEqual([
      'actionDesigner.canvas.eventMenuOpenCreate',
      'actionDesigner.canvas.eventMenuOpenEdit',
      'actionDesigner.canvas.eventMenuOpenView'
    ]);
    expect(entries[1]).toEqual({ kind: 'flat', key: 'handle-time', label: 'actionDesigner.events.handleTime' });
    expect(entries[2].kind === 'group' && entries[2].members.map(m => m.key)).toEqual([
      'create-before-save',
      'create-after-save',
      'edit-before-save',
      'edit-after-save'
    ]);
    expect(entries[2].kind === 'group' && entries[2].members.map(m => m.label)).toEqual([
      'actionDesigner.events.createBeforeSave',
      'actionDesigner.events.createAfterSave',
      'actionDesigner.events.editBeforeSave',
      'actionDesigner.events.editAfterSave'
    ]);
    expect(entries[0].label).toBe('actionDesigner.canvas.eventMenuOpen');
    expect(entries[4]).toEqual({ kind: 'flat', key: 'value-change', label: 'actionDesigner.events.valueChange' });
    // 摊平后与全量可选锚点集合一致（顺序不同），无遗漏无多余。
    expect([...flattenEventMenuKeys(entries)].sort()).toEqual([...allowed].sort());
  });

  it('组内成员按 allowed 过滤；全被过滤则整组不出现', () => {
    const allowed = new Set<ActionTriggerEventKey>(['create-time', 'view-time', 'manual']);
    const entries = buildEventMenuEntries(allowed);
    expect(entries.map(e => e.key)).toEqual(['group:open', 'manual']);
    expect(entries[0].kind === 'group' && entries[0].members.map(m => m.key)).toEqual(['create-time', 'view-time']);
  });

  it('顺序表未覆盖的锚点（如 job 模式的 scheduled）按原序平铺补在末尾，不静默丢失', () => {
    const allowed = new Set(SELECTABLE_TRIGGER_EVENT_KEYS);
    const entries = buildEventMenuEntries(allowed);
    expect(entries[entries.length - 1]).toEqual({ kind: 'flat', key: 'scheduled', label: 'actionDesigner.events.scheduled' });
    expect(flattenEventMenuKeys(entries)).toHaveLength(SELECTABLE_TRIGGER_EVENT_KEYS.length);
  });

  // 老保存键 before-save/after-save 已退役出可选事件集，哪怕调用方误把它们塞进
  // allowed（如载体 manifest 尚未更新声明），也绝不能通过"顺序表未覆盖锚点补在末尾"这条兜底通道
  // 漏进菜单——本用例锁死这条约束，覆盖全量 ACTION_TRIGGER_EVENT_KEYS（含老键）作为 allowed 输入。
  it('老保存键即便出现在 allowed 里也绝不进入菜单', () => {
    const allowed = new Set(ACTION_TRIGGER_EVENT_KEYS);
    const entries = buildEventMenuEntries(allowed);
    const flat = flattenEventMenuKeys(entries);
    expect(flat).not.toContain('before-save');
    expect(flat).not.toContain('after-save');
    expect(flat).toHaveLength(SELECTABLE_TRIGGER_EVENT_KEYS.length);
    expect([...flat].sort()).toEqual([...SELECTABLE_TRIGGER_EVENT_KEYS].sort());
  });

  it('allowed 为空 ⇒ 无条目', () => {
    expect(buildEventMenuEntries(new Set())).toEqual([]);
  });
});
