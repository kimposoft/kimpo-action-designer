import { describe, it, expect } from 'vitest';
import { useActionDesigner } from '../useActionDesigner';
import type { ActionDesignerScope } from '../hostTypes';
import { createFakeHostApi } from './fakeHostApi';

// 动作暂存区（Phase B）前驱推导测试：stagingProducerOf 必须与引擎侧「续接带/子流程可见性」语义严格
// 对齐——把 X 挂在自己续接带/子流程里的那个父 action 节点即生产者；顺序兄弟互相不可见；condition
// 透明跳过；到 root/trigger 根则无。测试直接用 applyDrop 在画布拓扑上搭建结构（不依赖动作注册表/
// 后端，createActionNode 对未注册的 actionName 也能正常建节点），每次 applyDrop 后新节点会被自动
// selectNode，借 selectedId 取到新建节点的稳定 id。
//
// scope 类型用插件本地 ActionDesignerScope（见 hostTypes.ts 注释）；useActionDesigner 必传 hostApi，
// 本文件测试全程只调用画布拓扑相关方法
// （applyDrop/addEvent/stagingProducerOf），从不触发 .load()/.saveActiveEvent()，故用
// createFakeHostApi() 的默认全空桩即可，不影响任何断言。
const hostApi = createFakeHostApi();

function makeScope(): ActionDesignerScope {
  return { appId: 'app1', templateId: 'tpl1', templateVersionNo: '1', designerType: 'canvas-form' };
}

describe('stagingProducerOf（动作暂存区 Phase B 前驱推导）', () => {
  it('①续接带子节点 → 父 action：A 的 children 带里的 B，生产者是 A', () => {
    const ctrl = useActionDesigner({ scope: makeScope(), hostApi });
    ctrl.addEvent({ eventKey: 'manual' });
    const root = ctrl.root.value!;
    // A 挂在根 band。
    ctrl.applyDrop({ ownerId: root.id, index: 0 }, { kind: 'action', name: 'action.a' });
    const aId = ctrl.selectedId.value!;
    // B 挂进 A 的子流程 band（续接带）。
    ctrl.applyDrop({ ownerId: aId, index: 0 }, { kind: 'action', name: 'action.b' });
    const bId = ctrl.selectedId.value!;

    const producer = ctrl.stagingProducerOf(bId);
    expect(producer?.id).toBe(aId);
  });

  it('②顺序兄弟 → 不是兄弟而是共同父：A 的子流程带里 [Ax, By] 顺序两个动作，By 的生产者是 A 不是 Ax', () => {
    const ctrl = useActionDesigner({ scope: makeScope(), hostApi });
    ctrl.addEvent({ eventKey: 'manual' });
    const root = ctrl.root.value!;
    ctrl.applyDrop({ ownerId: root.id, index: 0 }, { kind: 'action', name: 'action.a' });
    const aId = ctrl.selectedId.value!;
    ctrl.applyDrop({ ownerId: aId, index: 0 }, { kind: 'action', name: 'action.ax' });
    const axId = ctrl.selectedId.value!;
    // 追加到 A 子流程带的末尾（index 1），与 Ax 同带顺序相邻，非嵌套关系。
    ctrl.applyDrop({ ownerId: aId, index: 1 }, { kind: 'action', name: 'action.by' });
    const byId = ctrl.selectedId.value!;

    const producer = ctrl.stagingProducerOf(byId);
    expect(producer?.id).toBe(aId);
    expect(producer?.id).not.toBe(axId);
  });

  it('③跨 condition 透明：A → children=[C(condition)] → C.thenChildren=[B]，B 的生产者仍是 A（条件不算生产者）', () => {
    const ctrl = useActionDesigner({ scope: makeScope(), hostApi });
    ctrl.addEvent({ eventKey: 'manual' });
    const root = ctrl.root.value!;
    ctrl.applyDrop({ ownerId: root.id, index: 0 }, { kind: 'action', name: 'action.a' });
    const aId = ctrl.selectedId.value!;
    // 条件节点挂进 A 的子流程带。
    ctrl.applyDrop({ ownerId: aId, index: 0 }, { kind: 'condition' });
    const cId = ctrl.selectedId.value!;
    // B 挂进条件的「成立」分支。
    ctrl.applyDrop({ ownerId: cId, branch: 'then', index: 0 }, { kind: 'action', name: 'action.b' });
    const bId = ctrl.selectedId.value!;

    const producer = ctrl.stagingProducerOf(bId);
    expect(producer?.id).toBe(aId);
    expect(producer?.kind).toBe('action');
  });

  it('④根下节点 → null：直接挂在触发根 band 下的动作，无生产者', () => {
    const ctrl = useActionDesigner({ scope: makeScope(), hostApi });
    ctrl.addEvent({ eventKey: 'manual' });
    const root = ctrl.root.value!;
    ctrl.applyDrop({ ownerId: root.id, index: 0 }, { kind: 'action', name: 'action.a' });
    const aId = ctrl.selectedId.value!;

    expect(ctrl.stagingProducerOf(aId)).toBeNull();
  });

  it('空白态（无事件/root）恒返回 null', () => {
    const ctrl = useActionDesigner({ scope: makeScope(), hostApi });
    expect(ctrl.stagingProducerOf('whatever')).toBeNull();
  });
});
