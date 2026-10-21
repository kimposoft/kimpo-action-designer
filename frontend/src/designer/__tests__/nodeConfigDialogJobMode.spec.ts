/**
 * NodeConfigDialog job 模式 + 触发事件下拉两处过滤之一：
 * - 条件页在 job 模式下只给「定时模式不支持条件分支」提示，不渲染内嵌表达式编辑面板：
 *   条件分支用 V4 判断表达式（宿主查询服务求值），定时任务无表单字段上下文 ⇒ 引用无从解析，整体不可用；
 * - 触发根事件多选下拉（eventOptions）：template 模式排除 scheduled，job 模式保留。
 *
 * 挂载说明：NodeConfigDialog 用 ActionDesignerDialog（Teleport to body）作外壳，show=true 时
 * 内容渲染进真实 document.body（非 wrapper.element 子树），故本文件断言一律查 document.body
 * （与该 Teleport 的既有实现一致，不是测试技巧变通）。
 */
import { mount } from '@vue/test-utils';
import { h } from 'vue';
import { afterEach, describe, expect, it } from 'vitest';
import { NMessageProvider, NSelect, NSwitch } from 'naive-ui';
import { createFakeHostApi, createFakeInteractiveSession } from './fakeHostApi';
import { createConditionNode, createTriggerRoot } from '../model';
import type { MindNode } from '../model';
import NodeConfigDialog from '../NodeConfigDialog.vue';

const hostApi = createFakeHostApi();
const interactiveSession = createFakeInteractiveSession();

/**
 * 挂载时先 show:false 再 setProps 翻到 true——与真实用法一致（ActionDesigner.vue 的
 * dialogOpen 恒起始 false，双击节点才翻 true）：resetDraft 由 `watch([show, node.id],
 * {immediate:true})` 驱动，immediate 回调在 setup() 期同步执行；若初始 props 就是 show:true，
 * 该回调会抢在脚本里位于其后的 `const extract = reactive(...)` 声明执行之前跑
 * （resetDraft→parseExtraction 读 extract），命中 TDZ 报错——这是该文件的既有时序脆弱点，
 * 现实中从未触发（真实调用方从不会以 show:true 挂载），测试按真实时序驱动以规避，而非改源码掩盖。
 *
 * 条件页本身就是表达式编辑界面（内嵌 ConditionV4Editor，无需再点按钮打开弹窗），
 * 判据钉 data-testid="condition-panel" 与文案 key。
 */
// NMessageProvider：弹窗内多处子组件用 useMessage()，缺 provider 挂载即抛。运行时宿主根部提供了
// 这个 provider，测试里显式包一层对齐。
async function mountDialog(props: { node: MindNode | null } & Record<string, unknown>) {
  const inner = { show: false, definition: null, fields: [], hostApi, interactiveSession, ...props };
  const wrapper = mount(
    {
      props: { inner: { type: Object, required: true } },
      setup: (p: { inner: Record<string, unknown> }) => () => h(NMessageProvider, null, { default: () => h(NodeConfigDialog, p.inner as never) })
    },
    { props: { inner }, attachTo: document.body, global: { stubs: { SvgIcon: true } } }
  );
  await wrapper.setProps({ inner: { ...inner, show: true } });
  return wrapper;
}

describe('NodeConfigDialog job 模式', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('job 模式：条件分支整体不可用——只给不支持提示，不渲染内嵌编辑面板', async () => {
    const cond = createConditionNode({ condition: { fieldId: '', op: '>', value: 0 } });
    // createConditionNode 会从 condition 合成 guided 单条 guardSpec 镜像；模拟"全新节点"场景须
    // 显式清空 guardSpec，只留 legacy condition。
    cond.guardSpec = undefined;
    cond.condition = undefined;
    const wrapper = await mountDialog({ node: cond, designerMode: 'job' });
    await wrapper.vm.$nextTick();

    // 测试环境未注入宿主 i18n（setHostI18n 未调用），$t 按插件 i18n.ts 的回退语义原样返回
    // key——直接断言 key 存在即等价于断言该文案被渲染（回退链见 ../i18n.ts）。
    expect(document.body.textContent).toContain('actionDesigner.dialog.conditionJobUnsupported');
    expect(document.body.querySelector('[data-testid="condition-panel"]')).toBeNull();
  });

  it('模板模式（designerMode 缺省）条件节点：直接内嵌表达式编辑面板，无 job 不支持提示', async () => {
    const cond = createConditionNode({ condition: { fieldId: '', op: '>', value: 0 } });
    const wrapper = await mountDialog({ node: cond, scope: { appId: 'app-1', templateId: 'tpl-1' } });
    await wrapper.vm.$nextTick();

    expect(document.body.querySelector('[data-testid="condition-panel"]')).not.toBeNull();
    expect(document.body.textContent).not.toContain('actionDesigner.dialog.conditionJobUnsupported');
  });

  it('job 模式下已是 guided 的旧节点（异常/回读路径）：同样只给不支持提示，不显示旧内容', async () => {
    const cond = createConditionNode({ guardSpec: { mode: 'guided', guided: { logic: 'and', items: [{ fieldId: 'f1', op: '>', value: 0 }] } } });
    const wrapper = await mountDialog({ node: cond, designerMode: 'job' });
    await wrapper.vm.$nextTick();

    expect(document.body.textContent).toContain('actionDesigner.dialog.conditionJobUnsupported');
    expect(document.body.textContent).not.toContain('actionDesigner.dialog.conditionLegacyFormat');
  });

  // 触发事件下拉按「打开/保存/删除」分组（NSelect type:'group'，与画布「＋事件」下拉共用
  // eventMenu.ts），读 options 时要把组内 children 摊平再看某事件是否可选。
  type EventSelectOption = { value?: string; children?: Array<{ value: string }> };
  const flatValues = (options: EventSelectOption[]): string[] => options.flatMap(o => (o.children ? o.children.map(c => c.value) : o.value ? [o.value] : []));

  it('触发根事件多选：template 模式排除 scheduled，job 模式保留', async () => {
    const root = createTriggerRoot({ eventKey: 'manual' });
    // 直接读 NSelect 的 options prop（:value="draft.eventKeys" multiple :options="eventOptions"）
    // 比模拟下拉展开更稳（不依赖 naive-ui 下拉的 Teleport/动画时序），且断言的正是 eventOptions
    // 计算属性本身的过滤结果。
    const templateWrapper = await mountDialog({ node: root });
    const templateOptions = templateWrapper.findComponent(NSelect).props('options') as EventSelectOption[];
    expect(flatValues(templateOptions)).not.toContain('scheduled');

    const jobWrapper = await mountDialog({ node: root, designerMode: 'job' });
    const jobOptions = jobWrapper.findComponent(NSelect).props('options') as EventSelectOption[];
    expect(flatValues(jobOptions)).toContain('scheduled');
  });

  // 记录页事件（before-delete/after-delete）与上面 scheduled 的可见性刚好相反——
  // 同一 eventOptions 计算属性，同一组挂载，追加对称断言（不改上面已有的 scheduled 断言）。
  it('触发根事件多选：记录页事件（before-delete/after-delete）template 模式出现，job 模式排除', async () => {
    const root = createTriggerRoot({ eventKey: 'manual' });
    const templateWrapper = await mountDialog({ node: root });
    const templateValues = flatValues(templateWrapper.findComponent(NSelect).props('options') as EventSelectOption[]);
    expect(templateValues).toContain('before-delete');
    expect(templateValues).toContain('after-delete');

    const jobWrapper = await mountDialog({ node: root, designerMode: 'job' });
    const jobValues = flatValues(jobWrapper.findComponent(NSelect).props('options') as EventSelectOption[]);
    expect(jobValues).not.toContain('before-delete');
    expect(jobValues).not.toContain('after-delete');
  });

  // 可阻断开关：可见性与 BLOCKABLE_EVENT_KEYS（保存事件四档细分后的
  // create-before-save/edit-before-save + before-delete）求交集，标签用通用 key——老保存键 before-save 已退役出
  // 可选事件集，不再是本判据的输入（真实链路里旧文档打开即被 compile.ts 迁移为新两档，不会再以
  // 裸 before-save 出现在草稿 eventKeys 里）。
  it('可阻断开关：create-before-save/edit-before-save/before-delete 均可见，manual 等其它事件不可见', async () => {
    const createBeforeSaveRoot = createTriggerRoot({ eventKey: 'create-before-save' });
    const createBeforeSaveWrapper = await mountDialog({ node: createBeforeSaveRoot });
    expect(createBeforeSaveWrapper.findComponent(NSwitch).exists()).toBe(true);
    // 通用 key 生效（旧的 blockableBeforeSave 写死"保存前"文案已不再被引用）。
    expect(document.body.textContent).toContain('actionDesigner.dialog.blockable');
    expect(document.body.textContent).not.toContain('actionDesigner.dialog.blockableBeforeSave');

    const editBeforeSaveRoot = createTriggerRoot({ eventKey: 'edit-before-save' });
    const editBeforeSaveWrapper = await mountDialog({ node: editBeforeSaveRoot });
    expect(editBeforeSaveWrapper.findComponent(NSwitch).exists()).toBe(true);

    const beforeDeleteRoot = createTriggerRoot({ eventKey: 'before-delete' });
    const beforeDeleteWrapper = await mountDialog({ node: beforeDeleteRoot });
    expect(beforeDeleteWrapper.findComponent(NSwitch).exists()).toBe(true);

    // 保存后两档（非阻断钩子）与 manual 均不应出现可阻断开关。
    const createAfterSaveRoot = createTriggerRoot({ eventKey: 'create-after-save' });
    const createAfterSaveWrapper = await mountDialog({ node: createAfterSaveRoot });
    expect(createAfterSaveWrapper.findComponent(NSwitch).exists()).toBe(false);

    const manualRoot = createTriggerRoot({ eventKey: 'manual' });
    const manualWrapper = await mountDialog({ node: manualRoot });
    expect(manualWrapper.findComponent(NSwitch).exists()).toBe(false);
  });
});
