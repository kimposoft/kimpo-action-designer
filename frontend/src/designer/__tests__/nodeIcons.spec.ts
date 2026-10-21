/** 画布节点图标选择（精确动作名 → 名称前缀 → 功能分类 → 通用宫格），以及每个键都有路径。 */
import { describe, expect, it } from 'vitest';
import { NODE_ICON_PATHS, actionIconKey } from '../nodes/nodeIcons';

describe('actionIconKey', () => {
  it('按精确动作名 → 前缀 → 分类 → 宫格依次回落', () => {
    expect(actionIconKey('data.update_record', '数据')).toBe('pencil');
    expect(actionIconKey('workflow.start_instance', undefined)).toBe('flow');
    expect(actionIconKey('vendor.custom', '表单')).toBe('form');
    expect(actionIconKey('vendor.custom', '自定义')).toBe('grid');
    expect(actionIconKey(undefined, undefined)).toBe('grid');
  });

  it('选出的图标键都在路径表内', () => {
    for (const name of ['data.extract_record', 'ui.print', 'ui.switch_sheet', 'im.message', 'x']) {
      expect(NODE_ICON_PATHS[actionIconKey(name, '')]).toBeDefined();
    }
  });

  // 数据动作按种类出图标，第三方与官方同图标；种类优先于名字前缀与分类。
  it('按数据动作种类出图标（第三方与官方同口径）', () => {
    expect(actionIconKey('org.example.x.pull', '自定义', 'fetch')).toBe('database');
    expect(actionIconKey('org.example.x.new', undefined, 'create')).toBe('plus');
    expect(actionIconKey('org.example.x.close', '表单', 'update')).toBe('pencil');
    expect(actionIconKey('org.example.x.drop', undefined, 'delete')).toBe('trash');
    // 未给种类：官方名经兼容表解析，第三方名按前缀 / 分类兜底。
    expect(actionIconKey('data.delete_record', undefined)).toBe('trash');
    expect(actionIconKey('org.example.x.close', '表单')).toBe('form');
  });
});
