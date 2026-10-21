/**
 * 条件分支配置面板：V4 判断表达式（条件节点 V4 形态）。
 *
 * 现状口径：
 * - 引导式条件树 ConditionTree 不再使用，产出的是整份 V4 表达式文档（token 化 source_text + 完整
 *   refs），不再是 3.4 结构化条件 + sidecar；
 * - 配置页本身就是表达式编辑界面，不需要多一次点击打开弹窗：条件页**内嵌** AdvancedExpressionPanel
 *   （由薄包装 ConditionV4Editor 提供三个 provide + 文档翻译），保存流程是「先驱动面板 confirm、
 *   在回调里提交」。
 *
 * 本文件钉九件事：**条件页长什么样**、**面板拿到的上下文对不对**、**保存先驱动面板确认**、
 * **确认后产出什么形态**、**未改照常提交 / 未改且没配则拦下**、**旧形态提示且面板空文本**、
 * **setScope 信封 alias**、**重开补可读原文**、**宿主缺桥降级**。
 * 面板自身的交互与视觉由 @kimposoft/expression-editor 共享包的测试负责，这里用桩件替换——判据只关心
 * 「递进去什么、回调怎么接」，不关心面板内部的 lowerText 时序。
 *
 * 挂载注意：编辑器内部用 useMessage()，必须有外层 NMessageProvider，否则挂载即报错。
 * 运行时宿主根部提供了它；测试里要显式包一层。
 */
import { mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, ref } from 'vue';
import { NMessageProvider } from 'naive-ui';
import { ConditionEditorDialog, ConditionTree } from '@kimposoft/expression-editor';
import type { TextSource, V4ExpressionRefWire } from '@kimposoft/expression-editor';
import { createFakeAliceV4Host, createFakeHostApi, createFakeInteractiveSession } from './fakeHostApi';
import { createConditionNode } from '../model';
import type { ConditionNodeGuard, ConditionV4Spec, MindNode } from '../model';
import type { TemplateDataTable, TemplateField } from '../hostTypes';
import NodeConfigDialog from '../NodeConfigDialog.vue';

const scope = { appId: 'app-1', templateId: 'tpl-1', templateVersionNo: '1.0' };

/**
 * 表达式面板桩件：按名字（__name='AdvancedExpressionPanel'）替换共享包真面板。
 * - 原样声明面板真实 props，测试据此读取「递进去的上下文」；
 * - expose 一个 confirm 间谍：钉住「保存必须先驱动面板确认」这条时序；
 * - 语法状态四件套 + confirmDisabled 用模块级 ref 暴露：测试直接改这些 ref 就能驱动
 *   ConditionV4Editor → NodeConfigDialog 两跳转发（外置状态条 / 保存闸）；
 * - 确认回包由测试显式 $emit（confirmWhere / confirmUnchanged），不跑真实 lowerText。
 */
const panelConfirm = vi.fn();
const panelFocusIssue = vi.fn();
const panelSyntaxState = ref<'idle' | 'typing' | 'checking' | 'ok' | 'error'>('idle');
const panelSyntaxLabel = ref('');
const panelSyntaxDetail = ref('');
const panelConfirmDisabled = ref(false);
const PanelStub = defineComponent({
  name: 'AdvancedExpressionPanel',
  props: {
    show: { type: Boolean, default: false },
    purpose: { type: String, default: 'value' },
    modelValue: { type: Object, default: null },
    textSource: { type: Object, default: null },
    sourceTables: { type: Array, default: () => [] },
    formTables: { type: Array, default: () => [] },
    shellHeight: { type: Number, default: 0 },
    // 对齐取数「筛选条件」弹窗的三件装配参数（判据见同名用例）。
    hidePersistentHints: { type: Boolean, default: false },
    compactFunctionBar: { type: Boolean, default: false },
    syntaxStatusPlacement: { type: String, default: 'inline' }
  },
  setup(_props, { expose }) {
    expose({
      confirm: panelConfirm,
      syntaxState: panelSyntaxState,
      syntaxLabel: panelSyntaxLabel,
      syntaxDetail: panelSyntaxDetail,
      confirmDisabled: panelConfirmDisabled,
      dirty: ref(false),
      focusIssue: panelFocusIssue
    });
    return () => h('div', { 'data-testid': 'expr-panel-stub' });
  }
});

/**
 * ResizeObserver 桩：observe() 当场回调固定高度。插件不反推面板 shellHeight，
 * 实际可用尺寸的观察与分栏由共享面板自身负责。
 */
function stubResizeObserver(height: number): void {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(private cb: (entries: Array<{ contentRect: { height: number } }>) => void) {}
      observe(): void {
        this.cb([{ contentRect: { height } }]);
      }
      unobserve(): void {}
      disconnect(): void {}
    }
  );
}

function field(id: string, name: string): TemplateField {
  return {
    field_id: id,
    field_code: id,
    field_name: name,
    data_type: 'text',
    display_style: 'input',
    sort_no: 0,
    is_searchable: false,
    is_filterable: false,
    is_sortable: false,
    is_list_visible: true
  };
}
function table(id: string, name: string, role: 'main' | 'detail', sortNo: number): TemplateDataTable {
  return {
    data_table_id: id,
    table_code: id,
    table_name: name,
    physical_table_name: id,
    table_role: role,
    sort_no: sortNo,
    field_count: 1,
    version_no: 1
  };
}

const mainTable = table('tbl_main', '主表', 'main', 0);
const detailTable = table('tbl_detail', '明细表', 'detail', 1);
const mainField = field('f_main', '主表字段');
const detailField = field('f_detail', '明细字段');

/** 目录桩：主表 + 扩展表各一张，字段按表分发（条件编辑器要的是「哪个字段属于哪张表」）。
 *  顺序模拟真实宿主契约（后端按「主表优先 → 设计器拖动排序位」下发），组件信任接口序不再自排。 */
function catalogHostApi(extra: Record<string, unknown> = {}) {
  return createFakeHostApi({
    listTemplateTables: vi.fn().mockResolvedValue({ data: { items: [mainTable, detailTable] } }),
    listTemplateFields: vi.fn(async (_a: string, _t: string, _v: string | undefined, dataTableId: string) => ({
      data: { items: dataTableId === 'tbl_main' ? [mainField] : [detailField] }
    })),
    ...extra
  } as never);
}

/** 一份 V4 条件规格（token 化源码 + 一条绑定）。 */
const ref1: V4ExpressionRefWire = {
  ref_id: 'r1',
  kind: 'report_field',
  table_id: 'tbl_main',
  field_id: 'f_main',
  last_label: '主表字段'
} as V4ExpressionRefWire;
function v4Spec(overrides: Partial<ConditionV4Spec> = {}): ConditionV4Spec {
  return {
    conditionId: 'cond_deadbeef',
    expression: {
      expression_id: 'cond_deadbeef',
      purpose: 'condition',
      source_text: '[主表字段]#{r1} > 0',
      refs: [ref1],
      normalized_digest: 'dg0'
    },
    readableText: '本报表.[主表].[主表字段] > 0',
    ...overrides
  };
}

async function mountDialog(props: { node: MindNode | null } & Record<string, unknown>) {
  const dialogProps = {
    show: false,
    definition: null,
    fields: [mainField, detailField],
    scope,
    hostApi: catalogHostApi(),
    interactiveSession: createFakeInteractiveSession(),
    ...props
  };
  const wrapper = mount(
    {
      props: { inner: { type: Object, required: true } },
      setup: (p: { inner: Record<string, unknown> }) => () => h(NMessageProvider, null, { default: () => h(NodeConfigDialog, p.inner as never) })
    },
    { props: { inner: dialogProps }, attachTo: document.body, global: { stubs: { SvgIcon: true, AdvancedExpressionPanel: PanelStub } } }
  );
  await wrapper.setProps({ inner: { ...dialogProps, show: true } });
  // 表目录 + 逐表字段是两跳异步；多刷几轮微任务让 conditionTables 落地。
  for (let i = 0; i < 6; i += 1) await wrapper.vm.$nextTick();
  return wrapper;
}

const dialogOf = (wrapper: ReturnType<typeof mount>) => wrapper.findComponent(NodeConfigDialog);
const panelOf = (wrapper: ReturnType<typeof mount>) => wrapper.findComponent(PanelStub);

async function click(el: Element | null, wrapper: { vm: { $nextTick: () => Promise<void> } }) {
  expect(el).toBeTruthy();
  el!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await wrapper.vm.$nextTick();
  await wrapper.vm.$nextTick();
}
// 保存按钮是 KDialogFooter 的确认按钮（data-kdlf="confirm"）
const saveButton = () => document.querySelector('[data-kdlf="confirm"]');

/** 消息桩：commitConditionSave / onConditionEditorError 的兜底提示走 window.$message。 */
const messageError = vi.fn();

describe('条件分支内嵌 V4 判断表达式', () => {
  beforeEach(() => {
    panelConfirm.mockClear();
    panelFocusIssue.mockClear();
    panelSyntaxState.value = 'idle';
    panelSyntaxLabel.value = '';
    panelSyntaxDetail.value = '';
    panelConfirmDisabled.value = false;
    messageError.mockClear();
    (window as unknown as { $message?: unknown }).$message = { error: messageError };
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  it('条件页直接内嵌表达式面板：purpose=where、表上下文含主表与扩展表、来源表恒空，不再有「编辑条件」按钮与弹窗', async () => {
    const wrapper = await mountDialog({ node: createConditionNode({ guardSpec: { mode: 'expression', v4: v4Spec() } }) });

    const panel = panelOf(wrapper);
    expect(panel.exists(), '条件页应内嵌表达式面板').toBe(true);
    expect(panel.props('purpose')).toBe('where');
    expect(panel.props('sourceTables')).toEqual([]);
    const formTables = panel.props('formTables') as Array<{ table: TemplateDataTable; fields: TemplateField[]; alias: string }>;
    // 沿宿主接口序：主表在前 + 扩展表在后，各带自己的字段与 bt* 别名（别名同时是 setScope 信封里的 alias）。
    expect(formTables.map(t => t.table.data_table_id)).toEqual(['tbl_main', 'tbl_detail']);
    expect(formTables.map(t => t.alias)).toEqual(['bt0', 'bt1']);
    expect(formTables.flatMap(t => t.fields.map(f => f.field_id))).toEqual(['f_main', 'f_detail']);
    // 既有草稿按可读原文回填，随身包带上完整 refs（重开不丢绑定）。
    const ts = panel.props('textSource') as TextSource;
    expect(ts.text).toBe('本报表.[主表].[主表字段] > 0');
    expect(ts.v4).toEqual({ source_text: '[主表字段]#{r1} > 0', refs: [ref1] });

    // 多点一次的旧形态一律不存在。
    expect(document.querySelector('[data-testid="condition-edit-btn"]'), '「编辑条件」按钮已退役').toBeNull();
    expect(wrapper.findComponent(ConditionEditorDialog).exists(), '条件编辑弹窗已退役').toBe(false);
    expect(wrapper.findComponent(ConditionTree).exists(), '引导式条件树已退役').toBe(false);
  });

  it('保存先驱动面板确认：面板未回包前不提交，回包后才 emit saveCondition', async () => {
    const wrapper = await mountDialog({ node: createConditionNode({ guardSpec: { mode: 'expression', v4: v4Spec() } }) });

    await click(saveButton(), wrapper);
    expect(panelConfirm, '保存必须先驱动面板 confirm（面板是「确认时才产出」的组件）').toHaveBeenCalledTimes(1);
    expect(dialogOf(wrapper).emitted('saveCondition'), '面板未回包前不许提交').toBeFalsy();

    panelOf(wrapper).vm.$emit('confirmWhere', {
      condition: null,
      textSource: {
        text: '本报表.[主表].[主表字段] > 0',
        pack_revision: 'alice-v4',
        digest: 'dg0',
        refs: [{ stable_id: 'r1', label: '主表字段' }],
        v4: { source_text: '[主表字段]#{r1} > 0', refs: [ref1] }
      } satisfies TextSource
    });
    await wrapper.vm.$nextTick();
    expect(dialogOf(wrapper).emitted('saveCondition')).toBeTruthy();
  });

  it('确认后保存：guardSpec.v4 带整份文档（refs 完整）、conditionId 稳定、readableText 是用户原文', async () => {
    const wrapper = await mountDialog({ node: createConditionNode({ guardSpec: { mode: 'expression', v4: v4Spec() } }) });
    await click(saveButton(), wrapper);

    // 模拟面板确认：载荷里的 sidecar 带 V4 随身包（运行时由 createV4ExpressionHost 的 lowerText 写入）。
    const edited: TextSource = {
      text: '本报表.[主表].[主表字段] > 100',
      pack_revision: 'alice-v4',
      digest: 'dg1',
      refs: [{ stable_id: 'r1', label: '主表字段' }],
      v4: { source_text: '[主表字段]#{r1} > 100', refs: [ref1] }
    };
    panelOf(wrapper).vm.$emit('confirmWhere', { condition: null, textSource: edited });
    await wrapper.vm.$nextTick();

    const emitted = dialogOf(wrapper).emitted('saveCondition');
    expect(emitted).toBeTruthy();
    const spec = emitted![0][0] as ConditionNodeGuard;
    expect(spec.mode).toBe('expression');
    expect(spec.v4!.conditionId, '改表达式不换身份（guard.path 的引用才稳定）').toBe('cond_deadbeef');
    expect(spec.v4!.expression).toEqual({
      expression_id: 'cond_deadbeef',
      purpose: 'condition',
      source_text: '[主表字段]#{r1} > 100',
      refs: [ref1],
      normalized_digest: 'dg1'
    });
    expect(spec.v4!.readableText).toBe('本报表.[主表].[主表字段] > 100');
    // 旧形态字段一个都不该被写出——V4 在场时它是唯一权威。
    expect(spec.group).toBeUndefined();
    expect(spec.guided).toBeUndefined();
    expect(spec.expression).toBeUndefined();
  });

  it('unchanged 确认（文本未改）且已有条件：草稿原样提交', async () => {
    const wrapper = await mountDialog({ node: createConditionNode({ guardSpec: { mode: 'expression', v4: v4Spec() } }) });
    await click(saveButton(), wrapper);

    panelOf(wrapper).vm.$emit('confirmUnchanged');
    await wrapper.vm.$nextTick();

    const spec = dialogOf(wrapper).emitted('saveCondition')![0][0] as ConditionNodeGuard;
    expect(spec.v4!.expression.source_text).toBe('[主表字段]#{r1} > 0');
    expect(spec.v4!.readableText).toBe('本报表.[主表].[主表字段] > 0');
  });

  it('全新节点一个字没写就保存：unchanged 回包不提交，就地提示 conditionMissing', async () => {
    const fresh = createConditionNode({});
    fresh.guardSpec = undefined;
    fresh.condition = undefined;
    const wrapper = await mountDialog({ node: fresh });
    await click(saveButton(), wrapper);

    panelOf(wrapper).vm.$emit('confirmUnchanged');
    await wrapper.vm.$nextTick();

    expect(dialogOf(wrapper).emitted('saveCondition'), '没配表达式不许落一个空 guard').toBeFalsy();
    expect(messageError).toHaveBeenCalledWith(expect.stringContaining('actionDesigner.compile.conditionMissing'));
  });

  it('面板产不出 V4 文档（清空文本 / 随身包缺席）：不提交，就地提示宿主桥不可用', async () => {
    const wrapper = await mountDialog({ node: createConditionNode({ guardSpec: { mode: 'expression', v4: v4Spec() } }) });
    await click(saveButton(), wrapper);

    // 面板清空文本时的真实回包形状：condition 与 textSource 都是 null。
    panelOf(wrapper).vm.$emit('confirmWhere', { condition: null, textSource: null });
    await wrapper.vm.$nextTick();

    expect(dialogOf(wrapper).emitted('saveCondition')).toBeFalsy();
    expect(messageError).toHaveBeenCalledWith(expect.stringContaining('actionDesigner.dialog.conditionHostUnavailable'));
  });

  it('旧形态节点：显示「旧格式请重新配置」，面板从空文本起步（旧内容一律不回显）', async () => {
    const legacy = createConditionNode({ guardSpec: { mode: 'guided', guided: { logic: 'and', items: [{ fieldId: 'f_main', op: '>', value: 0 }] } } });
    const wrapper = await mountDialog({ node: legacy });

    expect(document.body.textContent).toContain('actionDesigner.dialog.conditionLegacyFormat');
    expect(panelOf(wrapper).props('textSource'), '旧内容不回显：面板初始文本为空').toBeNull();

    // 重配一条 V4 表达式即完成换轨（保存这一次点击同时完成确认与提交）。
    await click(saveButton(), wrapper);
    panelOf(wrapper).vm.$emit('confirmWhere', {
      condition: null,
      textSource: {
        text: '本报表.[主表].[主表字段] > 1',
        pack_revision: 'alice-v4',
        digest: 'dg2',
        refs: [{ stable_id: 'r1', label: '主表字段' }],
        v4: { source_text: '[主表字段]#{r1} > 1', refs: [ref1] }
      } satisfies TextSource
    });
    await wrapper.vm.$nextTick();
    const spec = dialogOf(wrapper).emitted('saveCondition')![0][0] as ConditionNodeGuard;
    expect(spec.v4!.expression.source_text).toBe('[主表字段]#{r1} > 1');
  });

  it('表目录就绪后把本报表来源信封交给 V4 桥：instance_id 为 rpt-<table_id>-<6hex>，alias 是表显示名（与编辑器插入的 本报表.[表] 文本逐字一致，bt* 只是编辑器索引）', async () => {
    const v4Host = createFakeAliceV4Host();
    const hostApi = catalogHostApi({ createAliceV4Host: vi.fn(() => v4Host) });
    const wrapper = await mountDialog({ node: createConditionNode({ guardSpec: { mode: 'expression', v4: v4Spec() } }), hostApi });

    const calls = (v4Host.setScope as unknown as { mock: { calls: Array<[Record<string, unknown>]> } }).mock.calls;
    const scopeArg = calls[calls.length - 1][0] as { sources: unknown[]; report_sources: Array<Record<string, string>> };
    expect(scopeArg.sources, '条件分支没有目录来源表').toEqual([]);
    expect(scopeArg.report_sources).toEqual([
      { instance_id: expect.stringMatching(/^rpt-tbl_main-[0-9a-f]{6}$/), table_id: 'tbl_main', table_role: 'main', alias: expect.any(String) },
      { instance_id: expect.stringMatching(/^rpt-tbl_detail-[0-9a-f]{6}$/), table_id: 'tbl_detail', table_role: 'detail', alias: expect.any(String) }
    ]);

    // 🔴 alias 必须是表显示名：服务端把它当 Label，按 `本报表.[表显示名].[字段]` 的表段比对；编辑器插入文本
    //    也用 table_name（bracketText.reportBracketToken）。送 bt* 会报「本报表下找不到数据表」。
    const formTables = panelOf(wrapper).props('formTables') as Array<{ alias: string; table: { table_name: string } }>;
    expect(scopeArg.report_sources.map(s => s.alias)).toEqual(formTables.map(t => t.table.table_name));
    expect(scopeArg.report_sources.map(s => s.alias)).not.toEqual(formTables.map(t => t.alias));
  });

  it('打开已有 V4 条件但缺 readableText 时：经宿主 restore 取回可读原文，作为面板初始文本', async () => {
    const v4Host = createFakeAliceV4Host();
    const hostApi = catalogHostApi({ createAliceV4Host: vi.fn(() => v4Host) });
    const spec = v4Spec({ readableText: undefined });
    const wrapper = await mountDialog({ node: createConditionNode({ guardSpec: { mode: 'expression', v4: spec } }), hostApi });
    for (let i = 0; i < 4; i += 1) await wrapper.vm.$nextTick();

    expect(v4Host.restore).toHaveBeenCalledWith({ source_text: '[主表字段]#{r1} > 0', refs: [ref1], purpose: 'condition' });
    expect((panelOf(wrapper).props('textSource') as TextSource).text).toBe('本报表.[主表].[主表字段] > 0');
  });

  it('restore 落定前不挂载面板（面板只在挂载时读一次 textSource），落定后再挂并带可读原文', async () => {
    // 若面板先于 restore 挂载 ⇒ 编辑区钉住 token 文本 `[联系人]#{r1}`、显示语法错误但执行正常。
    let resolveRestore: ((value: unknown) => void) | undefined;
    const v4Host = createFakeAliceV4Host({
      restore: vi.fn(() => new Promise(resolve => { resolveRestore = resolve; })) as never
    });
    const hostApi = catalogHostApi({ createAliceV4Host: vi.fn(() => v4Host) });
    const wrapper = await mountDialog({ node: createConditionNode({ guardSpec: { mode: 'expression', v4: v4Spec({ readableText: undefined }) } }), hostApi });
    for (let i = 0; i < 4; i += 1) await wrapper.vm.$nextTick();
    expect(v4Host.restore).toHaveBeenCalledTimes(1);
    expect(panelOf(wrapper).exists(), 'restore 未落定前面板不该挂载').toBe(false);

    resolveRestore!({ ok: true, text: '[主表字段]#{r1} > 0', readable_text: '本报表.[主表].[主表字段] > 0', digest: 'd', diagnostics: [] });
    for (let i = 0; i < 4; i += 1) await wrapper.vm.$nextTick();
    expect(panelOf(wrapper).exists()).toBe(true);
    expect((panelOf(wrapper).props('textSource') as TextSource).text).toBe('本报表.[主表].[主表字段] > 0');
  });

  it('宿主未提供 createAliceV4Host（旧宿主）：显示降级提示且不实例化面板', async () => {
    const hostApi = catalogHostApi();
    // 旧宿主：该可选方法整个缺席（不是返回 null）。
    delete (hostApi as { createAliceV4Host?: unknown }).createAliceV4Host;
    const wrapper = await mountDialog({ node: createConditionNode({ guardSpec: { mode: 'expression', v4: v4Spec() } }), hostApi });

    expect(document.body.textContent).toContain('actionDesigner.dialog.conditionHostUnavailable');
    expect(panelOf(wrapper).exists(), '桥缺席时面板不该被构造（它在 setup 顶层 provide 宿主桥）').toBe(false);
    expect((saveButton() as HTMLButtonElement | null)?.disabled, '缺桥时保存禁用').toBe(true);
  });

  // ── 条件页与取数「筛选条件」弹窗对齐：样式一致，并且带本表字段 ──

  it('面板装配参数与取数「筛选条件」弹窗一致：隐藏常驻说明 + 紧凑函数条 + 语法状态条外置', async () => {
    const wrapper = await mountDialog({ node: createConditionNode({ guardSpec: { mode: 'expression', v4: v4Spec() } }) });
    const panel = panelOf(wrapper);
    // 三者同时成立才会切进共享包的紧凑布局（编辑区最小高 270→210），把高度让给字段树坞。
    expect(panel.props('hidePersistentHints'), '常驻说明是 3.4 口径，对 V4 条件是误导').toBe(true);
    expect(panel.props('compactFunctionBar'), '函数横条只留九个常用项').toBe(true);
    expect(panel.props('syntaxStatusPlacement'), '状态条交由宿主壳摆放').toBe('external');
  });

  it('量不到容器高度（无 ResizeObserver）：shellHeight 回落 660，且不报错', async () => {
    vi.stubGlobal('ResizeObserver', undefined);
    const wrapper = await mountDialog({ node: createConditionNode({ guardSpec: { mode: 'expression', v4: v4Spec() } }) });
    expect(panelOf(wrapper).props('shellHeight'), '回落值＝取数弹窗默认窗口高').toBe(660);
  });

  it('插件不再复制144px chrome，实际尺寸由共享面板自行观察', async () => {
    stubResizeObserver(400);
    const wrapper = await mountDialog({ node: createConditionNode({ guardSpec: { mode: 'expression', v4: v4Spec() } }) });
    expect(panelOf(wrapper).props('shellHeight')).toBe(660);
  });

  it('语法状态条渲染在条件页、内容取自面板暴露值，error 态可点击定位', async () => {
    const wrapper = await mountDialog({ node: createConditionNode({ guardSpec: { mode: 'expression', v4: v4Spec() } }) });
    // 状态条常显——idle 态渲染占位文案（$t 在测试里回落 key），不再隐藏。
    const idle = document.querySelector('[data-testid="adv-syntax-status"]');
    expect(idle, 'idle 态也要渲染状态条').toBeTruthy();
    expect(idle!.className).toContain('ncd-guard-status--idle');
    expect(idle!.textContent).toContain('conditionSyntaxIdle');

    panelSyntaxState.value = 'error';
    panelSyntaxLabel.value = '语法错误';
    panelSyntaxDetail.value = '第 3 个字符处不认识的符号';
    await wrapper.vm.$nextTick();

    const status = document.querySelector('[data-testid="adv-syntax-status"]');
    expect(status, 'error 态应渲染状态条').toBeTruthy();
    expect(status!.textContent).toContain('语法错误');
    expect(status!.textContent).toContain('第 3 个字符处不认识的符号');

    await click(status, wrapper);
    expect(panelFocusIssue, '点状态条应让面板选中出错片段').toHaveBeenCalledTimes(1);
  });

  it('面板判定不可确认（confirmDisabled）时保存按钮同步禁用', async () => {
    const wrapper = await mountDialog({ node: createConditionNode({ guardSpec: { mode: 'expression', v4: v4Spec() } }) });
    expect((saveButton() as HTMLButtonElement | null)?.disabled, '面板可确认时保存可用').toBe(false);

    panelConfirmDisabled.value = true;
    await wrapper.vm.$nextTick();
    expect((saveButton() as HTMLButtonElement | null)?.disabled, '否则点了保存只会被面板静默拦下').toBe(true);
  });
});
