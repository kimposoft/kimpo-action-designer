/**
 * TriggerRootNode.vue 画布触发根「流程步骤门」徽标。
 *
 * 覆盖：徽标计数（steps 数 + notStarted?1:0）、含失效条目时改判为琥珀色 gateDead 展示、
 * 拿不到目录（workflowStepCatalog 缺省/null）时不判失效只显示数量、门为空时徽标不渲染。
 *
 * 参数断言技巧：插件本地 i18n.ts 的 $t 在未注入宿主译文时回退 key 原样、丢弃插值参数（见该文件
 * 头注），无法从渲染文本里直接读出 count 数值——这里用一个"回显 key+params"的假宿主 i18n（经
 * setHostI18n 注入）替代默认回退，使 gateBadge({count}) 的实际 count 值可被断言到，afterEach 复原
 * 单例（同 testZhCnFixture.ts 的既有约定）。
 */
import { mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTriggerRoot } from '../model';
import type { WorkflowGateStep } from '../model';
import type { WorkflowStepCatalogDefinition } from '../hostTypes';
import { setHostI18n } from '../../i18n';
import TriggerRootNode from '../nodes/TriggerRootNode.vue';

// setHostI18n 是模块级单例，须逐用例重装（不能只在文件顶层装一次）——上一条用例结束后
// afterEach 已复原为 undefined，下一条用例若不重装会静默回落 key 原样，首次踩过见本文件调试记录。
beforeEach(() => setHostI18n({ t: (key, params) => (params ? `${key}::${JSON.stringify(params)}` : key) }));
afterEach(() => setHostI18n(undefined));

const catalog: WorkflowStepCatalogDefinition[] = [
  {
    definition_id: 'wf1',
    name: '采购审批',
    status: 'enabled',
    latest_version_no: 2,
    steps: [
      { node_id: 'n1', node_kind: 'START', node_name: '发起' },
      { node_id: 'n2', node_kind: 'APPROVE', node_name: '审批' }
    ]
  }
];

function stepsGate(steps: WorkflowGateStep[], notStarted = false) {
  return { notStarted, steps };
}

describe('TriggerRootNode 流程步骤门徽标', () => {
  it('门为空：不渲染徽标', () => {
    const node = createTriggerRoot({ eventKey: 'manual' });
    const wrapper = mount(TriggerRootNode, { props: { node, workflowStepCatalog: catalog } });
    expect(wrapper.find('.badge-gate').exists()).toBe(false);
  });

  it('徽标计数 = steps 数 + notStarted?1:0，全部有效时主色底（无 is-dead）', () => {
    const node = createTriggerRoot({ eventKey: 'manual' });
    node.workflowGate = stepsGate(
      [
        { definitionId: 'wf1', nodeId: 'n1', arrivals: ['submitted', 'returned'] },
        { definitionId: 'wf1', nodeId: 'n2', arrivals: ['submitted', 'returned'] }
      ],
      true
    );
    const wrapper = mount(TriggerRootNode, { props: { node, workflowStepCatalog: catalog } });
    const badge = wrapper.find('.badge-gate');
    expect(badge.exists()).toBe(true);
    expect(badge.classes()).not.toContain('is-dead');
    expect(badge.text()).toBe(`actionDesigner.node.gateBadge::${JSON.stringify({ count: 3 })}`);
  });

  it('含失效条目：徽标改判琥珀色（is-dead），显示 gateDead 而非计数', () => {
    const node = createTriggerRoot({ eventKey: 'manual' });
    node.workflowGate = stepsGate([
      { definitionId: 'wf1', nodeId: 'n1', arrivals: ['submitted', 'returned'] },
      { definitionId: 'wf1', nodeId: 'gone', arrivals: ['submitted', 'returned'] } // 目录里不存在 ⇒ 失效
    ]);
    const wrapper = mount(TriggerRootNode, { props: { node, workflowStepCatalog: catalog } });
    const badge = wrapper.find('.badge-gate');
    expect(badge.exists()).toBe(true);
    expect(badge.classes()).toContain('is-dead');
    expect(badge.text()).toBe('actionDesigner.node.gateDead');
  });

  it('拿不到目录（workflowStepCatalog 缺省）：不判失效，只显示数量（即便引用的步骤实际已不存在）', () => {
    const node = createTriggerRoot({ eventKey: 'manual' });
    node.workflowGate = stepsGate([{ definitionId: 'wf1', nodeId: 'gone', arrivals: ['submitted', 'returned'] }]);
    const wrapper = mount(TriggerRootNode, { props: { node } }); // 未传 workflowStepCatalog
    const badge = wrapper.find('.badge-gate');
    expect(badge.exists()).toBe(true);
    expect(badge.classes()).not.toContain('is-dead');
    expect(badge.text()).toBe(`actionDesigner.node.gateBadge::${JSON.stringify({ count: 1 })}`);
  });

  it('workflowStepCatalog 显式为 null（同缺省语义）：同样不判失效', () => {
    const node = createTriggerRoot({ eventKey: 'manual' });
    node.workflowGate = stepsGate([{ definitionId: 'wf1', nodeId: 'gone', arrivals: ['submitted', 'returned'] }]);
    const wrapper = mount(TriggerRootNode, { props: { node, workflowStepCatalog: null } });
    expect(wrapper.find('.badge-gate').classes()).not.toContain('is-dead');
  });
});
