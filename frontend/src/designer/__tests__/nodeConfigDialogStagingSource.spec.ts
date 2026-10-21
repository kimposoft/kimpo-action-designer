/**
 * NodeConfigDialog stagingSource 派生（临时表列的两个键）。
 *
 * 背景：V4 取数节点文档 staging_target.columns[] 的列有两个键：column_id（稳定键=临时表物理列名=
 * 下游 staging_field.staging_column_id 引用键）与 name（任意文本，只作显示）。本文件覆盖 NodeConfigDialog
 * 内 stagingSource 计算属性——由上一步暂存生产者节点的 params.extract_v4.staging_target.columns
 * 推导出 {code, name} 列表，供来源树 /（经 toStagingPreviewSchema）表达式预览 schema 消费。
 *
 * 挂载方式参照 __tests__/nodeConfigDialogJobMode.spec.ts / nodeConfigDialogFinalizeOnSave.spec.ts：
 * 直接 mount NodeConfigDialog（show:true），stub ExpressionEditor 避免真组件依赖。stagingSource 本身
 * 未 defineExpose，故间接经 hostApi.createExpressionHost 的调用参数（getStagingSchema 闭包）读出
 * 派生结果——该闭包就是 toStagingPreviewSchema(stagingSource.value)，二者同源同口径。
 */
import { mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeHostApi, createFakeInteractiveSession } from './fakeHostApi';
import { createActionNode } from '../model';
import type { ActionDefinition } from '../hostTypes';
import NodeConfigDialog from '../NodeConfigDialog.vue';

const scope = { appId: 'app-1', templateId: 'tpl-1' };

// 当前编辑节点随便挂一个标准表达式动作——本文件只关心 stagingProducer→stagingSource 的派生，
// 不依赖当前节点自身的配置面渲染（同 nodeConfigDialogFinalizeOnSave.spec.ts 的 definition 写法）。
const definition: ActionDefinition = {
  name: 'data.extract',
  title: '取数',
  source: 'builtin',
  capabilities: { asyncable: false, side_effecting: false, expression_based: true },
  params_schema: { 'x-editor': 'expression' }
};

function expr(id: string, text: string) {
  return { expression_id: id, purpose: 'output' as const, source_text: text, refs: [] };
}

let wrapper: VueWrapper | undefined;
afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
  document.body.innerHTML = '';
});

/** 取 createExpressionHost 首次调用的 getStagingSchema 闭包并执行，读出派生后的预览 schema
 *（即 stagingSource.columns 经 toStagingPreviewSchema 摊平的 {name, field_id, kind}）。 */
function stagingSchemaOf(hostApi: ReturnType<typeof createFakeHostApi>) {
  const calls = (hostApi.createExpressionHost as ReturnType<typeof vi.fn>).mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  const getStagingSchema = calls[0][0] as () => Array<{ name: string; field_id: string; kind: string }> | undefined;
  return getStagingSchema();
}

describe('NodeConfigDialog stagingSource 派生（column_id/name 分离）', () => {
  it('column_id 与 name 分离：预览 schema 的 name/field_id 取 column_id，不取显示名', () => {
    const producer = createActionNode({
      actionName: 'data.extract_record',
      params: {
        extract_v4: {
          staging_target: {
            columns: [{ column_id: 'col_1a2b3c4d', name: '物料编号', expression: expr('e1', '1') }]
          }
        }
      }
    });
    const hostApi = createFakeHostApi();
    wrapper = mount(NodeConfigDialog, {
      props: {
        show: true,
        node: createActionNode({ actionName: 'data.extract', params: {} }),
        definition,
        fields: [],
        scope,
        hostApi,
        interactiveSession: createFakeInteractiveSession(),
        stagingProducer: producer
      },
      attachTo: document.body,
      global: { stubs: { SvgIcon: true, ExpressionEditor: true } }
    });

    // 预览 schema 口径：name/field_id 都是 column_id（物理列名/引用键），不是用户可自由改的显示名「物料编号」。
    expect(stagingSchemaOf(hostApi)).toEqual([{ name: 'col_1a2b3c4d', field_id: 'col_1a2b3c4d', kind: 'string' }]);
  });

  it('存量文档缺 column_id：回落 name（存量列名当年受白名单约束，天然合法可当 code 用）', () => {
    const producer = createActionNode({
      actionName: 'data.extract_record',
      params: {
        extract_v4: {
          staging_target: {
            // 存量列：没有 column_id。
            columns: [{ name: 'legacy_col', expression: expr('e2', '2') }]
          }
        }
      }
    });
    const hostApi = createFakeHostApi();
    wrapper = mount(NodeConfigDialog, {
      props: {
        show: true,
        node: createActionNode({ actionName: 'data.extract', params: {} }),
        definition,
        fields: [],
        scope,
        hostApi,
        interactiveSession: createFakeInteractiveSession(),
        stagingProducer: producer
      },
      attachTo: document.body,
      global: { stubs: { SvgIcon: true, ExpressionEditor: true } }
    });

    expect(stagingSchemaOf(hostApi)).toEqual([{ name: 'legacy_col', field_id: 'legacy_col', kind: 'string' }]);
  });

  it('无暂存生产者：预览 schema 为 undefined（不报错）', () => {
    const hostApi = createFakeHostApi();
    wrapper = mount(NodeConfigDialog, {
      props: {
        show: true,
        node: createActionNode({ actionName: 'data.extract', params: {} }),
        definition,
        fields: [],
        scope,
        hostApi,
        interactiveSession: createFakeInteractiveSession(),
        stagingProducer: null
      },
      attachTo: document.body,
      global: { stubs: { SvgIcon: true, ExpressionEditor: true } }
    });

    expect(stagingSchemaOf(hostApi)).toBeUndefined();
  });
});
