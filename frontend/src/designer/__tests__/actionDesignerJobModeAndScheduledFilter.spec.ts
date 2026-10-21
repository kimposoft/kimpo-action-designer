/**
 * ActionDesigner.vue：job 模式固定单事件 UI + 触发事件下拉两处过滤之二
 * （addEventOptions 排除 scheduled）。
 *
 * 挂载策略：画布/面板/节点配置弹窗与本文件断言无关，一律 stub 掉（避免 SVG 拖拽/表达式编辑器等
 * 重依赖拖慢或引入无关失败面），只验证 ActionDesigner.vue 自身的事件列/新增下拉这层编排逻辑。
 */
import { mount, flushPromises } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import { NDropdown } from 'naive-ui';
import { createFakeHostApi, createFakeInteractiveSession } from './fakeHostApi';
import ActionDesigner from '../ActionDesigner.vue';

const stubs = {
  ActionDesignerCanvas: true,
  ActionPanel: true,
  NodeConfigDialog: true
};
const interactiveSession = createFakeInteractiveSession();

describe('ActionDesigner job 模式与定时触发过滤', () => {
  it('template 模式：addEventOptions 排除 scheduled（两处过滤之一）', async () => {
    const hostApi = createFakeHostApi({
      openActionDocument: async () => ({ data: { template_id: 't', template_version_no: '1.0', actions: null, content_revision: 0, version_no: 0 } })
    });
    const wrapper = mount(ActionDesigner, {
      props: {
        target: { kind: 'template', scope: { appId: 'app_1', templateId: 'tpl_1', templateVersionNo: '1.0' } },
        hostApi,
        interactiveSession,
        sessionEditable: true
      },
      global: { stubs }
    });
    await flushPromises();

    const options = wrapper.findComponent(NDropdown).props('options') as Array<{ key: string; children?: Array<{ key: string }> }>;
    // 下拉分组（打开/保存/删除三组带子菜单），scheduled 的排除要连子项一起看。
    const flatKeys = options.flatMap(o => (o.children ? o.children.map(c => c.key) : [o.key]));
    expect(flatKeys).not.toContain('scheduled');
    // 「＋事件」下拉本身仍在（模板模式不隐藏），佐证上面拿到的的确是 addEventOptions。
    expect(wrapper.find('.ad-event-add').exists()).toBe(true);
  });

  it('template 模式：新增事件下拉按「打开/保存/删除」三组收成子菜单，其余锚点平铺', async () => {
    const hostApi = createFakeHostApi({
      openActionDocument: async () => ({ data: { template_id: 't', template_version_no: '1.0', actions: null, content_revision: 0, version_no: 0 } })
    });
    const wrapper = mount(ActionDesigner, {
      props: {
        target: { kind: 'template', scope: { appId: 'app_1', templateId: 'tpl_1', templateVersionNo: '1.0' } },
        hostApi,
        interactiveSession,
        sessionEditable: true
      },
      global: { stubs }
    });
    await flushPromises();

    const options = wrapper.findComponent(NDropdown).props('options') as Array<{ key: string; label: string; children?: Array<{ key: string; label: string }> }>;
    // 顶层顺序：「打开」组 → 「办理时」独立项 → 「保存」组（四档） → 「删除」组，
    // 平铺锚点在后。
    expect(options.map(o => o.key)).toEqual([
      'group:open',
      'handle-time',
      'group:save',
      'group:delete',
      'value-change',
      'field-click',
      'manual'
    ]);
    expect(options[0].children?.map(c => c.key)).toEqual(['create-time', 'edit-time', 'view-time']);
    expect(options[2].children?.map(c => c.key)).toEqual(['create-before-save', 'create-after-save', 'edit-before-save', 'edit-after-save']);
    expect(options[3].children?.map(c => c.key)).toEqual(['before-delete', 'after-delete']);
    // 「打开」子项用短名键（测试环境 $t 回退 key 原样）；保存组子项用事件全名键。
    expect(options[0].children?.map(c => c.label)).toEqual([
      'actionDesigner.canvas.eventMenuOpenCreate',
      'actionDesigner.canvas.eventMenuOpenEdit',
      'actionDesigner.canvas.eventMenuOpenView'
    ]);
    expect(options[2].children?.map(c => c.label)).toEqual([
      'actionDesigner.events.createBeforeSave',
      'actionDesigner.events.createAfterSave',
      'actionDesigner.events.editBeforeSave',
      'actionDesigner.events.editAfterSave'
    ]);
    // 平铺项不带 children。
    expect(options[1].children).toBeUndefined();
    expect(options[4].children).toBeUndefined();
  });

  it('template 模式：事件项不再有上/下移按钮，操作区含重命名 + 删除按钮（排序改用指针拖动）', async () => {
    const hostApi = createFakeHostApi({
      openActionDocument: async () => ({ data: { template_id: 't', template_version_no: '1.0', actions: null, content_revision: 0, version_no: 0 } })
    });
    const wrapper = mount(ActionDesigner, {
      props: {
        target: { kind: 'template', scope: { appId: 'app_1', templateId: 'tpl_1', templateVersionNo: '1.0' } },
        hostApi,
        interactiveSession,
        sessionEditable: true
      },
      global: { stubs }
    });
    await flushPromises();
    // 空白态：先经下拉新增两个事件，才有事件项可断言。
    const dropdown = wrapper.findComponent(NDropdown);
    dropdown.vm.$emit('select', 'manual');
    dropdown.vm.$emit('select', 'after-save');
    await flushPromises();

    const tabs = wrapper.findAll('.ad-event-tab');
    expect(tabs).toHaveLength(2);
    expect(wrapper.find('.ad-event-move').exists()).toBe(false);
    expect(wrapper.find('.ad-event-move-btn').exists()).toBe(false);
    for (const tab of tabs) {
      const actions = tab.find('.ad-event-actions');
      expect(actions.exists()).toBe(true);
      expect(actions.find('.ad-event-rename-btn').exists()).toBe(true);
      expect(actions.find('.ad-event-close').exists()).toBe(true);
    }
    // 点重命名按钮进入内联编辑：输入框出现、该项操作区随之隐藏（输入框占据标签位）。
    await tabs[0].find('.ad-event-rename-btn').trigger('click');
    await flushPromises();
    expect(wrapper.findAll('.ad-event-tab')[0].find('.ad-event-rename').exists()).toBe(true);
    expect(wrapper.findAll('.ad-event-tab')[0].find('.ad-event-actions').exists()).toBe(false);
  });

  it('job 模式：事件列表恒一项，label 优先任务名；「＋事件」与删除按钮整块隐藏', async () => {
    const hostApi = createFakeHostApi({
      openJobActionDocument: async () => ({ data: { job_definition_id: 'job_1', actions: null, content_revision: 0, version_no: 0 } })
    });
    const wrapper = mount(ActionDesigner, {
      props: {
        target: { kind: 'job', appId: 'app_1', jobId: 'job_1', jobName: '每日汇总任务' },
        hostApi,
        interactiveSession,
        sessionEditable: true
      },
      global: { stubs }
    });
    await flushPromises();

    // 自动 seed 后恰一个事件 tab，label 用任务名。
    const tabs = wrapper.findAll('.ad-event-tab');
    expect(tabs).toHaveLength(1);
    expect(tabs[0].text()).toContain('每日汇总任务');
    // 「＋事件」整块隐藏（不可新增）。
    expect(wrapper.find('.ad-event-add').exists()).toBe(false);
    // 删除按钮（NPopconfirm 触发的 ×）整块隐藏（不可删除固定事件）。
    expect(wrapper.find('.ad-event-close').exists()).toBe(false);
  });

  it('job 模式：无任务名时 label 回落「定时触发」译文 key', async () => {
    const hostApi = createFakeHostApi({
      openJobActionDocument: async () => ({ data: { job_definition_id: 'job_2', actions: null, content_revision: 0, version_no: 0 } })
    });
    const wrapper = mount(ActionDesigner, {
      props: { target: { kind: 'job', appId: 'app_1', jobId: 'job_2' }, hostApi, interactiveSession, sessionEditable: true },
      global: { stubs }
    });
    await flushPromises();

    const tabs = wrapper.findAll('.ad-event-tab');
    expect(tabs).toHaveLength(1);
    // 测试环境未注入宿主 i18n，$t 回退原样返回 key（见插件 i18n.ts）。
    expect(tabs[0].text()).toContain('actionDesigner.events.scheduled');
  });

  it('job 模式：双击定时触发根不弹节点配置弹窗', async () => {
    const hostApi = createFakeHostApi({
      openJobActionDocument: async () => ({ data: { job_definition_id: 'job_3', actions: null, content_revision: 0, version_no: 0 } })
    });
    const wrapper = mount(ActionDesigner, {
      props: {
        target: { kind: 'job', appId: 'app_1', jobId: 'job_3', jobName: '演示任务' },
        hostApi,
        interactiveSession,
        sessionEditable: true
      },
      global: { stubs }
    });
    await flushPromises();

    // job 模式空文档会自动 seed 一个 scheduled 触发根，此时画布上只有它一个节点。
    const canvas = wrapper.findComponent({ name: 'ActionDesignerCanvas' });
    const rootId = (wrapper.vm as unknown as { ctrl: { events: { value: { id: string }[] } } }).ctrl.events.value[0].id;
    // 模拟画布双击该节点（canvas 组件对外抛 edit 事件）。
    canvas.vm.$emit('edit', rootId);
    await flushPromises();

    // 触发根的调度（cron/时区/超时/身份）全在任务表单里配，设计器侧无可配项 ⇒ 不弹窗。
    expect(wrapper.findComponent({ name: 'NodeConfigDialog' }).props('show')).toBe(false);
  });
});
