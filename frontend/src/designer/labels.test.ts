import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// ActionDefinition 取自本地 hostTypes.ts。本文件大量断言依赖 nodeSummary/outcomeLabel/eventLabel 产出的具体中文文案——
// 这些文案在 labels.ts 里全部经 $t 取值，插件自带 locale 包当前是空壳（见 ../i18n.ts 顶部注释），
// 未注入宿主译文时恒回退 key 原样。故 beforeEach 装配 installTestZhCn() 查表桩（摘自宿主
// zh-cn.ts 的 actionDesigner 命名空间），afterEach 复原。
import type { V4ExpressionDocument, V4ExtractNodeDocument } from '@kimposoft/expression-editor';
import type { ActionDefinition } from './hostTypes';
import { actionOutcomes, cleanFieldName, conditionStatement, extractV4Summary, guardSpecStatement, nodeSummary, outcomeLabel } from './labels';
import { ACTION_TRIGGER_EVENT_KEYS, LEGACY_SAVE_EVENT_KEYS, RECORD_PAGE_EVENT_KEYS, SELECTABLE_TRIGGER_EVENT_KEYS } from './model';
import type { ConditionNodeGuard, MindNode, SimpleCondition } from './model';
import { installTestZhCn } from './__tests__/testZhCnFixture';

let restoreI18n: () => void;
beforeEach(() => {
  restoreI18n = installTestZhCn();
});
afterEach(() => {
  restoreI18n();
});

describe('action trigger event contract', () => {
  // 共十六类：含记录页事件 before-delete/after-delete、handle-time 与保存四档细分；
  // 同时钉住 workflow-event 已退役、scheduled 存在。
  it('keeps the sixteen generic trigger events and excludes the retired workflow event', () => {
    expect(ACTION_TRIGGER_EVENT_KEYS).toHaveLength(16);
    expect(ACTION_TRIGGER_EVENT_KEYS).not.toContain('workflow-event');
    expect(ACTION_TRIGGER_EVENT_KEYS).toContain('scheduled');
    expect(ACTION_TRIGGER_EVENT_KEYS).toContain('before-delete');
    expect(ACTION_TRIGGER_EVENT_KEYS).toContain('after-delete');
    expect(ACTION_TRIGGER_EVENT_KEYS).toContain('handle-time');
    expect(ACTION_TRIGGER_EVENT_KEYS).toContain('create-before-save');
    expect(ACTION_TRIGGER_EVENT_KEYS).toContain('create-after-save');
    expect(ACTION_TRIGGER_EVENT_KEYS).toContain('edit-before-save');
    expect(ACTION_TRIGGER_EVENT_KEYS).toContain('edit-after-save');
    // 老保存键仍在类型联合的全量真值表里（读兼容），但下方 SELECTABLE 断言会验证它俩已退役出可选集。
    expect(ACTION_TRIGGER_EVENT_KEYS).toContain('before-save');
    expect(ACTION_TRIGGER_EVENT_KEYS).toContain('after-save');
  });

  it('RECORD_PAGE_EVENT_KEYS（记录页事件）恰为 before-delete/after-delete 两项，且均是 ACTION_TRIGGER_EVENT_KEYS 的子集', () => {
    expect(RECORD_PAGE_EVENT_KEYS).toEqual(['before-delete', 'after-delete']);
    for (const key of RECORD_PAGE_EVENT_KEYS) {
      expect(ACTION_TRIGGER_EVENT_KEYS).toContain(key);
    }
  });

  // 老保存键退役出「可选事件集」——SELECTABLE 恰为 ACTION_TRIGGER_EVENT_KEYS 去掉
  // LEGACY_SAVE_EVENT_KEYS 两项，长度 14。
  it('SELECTABLE_TRIGGER_EVENT_KEYS 恰为全量去掉 LEGACY_SAVE_EVENT_KEYS（老保存键退役出可选事件集）', () => {
    expect(LEGACY_SAVE_EVENT_KEYS).toEqual(['before-save', 'after-save']);
    expect(SELECTABLE_TRIGGER_EVENT_KEYS).toHaveLength(ACTION_TRIGGER_EVENT_KEYS.length - LEGACY_SAVE_EVENT_KEYS.length);
    expect(SELECTABLE_TRIGGER_EVENT_KEYS).not.toContain('before-save');
    expect(SELECTABLE_TRIGGER_EVENT_KEYS).not.toContain('after-save');
    for (const key of LEGACY_SAVE_EVENT_KEYS) expect(ACTION_TRIGGER_EVENT_KEYS).toContain(key);
    for (const key of SELECTABLE_TRIGGER_EVENT_KEYS) expect(ACTION_TRIGGER_EVENT_KEYS).toContain(key);
  });
});

// 四语 locale json 补文案核验——直接静态读取 frontend/locales/*.json 源文件（不经
// $t 运行时链路）。插件自带 locale 包当前尚未接入 t() 回退链（见 ../i18n.ts 顶部 TODO），这里
// 只核验「文件本身补齐了两条新 key 且均为非空字符串」，与该包是否已被运行时消费无关；范式同
// printPanel.static.test.ts 的 readFileSync(join(process.cwd(), ...)) 静态读取写法。
describe('记录页事件四语 locale 补齐（actionDesigner.events.beforeDelete / afterDelete）', () => {
  const LOCALE_FILES = ['zh-CN', 'en-US', 'ja-JP', 'zh-TW'] as const;
  const NEW_KEYS = ['actionDesigner.events.beforeDelete', 'actionDesigner.events.afterDelete'] as const;

  it.each(LOCALE_FILES)('locales/%s.json 含两条新 key，且均为非空字符串', file => {
    const table = JSON.parse(readFileSync(join(process.cwd(), `locales/${file}.json`), 'utf8')) as Record<string, unknown>;
    for (const key of NEW_KEYS) {
      expect(typeof table[key]).toBe('string');
      expect((table[key] as string).trim().length).toBeGreaterThan(0);
    }
  });
});

describe('cleanFieldName（条件语句字段名清洗）', () => {
  it('去前导必填标记 *', () => {
    expect(cleanFieldName('*姓名')).toBe('姓名');
    expect(cleanFieldName('＊证件类型')).toBe('证件类型');
  });
  it('折叠半角/全角对齐空格', () => {
    expect(cleanFieldName('*姓 名')).toBe('姓名');
    expect(cleanFieldName('*职　　级')).toBe('职级');
  });
  it('无标记原样', () => {
    expect(cleanFieldName('数量')).toBe('数量');
  });
  it('清洗后为空则回退原串', () => {
    expect(cleanFieldName('*')).toBe('*');
  });
});

describe('conditionStatement（条件节点 KimpoSQL 判断语句）', () => {
  const name = (id: string) => ({ fld_qty: '数量', fld_name: '姓名' })[id] ?? id;

  it('未设置条件 → 占位文案', () => {
    expect(conditionStatement(undefined)).toBe('（未设置条件）');
  });

  it('字段名 + SQL 运算符 + 数字值', () => {
    const c: SimpleCondition = { fieldId: 'fld_qty', op: '>', value: 0 };
    expect(conditionStatement(c, name)).toBe('数量 > 0');
  });

  it('字符串值加单引号、转义内部单引号', () => {
    const c: SimpleCondition = { fieldId: 'fld_name', op: '=', value: "o'brien" };
    expect(conditionStatement(c, name)).toBe("姓名 = 'o''brien'");
  });

  it('各运算符用 SQL 符号原样', () => {
    const ops: SimpleCondition['op'][] = ['=', '!=', '>', '>=', '<', '<='];
    for (const op of ops) {
      expect(conditionStatement({ fieldId: 'fld_qty', op, value: 1 }, name)).toBe(`数量 ${op} 1`);
    }
  });

  it('无 fieldName 映射时回退 fieldId', () => {
    expect(conditionStatement({ fieldId: 'fld_x', op: '=', value: true })).toBe('fld_x = true');
  });
});

describe('nodeSummary（节点详情 popover 摘要）', () => {
  const name = (id: string) => ({ fld_qty: '数量' })[id] ?? id;

  it('触发根：仅展示事件（无执行条件；多事件联合展示）', () => {
    const node: MindNode = { id: 't1', kind: 'trigger-root', eventKey: 'before-save', scope: 'form' };
    expect(nodeSummary(node)).toEqual([{ label: '事件', value: '保存前' }]);
    const multi: MindNode = { id: 't2', kind: 'trigger-root', eventKey: 'create-time', eventKeys: ['create-time', 'after-save'], scope: 'form' };
    expect(nodeSummary(multi)).toEqual([{ label: '事件', value: '新建时 / 保存后' }]);
  });

  it('触发根（R8）：提供 eventFieldIds 时按事件分段展示触发字段，未设置字段的事件展示占位', () => {
    const node: MindNode = {
      id: 't3',
      kind: 'trigger-root',
      eventKey: 'value-change',
      eventKeys: ['value-change', 'field-click'],
      eventFieldIds: { 'value-change': ['fld_qty'], 'field-click': [] }
    };
    expect(nodeSummary(node, null, name)).toEqual([
      { label: '事件', value: '值变动 / 点击字段时' },
      { label: '触发字段', value: '值变动: 数量 · 点击字段时: 未设置' }
    ]);
  });

  it('动作：动作名/来源/同步异步 + 参数键值', () => {
    const node: MindNode = {
      id: 'a1',
      kind: 'action',
      actionName: 'system.probe',
      source: 'plugin',
      async: true,
      params: { field_id: 'fld_qty', count: 3 }
    };
    const def = { name: 'system.probe', title: '探针', source: 'plugin', capabilities: { asyncable: true, side_effecting: true, expression_based: false } };
    expect(nodeSummary(node, def)).toEqual([
      { label: '动作', value: '探针' },
      { label: '来源', value: '插件' },
      { label: '执行', value: '异步' },
      { label: 'field_id', value: 'fld_qty' },
      { label: 'count', value: '3' }
    ]);
  });

  // 旧形态条件（只有 legacy condition / guided / structured）不再翻译成判断语句，
  // 摘要统一显示「旧格式，请重新配置」（测试里 $t 回落 key）。
  it('条件（旧形态）：摘要显示「旧格式」提示而非判断语句', () => {
    const node: MindNode = { id: 'c1', kind: 'condition', condition: { fieldId: 'fld_qty', op: '>', value: 0 } };
    expect(nodeSummary(node, null, name)).toEqual([{ label: '判断', value: 'actionDesigner.dialog.conditionLegacyFormat' }]);
  });
});

// ⑦ 条件节点摘要：V4 判断表达式是唯一在用形态，旧三形态统一「旧格式」提示。
// 旧形态的三条用例（guided 单条/多条、旧 expression 串）是「旧形态一律落到同一句提示」的回归锚。
describe('guardSpecStatement（条件节点摘要）', () => {
  const name = (id: string) => ({ fld_qty: '数量', fld_name: '姓名' })[id] ?? id;
  const LEGACY = 'actionDesigner.dialog.conditionLegacyFormat';

  /** 一份最小 V4 表达式文档（purpose 断言绕过安装期副本的旧联合，见 conditionV4Compile.spec.ts）。 */
  const v4Spec = (sourceText: string, readableText?: string): ConditionNodeGuard => ({
    mode: 'expression',
    v4: {
      conditionId: 'cond_12345678',
      expression: {
        expression_id: 'cond_12345678',
        purpose: 'condition' as unknown as V4ExpressionDocument['purpose'],
        source_text: sourceText,
        refs: []
      },
      readableText
    }
  });

  it('未提供 guardSpec 时从 legacyCondition 合成 guided 单条镜像 → 旧格式提示', () => {
    const c: SimpleCondition = { fieldId: 'fld_qty', op: '>', value: 0 };
    expect(guardSpecStatement(undefined, c, name)).toBe(LEGACY);
    // conditionStatement 本身不变（旧单条判断语句仍可单独渲染，只是不再作为条件节点摘要）。
    expect(conditionStatement(c, name)).toBe('数量 > 0');
  });

  it('guardSpec 为 guided 单条/多条 → 旧格式提示', () => {
    const c1: SimpleCondition = { fieldId: 'fld_qty', op: '>', value: 0 };
    const c2: SimpleCondition = { fieldId: 'fld_name', op: '=', value: '张三' };
    expect(guardSpecStatement({ mode: 'guided', guided: { logic: 'and', items: [c1] } }, c1, name)).toBe(LEGACY);
    expect(guardSpecStatement({ mode: 'guided', guided: { logic: 'or', items: [c1, c2] } }, undefined, name)).toBe(LEGACY);
  });

  it('guardSpec 为旧 expression 串 / 结构化条件 → 旧格式提示', () => {
    expect(guardSpecStatement({ mode: 'expression', expression: '{{field:fld_qty}} > 0' }, undefined, name)).toBe(LEGACY);
    const structured: ConditionNodeGuard = {
      mode: 'guided',
      group: { logic: 'and', items: [{ predicate: { left: { kind: 'form_field', field_id: 'fld_qty' }, op: 'gt', right: { kind: 'const', value: 0 } } }] }
    };
    expect(guardSpecStatement(structured, undefined, name)).toBe(LEGACY);
  });

  it('V4 形态：优先展示可读原文，缺省回落 token 化源码', () => {
    expect(guardSpecStatement(v4Spec('#{r1} > 0', '数量 > 0'), undefined, name)).toBe('数量 > 0');
    expect(guardSpecStatement(v4Spec('#{r1} > 0'), undefined, name)).toBe('#{r1} > 0');
  });

  it('V4 形态：超长截断加省略号（沿用 40 字上限）', () => {
    const result = guardSpecStatement(v4Spec('#{r1} > 0', `数量 > ${'9'.repeat(60)}`), undefined, name);
    expect(result.endsWith('…')).toBe(true);
    expect(result.length).toBe(41); // 40 截断 + 省略号
  });

  it('V4 形态：源码为空 → 占位文案（未配置，不算旧格式）', () => {
    expect(guardSpecStatement(v4Spec('   '), undefined, name)).toBe('（未设置条件）');
  });

  it('guardSpec/legacyCondition 均缺省 → 占位文案', () => {
    expect(guardSpecStatement(undefined, undefined, name)).toBe('（未设置条件）');
  });
});

describe("actionOutcomes（R5，读取动作定义 params_schema['x-outcomes']）", () => {
  it('声明了 x-outcomes 字符串数组时原样返回（过滤非字符串/空字符串项）', () => {
    const def = { params_schema: { 'x-outcomes': ['hit', 'miss', 42, ''] } } as unknown as ActionDefinition;
    expect(actionOutcomes(def)).toEqual(['hit', 'miss']);
  });

  it('未声明 / 定义缺省 / 非数组格式一律回落空数组（普通单续接动作不受影响）', () => {
    expect(actionOutcomes(undefined)).toEqual([]);
    expect(actionOutcomes({ params_schema: {} } as unknown as ActionDefinition)).toEqual([]);
    expect(actionOutcomes({ params_schema: { 'x-outcomes': 'hit' } } as unknown as ActionDefinition)).toEqual([]);
  });
});

describe('outcomeLabel（R5，出口 key 本地化）', () => {
  it('已登记的 key（hit/miss）返回本地化文案', () => {
    expect(outcomeLabel('hit')).toBe('命中');
    expect(outcomeLabel('miss')).toBe('未命中');
  });

  it('未登记的 outcome key 回落显示原文（未知出口不炸也不空白）', () => {
    expect(outcomeLabel('some-unknown-outcome')).toBe('some-unknown-outcome');
  });
});

// 视图 / 跨应用来源：来源是视图时显示视图名；跨应用来源前缀「应用名 › 」。
describe('extractV4Summary 来源行（视图 / 跨应用来源）', () => {
  it('视图来源：显示视图别名、kind=view，无 tag（与目录来源同级，靠图标区分）', () => {
    const doc = {
      query: { sources: [{ kind: 'view', instance_id: 'v-1', alias: '汇总视图', app_id: 'app-a', view_id: 'view_x' }] }
    } as unknown as V4ExtractNodeDocument;

    const summary = extractV4Summary(doc, {});

    expect(summary.sources).toHaveLength(1);
    expect(summary.sources[0]).toMatchObject({ key: 'v-1', name: '汇总视图', kind: 'view' });
    expect(summary.sources[0].tag).toBeUndefined();
  });

  it('视图无别名时回退 view_id（同目录来源回退 data_table_id 同一范式）', () => {
    const doc = {
      query: { sources: [{ kind: 'view', instance_id: 'v-1', alias: '', app_id: 'app-a', view_id: 'view_x' }] }
    } as unknown as V4ExtractNodeDocument;

    expect(extractV4Summary(doc, {}).sources[0].name).toBe('view_x');
  });

  it('跨应用来源（catalog/view 均可）前缀「应用名 › 」，同应用来源不加前缀', () => {
    const doc = {
      query: {
        sources: [
          { kind: 'catalog', instance_id: 'c-1', alias: '订单表', app_id: 'app-b', template_id: 't1', data_table_id: 'dt1' },
          { kind: 'view', instance_id: 'v-1', alias: '汇总视图', app_id: 'app-a', view_id: 'view_x' }
        ]
      }
    } as unknown as V4ExtractNodeDocument;
    const appName = (id: string) => ({ 'app-b': '销售应用' })[id] ?? '';

    const summary = extractV4Summary(doc, { appName, currentAppId: 'app-a' });

    // c-1 属于 app-b（≠当前 app-a）→ 前缀；v-1 属于 app-a（=当前应用）→ 不加前缀。
    expect(summary.sources.map(s => s.name)).toEqual(['销售应用 › 订单表', '汇总视图']);
  });

  it('缺 currentAppId / appName 解析口（旧调用点）时不产出前缀，行为与改造前一致', () => {
    const doc = {
      query: {
        sources: [{ kind: 'catalog', instance_id: 'c-1', alias: '订单表', app_id: 'app-b', template_id: 't1', data_table_id: 'dt1' }]
      }
    } as unknown as V4ExtractNodeDocument;

    expect(extractV4Summary(doc, {}).sources[0].name).toBe('订单表');
    // 只传 currentAppId、不传 appName 解析口：查不到应用名同样不产出前缀（不拿 appId 冒充应用名）。
    expect(extractV4Summary(doc, { currentAppId: 'app-a' }).sources[0].name).toBe('订单表');
  });
});
