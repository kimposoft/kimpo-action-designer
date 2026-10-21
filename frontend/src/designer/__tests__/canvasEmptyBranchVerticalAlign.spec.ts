/**
 * ActionDesignerCanvas：空分支占位胶囊贴在连线终点那一侧（否则纵向布局下箭头尖会悬在
 * 「无数据·空 / 成立·空 / 不成立·空」胶囊上方一截）。
 *
 * 连线终点：横向落在格子左中、纵向落在格子上中（见 Connectors.vue）；占位格 `.empty-branch-cell` 横向按
 * 「左对齐 + 垂直居中」摆胶囊，纵向须切到「贴顶 + 水平居中」——由 `is-vertical` 类承载，本文件钉这一点。
 * 节点卡片 / 连线 / 详情 popover 与断言无关，一律 stub。
 */
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import ActionDesignerCanvas from '../ActionDesignerCanvas.vue';
import { createActionNode, createConditionNode, createTriggerRoot } from '../model';
import type { MindNode } from '../model';
import type { ActionDefinition } from '../hostTypes';

const EXTRACT = 'data.extract_record';

const stubs = {
  Connectors: true,
  ActionNode: true,
  ConditionNode: true,
  TriggerRootNode: true,
  NodeDetailPopover: true,
  NPopover: true,
  SvgIcon: true
};

const registryByName = new Map<string, ActionDefinition>([
  [
    EXTRACT,
    {
      name: EXTRACT,
      title: EXTRACT,
      source: 'plugin',
      capabilities: {} as ActionDefinition['capabilities'],
      params_schema: { type: 'object', 'x-outcomes': ['filled', 'empty'] }
    }
  ]
]);

/** 触发根 → 提取数据（两个空出口）→ 无；另挂一个条件节点（成立/不成立两个空分支）。 */
function tree(): MindNode {
  const extract = createActionNode({ id: 'a1', actionName: EXTRACT });
  const cond = createConditionNode({ id: 'c1', condition: { fieldId: 'fld', op: '>', value: 0 } });
  const root = createTriggerRoot({ eventKey: 'manual', scope: 'form', children: [extract, cond] });
  root.id = 'root';
  return root;
}

function mountCanvas() {
  return mount(ActionDesignerCanvas, {
    props: { root: tree(), selectedId: null, registryByName, fieldName: (id: string) => id },
    global: { stubs }
  });
}

describe('空分支占位胶囊随布局朝向贴连线终点', () => {
  it('横向（默认）：占位格不带 is-vertical；切到纵向后全部占位格带 is-vertical，且连线组件收到 vertical', async () => {
    const wrapper = mountCanvas();
    const cells = wrapper.findAll('.empty-branch-cell');
    expect(cells.length).toBe(4); // 提取数据 filled/empty + 条件 then/else
    expect(cells.every(c => !c.classes().includes('is-vertical'))).toBe(true);

    // 朝向切换按钮：title 走 $t，测试未装宿主译文时回退 key 原样
    const toggle = wrapper.find('button[title="actionDesigner.canvas.toVertical"]');
    expect(toggle.exists()).toBe(true);
    await toggle.trigger('click');

    const after = wrapper.findAll('.empty-branch-cell');
    expect(after.length).toBe(4);
    expect(after.every(c => c.classes().includes('is-vertical'))).toBe(true);
    expect(wrapper.findComponent({ name: 'Connectors' }).props('orientation')).toBe('vertical');

    // 切回横向：类移除
    await wrapper.find('button[title="actionDesigner.canvas.toHorizontal"]').trigger('click');
    expect(wrapper.findAll('.empty-branch-cell').every(c => !c.classes().includes('is-vertical'))).toBe(true);
  });
});
