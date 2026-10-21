/**
 * ActionDesignerCanvas：打开已有文档时节点一律展开——插件默认收起关键字 params_schema['x-collapse-default']
 * 已退役，设计器不再读取：打开已有动作时提取数据节点不折叠，哪怕没挂子动作。
 * 收起只剩用户本会话手动点出来的一种来源。
 *
 * 挂载策略：节点卡片/连线/详情 popover 与本文件断言无关，一律 stub；节点身份经 ActionNode stub 的 node prop 读取，
 * 收起态经 `.collapse-btn` 字形（展开 −／收起 +）与空出口占位 `.empty-branch-cell` 数量判定。
 */
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import { nextTick } from 'vue';
import ActionDesignerCanvas from '../ActionDesignerCanvas.vue';
import { createActionNode, createTriggerRoot } from '../model';
import type { MindNode } from '../model';
import type { ActionDefinition } from '../hostTypes';

const EXTRACT = 'data.extract_record';
const PLAIN = 'ui.notify';

const stubs = {
  Connectors: true,
  ActionNode: true,
  ConditionNode: true,
  TriggerRootNode: true,
  NodeDetailPopover: true,
  NPopover: true,
  SvgIcon: true
};

function definition(name: string, schema: Record<string, unknown>): ActionDefinition {
  return {
    name,
    title: name,
    source: 'plugin',
    capabilities: {} as ActionDefinition['capabilities'],
    params_schema: { type: 'object', ...schema }
  };
}

/** 提取数据：两个出口，并且仍像 record-controllers 那样声明了已退役的 x-collapse-default——必须被无视。 */
const registryByName = new Map<string, ActionDefinition>([
  [EXTRACT, definition(EXTRACT, { 'x-outcomes': ['filled', 'empty'], 'x-collapse-default': true })],
  [PLAIN, definition(PLAIN, {})]
]);

/** 存量树：a1=提取数据（filled 出口挂了子动作 c1），a2=提取数据（没挂任何子动作）。 */
function loadedTree(rootId: string): MindNode {
  const c1 = createActionNode({ id: `${rootId}-c1`, actionName: PLAIN });
  const a1 = createActionNode({ id: `${rootId}-a1`, actionName: EXTRACT });
  a1.outcomeChildren = { filled: [c1] };
  const a2 = createActionNode({ id: `${rootId}-a2`, actionName: EXTRACT });
  const root = createTriggerRoot({ eventKey: 'manual', scope: 'form', children: [a1, a2] });
  root.id = rootId;
  return root;
}

function mountCanvas(root: MindNode) {
  return mount(ActionDesignerCanvas, {
    props: { root, selectedId: null, registryByName, fieldName: (id: string) => id },
    global: { stubs }
  });
}

/** 画布上已渲染的动作节点 id 集合（经 ActionNode stub 的 node prop）。 */
function renderedActionIds(wrapper: ReturnType<typeof mountCanvas>): string[] {
  return wrapper.findAllComponents({ name: 'ActionNode' }).map(c => (c.props('node') as MindNode).id);
}

function nodeWrap(wrapper: ReturnType<typeof mountCanvas>, nodeId: string) {
  return wrapper.findAll('.node-wrap').find(w => {
    const stub = w.findComponent({ name: 'ActionNode' });
    return stub.exists() && (stub.props('node') as MindNode).id === nodeId;
  });
}

/** 某动作节点收纳钮的字形：'−' 展开 / '+' 收起 / null 无钮。 */
function collapseGlyph(wrapper: ReturnType<typeof mountCanvas>, nodeId: string): string | null {
  const btn = nodeWrap(wrapper, nodeId)?.find('.collapse-btn');
  return btn && btn.exists() ? btn.text() : null;
}

describe('ActionDesignerCanvas · 打开已有文档时节点一律展开，x-collapse-default 不再生效', () => {
  it('声明了默认收起的提取数据节点打开即展开：无子动作的出两个空出口占位、有子动作的子动作可见，钮均为 −', () => {
    const wrapper = mountCanvas(loadedTree('r1'));

    // a1：filled 出口子动作 c1 可见 + empty 出口占位 1 个；a2：filled/empty 两个空占位。合计 3 个占位。
    expect(renderedActionIds(wrapper)).toContain('r1-c1');
    expect(wrapper.findAll('.empty-branch-cell')).toHaveLength(3);
    expect(collapseGlyph(wrapper, 'r1-a1')).toBe('−');
    expect(collapseGlyph(wrapper, 'r1-a2')).toBe('−');
    wrapper.unmount();
  });

  it('切换到另一棵树（root.id 变化=整树装载）同样一律展开', async () => {
    const wrapper = mountCanvas(loadedTree('r1'));
    await wrapper.setProps({ root: loadedTree('r2') });
    await nextTick();

    expect(renderedActionIds(wrapper)).toContain('r2-c1');
    expect(wrapper.findAll('.empty-branch-cell')).toHaveLength(3);
    expect(collapseGlyph(wrapper, 'r2-a1')).toBe('−');
    expect(collapseGlyph(wrapper, 'r2-a2')).toBe('−');
    wrapper.unmount();
  });

  it('用户仍可手动收起再展开（会话覆盖表是唯一的收起来源）', async () => {
    const wrapper = mountCanvas(loadedTree('r1'));
    const a2Btn = () => nodeWrap(wrapper, 'r1-a2')!.find('.collapse-btn');

    await a2Btn().trigger('click');
    await nextTick();
    // a2 收起：它的两个空占位消失，只剩 a1 的 1 个；a1 不受影响。
    expect(collapseGlyph(wrapper, 'r1-a2')).toBe('+');
    expect(wrapper.findAll('.empty-branch-cell')).toHaveLength(1);
    expect(renderedActionIds(wrapper)).toContain('r1-c1');

    await a2Btn().trigger('click');
    await nextTick();
    expect(collapseGlyph(wrapper, 'r1-a2')).toBe('−');
    expect(wrapper.findAll('.empty-branch-cell')).toHaveLength(3);
    wrapper.unmount();
  });
});
