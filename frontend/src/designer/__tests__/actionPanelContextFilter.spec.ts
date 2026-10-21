/**
 * ActionPanel 调色板按声明位过滤：contextFilter='scheduled'（job 模式）时
 * 只展示 capabilities.scheduled_context===true 的动作；contextFilter 缺省/'template' 时不过滤
 * （模板模式零变化）。
 * 面板底部不展示缺席说明（灰字提示行），故本文件相应用例断言 `.panel-scheduled-hint` 不存在。
 */
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import type { ActionDefinition } from '../hostTypes';
import ActionPanel from '../ActionPanel.vue';

function action(name: string, title: string, scheduledContext: boolean): ActionDefinition {
  return {
    name,
    title,
    source: 'builtin',
    capabilities: { asyncable: false, side_effecting: false, expression_based: false, scheduled_context: scheduledContext }
  };
}

const registry: ActionDefinition[] = [
  action('data.extract_record', '提取数据', true),
  action('ui.message', '提示语', false),
  action('ui.print', '打印', false)
];

const stubs = { NScrollbar: { template: '<div><slot /></div>' }, NEmpty: true };

describe('ActionPanel contextFilter', () => {
  it("contextFilter='scheduled'：只展示 scheduled_context===true 的动作，其余被过滤", () => {
    const wrapper = mount(ActionPanel, {
      props: { registry, contextFilter: 'scheduled' },
      global: { stubs }
    });
    const items = wrapper.findAll('.action-item');
    expect(items).toHaveLength(1);
    expect(items[0].attributes('data-action-name')).toBe('data.extract_record');
  });

  it("contextFilter='scheduled' 时不展示面板底部缺席说明", () => {
    const scheduled = mount(ActionPanel, { props: { registry, contextFilter: 'scheduled' }, global: { stubs } });
    expect(scheduled.find('.panel-scheduled-hint').exists()).toBe(false);

    const allScheduled = mount(ActionPanel, {
      props: { registry: [action('a', 'A', true), action('b', 'B', true)], contextFilter: 'scheduled' },
      global: { stubs }
    });
    expect(allScheduled.find('.panel-scheduled-hint').exists()).toBe(false);
  });

  it("contextFilter 缺省（模板模式）：不过滤，展示全部动作，不显示缺席说明（零变化）", () => {
    const wrapper = mount(ActionPanel, { props: { registry }, global: { stubs } });
    expect(wrapper.findAll('.action-item')).toHaveLength(3);
    expect(wrapper.find('.panel-scheduled-hint').exists()).toBe(false);
  });

  // 条件分支使用 V4 判断表达式，定时任务（无表单字段上下文）整体不可用，
  // 「＋条件分支」这个新增入口在 job 模式（contextFilter='scheduled'）下必须隐藏——留着它等于
  // 让用户配出一条永远解析不出引用的死条件。
  it("contextFilter='scheduled'（job 模式）：隐藏「条件分支」新增入口；模板模式照常展示", () => {
    const scheduled = mount(ActionPanel, { props: { registry, contextFilter: 'scheduled' }, global: { stubs } });
    expect(scheduled.find('.primitive').exists()).toBe(false);

    const template = mount(ActionPanel, { props: { registry }, global: { stubs } });
    expect(template.find('.primitive').exists()).toBe(true);
  });

  it('画布上已存在但被过滤掉的动作节点不受调色板过滤影响：registry 本身不被裁剪（面板过滤只影响展示列表，不影响调用方持有的原始清单）', () => {
    mount(ActionPanel, { props: { registry, contextFilter: 'scheduled' }, global: { stubs } });
    // 面板内部按 contextFilteredRegistry 派生展示列表，不修改/替换调用方传入的 registry 数组
    // 本身——画布节点按 registryByName（上游 useActionDesigner.registry，与本面板共享同一份
    // 原始 registry）解析，不会因本面板过滤而把已配置节点判定为"未知动作"。
    expect(registry).toHaveLength(3);
    expect(registry.map(def => def.name)).toEqual(['data.extract_record', 'ui.message', 'ui.print']);
  });
});
