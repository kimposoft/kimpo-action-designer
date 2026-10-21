import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

// ActionDefinition 用本地 hostTypes.ts 的结构声明（字段与宿主线上结构保持一致，见该文件头注释）。
import type { ActionDefinition } from './hostTypes';
import ActionPanel from './ActionPanel.vue';

const action = (name: string, title: string): ActionDefinition => ({
  name,
  title,
  source: 'plugin',
  plugin_id: 'com.kimposoft.formcontrollers',
  capabilities: { asyncable: false, side_effecting: false, expression_based: false }
});

describe('ActionPanel registry identity and search', () => {
  it('按技术名和显示名搜索时保持 data-action-name 稳定身份', async () => {
    const wrapper = mount(ActionPanel, {
      props: { registry: [action('ui.linked_form', '联动表单')] },
      global: { stubs: { NScrollbar: { template: '<div><slot /></div>' }, NEmpty: true } }
    });

    expect(wrapper.findAll('.action-item')).toHaveLength(1);
    expect(wrapper.find('.action-item').attributes('data-action-name')).toBe('ui.linked_form');
    await wrapper.find('.panel-search-btn').trigger('click');
    const input = wrapper.find('.panel-search input');

    await input.setValue('ui.open_form');
    expect(wrapper.findAll('.action-item')).toHaveLength(0);
    await input.setValue('打开表单');
    expect(wrapper.findAll('.action-item')).toHaveLength(0);
    await input.setValue('ui.linked_form');
    expect(wrapper.findAll('[data-action-name="ui.linked_form"]')).toHaveLength(1);
    await input.setValue('联动表单');
    expect(wrapper.findAll('[data-action-name="ui.linked_form"]')).toHaveLength(1);
    expect(wrapper.emitted('addAction')).toBeUndefined();
  });
});

// FIX-B：动作清单不吞错——registryState 三分驱动 NEmpty 的三种空态文案，不再对"加载失败/
// 未就绪/确实无动作"一律显示同一句「暂无可用动作」。$t 未注入宿主 i18n 时按 key 原样返回
// （见 ../i18n.ts），故直接断言 NEmpty 渲染出的描述文本就是对应的 key 本身。
// 注：NEmpty 是具名导出的 naive-ui 组件，非全局注册，`stubs: { NEmpty: true }`
//（按 tag 名字符串匹配）打不中它、仍会渲染真实组件——沿用既有用例同款 stubs 配置（仅
// stub 掉 NScrollbar），直接找真实渲染出的 `.n-empty__description` 断言文本内容。
describe('ActionPanel empty-state registryState 三分', () => {
  const mountEmpty = (registryState?: 'ok' | 'error' | 'not-ready') =>
    mount(ActionPanel, {
      props: { registry: [], registryState },
      global: { stubs: { NScrollbar: { template: '<div><slot /></div>' } } }
    });

  it('registryState 缺省（未传）时沿用既有"确实无动作"文案，不破现状', () => {
    const wrapper = mountEmpty(undefined);
    expect(wrapper.find('.panel-empty .n-empty__description').text()).toBe('actionDesigner.panel.noActions');
  });

  it("registryState='error' 时显示加载失败文案", () => {
    const wrapper = mountEmpty('error');
    expect(wrapper.find('.panel-empty .n-empty__description').text()).toBe('actionDesigner.panel.noActionsError');
  });

  it("registryState='not-ready' 时显示未就绪文案", () => {
    const wrapper = mountEmpty('not-ready');
    expect(wrapper.find('.panel-empty .n-empty__description').text()).toBe('actionDesigner.panel.noActionsNotReady');
  });

  it("registryState='ok' 且清单确实为空时仍是「无动作」文案", () => {
    const wrapper = mountEmpty('ok');
    expect(wrapper.find('.panel-empty .n-empty__description').text()).toBe('actionDesigner.panel.noActions');
  });

  it('registry 非空时不渲染空态，与 registryState 无关', () => {
    const wrapper = mount(ActionPanel, {
      props: { registry: [action('ui.linked_form', '联动表单')], registryState: 'error' },
      global: { stubs: { NScrollbar: { template: '<div><slot /></div>' } } }
    });
    expect(wrapper.find('.panel-empty').exists()).toBe(false);
  });
});

// 当前模板编辑器不支持的动作置灰、不可点击添加、悬停说明原因；其余动作不受影响。
describe('ActionPanel 按编辑器档案置灰', () => {
  it('unsupportedOf 命中的动作置灰且点击不添加', async () => {
    const wrapper = mount(ActionPanel, {
      props: {
        registry: [action('ui.switch_sheet', '切换Sheet'), action('ui.message', '提示语')],
        unsupportedOf: (def: ActionDefinition) => (def.name === 'ui.switch_sheet' ? { command: 'sheet.switch', profile: 'sheet-catalog' } : null)
      },
      global: { stubs: { NScrollbar: { template: '<div><slot /></div>' }, NEmpty: true } }
    });
    const sw = wrapper.find('[data-action-name="ui.switch_sheet"]');
    expect(sw.classes()).toContain('is-unsupported');
    expect(sw.attributes('draggable')).toBe('false');
    expect(sw.attributes('title')).toBe('actionDesigner.panel.editorUnsupported');
    await sw.trigger('click');
    expect(wrapper.emitted('addAction')).toBeUndefined();
    const msg = wrapper.find('[data-action-name="ui.message"]');
    expect(msg.classes()).not.toContain('is-unsupported');
    await msg.trigger('click');
    expect(wrapper.emitted('addAction')).toEqual([['ui.message']]);
  });
});
