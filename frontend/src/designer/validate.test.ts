import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { V4ExpressionDocument } from '@kimposoft/expression-editor';
import { createActionNode, createConditionNode, createTriggerRoot } from './model';
import type { ConditionNodeGuard, MindNode } from './model';
import { countByLevel, validateTree } from './validate';
// validate.ts 的校验信息全部经 $t 取值，插件自带 locale 包当前
// 是空壳（见 ../i18n.ts 顶部注释），未注入宿主译文时恒回退 key 原样——本文件用 message.includes(...)
// 断言具体中文片段，故 beforeEach 装配 installTestZhCn() 查表桩（摘自宿主 zh-cn.ts），afterEach 复原。
import { installTestZhCn } from './__tests__/testZhCnFixture';

let restoreI18n: () => void;
beforeEach(() => {
  restoreI18n = installTestZhCn();
});
afterEach(() => {
  restoreI18n();
});

const ctx = (fieldIds: string[] = [], asyncableNames: string[] = []) => ({
  fieldIds: new Set(fieldIds),
  asyncable: (name: string) => asyncableNames.includes(name)
});

/** 一条 V4 形态的条件节点 guard（purpose 断言绕过安装期副本的旧联合，见 compile.ts）。 */
const v4Spec = (sourceText: string): ConditionNodeGuard => ({
  mode: 'expression',
  v4: {
    conditionId: 'cond_12345678',
    expression: {
      expression_id: 'cond_12345678',
      purpose: 'condition' as unknown as V4ExpressionDocument['purpose'],
      source_text: sourceText,
      refs: []
    }
  }
});

/** 旧形态条件一律报「旧格式，请重新配置」（测试里 $t 回落 key）。 */
const LEGACY_MESSAGE = 'actionDesigner.dialog.conditionLegacyFormat';

describe('validateTree', () => {
  it('warns when the canvas is empty', () => {
    const root = createTriggerRoot({ eventKey: 'manual', scope: 'form', children: [] });
    const issues = validateTree(root, ctx());
    expect(issues.some(i => i.level === 'warn' && i.message.includes('画布为空'))).toBe(true);
  });

  // 旧形态条件节点不再逐字段校验，一律报「旧格式，请重新配置」——下面两条用例
  // 钉「旧条件必须被拦住、不能静默放行」，期望的错误是旧格式提示。
  it('errors on a condition with no field（旧形态 → 旧格式错误）', () => {
    const root = createTriggerRoot({
      eventKey: 'manual',
      scope: 'form',
      children: [createConditionNode({ condition: { fieldId: '', op: '>', value: 0 }, thenChildren: [createActionNode({ actionName: 'x' })] })]
    });
    expect(validateTree(root, ctx()).some(i => i.level === 'error' && i.message === LEGACY_MESSAGE)).toBe(true);
  });

  it('errors on a condition referencing an unknown field（旧形态 → 旧格式错误）', () => {
    const root = createTriggerRoot({
      eventKey: 'manual',
      scope: 'form',
      children: [createConditionNode({ condition: { fieldId: 'fld_missing', op: '>', value: 0 }, thenChildren: [createActionNode({ actionName: 'x' })] })]
    });
    expect(validateTree(root, ctx(['fld_other'])).some(i => i.level === 'error' && i.message === LEGACY_MESSAGE)).toBe(true);
  });

  it('errors when nesting exceeds max depth', () => {
    const deepest = createConditionNode({ condition: { fieldId: 'f', op: '>', value: 0 }, thenChildren: [createActionNode({ actionName: 'x' })] });
    let node: MindNode = deepest;
    for (let i = 0; i < 3; i += 1) {
      node = createConditionNode({ condition: { fieldId: 'f', op: '>', value: 0 }, thenChildren: [node] });
    }
    const root = createTriggerRoot({ eventKey: 'manual', scope: 'form', children: [node] });
    expect(validateTree(root, ctx(['f'])).some(i => i.message.includes('嵌套超过'))).toBe(true);
  });

  it('errors on async set for a non-asyncable action', () => {
    const root = createTriggerRoot({
      eventKey: 'manual',
      scope: 'form',
      children: [createActionNode({ actionName: 'system.probe', async: true })]
    });
    expect(validateTree(root, ctx([], [])).some(i => i.message.includes('不支持异步'))).toBe(true);
  });

  // R9=E4：条件节点双判断模式的设计期校验（guided 多条逐条校验 + expression 模式非空 else 拦截）。
  it('guided 多条：任一条字段不存在都报错，定位到该条件节点', () => {
    const root = createTriggerRoot({
      eventKey: 'manual',
      scope: 'form',
      children: [
        createConditionNode({
          guardSpec: {
            mode: 'guided',
            guided: { logic: 'and', items: [{ fieldId: 'fld_ok', op: '>', value: 0 }, { fieldId: 'fld_missing', op: '=', value: 1 }] }
          },
          thenChildren: [createActionNode({ actionName: 'x' })]
        })
      ]
    });
    expect(validateTree(root, ctx(['fld_ok'])).some(i => i.level === 'error' && i.message === LEGACY_MESSAGE)).toBe(true);
  });

  it('旧 expression 模式：空表达式也走旧格式错误（0.1 口径旧条件必须重配）', () => {
    const root = createTriggerRoot({
      eventKey: 'manual',
      scope: 'form',
      children: [
        createConditionNode({
          guardSpec: { mode: 'expression', expression: '' },
          thenChildren: [createActionNode({ actionName: 'x' })]
        })
      ]
    });
    expect(validateTree(root, ctx()).some(i => i.level === 'error' && i.message === LEGACY_MESSAGE)).toBe(true);
  });

  // ── V4 判断表达式形态的设计期校验 ──
  it('V4 形态：source_text 为空报「条件未设置」，且不报旧格式错误', () => {
    const root = createTriggerRoot({
      eventKey: 'manual',
      scope: 'form',
      children: [createConditionNode({ guardSpec: v4Spec('   '), thenChildren: [createActionNode({ actionName: 'x' })] })]
    });
    const issues = validateTree(root, ctx());
    expect(issues.some(i => i.level === 'error' && i.message === 'actionDesigner.compile.conditionMissing')).toBe(true);
    expect(issues.some(i => i.message === LEGACY_MESSAGE)).toBe(false);
  });

  it('V4 形态：source_text 非空不报 guard 错误（绑定/形状由宿主诊断与后端保存期负责）', () => {
    const root = createTriggerRoot({
      eventKey: 'manual',
      scope: 'form',
      children: [createConditionNode({ guardSpec: v4Spec('#{r1} > 0'), thenChildren: [createActionNode({ actionName: 'x' })] })]
    });
    const issues = validateTree(root, ctx());
    expect(issues.some(i => i.level === 'error')).toBe(false);
  });

  it('V4 形态 + 非空 else：不再被「不支持不成立分支」拦截（取反 = negate 翻转）', () => {
    const root = createTriggerRoot({
      eventKey: 'manual',
      scope: 'form',
      children: [
        createConditionNode({
          guardSpec: v4Spec('#{r1} > 0'),
          thenChildren: [createActionNode({ actionName: 'x' })],
          elseChildren: [createActionNode({ actionName: 'y' })]
        })
      ]
    });
    expect(validateTree(root, ctx()).some(i => i.level === 'error')).toBe(false);
  });

  it('expression 模式 + 非空 else：设计期即报错（无 NOT，不可取反）', () => {
    const root = createTriggerRoot({
      eventKey: 'manual',
      scope: 'form',
      children: [
        createConditionNode({
          guardSpec: { mode: 'expression', expression: '{{field:fld_a}} > 0 OR {{field:fld_b}} > 0' },
          thenChildren: [createActionNode({ actionName: 'x' })],
          elseChildren: [createActionNode({ actionName: 'y' })]
        })
      ]
    });
    expect(validateTree(root, ctx()).some(i => i.level === 'error' && i.message.includes('不支持'))).toBe(true);
  });

  it('expression 模式 + 空 else：不报「不支持」错误', () => {
    const root = createTriggerRoot({
      eventKey: 'manual',
      scope: 'form',
      children: [
        createConditionNode({
          guardSpec: { mode: 'expression', expression: '{{field:fld_a}} > 0 OR {{field:fld_b}} > 0' },
          thenChildren: [createActionNode({ actionName: 'x' })],
          elseChildren: []
        })
      ]
    });
    expect(validateTree(root, ctx()).some(i => i.message.includes('不支持'))).toBe(false);
  });

  it('counts errors and warnings', () => {
    const counts = countByLevel([
      { nodeId: 'a', level: 'error', message: '' },
      { nodeId: 'b', level: 'warn', message: '' },
      { nodeId: 'c', level: 'error', message: '' }
    ]);
    expect(counts).toEqual({ error: 2, warn: 1 });
  });
});

// 触发根流程步骤门失效校验——只计警告（门仍可保存），目录未加载（undefined/null）时跳过。
describe('validateTree 流程步骤门失效校验', () => {
  const catalog = [
    {
      definition_id: 'wf1',
      name: '采购审批',
      status: 'enabled' as const,
      latest_version_no: 2,
      steps: [{ node_id: 'n1', node_kind: 'START' as const, node_name: '发起' }]
    }
  ];

  it('目录未加载（undefined）时跳过校验，即使门内引用的步骤不在目录里也不报警告', () => {
    const root = createTriggerRoot({ eventKey: 'manual', scope: 'form', children: [createActionNode({ actionName: 'x' })] });
    root.workflowGate = { notStarted: false, steps: [{ definitionId: 'wf1', nodeId: 'not-exist', arrivals: ['submitted', 'returned'] }] };
    const issues = validateTree(root, ctx());
    expect(issues.some(i => i.nodeId === root.id && i.level === 'warn' && i.message.includes('gate'))).toBe(false);
  });

  it('部分步骤失效（且未勾「未发起」）：计一条警告，文案用 deadCount', () => {
    const root = createTriggerRoot({ eventKey: 'manual', scope: 'form', children: [createActionNode({ actionName: 'x' })] });
    root.workflowGate = {
      notStarted: false,
      steps: [
        { definitionId: 'wf1', nodeId: 'n1', arrivals: ['submitted', 'returned'] }, // 目录里仍有效
        { definitionId: 'wf1', nodeId: 'gone', arrivals: ['submitted', 'returned'] } // 失效
      ]
    };
    const issues = validateTree(root, { ...ctx(), workflowStepCatalog: catalog });
    expect(issues.some(i => i.nodeId === root.id && i.level === 'warn' && i.message === 'actionDesigner.dialog.gate.deadCount')).toBe(true);
    expect(issues.some(i => i.message === 'actionDesigner.dialog.gate.allDeadWarn')).toBe(false);
  });

  it('所选步骤全部失效（且 notStarted=false）：文案改用 allDeadWarn', () => {
    const root = createTriggerRoot({ eventKey: 'manual', scope: 'form', children: [createActionNode({ actionName: 'x' })] });
    root.workflowGate = { notStarted: false, steps: [{ definitionId: 'wf1', nodeId: 'gone', arrivals: ['submitted', 'returned'] }] };
    const issues = validateTree(root, { ...ctx(), workflowStepCatalog: catalog });
    expect(issues.some(i => i.nodeId === root.id && i.level === 'warn' && i.message === 'actionDesigner.dialog.gate.allDeadWarn')).toBe(true);
  });

  it('全部步骤失效但勾了「未发起」：不算全灭，仍用 deadCount（未发起本身仍是有效触发条件）', () => {
    const root = createTriggerRoot({ eventKey: 'manual', scope: 'form', children: [createActionNode({ actionName: 'x' })] });
    root.workflowGate = { notStarted: true, steps: [{ definitionId: 'wf1', nodeId: 'gone', arrivals: ['submitted', 'returned'] }] };
    const issues = validateTree(root, { ...ctx(), workflowStepCatalog: catalog });
    expect(issues.some(i => i.message === 'actionDesigner.dialog.gate.deadCount')).toBe(true);
    expect(issues.some(i => i.message === 'actionDesigner.dialog.gate.allDeadWarn')).toBe(false);
  });

  it('门内步骤全部有效：不报任何警告', () => {
    const root = createTriggerRoot({ eventKey: 'manual', scope: 'form', children: [createActionNode({ actionName: 'x' })] });
    root.workflowGate = { notStarted: false, steps: [{ definitionId: 'wf1', nodeId: 'n1', arrivals: ['submitted', 'returned'] }] };
    const issues = validateTree(root, { ...ctx(), workflowStepCatalog: catalog });
    expect(issues.some(i => i.message.includes('gate'))).toBe(false);
  });
});

// 值变动 / 点击字段时未选触发字段 ⇒ 报错阻断保存。
describe('validateTree：触发字段必填', () => {
  const child = () => [createActionNode({ actionName: 'x' })];

  it('值变动未选字段：报错且定位到触发根', () => {
    const root = createTriggerRoot({ eventKey: 'value-change', scope: 'form', children: child() });
    root.eventFieldIds = { 'value-change': [] };
    const issues = validateTree(root, ctx());
    expect(issues.some(i => i.nodeId === root.id && i.level === 'error' && i.message.includes('未设置触发字段'))).toBe(true);
    expect(countByLevel(issues).error).toBe(1);
  });

  it('值变动 + 点击字段时都缺字段：各报一条；字段缺省（undefined）同样视为未设置', () => {
    const root = createTriggerRoot({ eventKey: 'value-change', scope: 'form', children: child() });
    root.eventKeys = ['value-change', 'field-click'];
    const issues = validateTree(root, ctx());
    expect(issues.filter(i => i.message.includes('未设置触发字段'))).toHaveLength(2);
  });

  it('只有一类事件缺字段：只报那一条', () => {
    const root = createTriggerRoot({ eventKey: 'value-change', scope: 'form', children: child() });
    root.eventKeys = ['value-change', 'field-click'];
    root.eventFieldIds = { 'value-change': ['f1'] };
    const issues = validateTree(root, ctx());
    expect(issues.filter(i => i.message.includes('未设置触发字段'))).toHaveLength(1);
  });

  it('已选字段或非字段类事件：不报', () => {
    const withField = createTriggerRoot({ eventKey: 'field-click', scope: 'form', children: child() });
    withField.eventFieldIds = { 'field-click': ['f1'] };
    expect(countByLevel(validateTree(withField, ctx())).error).toBe(0);
    const manual = createTriggerRoot({ eventKey: 'manual', scope: 'form', children: child() });
    expect(countByLevel(validateTree(manual, ctx())).error).toBe(0);
  });
});
