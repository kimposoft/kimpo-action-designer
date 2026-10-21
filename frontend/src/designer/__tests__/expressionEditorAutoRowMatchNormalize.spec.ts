/**
 * ExpressionEditor.reconcile：auto_row_match=true 时规整存量 row_match 输出。
 *
 * 背景：填充策略下拉里的「按行列匹配」选项仅在 auto_row_match=false（手动模式）时出现。若 reconcile()
 * 的 auto_row_match=true 分支只处理 match_keys，已落在某 target.outputs 上的 fill_strategy:'row_match'
 * 会「从下拉里消失，但值还在模型里、并照样提交给后端」。因此该分支还要归一化 outputs：
 * auto_row_match 变为 true 时，outputs 里 fill_strategy==='row_match' 的行改回默认 overwrite。
 *
 * 挂载策略：经 @kimposoft/expression-editor 公开导出在真实消费方测试——本插件本身就是 ExpressionEditor
 * 的消费方（NodeConfigDialog.vue 内联挂载）。reconcile() 只在 onMounted 迁移一次性调和、以及
 * 组件内部 update() 收口点被触发时运行；本用例利用前者——以「已置 auto_row_match:true 但仍带存量
 * row_match 输出」的模型挂载，断言 onMounted 迁移那趟 reconcile 产出的 update:modelValue 里，
 * 该输出已被规整。
 */
import { mount, type VueWrapper } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import { h } from 'vue';
import { NMessageProvider } from 'naive-ui';
import { EXPRESSION_HOST, ExpressionEditor, emptyExpressionModel, type ExpressionHost, type ExpressionModel } from '@kimposoft/expression-editor';

/** 最小可用 host 桩：全部返回空/成功，不产生真实网络请求。 */
function stubHost(): ExpressionHost {
  return {
    listTemplates: async () => [],
    listTables: async () => [],
    listFields: async () => [],
    compilePreview: async () => ({ valid: true, arg_count: 0 }),
    loadCatalog: async () => ({ system_variables: [], functions: [], window_functions: [] }),
    // lowerText 是 ExpressionHost 必需方法；本用例不触达文本模式确认，给一个恒成功的空桩满足接口。
    lowerText: async req => ({ purpose: req.purpose, text_source: { text: req.text, pack_revision: 'test', digest: 'd' }, diagnostics: [] })
  };
}

/** 等待 onMounted 内 ctx.load().then(...) 那趟异步迁移 reconcile 落定并 emit——链路含真实
 *  Promise 微任务链（非同步 resolve），固定轮数 Promise.resolve() 不可靠，改真实计时器轮询。 */
async function waitForEmit(editor: VueWrapper, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!editor.emitted('update:modelValue')) {
    if (Date.now() - start > timeoutMs) throw new Error('等待 update:modelValue 超时');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

describe('ExpressionEditor reconcile 归一化 row_match', () => {
  it('auto_row_match=true 时，outputs 里存量 fill_strategy:"row_match" 被改回 overwrite；其余策略不受影响', async () => {
    const model: ExpressionModel = emptyExpressionModel('tpl1');
    model.target.auto_row_match = true;
    model.target.outputs = [
      { target_field_id: 'f1', expression: { kind: 'const', value: 'x' }, fill_strategy: 'row_match' },
      { target_field_id: 'f2', expression: { kind: 'const', value: 'y' }, fill_strategy: 'append' }
    ];

    // ExpressionEditor.vue 顶层调用 useMessage()，须有 NMessageProvider 祖先（同 naive-ui 官方推荐挂载方式）。
    const wrapper = mount(
      { render: () => h(NMessageProvider, () => h(ExpressionEditor, { modelValue: model, templateId: 'tpl1' })) },
      {
        attachTo: document.body,
        global: { provide: { [EXPRESSION_HOST as unknown as string]: stubHost() } }
      }
    );
    // onMounted 内 ctx.load() 落定 + reconcile 回传 update:modelValue：这段链路经真实 Promise
    // （非纯同步 resolve），微任务轮数不确定，改用真实计时器轮询等待，比固定轮数 Promise.resolve() 更稳。
    const editor = wrapper.findComponent(ExpressionEditor as any);
    await waitForEmit(editor);
    const emitted = editor.emitted('update:modelValue') as Array<[ExpressionModel]> | undefined;
    expect(emitted).toBeTruthy();
    const migrated = emitted![emitted!.length - 1][0];

    expect(migrated.target.outputs.find(o => o.target_field_id === 'f1')?.fill_strategy).toBe('overwrite');
    // 反向判据：非 row_match 的行原样保留，不被本次归一化误伤。
    expect(migrated.target.outputs.find(o => o.target_field_id === 'f2')?.fill_strategy).toBe('append');

    wrapper.unmount();
  });

  it('auto_row_match=false（手动模式）时，row_match 输出不受影响——归一化只在自动模式下生效', async () => {
    const model: ExpressionModel = emptyExpressionModel('tpl1');
    model.target.auto_row_match = false;
    model.target.outputs = [{ target_field_id: 'f1', expression: { kind: 'const', value: 'x' }, fill_strategy: 'row_match' }];

    const wrapper = mount(
      { render: () => h(NMessageProvider, () => h(ExpressionEditor, { modelValue: model, templateId: 'tpl1' })) },
      {
        attachTo: document.body,
        global: { provide: { [EXPRESSION_HOST as unknown as string]: stubHost() } }
      }
    );
    const editor = wrapper.findComponent(ExpressionEditor as any);
    await waitForEmit(editor);
    const emitted = editor.emitted('update:modelValue') as Array<[ExpressionModel]>;
    // 手动模式下 reconcile 对 outputs 无归一化改动；match_keys 由 row_match 输出算出且非空，
    // 模型会因此产出一次 update（match_keys 从无到有），但 fill_strategy 本身应保持 row_match 不变。
    const finalModel = emitted[emitted.length - 1][0];
    expect(finalModel.target.outputs.find(o => o.target_field_id === 'f1')?.fill_strategy).toBe('row_match');

    wrapper.unmount();
  });
});
