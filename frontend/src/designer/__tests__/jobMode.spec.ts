/**
 * job 模式（定时任务持有独立动作文档）composable 级回归：
 * - 固定单事件 + 首次打开自动 seed（空文档 → 恰一个 scheduled 触发根，画布直接可用）；
 * - 文档读写走任务级端点（openJobActionDocument/saveJobActionDocument），不触碰模板端点；
 * - loadFields 早退：无模板字段目录，allFields 恒空、listTemplateTables/listTemplateFields 不被调用。
 *
 * 与 useActionDesignerPersistence.test.ts 同一测试哲学：经 createFakeHostApi 的 overrides 注入
 * 桩函数，断言桩函数的调用参数与 controller 状态，不 mock 任何 `@/` 路径（插件不直连宿主）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeHostApi } from './fakeHostApi';
import { useActionDesigner } from '../useActionDesigner';
import type { ActionBehaviorDocument } from '../bundle';

const openJobActionDocument = vi.fn();
const saveJobActionDocument = vi.fn();
const openActionDocument = vi.fn();
const saveActionDocument = vi.fn();
const listActionRegistry = vi.fn();
const listTemplateTables = vi.fn();
const listTemplateFields = vi.fn();
const getSupportedTriggers = vi.fn();

const hostApi = createFakeHostApi({
  openJobActionDocument,
  saveJobActionDocument,
  openActionDocument,
  saveActionDocument,
  listActionRegistry,
  listTemplateTables,
  listTemplateFields,
  getSupportedTriggers
});

const jobTarget = { kind: 'job' as const, appId: 'app_1', jobId: 'job_42', jobName: '每日汇总' };

describe('useActionDesigner job 模式', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listActionRegistry.mockResolvedValue({ data: { actions: [] } });
  });

  it('首次打开（空文档）自动 seed 一个固定的 scheduled 触发根——固定单事件+自动 seed', async () => {
    openJobActionDocument.mockResolvedValue({ data: { job_definition_id: 'job_42', actions: null, content_revision: 0, version_no: 0 } });

    const ctrl = useActionDesigner({ ...jobTarget, hostApi });
    await ctrl.load();

    expect(ctrl.events.value).toHaveLength(1);
    expect(ctrl.events.value[0].eventKey).toBe('scheduled');
    expect(ctrl.events.value[0].eventKeys).toEqual(['scheduled']);
    expect(ctrl.activeEventId.value).toBe(ctrl.events.value[0].id);
    expect(ctrl.root.value?.id).toBe(ctrl.events.value[0].id);
  });

  it('已有文档（非空 trigger_bindings）时按文档回显，不重复 seed', async () => {
    const doc: ActionBehaviorDocument = {
      trigger_bindings: [
        { binding_id: 'tb_1', trigger_event_key: 'scheduled', trigger_event_keys: ['scheduled'], scopes: ['form'], ordered_group_ids: [] }
      ],
      action_groups: [],
      action_nodes: [],
      guards: []
    };
    openJobActionDocument.mockResolvedValue({ data: { job_definition_id: 'job_42', actions: doc, content_revision: 1, version_no: 3 } });

    const ctrl = useActionDesigner({ ...jobTarget, hostApi });
    await ctrl.load();

    expect(ctrl.events.value).toHaveLength(1);
    expect(ctrl.events.value[0].bindingId).toBe('tb_1');
  });

  it('文档端点走 job 分支：open/save 调用 openJobActionDocument/saveJobActionDocument(appId, jobId, …)，不触碰模板端点', async () => {
    openJobActionDocument.mockResolvedValue({ data: { job_definition_id: 'job_42', actions: null, content_revision: 0, version_no: 0 } });
    saveJobActionDocument.mockResolvedValue({ data: { job_definition_id: 'job_42', actions: null, content_revision: 1, version_no: 1 } });

    const ctrl = useActionDesigner({ ...jobTarget, hostApi });
    await ctrl.load();
    expect(openJobActionDocument).toHaveBeenCalledWith('app_1', 'job_42');
    expect(openActionDocument).not.toHaveBeenCalled();

    const ok = await ctrl.saveActiveEvent();
    expect(ok).toBe(true);
    expect(saveJobActionDocument).toHaveBeenCalledTimes(1);
    const [appId, jobId, body] = saveJobActionDocument.mock.calls[0] as [string, string, { actions: unknown; expectedVersionNo: number }];
    expect(appId).toBe('app_1');
    expect(jobId).toBe('job_42');
    expect(body.expectedVersionNo).toBe(0);
    expect(saveActionDocument).not.toHaveBeenCalled();
  });

  it('loadFields 早退：job 模式无模板字段目录，listTemplateTables/listTemplateFields 不被调用，allFields 恒空', async () => {
    openJobActionDocument.mockResolvedValue({ data: { job_definition_id: 'job_42', actions: null, content_revision: 0, version_no: 0 } });

    const ctrl = useActionDesigner({ ...jobTarget, hostApi });
    await ctrl.load();

    expect(listTemplateTables).not.toHaveBeenCalled();
    expect(listTemplateFields).not.toHaveBeenCalled();
    expect(ctrl.allFields.value).toEqual([]);
    expect(ctrl.tables.value).toEqual([]);
  });

  it('loadSupportedTriggers 早退：job 模式不拉取载体触发声明', async () => {
    openJobActionDocument.mockResolvedValue({ data: { job_definition_id: 'job_42', actions: null, content_revision: 0, version_no: 0 } });

    const ctrl = useActionDesigner({ ...jobTarget, hostApi });
    await ctrl.load();

    expect(getSupportedTriggers).not.toHaveBeenCalled();
  });

  it('模板模式（kind 缺省）行为零变化：仍走 openActionDocument/saveActionDocument，不触碰 job 端点', async () => {
    openActionDocument.mockResolvedValue({ data: { template_id: 'tpl_1', template_version_no: '1.0', actions: null, content_revision: 0, version_no: 0 } });
    listTemplateTables.mockResolvedValue({ data: { items: [] } });

    const ctrl = useActionDesigner({
      scope: { appId: 'app_1', templateId: 'tpl_1', templateVersionNo: '1.0' },
      hostApi
    });
    await ctrl.load();

    expect(openActionDocument).toHaveBeenCalledTimes(1);
    expect(openJobActionDocument).not.toHaveBeenCalled();
    // 模板模式空文档不自动 seed（空白起步，用户经「＋事件」显式新增）。
    expect(ctrl.events.value).toHaveLength(0);
  });
});
