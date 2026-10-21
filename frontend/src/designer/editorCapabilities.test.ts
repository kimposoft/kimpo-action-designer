import { describe, expect, it } from 'vitest';
import { actionEditorGap, profileForCommand } from './editorCapabilities';
import { validateTree } from './validate';
import { createActionNode, createTriggerRoot } from './model';

// 按模板绑定编辑器档案判定动作是否可用（第三方编辑器经 SDK 声明能力档案）。
describe('editorCapabilities', () => {
  const sw = { editor_commands: ['sheet.switch'] };
  const msg = { editor_commands: ['message.show'] };

  it('P 级命令档案表与 SDK 同口径', () => {
    expect(profileForCommand('sheet.switch')).toBe('sheet-catalog');
    expect(profileForCommand('sheet.print')).toBe('print.basic');
    expect(profileForCommand('chart.set-inline-data')).toBe('chart');
    expect(profileForCommand('preview.custom')).toBe('ai-proposal');
    expect(profileForCommand('message.show')).toBeNull();
    expect(profileForCommand('form.save')).toBeNull();
  });

  it('未加载能力（null）不裁剪；H 级动作恒可用', () => {
    expect(actionEditorGap(sw, null)).toBeNull();
    expect(actionEditorGap(msg, { pluginId: 'x', designerType: 'form', profiles: [], commands: [] })).toBeNull();
  });

  it('第三方编辑器无 sheet-catalog：切换 Sheet 不可用；表格编辑器兼容声明可用', () => {
    expect(actionEditorGap(sw, { pluginId: 'org.example.editor', designerType: 'form', profiles: [], commands: ['form.save'] })).toEqual({
      command: 'sheet.switch',
      profile: 'sheet-catalog'
    });
    expect(
      actionEditorGap(sw, { pluginId: 'com.kimposoft.sheet', designerType: 'spreadsheet', profiles: ['sheet-catalog'], commands: ['sheet.switch'] })
    ).toBeNull();
    // 有档案但静态命令清单未声明该命令：同样不可用；静态命令取不到（null）时只按档案判。
    expect(actionEditorGap(sw, { pluginId: 'p', designerType: 'form', profiles: ['sheet-catalog'], commands: [] })).not.toBeNull();
    expect(actionEditorGap(sw, { pluginId: 'p', designerType: 'form', profiles: ['sheet-catalog'], commands: null })).toBeNull();
  });

  it('画布上已有的不支持节点报错（阻止保存）', () => {
    const root = createTriggerRoot({ eventKey: 'manual', scopes: ['form'] });
    root.children = [createActionNode({ actionName: 'ui.switch_sheet' })];
    const issues = validateTree(root, {
      fieldIds: new Set(),
      asyncable: () => false,
      actionUnsupported: name => (name === 'ui.switch_sheet' ? { command: 'sheet.switch', profile: 'sheet-catalog' } : null)
    });
    expect(issues.some(i => i.level === 'error' && i.message === 'actionDesigner.validate.editorUnsupported')).toBe(true);
  });
});
