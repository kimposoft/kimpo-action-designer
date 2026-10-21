import { t as $t } from '../i18n';
import type { ActionDefinition } from './hostTypes';
import { resolveLocalized } from './localize';
import type { ActionTriggerEventKey, ComparisonOperator, ConditionNodeGuard, MindNode, SimpleCondition } from './model';
// 取数节点指向详情摘要（V4 取数文档形状，只引类型）。
import type { V4ExpressionDocument, V4ExtractNodeDocument, V4FillTarget, V4SourceBinding } from '@kimposoft/expression-editor';
// 写节点（新增/修改/删除数据）指向详情摘要（V4 写文档形状，只引类型；
// 与取数节点摘要同构，见文件末尾「写节点」段）。
import type { V4WriteNodeDocument, V4WriteOperation } from '@kimposoft/expression-editor';

/** 暂存目标形状（共享包未单独导出 V4StagingTarget，从节点文档类型上取）。 */
type V4StagingTarget = NonNullable<V4ExtractNodeDocument['staging_target']>;

/**
 * 16 类触发事件 → i18n key（scheduled：宿主定时任务触发；before-delete/after-delete：
 * 记录页事件，见 model.ts RECORD_PAGE_EVENT_KEYS 注释；handle-time / create-before-save /
 * create-after-save / edit-before-save / edit-after-save：细分后的事件，老键 before-save/
 * after-save 的 label 仍保留——它们退役为只读兼容，旧文档摘要/存量引用仍需能显示文案）。
 * 用 Record<ActionTriggerEventKey, string> 声明，少写一档 TS 编译即报错，天然防漏。
 */
const EVENT_LABEL_KEYS: Record<ActionTriggerEventKey, string> = {
  'create-time': 'actionDesigner.events.createTime',
  'edit-time': 'actionDesigner.events.editTime',
  'view-time': 'actionDesigner.events.viewTime',
  'before-save': 'actionDesigner.events.beforeSave',
  'after-save': 'actionDesigner.events.afterSave',
  'value-change': 'actionDesigner.events.valueChange',
  'field-click': 'actionDesigner.events.fieldClick',
  manual: 'actionDesigner.events.manual',
  scheduled: 'actionDesigner.events.scheduled',
  'before-delete': 'actionDesigner.events.beforeDelete',
  'after-delete': 'actionDesigner.events.afterDelete',
  'handle-time': 'actionDesigner.events.handleTime',
  'create-before-save': 'actionDesigner.events.createBeforeSave',
  'create-after-save': 'actionDesigner.events.createAfterSave',
  'edit-before-save': 'actionDesigner.events.editBeforeSave',
  'edit-after-save': 'actionDesigner.events.editAfterSave'
};

/** 取触发事件的本地化标签（运行时解析，随语言切换）。 */
export function eventLabel(key: ActionTriggerEventKey): string {
  return $t(EVENT_LABEL_KEYS[key]);
}

const OPERATOR_LABEL_KEYS: Record<ComparisonOperator, string> = {
  '=': 'actionDesigner.operators.eq',
  '!=': 'actionDesigner.operators.ne',
  '>': 'actionDesigner.operators.gt',
  '>=': 'actionDesigner.operators.gte',
  '<': 'actionDesigner.operators.lt',
  '<=': 'actionDesigner.operators.lte'
};

/** 取比较运算符的本地化标签。 */
export function operatorLabel(op: ComparisonOperator): string {
  return $t(OPERATOR_LABEL_KEYS[op]);
}

/** 触发根作用域的可读标签：'form' → 表单；'field:xxx' → 字段。 */
export function scopeLabel(scope: string | undefined): string {
  if (!scope || scope === 'form') return $t('actionDesigner.scope.form');
  if (scope.startsWith('field:')) return $t('actionDesigner.scope.field', { name: scope.slice('field:'.length) });
  return scope;
}

/**
 * 触发根作用域集合的摘要标签：兼容多字段场景。
 * - 空/仅含 'form' → 表单；
 * - 单个 field: 项 → 复用 scopeLabel（展示字段 id）；
 * - 多个 field: 项 → 「字段×N」摘要，风格从简，不逐一展开。
 */
export function scopesLabel(scopes: string[] | undefined): string {
  const list = scopes && scopes.length > 0 ? scopes : ['form'];
  const fieldScopes = list.filter(s => s.startsWith('field:'));
  if (fieldScopes.length === 0) return $t('actionDesigner.scope.form');
  if (fieldScopes.length === 1) return scopeLabel(fieldScopes[0]);
  return $t('actionDesigner.scope.fieldCount', { count: fieldScopes.length });
}

/**
 * 触发根摘要：value-change / field-click 若在 eventKeys 中勾选，按事件分段展示各自
 * 独立的触发字段（如「值变动: A,B · 点击字段时: C」）；某事件字段为空时展示占位「未设置」
 * （呼应 NodeConfigDialog 内的补选提示，不静默隐藏）。
 * 仅当调用方提供 eventFieldIds 时才产出（未提供 = 旧共享 scopes 形态尚未回读迁移，不展示此行，
 * 兼容现状）；eventKeys 不含这两类事件时也不产出。
 */
export function eventFieldsSummary(
  eventKeys: ActionTriggerEventKey[] | undefined,
  eventFieldIds: Partial<Record<ActionTriggerEventKey, string[]>> | undefined,
  fieldName?: (fieldId: string) => string
): string | undefined {
  if (!eventFieldIds) return undefined;
  const relevant = (eventKeys ?? []).filter(
    (key): key is 'value-change' | 'field-click' => key === 'value-change' || key === 'field-click'
  );
  if (relevant.length === 0) return undefined;
  return relevant
    .map(key => {
      const ids = eventFieldIds[key] ?? [];
      const text = ids.length > 0 ? ids.map(id => (fieldName ? fieldName(id) : id)).join(',') : $t('actionDesigner.summary.unset');
      return `${eventLabel(key)}: ${text}`;
    })
    .join(' · ');
}

/**
 * 出口分支：动作定义声明的 x-outcomes 集合（来自 params_schema['x-outcomes']，如 ["hit","miss"]）；
 * 未声明/格式非法一律回落空数组（视为普通单续接动作，画布按原逻辑渲染）。
 */
export function actionOutcomes(definition: ActionDefinition | undefined): string[] {
  const raw = definition?.params_schema?.['x-outcomes'];
  return Array.isArray(raw) ? raw.filter((key): key is string => typeof key === 'string' && key.length > 0) : [];
}

/** 出口分支 key 的本地化标签（actionDesigner.outcome.<key>）；未登记的 key 回落显示原文。 */
export function outcomeLabel(key: string): string {
  const path = `actionDesigner.outcome.${key}`;
  const translated = $t(path);
  return translated === path ? key : translated;
}

/** 简化条件的可读表达式，如 `金额 大于 5000`（字段以 id 占位，UI 可再映射字段名）。 */
export function conditionText(condition: SimpleCondition | undefined): string {
  if (!condition) return $t('actionDesigner.condition.unset');
  const value = typeof condition.value === 'string' ? `「${condition.value}」` : String(condition.value);
  return `${condition.fieldId} ${operatorLabel(condition.op)} ${value}`;
}

/**
 * 清洗字段名供「判断语句」展示：去掉表单用的必填标记（前导 `*`/`＊`）与整列对齐空格
 * （如 `*姓 名` → `姓名`、`*职　　级` → `职级`）。仅用于条件语句展示，不改动 field_name 本身
 * （其在表单标签处仍需保留这些标记）。清洗后为空则回退原串。
 */
export function cleanFieldName(name: string): string {
  const cleaned = name
    .replace(/^[*＊]+/, '') // 去前导必填标记
    .replace(/[\s　]+/g, ''); // 折叠半角/全角空格（对齐填充）
  return cleaned || name;
}

/**
 * 条件节点展示用的「一段 KimpoSQL 判断语句」：字段名 + SQL 运算符 + 值。
 * - 运算符用 SQL 符号（`>` `=` `!=` …），契合「判断语句」语义；
 * - 字符串值加单引号、转义内部单引号；
 * - 字段名经 fieldName(fieldId) 映射后再 cleanFieldName（去表单必填标记/对齐空格）。
 * 后端若提供已清洗的整句，可直接替换此组合结果。
 */
export function conditionStatement(condition: SimpleCondition | undefined, fieldName?: (fieldId: string) => string): string {
  if (!condition) return $t('actionDesigner.condition.unset');
  const raw = fieldName ? fieldName(condition.fieldId) : condition.fieldId;
  const field = cleanFieldName(raw);
  const value = typeof condition.value === 'string' ? `'${condition.value.replace(/'/g, "''")}'` : String(condition.value);
  return `${field} ${condition.op} ${value}`;
}

/** guard 表达式串展示用截断长度（超出省略号收尾，避免撑爆画布节点/摘要行）。 */
const GUARD_EXPRESSION_DISPLAY_MAX = 40;

/**
 * 条件节点摘要：
 * - V4 判断表达式（spec.v4）→ 可读原文（restore 取回，缺省回落 token 化 source_text），超 40 字截断；
 * - 旧形态（结构化 condition_group / 旧 KimpoSQL 串 / 引导式草稿）→ 统一「旧格式，请重新配置」提示，
 *   不再翻译成判断语句（旧条件必须重配，继续展示旧内容会误导用户以为它仍生效）；
 * - 完全没配（无 guardSpec 且无 legacyCondition，或 guard 内容为空）→ 「未设置条件」占位。
 * 未传 guardSpec 时从 legacyCondition 合成 guided 单条镜像（旧节点同样落入「旧格式」提示）。
 */
export function guardSpecStatement(
  guardSpec: ConditionNodeGuard | undefined,
  legacyCondition: SimpleCondition | undefined,
  fieldName?: (fieldId: string) => string
): string {
  const spec: ConditionNodeGuard | undefined =
    guardSpec ?? (legacyCondition ? { mode: 'guided', guided: { logic: 'and', items: [legacyCondition] } } : undefined);
  if (!spec) return $t('actionDesigner.condition.unset');
  // V4 判断表达式：优先展示宿主 restore 取回的可读原文，缺省回落 token 化源码
  // （`[标签]#{rN}` 形态，虽不好看但至少不空白）；沿用既有 40 字截断，画布/摘要行一致。
  if (spec.v4) {
    const text = (spec.v4.readableText ?? spec.v4.expression?.source_text ?? '').trim();
    if (text === '') return $t('actionDesigner.condition.unset');
    return text.length > GUARD_EXPRESSION_DISPLAY_MAX ? `${text.slice(0, GUARD_EXPRESSION_DISPLAY_MAX)}…` : text;
  }
  // 旧形态：结构化条件 / 旧 KimpoSQL 串 /
  // 引导式草稿一律不再翻译成判断语句，统一显示「旧格式，请重新配置」——继续展示旧内容会让用户
  // 以为它还在生效（实际编译后端已改吃 V4 池 + path）。完全空的 guard 仍走「未设置条件」占位。
  const items = spec.guided?.items ?? [];
  const legacyEmpty = !spec.group && (spec.expression ?? '').trim() === '' && items.length === 0;
  if (legacyEmpty) return $t('actionDesigner.condition.unset');
  return $t('actionDesigner.dialog.conditionLegacyFormat');
}

/**
 * 画布节点简易标签（拖拽提示/无障碍文本用）：与 guardSpecStatement **同源**——
 * 旧版对「只有 node.condition 的旧节点」回退 conditionText 单独走一套文案，会让画布上同一个旧条件
 * 在节点卡片显示「旧格式」、在拖拽提示里显示旧判断语句，两处自相矛盾；改为一律经 guardSpecStatement。
 */
export function conditionQuickLabel(node: MindNode): string {
  return guardSpecStatement(node.guardSpec, node.condition);
}

/** 节点详情 popover 的一行：标签 + 取值。 */
export interface NodeSummaryRow {
  label: string;
  value: string;
}

/**
 * 节点「配置情况」摘要：供指向详情 Popover 默认渲染（前端壳）。
 * - 触发根：事件 / 作用域 / 执行条件（暂为占位「未设置」，待后续接线）；
 * - 动作：动作名 / 来源 / 同步异步 / 各参数键值；
 * - 条件：一段 KimpoSQL 判断语句。
 * 纯函数、无副作用，便于单测。后续插件提供 detailsSchema 时由组件层覆盖此默认渲染。
 */
export function nodeSummary(
  node: MindNode,
  definition?: ActionDefinition | null,
  fieldName?: (fieldId: string) => string
): NodeSummaryRow[] {
  if (node.kind === 'trigger-root') {
    // 触发根只展示触发事件（多事件联合展示）；不再有「执行条件」（guard 仅动作/条件节点具备）。
    const keys = node.eventKeys && node.eventKeys.length > 0 ? node.eventKeys : node.eventKey ? [node.eventKey] : [];
    const rows: NodeSummaryRow[] = [
      {
        label: $t('actionDesigner.summary.event'),
        value: keys.length > 0 ? keys.map(k => eventLabel(k) ?? k).join(' / ') : $t('actionDesigner.summary.trigger')
      }
    ];
    // value-change/field-click 已选时追加「触发字段」分段摘要；未提供 eventFieldIds（旧共享
    // scopes 形态未回读迁移）或未选这两类事件时不产出该行，保持旧行为不变。
    const fieldsSummary = eventFieldsSummary(node.eventKeys, node.eventFieldIds, fieldName);
    if (fieldsSummary) rows.push({ label: $t('actionDesigner.summary.triggerFields'), value: fieldsSummary });
    return rows;
  }
  if (node.kind === 'condition') {
    return [{ label: $t('actionDesigner.summary.judge'), value: guardSpecStatement(node.guardSpec, node.condition, fieldName) }];
  }
  // action
  const rows: NodeSummaryRow[] = [
    { label: $t('actionDesigner.summary.action'), value: resolveLocalized(definition?.title) || node.actionName || $t('actionDesigner.summary.actionDefault') },
    { label: $t('actionDesigner.summary.source'), value: node.source === 'plugin' ? $t('actionDesigner.summary.plugin') : $t('actionDesigner.summary.builtin') },
    { label: $t('actionDesigner.summary.exec'), value: node.async ? $t('actionDesigner.summary.async') : $t('actionDesigner.summary.sync') }
  ];
  const params = node.params ?? {};
  for (const [key, val] of Object.entries(params)) {
    rows.push({ label: key, value: typeof val === 'string' ? val : JSON.stringify(val) });
  }
  return rows;
}

// ── 取数节点（V4 取数文档）指向详情摘要 ──────────────────────────────────────────────────────

/**
 * 取数节点判定：动作定义顶层 x-editor==='extract-v4'（与 NodeConfigDialog 的 V4 配置面命中判定同口径），
 * 或节点参数已带 extract_v4 对象（注册中心尚未就绪 / definition 缺席时按参数形状兜底）。
 * 只认动作节点；3.4 旧格式（仅带 expression）不算——那类节点在配置面已显示失效横幅，详情不另起摘要。
 */
export function isExtractV4Node(node: MindNode, definition?: ActionDefinition | null): boolean {
  if (node.kind !== 'action') return false;
  const editor = (definition?.params_schema as { 'x-editor'?: unknown } | undefined)?.['x-editor'];
  if (editor === 'extract-v4') return true;
  return isPlainObject(node.params?.extract_v4);
}

/** 读节点参数里的 V4 取数文档：只做「是对象」浅守卫，深层缺省由 extractV4Summary 逐段 `?? []` 兜底。 */
export function extractV4DocumentOf(node: MindNode): Partial<V4ExtractNodeDocument> | undefined {
  const raw = node.params?.extract_v4;
  return isPlainObject(raw) ? (raw as Partial<V4ExtractNodeDocument>) : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** V4 表达式源码里的字段引用占位 `#{rN}`（完整形态 `[标签]#{rN}`）。 */
const V4_REF_TOKEN_RE = /#\{r\d+\}/g;
/** `[标签]#{rN}` 组合 token（标签里不会出现 `]`，tokenize 侧保证）。 */
const V4_LABELED_REF_RE = /\[([^\]]*)\]#\{(r\d+)\}/g;

type V4ExpressionRef = V4ExpressionDocument['refs'][number];

/** 表主题色板容量：与共享包 table-theme-colors.css 的 .ttc-0～.ttc-7 一一对应（弹层直接用那组全局类取 --ttc）。 */
export const TABLE_COLOR_COUNT = 8;
/** 编辑器显式来源别名 t1/t2/…（共享包 tableThemeColors.tableColorClass 同一规则）：命中时沿用其序号取色，两面同色。 */
const EXPLICIT_ALIAS_RE = /^t(\d+)$/;

/** 可读文本还原上下文：来源绑定（按 instance_id 反查表显示名 / 主题色序号）+ 本报表表名解析口。 */
export interface ReadableTextContext {
  sources?: V4SourceBinding[];
  tableName?: (tableId: string) => string;
  /**
   * 应用显示名解析口 + 当前设计所在应用 ID，供来源表/
   * 视图行的跨应用前缀「应用名 › 」使用（见下方 crossAppPrefix）。均可选：调用方（如取数/写节点
   * 指向详情摘要 nodeSummary 之外的旧调用点）未传时按「无跨应用信息」处理，不产出前缀，不影响
   * 既有展示。appName 查不到（返回空串/undefined）时同样不产出前缀，不拿 appId 冒充应用名。
   */
  appName?: (appId: string) => string;
  currentAppId?: string;
}

/**
 * 来源跨应用前缀：「应用名 › 」。与共享包 ExpressionEditor.vue 自身①来源面板
 * 的展示口径一致（appName + ' › ' + 表名，见其 crossAppLabel 附近实现），本文件独立实现、不跨包
 * import（两处各自维护，避免插件反向依赖宿主专属包内部实现）。
 * 缺 appId / 缺 currentAppId（调用方未传，旧调用点）/ 同应用 / 解析不到应用名，一律返回空串——
 * 不产出前缀，不拿 appId 原样冒充应用名。
 */
function crossAppPrefix(appId: string | undefined, ctx: ReadableTextContext): string {
  if (!appId || !ctx.currentAppId || appId === ctx.currentAppId) return '';
  const name = ctx.appName?.(appId);
  return name ? `${name} › ` : '';
}

/**
 * 来源绑定的表主题色序号（`[表]` 段按该表主题色着色）：
 * 别名为 tN 时取 (N-1) % 8（与编辑器 3.4 面同色）；否则按其在 query.sources 里非本报表来源的出现顺序 % 8
 *（与共享包 tableThemeColors.tableColorIndex 同一口径，编辑器四个面 + 编辑区表段同色）；本报表来源不占
 * 主题色（沿用编辑器「本报表=绿」语义，表段落绿实底）；查不到返回 -1（弹层落中性灰）。
 */
export function tableColorIndexOf(src: V4SourceBinding | undefined, ctx: ReadableTextContext): number {
  if (!src || src.kind === 'report') return -1;
  const m = EXPLICIT_ALIAS_RE.exec(src.instance_id ?? '') ?? EXPLICIT_ALIAS_RE.exec(src.alias ?? '');
  if (m && Number(m[1]) >= 1) return (Number(m[1]) - 1) % TABLE_COLOR_COUNT;
  // 与共享包 tableThemeColors.tableColorIndex 同口径：只数非本报表来源的出现顺序（编辑器四个面按同一顺序取色）。
  const ordered = (ctx.sources ?? []).filter(s => s.kind !== 'report');
  const idx = ordered.findIndex(s => s.instance_id === src.instance_id);
  return idx >= 0 ? idx % TABLE_COLOR_COUNT : -1;
}

/** 引用解析结果：表显示名 + 所属来源绑定（取主题色用；按 table_id 解析到表名但来源里没有对应绑定时为空）。 */
interface RefTable {
  label: string;
  source?: V4SourceBinding;
}

/**
 * 引用 → 表。优先按 source_instance_id 查来源绑定的 alias（目录 / 本报表来源的 alias 即表名，暂存来源的
 * alias 即「上一步暂存区」）；report_field 未带实例或查不到时按 table_id 走 tableName 解析口，再退同表的
 * 本报表来源 alias；暂存引用退「暂存区」。解析不到返回 undefined（不拿 id 冒充表名）。
 */
function refTable(ref: V4ExpressionRef, ctx: ReadableTextContext): RefTable | undefined {
  const byInstance = ref.source_instance_id ? ctx.sources?.find(s => s.instance_id === ref.source_instance_id) : undefined;
  if (byInstance) {
    const alias = byInstance.alias?.trim();
    if (alias) return { label: alias, source: byInstance };
    if (byInstance.kind === 'report') {
      const name = ctx.tableName?.(byInstance.table_id);
      if (name && name !== byInstance.table_id) return { label: name, source: byInstance };
    }
  }
  if (ref.kind === 'report_field' && ref.table_id) {
    const sameTable = ctx.sources?.find(s => s.kind === 'report' && s.table_id === ref.table_id);
    const name = ctx.tableName?.(ref.table_id);
    if (name && name !== ref.table_id) return { label: name, source: sameTable };
    if (sameTable?.alias?.trim()) return { label: sameTable.alias.trim(), source: sameTable };
  }
  if (ref.kind === 'staging_field') return { label: $t('actionDesigner.summary.extractStaging'), source: byInstance };
  return undefined;
}

/** 整条引用内的部件：table=表名（加粗）、field=字段名、punc=括号与点号（压暗）。 */
export interface ExprSegPart {
  text: string;
  role: 'table' | 'field' | 'punc';
}

/**
 * 表达式可读文本的一段（详情弹层按类型着色，「淡底胶囊」形态）：
 * ref=整条引用 `[表].[字段]`（一个颜色：来源表按主题色淡底 + 表色文字，本报表走独立色；parts 拆出表名 / 字段 / 标点）/
 * field=单段引用 `[x]`（系统变量按 system_var 色；引用缺失落中性色）/ func=函数名 / string=字符串字面量 /
 * number=数字 / keyword=关键字 / text=其余（运算符、标点、空白）。
 */
export interface ExprSeg {
  text: string;
  kind: 'ref' | 'field' | 'func' | 'string' | 'number' | 'keyword' | 'text';
  /** kind='ref'：表主题色序号（0～7），-1=无主题色（中性灰淡底）。 */
  colorIndex?: number;
  /** kind='ref'：本报表的引用（独立色，不占主题色）。 */
  report?: boolean;
  /** kind='ref'：表名 / 字段 / 标点部件。 */
  parts?: ExprSegPart[];
  /** kind='field'：引用种类；引用缺失（refs 里没有该 rN）时为 undefined，弹层落中性色。 */
  refKind?: V4ExpressionRef['kind'];
}

/** 组一条整条引用段：`[表].[字段]`。 */
function refSeg(table: string, field: string, colorIndex: number, report: boolean): ExprSeg {
  return {
    text: `[${table}].[${field}]`,
    kind: 'ref',
    colorIndex,
    report,
    parts: [
      { text: '[', role: 'punc' },
      { text: table, role: 'table' },
      { text: '].[', role: 'punc' },
      { text: field, role: 'field' },
      { text: ']', role: 'punc' }
    ]
  };
}

/** 引用之间的普通文本：字符串字面量 / 数字 / 标识符（后接 `(` 为函数名，命中关键字表为关键字）。 */
const PLAIN_TOKEN_RE = /('(?:[^']|'')*')|(\d+(?:\.\d+)?)|([A-Za-z_一-龥][A-Za-z0-9_一-龥]*)/g;
/** 关键字（中英文包各自的写法，只影响着色不影响语义）。 */
const KEYWORDS = new Set([
  'and', 'or', 'not', 'is', 'null', 'in', 'like', 'between', 'case', 'when', 'then', 'else', 'end', 'true', 'false',
  'contains', 'starts_with', 'ends_with',
  '且', '和', '或', '非', '分支', '当', '则', '否则', '结束', '包含', '开头是', '结尾是'
]);

function scanPlain(text: string, out: ExprSeg[]): void {
  let cursor = 0;
  PLAIN_TOKEN_RE.lastIndex = 0;
  for (let m = PLAIN_TOKEN_RE.exec(text); m; m = PLAIN_TOKEN_RE.exec(text)) {
    if (m.index > cursor) out.push({ text: text.slice(cursor, m.index), kind: 'text' });
    if (m[1] !== undefined) out.push({ text: m[0], kind: 'string' });
    else if (m[2] !== undefined) out.push({ text: m[0], kind: 'number' });
    else if (/^\s*\(/.test(text.slice(m.index + m[0].length))) out.push({ text: m[0], kind: 'func' });
    else if (KEYWORDS.has(m[0].toLowerCase())) out.push({ text: m[0], kind: 'keyword' });
    else out.push({ text: m[0], kind: 'text' });
    cursor = m.index + m[0].length;
  }
  if (cursor < text.length) out.push({ text: text.slice(cursor), kind: 'text' });
}

/**
 * token 化源码 → 着色分段：`[字段]#{rN}` 按 refs 反查来源实例还原成整条引用段 `[表].[字段]`（带主题色序号 /
 * 本报表标记 / 表名字段标点部件）；查不到来源时退 ref.last_label（绑定时的完整显示快照，形如 `[表].[字段]`——关联 ON
 * 反生成的 refs 只存字段标签，不算完整，不采用）；仍无则只留 `[字段]`；系统变量引用留标签、按 system_var
 * 着色；refs 里没有该占位的（旧文档 / 未绑定）留标签、不着来源色。引用之间的文本按字面量 / 函数 / 关键字
 * 切段。残留占位一律摘掉、text 段折叠空白、首尾空白剪掉。空文档 / 空文本返回空数组。
 */
export function readableExpressionSegments(
  expr: Partial<Pick<V4ExpressionDocument, 'source_text' | 'refs'>> | undefined | null,
  ctx: ReadableTextContext = {}
): ExprSeg[] {
  const refs = expr?.refs ?? [];
  const text = expr?.source_text ?? '';
  const raw: ExprSeg[] = [];
  let cursor = 0;
  V4_LABELED_REF_RE.lastIndex = 0;
  for (let m = V4_LABELED_REF_RE.exec(text); m; m = V4_LABELED_REF_RE.exec(text)) {
    if (m.index > cursor) scanPlain(text.slice(cursor, m.index).replace(V4_REF_TOKEN_RE, ''), raw);
    const label = m[1];
    const ref = refs.find(r => r.ref_id === m[2]);
    if (!ref || ref.kind === 'system_var') {
      raw.push({ text: `[${label}]`, kind: 'field', refKind: ref?.kind });
    } else {
      const table = refTable(ref, ctx);
      if (table) {
        const report = ref.kind === 'report_field' || table.source?.kind === 'report';
        raw.push(refSeg(table.label, label, report ? -1 : tableColorIndexOf(table.source, ctx), report));
      } else {
        const snapshot = (ref.last_label ?? '').trim();
        const dot = snapshot.lastIndexOf('].[');
        if (dot > 0) {
          // last_label 完整快照 `[表].[字段]`：来源已丢失，整条无主题色（中性灰淡底）
          raw.push(refSeg(snapshot.slice(1, dot), snapshot.slice(dot + 3, -1), -1, false));
        } else {
          raw.push({ text: `[${label}]`, kind: 'field', refKind: ref.kind });
        }
      }
    }
    cursor = m.index + m[0].length;
  }
  if (cursor < text.length) scanPlain(text.slice(cursor).replace(V4_REF_TOKEN_RE, ''), raw);
  // 清理：text 段摘残留占位、折叠空白；空段丢弃；首尾空白剪掉。
  const out: ExprSeg[] = [];
  for (const seg of raw) {
    const cleaned = seg.kind === 'text' ? seg.text.replace(V4_REF_TOKEN_RE, '').replace(/\s+/g, ' ') : seg.text;
    if (!cleaned) continue;
    out.push({ ...seg, text: cleaned });
  }
  if (out.length && out[0].kind === 'text') {
    out[0].text = out[0].text.replace(/^\s+/, '');
    if (!out[0].text) out.shift();
  }
  const last = out[out.length - 1];
  if (last && last.kind === 'text') {
    last.text = last.text.replace(/\s+$/, '');
    if (!last.text) out.pop();
  }
  return out;
}

/** token 化源码 → 可读文本（分段拼接；分段口径见 readableExpressionSegments）。 */
export function readableExpressionText(
  expr: Partial<Pick<V4ExpressionDocument, 'source_text' | 'refs'>> | undefined | null,
  ctx: ReadableTextContext = {}
): string {
  return readableExpressionSegments(expr, ctx)
    .map(seg => seg.text)
    .join('');
}

/** 来源表一枚 tag：显示名 + 种类标签（目录来源无标签；暂存来源标「暂存区」）+ 表主题色序号（与表达式里 `[表]` 段同色）。
 *  本报表来源（kind='report'）不进摘要——它是当前表单自己的表，不算「来源表」。 */
export interface ExtractSourceRow {
  key: string;
  name: string;
  tag?: string;
  colorIndex: number;
  /** 来源种类，供渲染层挑图标（staging=ph:stack，view=ph:eye，其余=ph:table）
   *  ——不再用 tag 是否存在反推种类（视图行不带 tag，但也不该落回 catalog 的 ph:table）。 */
  kind?: 'catalog' | 'staging' | 'view';
}

/** 填充输出一行：目标字段显示名 / 表达式（可读文本 + 着色分段）/ 填充方式标签（暂存列无填充方式，strategy 为空串）。
 *  key：行身份（可选）——暂存列传 column_id（缺省回落 name），供渲染层需要稳定标识时使用；
 *  目标输出行未传（field_id 语义已天然稳定，不必额外携带）。 */
export interface ExtractOutputRow {
  key?: string;
  field: string;
  expression: string;
  segments: ExprSeg[];
  strategy: string;
}

/** 填充信息的一个 tab：一张目标表（或暂存区）——表显示名 + 角色 + 输出行。
 *  目标级设置（清空规则 / 自动按行列匹配 / 清理空行）不进摘要：指向详情只看「填哪些字段」。 */
export interface ExtractFillTab {
  key: string;
  label: string;
  role?: string;
  /** 暂存区 tab 为 true：表头用「暂存列」而非「目标字段」、无填充方式列。 */
  staging?: boolean;
  outputs: ExtractOutputRow[];
}

/** 取数节点指向详情摘要：来源表 / 筛选条件（可读文本 + 着色分段，空=未设置）/ 按目标分 tab 的填充信息。 */
export interface ExtractV4Summary {
  sources: ExtractSourceRow[];
  filter: string;
  filterSegments: ExprSeg[];
  tabs: ExtractFillTab[];
}

/** 显示名解析口（均可选）：与设计器 useActionDesigner 的 fieldName / tableName 同签名，查不到时返回 id 原样。 */
export interface ExtractSummaryResolvers {
  fieldName?: (fieldId: string) => string;
  tableName?: (tableId: string) => string;
  /** 应用显示名解析口 + 当前设计所在应用 ID，供来源表/视图行跨应用前缀
   *  「应用名 › 」使用（见 crossAppPrefix）。均可选，未传时不产出前缀。 */
  appName?: (appId: string) => string;
  currentAppId?: string;
}

/** 经解析口取显示名；解析口缺席或「查不到回退 id 原样」时改用 fallback（如文档里的 alias / label），仍空则用 id。 */
function resolveDisplayName(resolver: ((id: string) => string) | undefined, id: string, fallback?: string): string {
  const resolved = resolver?.(id);
  if (resolved && resolved !== id) return resolved;
  return fallback?.trim() || id;
}

function tableRoleLabel(role: string | undefined): string | undefined {
  if (role === 'main') return $t('actionDesigner.summary.roleMain');
  if (role === 'detail') return $t('actionDesigner.summary.roleDetail');
  return undefined;
}

/** 填充方式标签：overwrite / merge / row_match 三档（V4 首版无 append）；未知值原样回显。 */
function fillStrategyLabel(strategy: string | undefined): string {
  switch (strategy) {
    case 'merge':
      return $t('actionDesigner.summary.fillMerge');
    case 'row_match':
      return $t('actionDesigner.summary.fillRowMatch');
    case 'overwrite':
    case undefined:
      return $t('actionDesigner.summary.fillOverwrite');
    default:
      return strategy;
  }
}

/** 来源绑定 → tag；本报表来源返回 undefined（不展示）。 */
function sourceRow(src: V4SourceBinding, index: number, ctx: ReadableTextContext): ExtractSourceRow | undefined {
  if (src.kind === 'report') return undefined;
  // 单位行来源只在服务端展开期合成，永不进节点文档；防御性跳过。
  if (src.kind === 'unit') return undefined;
  const key = src.instance_id || `src-${index}`;
  const colorIndex = tableColorIndexOf(src, ctx);
  if (src.kind === 'staging') {
    const staging = $t('actionDesigner.summary.extractStaging');
    return { key, name: src.alias?.trim() || staging, tag: staging, colorIndex, kind: 'staging' };
  }
  // 视图来源：alias 即视图显示名（选择时由编辑器写入，
  // 与下方目录来源同一惯例）；无独立 tag（视图不像暂存区那样需要跟"表"强制区分文案，图标已够用），
  // 跨应用时前缀「应用名 › 」。
  if (src.kind === 'view') {
    const name = `${crossAppPrefix(src.app_id, ctx)}${src.alias?.trim() || src.view_id}`;
    return { key, name, colorIndex, kind: 'view' };
  }
  // 外部数据表来源：没有 data_table_id，alias 即外部表显示名，缺省回落稳定 ID；
  // 图标沿用表格（kind=catalog）。
  if (src.kind === 'external') {
    const name = `${crossAppPrefix(src.app_id, ctx)}${src.alias?.trim() || src.external_stable_id}`;
    return { key, name, colorIndex, kind: 'catalog' };
  }
  // 目录来源（跨模板/跨应用）：alias 即目录表名（同表多实例带 (1)(2) 后缀），文档里不存
  // 跨模板表目录，直接显示；跨应用时前缀「应用名 › 」。
  const name = `${crossAppPrefix(src.app_id, ctx)}${src.alias?.trim() || src.data_table_id}`;
  return { key, name, colorIndex, kind: 'catalog' };
}

function outputRow(
  field: string,
  expression: V4ExpressionDocument | undefined,
  strategy: string,
  ctx: ReadableTextContext,
  key?: string
): ExtractOutputRow {
  const segments = readableExpressionSegments(expression, ctx);
  return { key, field, expression: segments.map(seg => seg.text).join(''), segments, strategy };
}

function targetTab(target: V4FillTarget, index: number, resolvers: ExtractSummaryResolvers, ctx: ReadableTextContext): ExtractFillTab {
  const outputs = (target.outputs ?? []).map(out =>
    outputRow(resolveDisplayName(resolvers.fieldName, out.target_field_id, out.label), out.expression, fillStrategyLabel(out.fill_strategy), ctx)
  );
  return {
    key: target.target_id || `target-${index}`,
    label: resolveDisplayName(resolvers.tableName, target.target_data_table_id),
    role: tableRoleLabel(target.table_role),
    outputs
  };
}

function stagingTab(staging: V4StagingTarget, ctx: ReadableTextContext): ExtractFillTab {
  return {
    key: 'staging',
    label: $t('actionDesigner.summary.extractStaging'),
    staging: true,
    // 暂存列显示名与身份分离：显示字段名用 col.name（用户可自由改
    // 的显示名），行 key/身份用 col.column_id（稳定键=物理列名/引用键），存量文档缺 column_id 时回落
    // col.name（与共享包适配层、NodeConfigDialog.stagingSource 同一回落口径）。
    outputs: (staging.columns ?? []).map(col => outputRow(col.name, col.expression, '', ctx, col.column_id ?? col.name))
  };
}

/**
 * 取数节点「指向详情」摘要（纯函数、无副作用，便于单测）：
 * - 来源表：query.sources 里的目录 / 暂存来源（本报表来源不列），各带表主题色序号；
 * - 筛选条件：query.filter 源码按 refs + 来源绑定还原成 `[表].[字段]` 的可读文本 + 着色分段；
 * - 填充：targets 每张目标表一个 tab（表名 + 角色 + 逐字段输出），staging_target 有列时追加「暂存区」tab；
 *   chart_targets 配置面尚未暴露，此处不展示。
 * 文档缺段 / 缺字段一律按空处理，绝不抛错——详情弹层是 hover 即显的只读视图，不能因旧文档形状炸掉画布。
 */
export function extractV4Summary(doc: Partial<V4ExtractNodeDocument> | undefined, resolvers: ExtractSummaryResolvers = {}): ExtractV4Summary {
  // 表达式还原上下文：全部来源绑定（含本报表来源——它虽不列进「来源表」，字段引用仍要靠它拼回表名与取色）。
  const ctx: ReadableTextContext = {
    sources: doc?.query?.sources ?? [],
    tableName: resolvers.tableName,
    appName: resolvers.appName,
    currentAppId: resolvers.currentAppId
  };
  const sources = (doc?.query?.sources ?? [])
    .map((src, i) => sourceRow(src, i, ctx))
    .filter((row): row is ExtractSourceRow => row !== undefined);
  const filterSegments = readableExpressionSegments(doc?.query?.filter, ctx);
  const filter = filterSegments.map(seg => seg.text).join('');
  const tabs = (doc?.targets ?? []).map((target, i) => targetTab(target, i, resolvers, ctx));
  const staging = doc?.staging_target;
  if (staging && (staging.columns ?? []).length > 0) tabs.push(stagingTab(staging, ctx));
  return { sources, filter, filterSegments, tabs };
}

// ── 写节点（V4WriteNodeDocument）指向详情摘要 ─────────
// 与上方取数节点摘要（isExtractV4Node/extractV4DocumentOf/extractV4Summary）同一先例：判定 → 读文档 →
// 纯函数产出摘要，供 NodeDetailPopover.vue 渲染。写节点没有多目标 tab（恒单一写目标），故不复用
// ExtractFillTab 结构，改用更扁平的 WriteV4Summary；赋值行仍复用 outputRow（同构 ExtractOutputRow）。

/**
 * 写节点判定：动作定义顶层 x-editor==='write-v4'（与 NodeConfigDialog.vue 的 V4 配置面命中判定
 * `v4SurfaceEditor`/`V4_SURFACE_PARAM_KEY` 同口径），或节点参数已带 write_v4 对象（注册中心尚未
 * 就绪 / definition 缺席时按参数形状兜底）。只认动作节点。
 */
export function isWriteV4Node(node: MindNode, definition?: ActionDefinition | null): boolean {
  if (node.kind !== 'action') return false;
  const editor = (definition?.params_schema as { 'x-editor'?: unknown } | undefined)?.['x-editor'];
  if (editor === 'write-v4') return true;
  return isPlainObject(node.params?.write_v4);
}

/** 读节点参数里的 V4 写文档：只做「是对象」浅守卫，深层缺省由 writeV4Summary 逐段 `?? []`/`?.` 兜底。 */
export function writeV4DocumentOf(node: MindNode): Partial<V4WriteNodeDocument> | undefined {
  const raw = node.params?.write_v4;
  return isPlainObject(raw) ? (raw as Partial<V4WriteNodeDocument>) : undefined;
}

/** 写目标表身份解析（目标先行）：三操作同形，直接取 target.data_table_id——
 *  与记录控制器插件（kimpo-record-controllers）finalizeWriteV4 的 WRITE_TARGET_REQUIRED 闸同一
 *  口径，两处各自独立实现（不跨插件依赖，保持插件间低耦合）。
 *  读兼容：旧格式 update/delete 文档只落 target.instance_id（未落 data_table_id），反查
 *  query.sources 里该实例的表身份（report 来源用 table_id，catalog 来源用 data_table_id）——
 *  供存量草稿/发布物仍能正确显示指向详情。 */
function writeTargetTableRef(doc: Partial<V4WriteNodeDocument>): { tableId?: string; alias?: string } {
  if (doc.target?.data_table_id) return { tableId: doc.target.data_table_id };
  const instanceId = doc.target?.instance_id;
  const src = instanceId ? (doc.query?.sources ?? []).find(s => s.instance_id === instanceId) : undefined;
  if (!src) return {};
  const tableId = src.kind === 'report' ? src.table_id : src.kind === 'catalog' ? src.data_table_id : undefined;
  return { tableId, alias: src.alias };
}

/** 写操作种类的本地化标签（新增/修改/删除）；未识别（理论不可达）回落空串。 */
function writeOperationLabel(op: V4WriteOperation | undefined): string {
  switch (op) {
    case 'insert':
      return $t('actionDesigner.summary.writeOperationInsert');
    case 'update':
      return $t('actionDesigner.summary.writeOperationUpdate');
    case 'delete':
      return $t('actionDesigner.summary.writeOperationDelete');
    default:
      return '';
  }
}

// 不产出「父记录锚定」摘要行：父记录恒取自查询结果里目标模板主表（隐含来源）的记录，
// 不是用户可配的独立项（NodeDetailPopover.vue 同样不展示）。

/** 防重摘要：唯一键字段名列表（经 fieldName 解析）+ 范围标签；未配置（无 dedupe 或空 field_ids）返回 undefined。 */
function writeDedupeSummary(dedupe: V4WriteNodeDocument['dedupe'] | undefined, resolvers: ExtractSummaryResolvers): { fields: string; scope: string } | undefined {
  const fieldIds = dedupe?.field_ids ?? [];
  if (fieldIds.length === 0) return undefined;
  const fields = fieldIds.map(id => resolveDisplayName(resolvers.fieldName, id)).join('、');
  const scope = dedupe?.scope === 'parent' ? $t('actionDesigner.summary.writeDedupeScopeParent') : $t('actionDesigner.summary.writeDedupeScopeAll');
  return { fields, scope };
}

/** 写节点（新增/修改/删除数据）指向详情摘要：目标表 / 定位条件（仅 update/delete，可读文本 + 着色
 *  分段）/ 赋值行（目标字段 ← 表达式，复用 outputRow）/ 防重摘要（仅配置了唯一键）。不产出「父记录锚定」
 *  行（父记录不是独立可配项，见上方 writeTargetTableRef 头注释）。纯函数、无副作用，与 extractV4Summary 同一颗粒度约定：文档缺段
 *  一律按空处理，绝不抛错。 */
export interface WriteV4Summary {
  operation: V4WriteOperation | '';
  operationLabel: string;
  target: string;
  /** 仅 update/delete 产出（insert 无定位条件）。 */
  filter?: string;
  filterSegments?: ExprSeg[];
  assignments: ExtractOutputRow[];
  dedupe?: { fields: string; scope: string };
}

export function writeV4Summary(doc: Partial<V4WriteNodeDocument> | undefined, resolvers: ExtractSummaryResolvers = {}): WriteV4Summary {
  const operation = doc?.operation ?? '';
  const sources = doc?.query?.sources ?? [];
  const ctx: ReadableTextContext = { sources, tableName: resolvers.tableName };
  const { tableId, alias } = writeTargetTableRef(doc ?? {});
  const target = tableId ? resolveDisplayName(resolvers.tableName, tableId, alias) : alias?.trim() || $t('actionDesigner.summary.unset');
  const showFilter = operation === 'update' || operation === 'delete';
  const filterSegments = showFilter ? readableExpressionSegments(doc?.query?.filter, ctx) : undefined;
  const filter = filterSegments ? filterSegments.map(seg => seg.text).join('') : undefined;
  const assignments = (doc?.assignments ?? []).map(a =>
    outputRow(resolveDisplayName(resolvers.fieldName, a.target_field_id), a.expression, '', ctx)
  );
  return {
    operation,
    operationLabel: writeOperationLabel(operation || undefined),
    target,
    filter,
    filterSegments,
    assignments,
    dedupe: writeDedupeSummary(doc?.dedupe, resolvers)
  };
}

// ── 画布节点卡片摘要 ─────────────────────────────────────────────────

/**
 * 动作节点卡片第二行的「关键配置一句话」（拼在动作类型之后：「取数 · 物料价格表 → 3 个字段」）。
 * 取自指向详情同源摘要（extractV4Summary / writeV4Summary）的首要信息，不另立口径：
 * - 取数：来源表（最多两张，余者「等」）+ 填充字段总数；
 * - 新增/修改/删除数据：操作 + 目标表；
 * - 其它动作：空串（卡片只显示动作类型）。
 * 未配置时返回空串，不在画布上堆「未设置」（问题由校验徽标承担）。
 */
export function actionCardDigest(node: MindNode, definition: ActionDefinition | null | undefined, resolvers: ExtractSummaryResolvers = {}): string {
  if (node.kind !== 'action') return '';
  if (isExtractV4Node(node, definition)) {
    const summary = extractV4Summary(extractV4DocumentOf(node), resolvers);
    const names = summary.sources.map(src => src.name).filter(Boolean);
    const sourceText = names.length > 2 ? `${names.slice(0, 2).join('、')} ${$t('actionDesigner.node.digestMore')}` : names.join('、');
    const fieldCount = summary.tabs.reduce((sum, tab) => sum + tab.outputs.length, 0);
    const fieldText = fieldCount > 0 ? $t('actionDesigner.node.digestFields', { count: fieldCount }) : '';
    return [sourceText, fieldText].filter(Boolean).join(' ');
  }
  if (isWriteV4Node(node, definition)) {
    const doc = writeV4DocumentOf(node);
    if (!doc?.operation) return '';
    const summary = writeV4Summary(doc, resolvers);
    return `${summary.operationLabel} ${summary.target}`.trim();
  }
  return '';
}
