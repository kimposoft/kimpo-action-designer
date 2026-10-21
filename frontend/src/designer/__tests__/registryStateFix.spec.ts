/**
 * registryStateFix.spec.ts —— FIX-B「动作清单不吞错」补测。
 *
 * loadRegistry 原实现 `data?.actions ?? []` 把"hostApi 调用失败"和"注册中心确实没有可用动作"
 * 混同为同一个空清单。改为 registryState 三分（'ok' | 'error' | 'not-ready'），本文件覆盖三条路径
 * + 向后兼容（宿主未带 ready 字段时按 true 处理）。用 job 模式最小夹具（同 jobMode.spec.ts 套路）
 * 只为触发 load() 走到 loadRegistry，不涉及 job 模式本身的其余断言。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeHostApi } from './fakeHostApi';
import { useActionDesigner } from '../useActionDesigner';

const listActionRegistry = vi.fn();
const openJobActionDocument = vi.fn();

const hostApi = createFakeHostApi({ listActionRegistry, openJobActionDocument });

const jobTarget = { kind: 'job' as const, appId: 'app_1', jobId: 'job_42', jobName: '每日汇总' };

describe('useActionDesigner registryState（FIX-B）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    openJobActionDocument.mockResolvedValue({
      data: { job_definition_id: 'job_42', actions: null, content_revision: 0, version_no: 0 }
    });
  });

  it("data 缺失（非 200/网络异常）时 registryState='error'，registry 置空——不再静默吞成空数组", async () => {
    listActionRegistry.mockResolvedValue({ error: { code: 'internal', message: 'boom' } });
    const ctrl = useActionDesigner({ ...jobTarget, hostApi });
    await ctrl.load();
    expect(ctrl.registryState.value).toBe('error');
    expect(ctrl.registry.value).toEqual([]);
  });

  it('hostApi 直接抛错（如网络异常）时同样归为 error，不让 load() 整体崩溃', async () => {
    listActionRegistry.mockRejectedValue(new Error('network down'));
    const ctrl = useActionDesigner({ ...jobTarget, hostApi });
    await ctrl.load();
    expect(ctrl.registryState.value).toBe('error');
    expect(ctrl.registry.value).toEqual([]);
  });

  it("data.ready===false 时 registryState='not-ready'，registry 置空", async () => {
    listActionRegistry.mockResolvedValue({ data: { actions: [{ name: 'x' }], ready: false } });
    const ctrl = useActionDesigner({ ...jobTarget, hostApi });
    await ctrl.load();
    expect(ctrl.registryState.value).toBe('not-ready');
    expect(ctrl.registry.value).toEqual([]);
  });

  it("data.ready===true 时 registryState='ok'，registry 透传实际清单", async () => {
    const actions = [{ name: 'ui.linked_form' }];
    listActionRegistry.mockResolvedValue({ data: { actions, ready: true } });
    const ctrl = useActionDesigner({ ...jobTarget, hostApi });
    await ctrl.load();
    expect(ctrl.registryState.value).toBe('ok');
    expect(ctrl.registry.value).toEqual(actions);
  });

  it('ready 字段缺省（宿主旧版本响应）时向后兼容按 true 处理，registryState=ok', async () => {
    const actions = [{ name: 'ui.linked_form' }];
    listActionRegistry.mockResolvedValue({ data: { actions } });
    const ctrl = useActionDesigner({ ...jobTarget, hostApi });
    await ctrl.load();
    expect(ctrl.registryState.value).toBe('ok');
    expect(ctrl.registry.value).toEqual(actions);
  });

  it('清单确实为空（ready=true 或缺省）时 registryState 仍是 ok，不是 error——空清单不是失败', async () => {
    listActionRegistry.mockResolvedValue({ data: { actions: [] } });
    const ctrl = useActionDesigner({ ...jobTarget, hostApi });
    await ctrl.load();
    expect(ctrl.registryState.value).toBe('ok');
    expect(ctrl.registry.value).toEqual([]);
  });
});
