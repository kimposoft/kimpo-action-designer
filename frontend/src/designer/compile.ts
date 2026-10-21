/**
 * 画布 ↔ 动作行为文档（bundle）的确定性可逆编译。
 *
 * 核心语义（严守基座单层映射）：
 * - 一个 band（容器 children）= 一串顺序成员，可在任意位置穿插任意数量的条件；条件经 then/else 向右分叉，
 *   分支「成立/不成立二选一执行后汇合」，其后成员续跑（可再遇下一个条件）。
 * - 每个动作组（action_group）的组级 guard = 从触发根到该 band 的「条件路径」AND 链，
 *   路径上每个条件取「成立=原条件 / 不成立=操作符反转」（后端 guard 文法无 NOT）。
 * - then 先 else 后进 ordered_group_ids；空分支（如空 else）也固化为一个空动作组以保留分支结构，
 *   从而保证 compile → open 结构可逆。
 *
 * 可逆性依据：ordered_group_ids 为 band→then 子树→else 子树的前序遍历，
 * 故反向时在分叉点「首个出现的分支」即为 then，其分叉字面量即设计者书写的原条件 C。
 *
 * 条件节点双判断模式：条件节点的 guard 权威改为 ConditionNodeGuard（见 model.ts）——
 * mode='guided' 为单层且/或（一组 SimpleCondition 统一 AND 或 OR）、mode='expression' 为原始
 * guard 串。「条件 C」不再是单条 SimpleCondition，而是整段 guardSpec 序列化后的字符串（guided
 * 多条整体括号包裹，expression 恒括号包裹），else 分支同理用 invertGuardSpec 取反（guided 走单层
 * 德摩根；expression 无 NOT，只允许空 else，非空则编译期报错）。详见 serializeGuardSpec/
 * parseGuardPath/invertGuardSpec。
 */

import type { CompareOp, ConditionGroup, V4ExpressionDocument } from '@kimposoft/expression-editor';
import { t as $t } from '../i18n';
import type {
  ActionBehaviorDocument,
  BehaviorActionGroup,
  BehaviorActionNode,
  BehaviorCondition,
  BehaviorGuard,
  BehaviorTriggerBinding
} from './bundle';
import type {
  ActionTriggerEventKey,
  ComparisonOperator,
  ConditionNodeGuard,
  ConditionV4Spec,
  GuardConditionGroup,
  MindNode,
  SimpleCondition,
  WorkflowGateStep
} from './model';
import { COMPARISON_OPERATORS, createConditionNode, createNodeId, invertGuardSpec } from './model';
import { isWriteKind, resolveOperationKind, type DataActionKind } from './dataActionKind';

// ─────────────────────────── 条件 ↔ guard 串 ───────────────────────────

/** 把字面量序列化进 guard 串：字符串单引号包裹（''转义单引号），布尔/数字原样。 */
function serializeLiteral(value: SimpleCondition['value']): string {
  if (typeof value === 'string') {
    return `'${value.replace(/'/g, "''")}'`;
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  return String(value);
}

/** SimpleCondition → `{{field:<id>}} <op> <literal>`（字段级条件串，不解析物理表名）。 */
export function serializeCondition(condition: SimpleCondition): string {
  return `{{field:${condition.fieldId}}} ${condition.op} ${serializeLiteral(condition.value)}`;
}

/**
 * path（已按顺序拼装的「路径段」数组）序列化为组级 guard 串——每个元素本身已是括号安全的单元
 * （单条裸串 / guided 多条已括号包裹 / expression 已括号包裹，见 serializeGuardSpec），此处只需
 * 顶层 AND 拼接，不再关心元素内部结构。
 */
export function serializeGuardPath(path: string[]): string {
  return path.join(' AND ');
}

// 字面量只认两种形态：单引号包裹的字符串（内部 '' 转义）或不含空白的裸词（数字/true/false——
// 二者都是 serializeLiteral 的唯一输出形态，不含空格）。parseCondition 的成功/失败被
// parseGuardSegment 直接当作「这段文本是否为合法单条件」的判定依据（用于决定是否回落 expression
// 模式），因此这里必须严格到「整段文本恰好是一个条件、没有多余尾巴」——旧版 `(.+)$` 贪婪匹配会把
// 紧跟在合法条件之后的其它内容（如 ` OR {{field:y}} > 0`）当成字面量的一部分吞掉，被误判为「能
// 解析」，从而漏判本该回落 expression 模式的复合表达式。
const CONDITION_RE = /^\{\{field:([A-Za-z][A-Za-z0-9_]*)\}\}\s*(>=|<=|!=|>|<|=)\s*('(?:[^']|'')*'|\S+)$/;

function parseLiteral(raw: string): SimpleCondition['value'] {
  const text = raw.trim();
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) {
    return text.slice(1, -1).replace(/''/g, "'");
  }
  if (text === 'true') return true;
  if (text === 'false') return false;
  const num = Number(text);
  return Number.isNaN(num) ? text : num;
}

/** 解析单条 guard 串为 SimpleCondition；不匹配时返回 null。 */
export function parseCondition(text: string): SimpleCondition | null {
  const match = CONDITION_RE.exec(text.trim());
  if (!match) return null;
  const op = match[2] as ComparisonOperator;
  if (!COMPARISON_OPERATORS.includes(op)) return null;
  return { fieldId: match[1], op, value: parseLiteral(match[3]) };
}

// ─────────────────────────── 条件节点双判断模式（guided 引导式 / expression 表达式） ───────────────────────────

/**
 * ConditionNodeGuard → guard 串（作为「路径段」使用时已括号安全，可被上级 AND 链直接拼接）：
 * - guided 单条：`serializeCondition` 原样（不加括号——与旧版逐字节一致，零回归锚）；
 * - guided 多条：整体括号包裹 `(P1 AND P2)` / `(P1 OR P2)`；
 * - expression：trim 后的原始串，非空恒加括号（表达式可能自带顶层 OR，被上级路径 AND 拼接时
 *   若不加括号会因优先级把 OR 的左右操作数错误拆散到 AND 两侧——不能省略这层保护）。
 * 空/无效 guard（guided 0 条 或 expression 空串）返回空串，调用方按「无 guard」处理。
 */
export function serializeGuardSpec(spec: ConditionNodeGuard | undefined): string {
  if (!spec) return '';
  // V4 判断表达式：规范串 = `#v<conditionId>` + 「不成立」侧后缀 `!`，
  // **只用于 then/else 配对比对**（同 group 分支：配对要的是确定性可重算的串，不要求可执行）。
  // 不把 source_text 拼进串：同一条件在两侧共用同一条池条目，靠 conditionId 就足以配对，且表达式
  // 文本里的空白/token 变动不该影响分支结构。
  if (spec.v4) return `#v${spec.v4.conditionId}${spec.v4.negate ? '!' : ''}`;
  // 结构化形态：产出确定性规范串（稳定键序的 JSON），**只用于 then/else 配对比对**
  // ——配对机制要的是「确定性可重算的规范串」，不要求这个串本身是可执行的 guard 语法。结构化条件
  // 的持久化形态是 guards[].condition_group，不经本函数。
  if (spec.group) return `#g${canonicalJson(spec.group)}`;
  if (spec.mode === 'expression') {
    const expr = (spec.expression ?? '').trim();
    return expr === '' ? '' : `(${expr})`;
  }
  const items = spec.guided?.items ?? [];
  if (items.length === 0) return '';
  if (items.length === 1) return serializeCondition(items[0]);
  const logic = spec.guided?.logic === 'or' ? 'OR' : 'AND';
  return `(${items.map(serializeCondition).join(` ${logic} `)})`;
}

// ─────────────────── guard 规格 ↔ 结构化条件 ───────────────────

/**
 * 稳定键序 JSON 序列化：同一棵条件树无论键的插入顺序如何，恒得同一个串。
 *
 * 为什么不用 JSON.stringify：它按**插入顺序**输出键。同一条件经不同路径构造（用户新配 vs 从文档
 * 反解回来 vs invertGuardSpec 用展开语法重建）键序可能不同，而 then/else 配对是逐字节比串——键序
 * 一漂，同一条件的 then 段与 else 段会被判成两个不同条件，分支结构在 round-trip 中散架。
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}


/** SimpleCondition 的比较符 → 结构化条件的 CompareOp。两套值域一一对应，无损。 */
const STRUCTURED_OP_BY_COMPARISON: Record<ComparisonOperator, CompareOp> = {
  '=': 'eq',
  '!=': 'neq',
  '>': 'gt',
  '>=': 'gte',
  '<': 'lt',
  '<=': 'lte'
};

/**
 * 把一条 guard 规格表达成 结构化条件组；表达不了时返回 null。
 *
 * 三种输入：
 *  - 已是结构化（spec.group）：原样返回，它本就是权威；
 *  - 旧 guided（单层且/或 + 字面量右值）：机械转换——字段引用变 form_field、比较符按上表映射、
 *    右值变 const。这是无损的：guided 的表达力是结构化的真子集。
 *    table_id 刻意留空：宿主后端 guard 求值时字段引用只按 field_id 定位宿主表单数据层坐标，
 *    表归属由触发上下文决定，不由条件自带。
 *  - 旧 expression（原始 KimpoSQL 串）：**返回 null**。串要变结构化得在前端再实现一遍后端
 *    谓词解析文法，那是重复实现且容易与后端漂移，故不做，由调用方按「这条路径整体
 *    走旧串式」处理。
 */
export function guardSpecToConditionGroup(spec: ConditionNodeGuard | undefined): ConditionGroup | null {
  if (!spec) return null;
  // V4 判断表达式：不是结构化条件形态，落 conditions 池 + guard.path 这条独立
  // 路径（见 pushGuardPath），这里明确返回 null——调用方据此不走 condition_group。
  if (spec.v4) return null;
  if (spec.group) return spec.group;
  if (spec.mode !== 'guided') return null;
  const items = spec.guided?.items ?? [];
  if (items.length === 0) return null;
  return {
    logic: spec.guided?.logic === 'or' ? 'or' : 'and',
    items: items.map(item => ({
      predicate: {
        left: { kind: 'form_field' as const, field_id: item.fieldId },
        op: STRUCTURED_OP_BY_COMPARISON[item.op],
        right: { kind: 'const' as const, value: item.value }
      }
    }))
  };
}

/**
 * 把一条条件路径（从触发根到当前 band 的各层条件）表达成**一个** 结构化条件组：各层 AND 串联。
 * 路径上任一层表达不了（旧 expression 串）时返回 null，调用方据此整条退回旧串式路径。
 *
 * 单层路径不套外壳直接返回该层——少一层无谓嵌套，求值语义完全相同。
 */
function conditionGroupForPath(path: ConditionNodeGuard[]): ConditionGroup | null {
  // V4 判断表达式：路径上一旦出现 V4 条件，整条路径改由 pushGuardPath 的 path
  // 形态接管（含「V4 与旧形态混用则具名报错」这一闸），此处不再尝试结构化。
  if (path.some(spec => !!spec.v4)) return null;
  // 只有路径上**真的出现过**结构化条件时才启用新形态。全部是旧 guided 的路径继续走 KimpoSQL 串
  // ——旧条件的编译产物逐字节不变（零回归），新形态只跟着新配的条件进入文档。
  // 混合路径（新旧同在一条路径上）必须整条统一，否则组级 guard 这一个条目装不下两种形态、必丢
  // 一半门控；此时把旧 guided 层机械升级成结构化（无损，见 guardSpecToConditionGroup），
  // 整条走结构化。
  if (!path.some(spec => !!spec.group)) return null;
  const groups: ConditionGroup[] = [];
  for (const spec of path) {
    const group = guardSpecToConditionGroup(spec);
    if (!group) return null;
    groups.push(group);
  }
  if (groups.length === 0) return null;
  if (groups.length === 1) return groups[0];
  return { logic: 'and', items: groups.map(group => ({ group })) };
}

/** guardSpec 是否为「有效 guard」（guided 至少 1 条 / expression 非空串）；否则视为未配置，走无条件旁路。 */
function isEffectiveGuardSpec(spec: ConditionNodeGuard | undefined): boolean {
  if (!spec) return false;
  // V4 判断表达式：token 化源码非空即有效（refs 可为空——纯常量/系统变量谓词
  // 合法）。与 group 分支同理，漏这一支会让配好的条件被当成「未配置」静默走无条件旁路。
  if (spec.v4) return (spec.v4.expression?.source_text ?? '').trim() !== '';
  // 结构化条件：至少一项即有效。漏了这一支会让结构化条件被当成「未配置」走无条件
  // 旁路——界面上配了、编译后完全没有 guard，且不报错（前端侧的 fail-open，与后端
  // pipeline.guardHasCondition 同一类风险，两侧判据必须同源）。
  if (spec.group) return (spec.group.items?.length ?? 0) > 0;
  if (spec.mode === 'expression') return (spec.expression ?? '').trim() !== '';
  return (spec.guided?.items.length ?? 0) > 0;
}

/**
 * 从条件节点取其权威 guardSpec：优先节点自身的 guardSpec；否则从旧字段 condition 合成 guided
 * 单条镜像（向后兼容手工构造的节点/旧内存态，不依赖调用方一定经过 createConditionNode）。
 */
function guardSpecOf(node: MindNode): ConditionNodeGuard | undefined {
  if (node.guardSpec) return node.guardSpec;
  if (node.condition) return { mode: 'guided', guided: { logic: 'and', items: [node.condition] } };
  return undefined;
}

/**
 * 按顶层关键字切分文本（不跨括号深度、不跨单引号字符串内部切分）；未出现分隔符时返回单元素数组。
 * 用于 parseGuardPath 的顶层 AND 切分，以及括号内 guided 分组的顶层 AND/OR 切分。
 */
function splitTopLevel(text: string, keyword: 'AND' | 'OR'): string[] {
  const parts: string[] = [];
  const re = new RegExp(`\\s+${keyword}\\s+`, 'g');
  let depth = 0;
  let inString = false;
  let start = 0;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (inString) {
      if (ch === "'") {
        if (text[i + 1] === "'") {
          i += 2;
          continue;
        }
        inString = false;
      }
      i += 1;
      continue;
    }
    if (ch === "'") {
      inString = true;
      i += 1;
      continue;
    }
    if (ch === '(') {
      depth += 1;
      i += 1;
      continue;
    }
    if (ch === ')') {
      depth -= 1;
      i += 1;
      continue;
    }
    if (depth === 0) {
      re.lastIndex = i;
      const match = re.exec(text);
      if (match && match.index === i) {
        parts.push(text.slice(start, i));
        i += match[0].length;
        start = i;
        continue;
      }
    }
    i += 1;
  }
  parts.push(text.slice(start));
  return parts.map(part => part.trim());
}

/**
 * 解析括号包裹的引导式分组内容（不含外层括号）：顶层按 AND 或 OR 切分为 items（二者不可混用/嵌套，
 * 混用视为超出「单层引导式」表达能力，返回 null 交由调用方回落 expression 模式）。
 */
function tryParseGuidedGroup(innerText: string): GuardConditionGroup | null {
  const andParts = splitTopLevel(innerText, 'AND');
  const orParts = splitTopLevel(innerText, 'OR');
  if (andParts.length > 1 && orParts.length === 1) {
    const items = andParts.map(parseCondition);
    return items.every((c): c is SimpleCondition => c !== null) ? { logic: 'and', items } : null;
  }
  if (orParts.length > 1 && andParts.length === 1) {
    const items = orParts.map(parseCondition);
    return items.every((c): c is SimpleCondition => c !== null) ? { logic: 'or', items } : null;
  }
  if (andParts.length === 1 && orParts.length === 1) {
    // 无顶层分隔符：退化为单条。
    const single = parseCondition(innerText);
    return single ? { logic: 'and', items: [single] } : null;
  }
  return null; // AND/OR 混用或其它无法归约的结构
}

/** 解析单个「路径段」文本为 ConditionNodeGuard；不可解析（既非裸单条也非合法括号分组）返回 null。 */
function parseGuardSegment(text: string): ConditionNodeGuard | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  if (trimmed.startsWith('(') && trimmed.endsWith(')')) {
    const group = tryParseGuidedGroup(trimmed.slice(1, -1).trim());
    return group ? { mode: 'guided', guided: group } : null;
  }
  const single = parseCondition(trimmed);
  return single ? { mode: 'guided', guided: { logic: 'and', items: [single] } } : null;
}

/**
 * 解析组级 guard 串为按深度顺序排列的 ConditionNodeGuard 分段（每段对应路径上一层条件节点的
 * then/else 分支选择）：
 * - 顶层按 AND 切分（尊重括号深度/字符串字面量）；
 * - 任一切分片段解析失败（不可归约为裸单条或合法括号分组）→ 整个 guard 串回落为单一 expression
 *   模式分段（{mode:'expression', expression:<原串>}），不 throw（graceful 降级：
 *   若抛错会中断整份文档加载、设计器整体打不开；就地识别为一个表达式条件节点后，
 *   文档仍可正常打开、可编辑/可另存）。
 */
export function parseGuardPath(condition: string | undefined): ConditionNodeGuard[] {
  const text = (condition ?? '').trim();
  if (text === '') return [];
  const segments = splitTopLevel(text, 'AND');
  const parsed: ConditionNodeGuard[] = [];
  for (const segment of segments) {
    const spec = parseGuardSegment(segment);
    if (!spec) return [{ mode: 'expression', expression: text }];
    parsed.push(spec);
  }
  return parsed;
}

/**
 * 解析一条组级 guard 为按深度顺序排列的路径分段（统一入口）。
 *
 * 结构化条件（condition_group）优先且独占——与后端 pipeline.evaluateGuardTruth 的选路口径严格一致。
 * 拆层规则是 pushGuardPath 的逆运算：
 *  - 顶层是「各层 AND 串联」的外壳（logic='and'、negate 为假、且每一项都是子组）→ 逐子组拆成各层；
 *  - 否则说明这条路径只有一层（pushGuardPath 对单层路径不套外壳）→ 整棵树就是那一层。
 *
 * 「每一项都是子组」这个条件不能省：用户完全可能在**同一层**里配出一个 and 组、其下若干条谓词，
 * 那棵树同样是 logic='and'，但项是谓词而不是子组。只看 logic 就拆，会把一层条件的若干谓词误拆成
 * 多层路径，分支结构在打开文档时直接散架。
 */
export function parseGuardEntry(guard: BehaviorGuard | undefined, conditionById?: Map<string, BehaviorCondition>): ConditionNodeGuard[] {
  if (!guard) return [];
  // V4 判断表达式：path 形态优先且独占——一步一层，逐步从文档级 conditions 池
  // 取回整份表达式文档。池内缺失**必须抛错**：静默丢步会让分支结构少一层、门控被悄悄放宽
  // （与「静默放宽 guard」同一类风险，见 pushGuardPath 注释），宁可让文档打不开也不能少一道条件。
  if (guard.path && guard.path.length > 0) {
    return guard.path.map(step => {
      const entry = conditionById?.get(step.condition_id);
      if (!entry) {
        throw new Error($t('actionDesigner.compile.conditionNotInPool', { conditionId: step.condition_id }));
      }
      const v4: ConditionV4Spec = { conditionId: step.condition_id, expression: entry.document.expression };
      // negate 只在「不成立」侧写入（与编译侧省略 false 的写法对称，保证 round-trip 逐字可逆）。
      if (step.negate) v4.negate = true;
      if (entry.plan) v4.plan = entry.plan;
      return { mode: 'expression' as const, v4 };
    });
  }
  const group = guard.condition_group;
  if (group) {
    const isPathEnvelope =
      group.logic === 'and' && !group.negate && (group.items?.length ?? 0) > 0 && group.items.every(item => !!item.group && !item.predicate);
    if (isPathEnvelope) {
      return group.items.map(item => ({ mode: 'guided' as const, group: item.group as ConditionGroup }));
    }
    return [{ mode: 'guided', group }];
  }
  return parseGuardPath(guard.condition);
}

/** 路径段字符串相等比较（确定性：guardSpec 经 serializeGuardSpec 序列化后逐字节比对，机制同旧 C/!C 配对）。 */
function sameGuardSpec(a: ConditionNodeGuard, b: ConditionNodeGuard): boolean {
  return serializeGuardSpec(a) === serializeGuardSpec(b);
}

/**
 * 尝试把一段自由文本表达式转换为引导式单层分组（NodeConfigDialog「表达式→引导式」模式切换用）：
 * 顶层允许不带括号（裸单条 / 裸 AND 链 / 裸 OR 链均可），与 parseGuardSegment 只认「已带外层括号
 * 的分组」不同——这里的输入是用户对**同一个条件节点**整段手写的表达式，不涉及跨节点路径拼接，
 * 无需靠括号区分层级。AND/OR 混用、含函数/参数等超出单层引导式表达能力时返回 null，
 * 由调用方决定回退方案（如提示用户「无法转换，将清空」）。
 */
export function tryConvertExpressionToGuidedGroup(expression: string): GuardConditionGroup | null {
  const trimmed = expression.trim();
  if (trimmed === '') return null;
  const unwrapped = trimmed.startsWith('(') && trimmed.endsWith(')') ? trimmed.slice(1, -1).trim() : trimmed;
  return tryParseGuidedGroup(unwrapped);
}

/** 触发字段按事件分离仅对这两类事件有意义（其余事件恒 scopes=['form']）。 */
const FIELD_SCOPED_EVENTS = new Set<ActionTriggerEventKey>(['value-change', 'field-click']);

/**
 * 写动作按数据动作种类（create / update / delete）识别，不按官方动作名字面量清单——第三方声明为写类种类的
 * 动作与官方写节点同口径在 before-save 根下被强制同步。
 *
 * compile.ts 只持有 MindNode（无 ActionDefinition），种类由调用方经 options.operationKindOf 按动作目录
 * 注入（useActionDesigner 传 registryByName）；未注入时按官方兼容表兜底（见 dataActionKind.ts）。
 */
type OperationKindResolver = (actionName: string | undefined) => DataActionKind | undefined;

/** 默认种类解析：无动作目录时只认官方兼容表（与宿主内置兼容表同口径）。 */
const defaultOperationKindOf: OperationKindResolver = actionName => resolveOperationKind(actionName);

// ─────────────────── 触发根流程步骤门（workflow_gate）───────────────────

/** bundle 侧单步门的形状（从 BehaviorTriggerBinding['workflow_gate'] 上取，避免重复声明）。 */
type BundleGateStep = NonNullable<BehaviorTriggerBinding['workflow_gate']>['steps'][number];

/**
 * 单步门序列化：definition_id/node_id 恒写；definition_name/node_name 是非权威展示快照，
 * trim 后非空才写（省略不影响语义，与 action.name 等"仅非默认值才写"的编码习惯一致）；
 * arrivals 两档（submitted+returned）全选时省略该键（缺省语义=两档都要），否则写出选中的那些——
 * 按 submitted、returned 固定顺序输出，保证同一选择集恒得同一份字节（往返可逆的前提）。
 */
function serializeGateStep(step: WorkflowGateStep): BundleGateStep {
  const out: BundleGateStep = { definition_id: step.definitionId, node_id: step.nodeId };
  if (step.definitionName?.trim()) out.definition_name = step.definitionName.trim();
  if (step.nodeName?.trim()) out.node_name = step.nodeName.trim();
  const arrivals = step.arrivals ?? [];
  const hasSubmitted = arrivals.includes('submitted');
  const hasReturned = arrivals.includes('returned');
  if (!(hasSubmitted && hasReturned)) {
    const picked: ('submitted' | 'returned')[] = [];
    if (hasSubmitted) picked.push('submitted');
    if (hasReturned) picked.push('returned');
    out.arrivals = picked;
  }
  return out;
}

/**
 * 触发根 workflowGate → bundle workflow_gate：steps 按 (definition_id, node_id) 稳定
 * 排序去重（同一步骤被重复勾选只算一条，取首次出现的展示快照）；not_started 仅 true 时写；
 * 空门（steps 为空且 notStarted 为假）返回 undefined，调用方按"无门"处理——不多写一个字节。
 */
function buildWorkflowGate(gate: MindNode['workflowGate']): BehaviorTriggerBinding['workflow_gate'] {
  if (!gate) return undefined;
  const dedup = new Map<string, WorkflowGateStep>();
  for (const step of gate.steps ?? []) {
    const key = `${step.definitionId}::${step.nodeId}`;
    if (!dedup.has(key)) dedup.set(key, step);
  }
  const steps = [...dedup.values()].sort((a, b) => {
    if (a.definitionId !== b.definitionId) return a.definitionId < b.definitionId ? -1 : 1;
    return a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0;
  });
  if (steps.length === 0 && !gate.notStarted) return undefined;
  const out: NonNullable<BehaviorTriggerBinding['workflow_gate']> = { steps: steps.map(serializeGateStep) };
  if (gate.notStarted) out.not_started = true;
  return out;
}

/**
 * bundle workflow_gate → 触发根 workflowGate（反向打开）：缺省 arrivals（后端省略=两档都要）在此
 * 补全为显式两档，保证内存态"恒显式两档全写"的不变式（见 model.ts WorkflowGateStep 注释）。
 * 无 workflow_gate 键（无门）返回 undefined。
 */
function parseWorkflowGate(raw: BehaviorTriggerBinding['workflow_gate']): MindNode['workflowGate'] {
  if (!raw) return undefined;
  const steps: WorkflowGateStep[] = (raw.steps ?? []).map(step => ({
    definitionId: step.definition_id,
    nodeId: step.node_id,
    definitionName: step.definition_name,
    nodeName: step.node_name,
    arrivals: step.arrivals && step.arrivals.length > 0 ? [...step.arrivals] : ['submitted', 'returned']
  }));
  return { notStarted: raw.not_started === true, steps };
}

// ─────────────────────────── 正向编译 ───────────────────────────

export interface CompileContext {
  /** 触发根编译为唯一一条 binding；id 由根节点推导，保证稳定可逆。 */
  bindingIdPrefix?: string;
}

/**
 * compileEventsToBundle：一组触发根（= 多个动作事件）→ ActionBehaviorDocument。
 * - group/guard id 用**跨事件全局计数器**，避免多事件合并到同一 bundle 时 id 冲突；
 *   action_nodes 用 MindNode id（已全局唯一）。
 * - 每个 root 产出一条 trigger_binding，其 ordered_group_ids 仅含本事件的组（前序遍历，保证可逆）。
 */
export function compileEventsToBundle(
  roots: MindNode[],
  options: {
    seqStart?: number;
    /** 动作名 → 数据动作种类：识别 before-save 根下需强制同步的写节点。 */
    operationKindOf?: OperationKindResolver;
  } = {}
): ActionBehaviorDocument {
  const operationKindOf = options.operationKindOf ?? defaultOperationKindOf;
  const groups: BehaviorActionGroup[] = [];
  const nodes: BehaviorActionNode[] = [];
  const guards: BehaviorGuard[] = [];
  const triggerBindings: BehaviorTriggerBinding[] = [];
  // 文档级条件池：跨事件全局、按 conditionId 去重——同一条件被 then/else 两侧以及多条
  // 嵌套路径引用时只登记一条（后端一次派发内也只求值一次）。
  const conditions: BehaviorCondition[] = [];
  const conditionIds = new Set<string>();
  // group/guard id 按「当前事件的稳定 bindingId」命名空间化、每个事件内从 1 计数：
  // 既跨事件唯一（前缀不同），又稳定（同事件同结构 → 同 id），从而支持单事件保存时精确替换该事件的实体。
  let currentBindingId = '';
  let groupSeq = 0;
  let guardSeq = 0;
  // 当前正在处理的触发根事件集合是否含 before-save——由下方 roots 循环按根置位，
  // appendActionNode 据此判定写动作是否要被强制同步（见该函数内注释）。
  let currentRootBlocksWriteAsync = false;

  function pushGuard(condition: string): string {
    guardSeq += 1;
    const guardId = `${currentBindingId}_gd${guardSeq}`;
    guards.push({ guard_id: guardId, condition });
    return guardId;
  }

  /**
   * 组级 guard 落库：整条条件路径优先表达成 结构化条件（condition_group），
   * 表达不了（路径上有旧 expression 串层）才退回旧的 KimpoSQL 串 AND 链。
   *
   * 「整条路径要么全结构化、要么全串式」不是洁癖：组级 guard 在文档里就是**一个**条目，后端按
   * condition_group 存在与否**独占**选路（见 pipeline.evaluateGuardTruth）。若一条路径里混着两种
   * 形态，无论落哪一种都会丢掉另一半条件——那是静默放宽门控，比报错危险得多。
   */
  /**
   * 把一条 V4 条件登记进文档级条件池：按 conditionId 去重（首次登记为准）。
   * 文档 expression 逐字取自 spec.expression，只强制两处身份字段（expression_id = conditionId、
   * purpose = 'condition'）——后端按这两处认领表达式；`plan` 有则原样透传，前端不改写不补算。
   */
  function registerCondition(v4: ConditionV4Spec): void {
    if (conditionIds.has(v4.conditionId)) return;
    conditionIds.add(v4.conditionId);
    const entry: BehaviorCondition = {
      condition_id: v4.conditionId,
      document: {
        schema_version: 'kimpo.report-expression/v4',
        mode: 'condition',
        expression: { ...v4.expression, expression_id: v4.conditionId, purpose: 'condition' }
      }
    };
    if (v4.plan) entry.plan = v4.plan;
    conditions.push(entry);
  }

  function pushGuardPath(path: ConditionNodeGuard[]): string {
    // V4 判断表达式：路径上出现 V4 条件时整条走 path 形态。
    // 「要么全 V4、要么全旧形态」与下方结构化/串式同一条理由：组级 guard 在文档里只有**一个**条目，
    // 三形态至多其一，混着装必丢一半门控（静默放宽），故具名报错而不是挑一种落。
    if (path.some(spec => !!spec.v4)) {
      if (!path.every(spec => !!spec.v4)) {
        throw new Error($t('actionDesigner.compile.conditionLegacyMixed'));
      }
      guardSeq += 1;
      const guardId = `${currentBindingId}_gd${guardSeq}`;
      const steps = path.map(spec => {
        const v4 = spec.v4!;
        registerCondition(v4);
        // negate 仅「不成立」侧写 true，成立侧省略键（与后端 omitempty 对齐，避免零值改变规范化字节）。
        const step: { condition_id: string; negate?: boolean } = { condition_id: v4.conditionId };
        if (v4.negate) step.negate = true;
        return step;
      });
      guards.push({ guard_id: guardId, condition: '', path: steps });
      return guardId;
    }
    const group = conditionGroupForPath(path);
    if (group) {
      guardSeq += 1;
      const guardId = `${currentBindingId}_gd${guardSeq}`;
      guards.push({ guard_id: guardId, condition: '', condition_group: group });
      return guardId;
    }
    return pushGuard(serializeGuardPath(path.map(serializeGuardSpec)));
  }

  function appendActionNode(action: MindNode): void {
    const node: BehaviorActionNode = {
      node_id: action.id,
      action_name: action.actionName ?? ''
    };
    if (action.source) node.source = action.source;
    // before-save 触发根下的写动作（新增/修改/删除数据；按数据动作种类识别，
    // 第三方写类种类同口径）必须同步执行——失败要能阻断
    // 保存，异步会让 before-save 校验/拦截语义失效。这里是保存链路的最后一道闸：即使 action.async
    // 在设计器里被置 true（如节点从别的触发根拖拽/复制而来，未经 NodeConfigDialog 那道闸重置），
    // 编译进文档时也不产出 async:true（省略即等价 false，与本文件其余"仅非默认值才写字段"的
    // 编码习惯一致，见上方 node.disabled 同款写法）。
    if (action.async && !(currentRootBlocksWriteAsync && isWriteKind(operationKindOf(action.actionName)))) node.async = true;
    // 名称：非空且与动作名不同才持久化（默认名=动作显示名时省略，避免冗余）。
    const trimmedName = action.name?.trim();
    if (trimmedName) node.name = trimmedName;
    // 启用态默认，仅停用时写 disabled=true（向后兼容：旧文档无此字段 → 启用）。
    if (action.enabled === false) node.disabled = true;
    if (action.params && Object.keys(action.params).length > 0) node.params = action.params;
    if (action.nodeGuard) node.node_guard_id = pushGuard(serializeCondition(action.nodeGuard));
    // 出口分支（与 continuation_group_ids 互斥）：动作定义声明 x-outcomes 时，节点后的续接不再走
    // 单一 children band，而是按 outcome 分流——每个 outcome 各自一条独立 band（与 condition 的
    // then/else 同构，但用 map key 而非 guard 反转区分分支，故各出口 band 无需 fixateEmpty：
    // 键本身就保留了「该出口存在」的结构信息，空 band 直接产出空组 id 列表即可、无损可逆）。
    // 按 key 排序遍历，保证同一份 outcomeChildren → 同一组 group/guard id 序列（幂等可复现）。
    const outcomeBands = action.outcomeChildren;
    if (outcomeBands && Object.keys(outcomeBands).length > 0) {
      const outcomeGroupIds: Record<string, string[]> = {};
      for (const outcome of Object.keys(outcomeBands).sort()) {
        const ids: string[] = [];
        walkBand(outcomeBands[outcome] ?? [], [], ids, false);
        outcomeGroupIds[outcome] = ids;
      }
      node.outcome_continuation_group_ids = outcomeGroupIds;
      nodes.push(node);
      return;
    }
    // 子流程（向右挂载）= 本节点的 children band：
    // - 若该 band 含条件分支 → 编译为本节点的「续接组」(continuation_group_ids)，复用 walkBand，
    //   表达「动作执行后,下一步条件分支并执行后续动作」；续接 band 自成一段，path 从空起算。
    // - 否则（纯动作）→ 沿用轻量的 children_node_ids，递归平铺进节点池（向后兼容、零结构变化）。
    const childBand = action.children ?? [];
    if (childBand.some(child => child.kind === 'condition')) {
      const continuationGroupIds: string[] = [];
      walkBand(childBand, [], continuationGroupIds, false);
      node.continuation_group_ids = continuationGroupIds;
      nodes.push(node);
      return;
    }
    const childActions = childBand.filter(child => child.kind === 'action');
    if (childActions.length > 0) node.children_node_ids = childActions.map(child => child.id);
    nodes.push(node);
    for (const child of childActions) appendActionNode(child);
  }

  function emitGroup(actions: MindNode[], path: ConditionNodeGuard[], orderedGroupIds: string[]): void {
    groupSeq += 1;
    const group: BehaviorActionGroup = { group_id: `${currentBindingId}_g${groupSeq}`, ordered_node_ids: [] };
    if (path.length > 0) group.group_guard_id = pushGuardPath(path);
    for (const action of actions) {
      appendActionNode(action);
      group.ordered_node_ids.push(action.id);
    }
    groups.push(group);
    orderedGroupIds.push(group.group_id);
  }

  // fixateEmpty：是否把「空 band」固化为一个空动作组（仅 then/else 分支需要，用于保留分支结构、保证可逆）；
  // 后段（汇合后续）不固化空组，避免产出幻影汇合组破坏 round-trip。
  function walkBand(band: MindNode[] | undefined, path: ConditionNodeGuard[], orderedGroupIds: string[], fixateEmpty = false): void {
    const members = band ?? [];
    const condIdx = members.findIndex(node => node.kind === 'condition' && isEffectiveGuardSpec(guardSpecOf(node)));
    const conditionNode = condIdx >= 0 ? members[condIdx] : undefined;
    if (!conditionNode) {
      // 无（有效）guard 的条件：整带作为一条顺序动作组；空分支固化为空组以保留结构（保证可逆）。
      const actions = members.filter(node => node.kind === 'action');
      if (actions.length > 0) emitGroup(actions, path, orderedGroupIds);
      else if (fixateEmpty && path.length > 0) emitGroup([], path, orderedGroupIds);
      return;
    }
    const spec = guardSpecOf(conditionNode)!;
    // band 可含多个顺序条件：在「首个条件」处分叉，其后段（含更多条件）按同 path 续 walk。
    // 前置动作组 → then/else 分支子树 → 后段（同 path、无额外分支 guard，递归处理后续动作与下一个条件）。
    // 运行时按组顺序执行 = 「逐个条件门控：成立/不成立二选一执行后，汇合再继续，遇到下个条件再次分叉」。
    const preActions = members.slice(0, condIdx).filter(node => node.kind === 'action');
    const postMembers = members.slice(condIdx + 1);
    if (preActions.length > 0) emitGroup(preActions, path, orderedGroupIds);
    walkBand(conditionNode.thenChildren, [...path, spec], orderedGroupIds, true);
    // 「不成立分支」的可用性取决于**能否安全取反**，而不是编辑模式：
    //  - 结构化条件：取反 = 翻转组级 negate（后端降成 ir.Not），恒可用——表达式模式
    //    下也能有 else 分支了，历史限制随之解除；
    //  - 旧 expression 串：KimpoSQL guard 文法无 NOT，生成不出取反串，只允许空 else（原样保留）。
    //  - V4 判断表达式：取反 = 路径步 negate 翻转（后端按补集收窄上下文），
    //    与结构化同属「恒可用」，故这道旧闸只对「无 v4 且无 group」的旧 KimpoSQL 串保留。
    if (!spec.v4 && !spec.group && spec.mode === 'expression') {
      // expression 模式无 NOT（宿主后端 guard 文法与求值器均只覆盖
      // AND/OR/比较符，没有取反能力）——else 分支无法生成安全取反 guard。因此 expression 模式的
      // 条件节点只允许空 else；非空则视为非法配置，编译期报错阻断（不静默丢弃业务语义）。
      const elseChildren = conditionNode.elseChildren ?? [];
      if (elseChildren.length > 0) {
        throw new Error($t('actionDesigner.compile.expressionElseUnsupported'));
      }
      // 空 else：不固化空组（与 guided 不同——没有可用的取反 guard 可写），reconstructBand 一侧
      // 对应地也不会为 expression 条件节点还原出 else 分支。
    } else {
      walkBand(conditionNode.elseChildren, [...path, invertGuardSpec(spec)], orderedGroupIds, true);
    }
    // 后段在两分支之后入序；空后段不产组（fixateEmpty=false）。
    if (postMembers.length > 0) walkBand(postMembers, path, orderedGroupIds, false);
  }

  for (const [rootIndex, root] of roots.entries()) {
    if (root.kind !== 'trigger-root' || !root.eventKey) {
      throw new Error($t('actionDesigner.compile.needTriggerRootEvents'));
    }
    // 画布顺序：同一触发下多个动作按事件列表顺序执行——按根下标写 seq（1 起连续，
    // 单事件保存时由调用方传 seqStart=该事件在列表中的下标+1），同根多 binding 同值。
    const seq = (options.seqStart ?? 1) + rootIndex;
    // 稳定 bindingId 作为 group/guard id 命名空间（每根计数归零，保证同根 id 稳定、跨根唯一）。
    const rootBindingId = root.bindingId ?? `tb_${root.id}`;
    const eventKeys = root.eventKeys && root.eventKeys.length > 0 ? root.eventKeys : [root.eventKey];
    // 多事件根：多个勾选事件的触发条件（事件+字段）各不相同，故一根拆产多条 binding；
    // 但组/guard 只按 walkBand 算一次，多条 binding 共享同一批 ordered_group_ids（N:1 骨架）。
    const isMultiEvent = eventKeys.length > 1;
    // 🔴 触发范围解析必须先于 walkBand（孤儿实体修复）：
    // value-change/field-click 在「未选触发字段」时不产 binding。旧实现把这个判断留在 walkBand
    // **之后**的产 binding 循环里，于是组/节点已经进池、binding 却一条没有——产出一批谁也引用不到
    // 的孤儿。孤儿能存进库（后端图校验只查引用完整性与无环，不拒孤儿），反向打开时又因为没有
    // binding 而不还原成画布事件，等于隐身。之后用户把触发字段补上再保存，useActionDesigner 的
    // removeRootFromDoc 从 binding 出发做可达遍历，遍历不到孤儿 → 删不掉 → 新编译的同名组
    // (`${bindingId}_g<n>`) 与同 id 节点被直接追加 → 后端判 duplicate group_id / node_id，整份
    // 动作文档 400（DESIGN_FILE_INVALID），且此后该事件每次保存都撞同一堵墙。
    // 正解是「一个 binding 都产不出的根，一个实体也不产」——故先把可产出的事件连同 scopes 算好。
    const emittableEvents: { event: ActionTriggerEventKey; scopes: string[] }[] = [];
    for (const event of eventKeys) {
      if (FIELD_SCOPED_EVENTS.has(event)) {
        // value-change/field-click 的触发字段各自独立登记；字段未设置（缺省/空数组）
        // = 该事件不产出 binding（不触发）——'form' 整表单兜底已废除，不再回落。
        const fieldIds = root.eventFieldIds?.[event] ?? [];
        if (fieldIds.length === 0) continue;
        emittableEvents.push({ event, scopes: fieldIds.map(fieldId => `field:${fieldId}`) });
      } else {
        // 生命周期事件（create-time 等）不涉及字段范围，恒 scopes=['form']。
        emittableEvents.push({ event, scopes: ['form'] });
      }
    }
    // 全部事件都产不出 binding（典型：唯一的 value-change 还没选触发字段）→ 整根跳过，组/节点/guard
    // 一律不产。注意 isMultiEvent 仍按**原始** eventKeys 长度判定（见下方 binding_id 命名规则）：
    // 用可产出集合的长度会让「双事件根其中一个没选字段」的 binding_id 从 `${base}__<event>` 退化成
    // `${base}`，破坏存量文档的身份稳定性与交互按钮的 target_binding_id 引用。
    if (emittableEvents.length === 0) continue;
    currentBindingId = rootBindingId;
    groupSeq = 0;
    guardSeq = 0;
    // 本根事件集合是否含"保存前"类事件，供 appendActionNode（在下方 walkBand 递归期间
    // 被调用）判定写动作是否要被强制同步。before-save 已细分为 create-before-save/
    // edit-before-save 两档——新配置只会产出新键，老键仅存量文档回读兼容，故三键都要判，否则新建/
    // 编辑场景下的保存前写动作会静默漏掉强制同步这道闸（该约束失效）。
    currentRootBlocksWriteAsync =
      eventKeys.includes('before-save') || eventKeys.includes('create-before-save') || eventKeys.includes('edit-before-save');
    // 触发根流程步骤门：有门才产出，该根拆出的每条 binding 共享同一份（见下方
    // emittableEvents 循环），无门（undefined）不影响任何字节。
    const workflowGate = buildWorkflowGate(root.workflowGate);
    const orderedGroupIds: string[] = [];
    walkBand(root.children, [], orderedGroupIds, false);

    for (const { event, scopes } of emittableEvents) {
      // binding_id 稳定性规则（防破坏交互按钮 target_binding_id 引用手动流程）：
      // - 单事件根：沿用 root.bindingId 原值，无后缀；
      // - 多事件根：manual 恒用原 bindingId（按钮 target_binding_id 精确引用手动流程，不可变动）；
      //   其余事件加 `__<event>` 后缀区分（同根多条 binding 共享同一批组，仅触发条件不同）。
      const bindingId = !isMultiEvent || event === 'manual' ? rootBindingId : `${rootBindingId}__${event}`;
      const binding: BehaviorTriggerBinding = {
        binding_id: bindingId,
        trigger_event_key: event,
        trigger_event_keys: [event],
        scopes,
        ordered_group_ids: orderedGroupIds,
        seq
      };
      if (root.name) binding.name = root.name; // 自定义事件名（可选）持久化，同根各 binding 共享同名
      // 动作事件停用：只写停用态，启用态省略键（宿主规范化对零值敏感，见 bundle.ts 注释）。
      // 同根拆产的多条 binding 共享同一停用态——「停用一个动作事件」= 停掉它的全部触发条件。
      if (root.enabled === false) binding.disabled = true;
      // 流程步骤门：同根拆产的多条 binding 共享同一份门（与 disabled/seq 同规则）。
      if (workflowGate) binding.workflow_gate = workflowGate;
      triggerBindings.push(binding);
    }
  }

  const document: ActionBehaviorDocument = { trigger_bindings: triggerBindings, action_groups: groups, action_nodes: nodes, guards };
  // 条件池：有条件才写这一键，无条件时整键省略（不写空数组，见 bundle.ts 注释）。
  if (conditions.length > 0) document.conditions = conditions;
  return document;
}

/** compileMindmapToBundle：单触发根 → ActionBehaviorDocument（单事件薄封装，委托多事件版）。 */
export function compileMindmapToBundle(root: MindNode, ctx: CompileContext = {}): ActionBehaviorDocument {
  if (root.kind !== 'trigger-root' || !root.eventKey) {
    throw new Error($t('actionDesigner.compile.needTriggerRootMindmap'));
  }
  const bundle = compileEventsToBundle([root]);
  // 兼容旧入参：自定义 binding 前缀（默认 'tb' 与多事件版一致）。
  if (ctx.bindingIdPrefix && bundle.trigger_bindings[0]) {
    bundle.trigger_bindings[0].binding_id = `${ctx.bindingIdPrefix}_${root.id}`;
  }
  return bundle;
}

// ─────────────────────────── 反向打开 ───────────────────────────

interface FlatGroup {
  path: ConditionNodeGuard[];
  actions: MindNode[];
}

/** binding 的 trigger_event_keys（读点兼容：空则回落旧单值 trigger_event_key，缺省视为 manual）。 */
function eventKeysOfBinding(binding: BehaviorTriggerBinding): ActionTriggerEventKey[] {
  return (
    binding.trigger_event_keys && binding.trigger_event_keys.length > 0
      ? binding.trigger_event_keys
      : [binding.trigger_event_key ?? 'manual']
  ) as ActionTriggerEventKey[];
}

/**
 * 从 binding 还原其所属触发根的「基名」bindingId（分组用）：
 * - 新格式（一条 binding 恰好 1 个事件，可能是 `${base}__<event>` 后缀形式）→ 剥离后缀还原 base；
 * - 旧格式（binding 自带多个事件的历史合并文档）没有后缀，binding_id 本身即 base。
 */
function baseBindingIdOf(binding: BehaviorTriggerBinding): string {
  const keys = eventKeysOfBinding(binding);
  if (keys.length === 1) {
    const suffix = `__${keys[0]}`;
    if (binding.binding_id.endsWith(suffix)) return binding.binding_id.slice(0, -suffix.length);
  }
  return binding.binding_id;
}

/**
 * 从一组「同源」binding（同一触发根按事件拆分产出的多条 binding，或旧格式的单条合并 binding）
 * 重建一棵 MindNode 触发根树（guards/nodes/groups 在 bundle 内全局查表）。
 */
function buildRootFromBindingGroup(
  bindings: BehaviorTriggerBinding[],
  guardById: Map<string, BehaviorGuard>,
  nodeById: Map<string, BehaviorActionNode>,
  groupById: Map<string, BehaviorActionGroup>,
  // 文档级条件池：guard.path 逐步按 condition_id 从这里取回 V4 表达式文档。
  conditionById: Map<string, BehaviorCondition>
): MindNode {
  const first = bindings[0];
  const baseId = baseBindingIdOf(first);

  // eventKeys：组内各 binding 事件的并集，按出现顺序去重展开——新格式下每条 binding 恰 1 事件，
  // 天然还原原 root.eventKeys 的选中顺序；旧格式合并 binding 本身可能已含多个事件，直接展开。
  // 旧保存键迁移：老 before-save/after-save 已退役出可选事件集，不能原样回读——打开时
  // 就地展开成新建/编辑两档（before-save → create-before-save + edit-before-save，after-save 同理），
  // 同根多条 binding 合并去重后仍是一棵根；只要迁移过一次即打 legacySaveMigrated 供 UI 提示。
  const eventKeys: ActionTriggerEventKey[] = [];
  const seenEvents = new Set<string>();
  let legacySaveMigrated = false;
  const pushEvent = (key: ActionTriggerEventKey): void => {
    if (seenEvents.has(key)) return;
    seenEvents.add(key);
    eventKeys.push(key);
  };
  for (const binding of bindings) {
    for (const key of eventKeysOfBinding(binding)) {
      if (key === 'before-save') {
        legacySaveMigrated = true;
        pushEvent('create-before-save');
        pushEvent('edit-before-save');
      } else if (key === 'after-save') {
        legacySaveMigrated = true;
        pushEvent('create-after-save');
        pushEvent('edit-after-save');
      } else {
        pushEvent(key);
      }
    }
  }

  // eventFieldIds + needsFieldSelection（迁移检测）：仅 value-change/field-click 关心。
  // 逐 binding 展开其 scopes → field id 集合，赋给该 binding 覆盖的每个相关事件——新格式下各事件
  // 各自一条 binding（字段独立）；旧格式合并 binding 下多个事件共享同一份 scopes，天然实现
  // 「复制语义」（两事件各得同份字段，对应原共享 scopes 行为）。
  const eventFieldIds: Partial<Record<ActionTriggerEventKey, string[]>> = {};
  const needsFieldSelection: ActionTriggerEventKey[] = [];
  for (const binding of bindings) {
    const scopes = binding.scopes && binding.scopes.length > 0 ? binding.scopes : [binding.scope ?? 'form'];
    const fieldIds = scopes.filter(s => s.startsWith('field:')).map(s => s.slice('field:'.length));
    for (const key of eventKeysOfBinding(binding)) {
      if (!FIELD_SCOPED_EVENTS.has(key)) continue;
      eventFieldIds[key] = [...fieldIds];
      // 旧「共享 scopes=['form']」文档回读迁移标记：字段集合为空 = 该事件尚未补选字段，保存后
      // 将不再触发；不自动删事件、不静默丢弃，仅打标供 UI 提示（NodeConfigDialog 打开时展示）。
      if (fieldIds.length === 0) needsFieldSelection.push(key);
    }
  }

  const firstScopes = first.scopes && first.scopes.length > 0 ? first.scopes : [first.scope ?? 'form'];

  const root: MindNode = {
    id: createNodeId('trigger'),
    kind: 'trigger-root',
    eventKey: eventKeys[0],
    eventKeys,
    // scope/scopes：已降级为展示/回读兼容字段（编译不再读取），取组内首条 binding 的值。
    scope: firstScopes[0],
    scopes: firstScopes,
    eventFieldIds,
    needsFieldSelection: needsFieldSelection.length > 0 ? needsFieldSelection : undefined,
    // 读回稳定身份与名称：bindingId 恒还原为「基名」，保证再保存时按同一规则重新派生各事件 binding_id。
    bindingId: baseId,
    name: first.name,
    // 启用态：仅显式 disabled=true 为停用，其余（含旧文档缺字段）默认启用；
    // 同根各 binding 由 compile 写同值，故取组内首条即可（与 name 同一取法）。
    enabled: first.disabled !== true,
    children: []
  };
  // 流程步骤门回读：同根各 binding 由 compile 写同一份，取组内首条即可（与 name/
  // enabled 同一取法）；无门（undefined）时不设该键，保持内存态"未配置=无门"的判定口径。
  const workflowGate = parseWorkflowGate(first.workflow_gate);
  if (workflowGate) root.workflowGate = workflowGate;
  // 旧保存键迁移提示：仅内存态展示用，不影响编译，见 model.ts legacySaveMigrated 注释。
  if (legacySaveMigrated) root.legacySaveMigrated = true;

  function toMindAction(nodeId: string): MindNode {
    const node = nodeById.get(nodeId);
    const action: MindNode = {
      id: nodeId,
      kind: 'action',
      actionName: node?.action_name ?? ''
    };
    if (node?.source) action.source = node.source;
    if (node?.async) action.async = true;
    if (node?.name) action.name = node.name;
    // 启用态：仅显式 disabled=true 为停用，其余（含旧文档缺字段）默认启用。
    action.enabled = node?.disabled !== true;
    if (node?.params) action.params = node.params;
    if (node?.node_guard_id) {
      const parsed = parseCondition(guardById.get(node.node_guard_id)?.condition ?? '');
      if (parsed) action.nodeGuard = parsed;
    }
    // 反向重建子流程（向右挂载的 children band）：
    // - children_node_ids（纯动作）→ 递归还原为 action.children；
    // - continuation_group_ids（含分支的续接）→ 把这串组按前序展平为带路径的扁平组，
    //   用 reconstructBand(prefixLen=0) 还原为含条件的 children band（与 walkBand 编译对称、可逆）；
    // - outcome_continuation_group_ids（出口分支，与上两者互斥）→ 逐 outcome 各自展平还原为一条
    //   band，装回 outcomeChildren（map key 本身即分支归属，无需路径判别）。
    if (node?.children_node_ids && node.children_node_ids.length > 0) {
      action.children = node.children_node_ids.map(toMindAction);
    } else if (node?.continuation_group_ids && node.continuation_group_ids.length > 0) {
      const flat: FlatGroup[] = node.continuation_group_ids.map(groupId => {
        const group = groupById.get(groupId);
        return {
          path: parseGuardEntry(group?.group_guard_id ? guardById.get(group.group_guard_id) : undefined, conditionById),
          actions: (group?.ordered_node_ids ?? []).map(toMindAction)
        };
      });
      action.children = reconstructBand(flat, 0);
    } else if (node?.outcome_continuation_group_ids && Object.keys(node.outcome_continuation_group_ids).length > 0) {
      const outcomeChildren: Record<string, MindNode[]> = {};
      for (const outcome of Object.keys(node.outcome_continuation_group_ids)) {
        const groupIds = node.outcome_continuation_group_ids[outcome] ?? [];
        const flat: FlatGroup[] = groupIds.map(groupId => {
          const group = groupById.get(groupId);
          return {
            path: parseGuardEntry(group?.group_guard_id ? guardById.get(group.group_guard_id) : undefined, conditionById),
            actions: (group?.ordered_node_ids ?? []).map(toMindAction)
          };
        });
        outcomeChildren[outcome] = reconstructBand(flat, 0);
      }
      action.outcomeChildren = outcomeChildren;
    }
    return action;
  }

  // 按 ordered_group_ids（前序）展平为带路径的组：组内各 binding 共享同一批 ordered_group_ids，取首条即可。
  const flat: FlatGroup[] = first.ordered_group_ids.map(groupId => {
    const group = groupById.get(groupId);
    return {
      path: parseGuardEntry(group?.group_guard_id ? guardById.get(group.group_guard_id) : undefined, conditionById),
      actions: (group?.ordered_node_ids ?? []).map(toMindAction)
    };
  });

  root.children = reconstructBand(flat, 0);
  return root;
}

/**
 * openBundleToTrees：bundle 的 binding 分组 → 每组一棵 MindNode 触发根树（坐标由布局 walker 另行重建）。
 * 一个触发根现在可能拆产多条 binding（每条恰 1 事件），故先按「基名 bindingId + ordered_group_ids
 * 序列一致」分组——同根拆出的多条 binding 组共享同一批组，天然命中同一 key，在此合并回一棵树；
 * 旧格式的单条合并 binding（自带多个 trigger_event_keys）自成一组，行为不变。
 */
export function openBundleToTrees(bundle: ActionBehaviorDocument): MindNode[] {
  // 三个实体表都是「可选数组」：动作文档允许省略空集合（后端保存的最小文档、以及任务级动作
  // 文档常常没有 guards），四处都要 `?? []` 兜底，否则裸 .map 会在
  // 缺字段时抛 "Cannot read properties of null/undefined (reading 'map')"，把整个设计器打断
  // （例如任务级文档无 guards ⇒ 打开即报错、画布空白）。
  const guardById = new Map((bundle.guards ?? []).map(guard => [guard.guard_id, guard] as const));
  const nodeById = new Map((bundle.action_nodes ?? []).map(node => [node.node_id, node] as const));
  const groupById = new Map((bundle.action_groups ?? []).map(group => [group.group_id, group] as const));
  // 条件池：与上面三张表同一处建表，同样按「可选数组」兜底——旧文档/无条件文档没有
  // 这一键，裸 .map 会在打开时抛错打断整个设计器（与 guards 缺失同款事故，见上方注释）。
  const conditionById = new Map((bundle.conditions ?? []).map(condition => [condition.condition_id, condition] as const));

  const bindingGroups: BehaviorTriggerBinding[][] = [];
  const indexByKey = new Map<string, number>();
  for (const binding of bundle.trigger_bindings ?? []) {
    const key = `${baseBindingIdOf(binding)}::${JSON.stringify(binding.ordered_group_ids)}`;
    let idx = indexByKey.get(key);
    if (idx === undefined) {
      idx = bindingGroups.length;
      indexByKey.set(key, idx);
      bindingGroups.push([]);
    }
    bindingGroups[idx].push(binding);
  }
  // 画布顺序回读：按组内最小 seq 稳定排序；无 seq 的旧文档组排在有 seq 的之后、保持文档
  // 顺序（宿主规范化已按 (seq, binding_id) 排好）。
  const seqOfGroup = (group: BehaviorTriggerBinding[]): number =>
    group.reduce((min, binding) => (binding.seq && binding.seq > 0 ? Math.min(min, binding.seq) : min), Number.POSITIVE_INFINITY);
  const ordered = bindingGroups
    .map((group, order) => ({ group, order, seq: seqOfGroup(group) }))
    .sort((a, b) => (a.seq === b.seq ? a.order - b.order : a.seq - b.seq))
    .map(entry => entry.group);
  return ordered.map(group => buildRootFromBindingGroup(group, guardById, nodeById, groupById, conditionById));
}

/** openBundleToTree：bundle 首条 binding → MindNode 触发根树（单事件薄封装，委托多事件版）。 */
export function openBundleToTree(bundle: ActionBehaviorDocument): MindNode {
  const trees = openBundleToTrees(bundle);
  if (trees.length > 0) return trees[0];
  // 无 binding：回退为空的 manual 触发根（保持旧行为）。
  return { id: createNodeId('trigger'), kind: 'trigger-root', eventKey: 'manual', scope: 'form', eventFieldIds: {}, children: [] };
}

/**
 * 从扁平组（保序）重建一个 band，支持「多个顺序条件」：
 * 按 ordered_group_ids 的前序顺序逐段消费——
 * - path 长度 === prefixLen 的组：本层动作组，动作直接追加（前导/汇合后续动作均如此）；
 * - path 长度 > prefixLen 的连续区段：一个条件的分支子树。该区段的首组分叉片段即原 guardSpec C，
 *   只消费 path[prefixLen] ∈ {C, !C} 的连续组（C 的整棵子树在前序中连续），其后若再现 > prefixLen
 *   的组则属于下一个顺序条件，循环再处理。then/else 各自按 prefixLen+1 递归重建。
 * 保序遍历天然还原「动作、条件、动作、条件…」的任意交错次序（与 walkBand 的入序一一对应）。
 *
 * then/else 配对：不再比较 SimpleCondition 字面量，改为 serializeGuardSpec 序列化后的
 * 字符串相等（sameGuardSpec）——机制与旧版 C/!C 配对相同（都是「确定性可重算的规范串」比对），
 * 只是现在的 guard 可能是 guided 单条/多条或 expression。C 的 else 对应片段：
 * - guided → invertGuardSpec(C) 的序列化串；
 * - expression → 无 NOT，没有对应的 else 片段（elseSpec=undefined，只消费 thenSpec 的连续组，
 *   elseGroups 恒为空——与 walkBand 里 expression 模式跳过空 else 固化的行为对称）。
 */
function reconstructBand(groups: FlatGroup[], prefixLen: number): MindNode[] {
  const band: MindNode[] = [];
  let i = 0;
  while (i < groups.length) {
    const group = groups[i];
    if (group.path.length === prefixLen) {
      // 本层动作组：直接铺开（条件前的前导 / 条件后的汇合续跑）。
      band.push(...group.actions);
      i += 1;
      continue;
    }
    // 进入一个条件的分支子树：以首组的分叉片段为 guardSpec C，消费其连续子树（path[prefixLen]∈{C,!C}）。
    const thenSpec = group.path[prefixLen];
    // V4 判断表达式与 guided 同属「恒可取反」：else 片段 = 同一 conditionId + negate
    // 翻转（见 invertGuardSpec / serializeGuardSpec）。旧 KimpoSQL 串仍无 NOT，恒无 else 片段。
    const elseSpec = thenSpec.v4 || thenSpec.mode === 'guided' ? invertGuardSpec(thenSpec) : undefined;
    const belongsToCurrentBranch = (candidate: FlatGroup): boolean => {
      if (candidate.path.length <= prefixLen) return false;
      const candidateSpec = candidate.path[prefixLen];
      return sameGuardSpec(candidateSpec, thenSpec) || (elseSpec !== undefined && sameGuardSpec(candidateSpec, elseSpec));
    };
    const block: FlatGroup[] = [];
    while (i < groups.length && belongsToCurrentBranch(groups[i])) {
      block.push(groups[i]);
      i += 1;
    }
    const thenGroups = block.filter(g => sameGuardSpec(g.path[prefixLen], thenSpec));
    const elseGroups = elseSpec !== undefined ? block.filter(g => sameGuardSpec(g.path[prefixLen], elseSpec)) : [];
    band.push(
      createConditionNode({
        guardSpec: thenSpec,
        thenChildren: reconstructBand(thenGroups, prefixLen + 1),
        elseChildren: reconstructBand(elseGroups, prefixLen + 1)
      })
    );
  }
  return band;
}
