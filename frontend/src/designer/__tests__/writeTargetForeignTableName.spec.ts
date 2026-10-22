/**
 * 写节点目标表名补齐：新增/修改/删除数据的目标表在别的模板下时，画布节点副标题
 * 此前显示表 ID（「新增 tbl_a6e37…」）。useActionDesigner 按写节点 target.template_id 经 hostApi
 * listTemplateTables 补拉目标模板表目录，tableName() 改为返回表名；当前模板不重复拉取。
 */
import { describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import { useActionDesigner } from '../useActionDesigner';
import type { ActionDesignerScope } from '../hostTypes';
import { createFakeHostApi } from './fakeHostApi';

function makeScope(): ActionDesignerScope {
  return { appId: 'app1', templateId: 'tpl_current', templateVersionNo: '1', designerType: 'canvas-form' };
}

const flush = async () => {
  await nextTick();
  await Promise.resolve();
  await Promise.resolve();
};

describe('写节点目标表名补齐', () => {
  it('目标表在别的模板：补拉该模板表目录并返回表名；每个模板只拉一次', async () => {
    const listTemplateTables = vi.fn(async (_appId: string, templateId: string) => ({
      data: { items: templateId === 'tpl_other' ? [{ data_table_id: 'tbl_a6e37', table_name: '入库单' }] : [] }
    })) as never;
    const hostApi = createFakeHostApi({ listTemplateTables });
    const ctrl = useActionDesigner({ scope: makeScope(), hostApi });
    ctrl.addEvent({ eventKey: 'manual' });
    const root = ctrl.root.value!;
    ctrl.applyDrop({ ownerId: root.id, index: 0 }, { kind: 'action', name: 'record.write' });
    expect(ctrl.tableName('tbl_a6e37')).toBe('tbl_a6e37');

    ctrl.updateSelected({ params: { write_v4: { operation: 'insert', target: { template_id: 'tpl_other', data_table_id: 'tbl_a6e37' } } } });
    await flush();
    expect(ctrl.tableName('tbl_a6e37')).toBe('入库单');
    expect(listTemplateTables).toHaveBeenCalledWith('app1', 'tpl_other');

    // 再加一个指向同一模板、以及指向当前模板的写节点：都不再触发新的拉取。
    ctrl.applyDrop({ ownerId: root.id, index: 1 }, { kind: 'action', name: 'record.write' });
    ctrl.updateSelected({ params: { write_v4: { operation: 'update', target: { template_id: 'tpl_other', data_table_id: 'tbl_a6e37' } } } });
    ctrl.applyDrop({ ownerId: root.id, index: 2 }, { kind: 'action', name: 'record.write' });
    ctrl.updateSelected({ params: { write_v4: { operation: 'insert', target: { template_id: 'tpl_current', data_table_id: 'tbl_main' } } } });
    await flush();
    const calls = (listTemplateTables as unknown as { mock: { calls: unknown[][] } }).mock.calls.filter(call => call[1] === 'tpl_other');
    expect(calls).toHaveLength(1);
    expect((listTemplateTables as unknown as { mock: { calls: unknown[][] } }).mock.calls.some(call => call[1] === 'tpl_current' && call.length === 2)).toBe(false);
  });
});
