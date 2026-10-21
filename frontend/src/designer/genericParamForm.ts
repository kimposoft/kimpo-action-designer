/**
 * 动作节点「通用参数表单」的纯逻辑。
 *
 * 链路：动作设计器插件（kimpo-action-designer，设计态）· 节点配置弹窗 NodeConfigDialog —— 动作没有
 * action-config 面板时，按宿主动作目录下发的 params_schema 顶层 properties 逐项渲染控件。本文件只做
 * 「schema → 表单字段描述」与「字段目标值 ↔ 下拉值」的换算，不发请求、不读写业务数据。
 *
 * 字段目标数组的识别约定（按 SDK `biz.Targets(min, max)` 构造器的实际产出核实）：
 *   { type: 'array',
 *     items: { type: 'object',
 *              properties: { data_table_id: { type: 'string', minLength: 1 }, field_id: { type: 'string', minLength: 1 } },
 *              required: ['data_table_id', 'field_id'], additionalProperties: false },
 *     minItems?: min, maxItems?: max }
 * 只看形状、不看属性名：items.properties 恰好是 data_table_id / field_id 两个字符串属性才认；多一个属性
 * 或类型不符一律回落 JSON 文本框（不认识的复杂参数不猜）。
 */

/** 通用表单里一个参数的渲染种类。 */
export type GenericParamKind = 'boolean' | 'number' | 'enum' | 'string' | 'fieldTargets' | 'json';

/** 一个顶层参数的渲染描述。 */
export interface GenericParamField {
  key: string;
  /** schema 原始 type（缺省按 string）。 */
  type: string;
  kind: GenericParamKind;
  enum?: unknown[];
  /** x-picker 扩展关键字（sheet-switch / sheet-print 由专用面板接管，本文件只透传）。 */
  picker?: string;
  /** 显示标签：schema title（宿主已按界面语言把 x-kimpo-title 选进 title），没有时回落键名。 */
  label: string;
  /** 是否在 schema 顶层 required 里。 */
  required: boolean;
  /** schema default（undefined 表示未声明）。 */
  defaultValue?: unknown;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
}

/** 字段目标数组的一项（与 SDK biz.FieldTarget 的 JSON 形状一致）。 */
export interface FieldTargetValue {
  data_table_id: string;
  field_id: string;
}

type SchemaNode = Record<string, unknown>;

function asNode(v: unknown): SchemaNode | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as SchemaNode) : undefined;
}

function asNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** 节点是否是 SDK biz.Targets 产出的字段目标数组（只看形状，见文件头注）。 */
export function isFieldTargetsSchema(node: unknown): boolean {
  const n = asNode(node);
  if (!n || n.type !== 'array') return false;
  const items = asNode(n.items);
  if (!items || items.type !== 'object') return false;
  const props = asNode(items.properties);
  if (!props) return false;
  const keys = Object.keys(props).sort();
  if (keys.length !== 2 || keys[0] !== 'data_table_id' || keys[1] !== 'field_id') return false;
  return asNode(props.data_table_id)?.type === 'string' && asNode(props.field_id)?.type === 'string';
}

/** 按 schema 节点判定渲染种类（顺序与旧模板 v-if 链一致，字段目标数组插在 JSON 兜底之前）。 */
function kindOf(node: SchemaNode, type: string): GenericParamKind {
  if (type === 'boolean') return 'boolean';
  if (type === 'number' || type === 'integer') return 'number';
  if (Array.isArray(node.enum) && node.enum.length > 0) return 'enum';
  if (type === 'string') return 'string';
  if (isFieldTargetsSchema(node)) return 'fieldTargets';
  return 'json';
}

/** params_schema → 顶层参数描述列表；schema 没有 properties 时返回空数组（调用方只读显示参数 JSON）。 */
export function deriveGenericParamFields(schema: unknown): GenericParamField[] {
  const root = asNode(schema);
  const props = asNode(root?.properties);
  if (!props) return [];
  const required = new Set(Array.isArray(root?.required) ? (root!.required as unknown[]).map(String) : []);
  return Object.entries(props).map(([key, raw]) => {
    const node = asNode(raw) ?? {};
    const type = typeof node.type === 'string' ? node.type : 'string';
    const title = typeof node.title === 'string' && node.title.trim() ? node.title : key;
    return {
      key,
      type,
      kind: kindOf(node, type),
      enum: Array.isArray(node.enum) ? node.enum : undefined,
      picker: typeof node['x-picker'] === 'string' ? (node['x-picker'] as string) : undefined,
      label: title,
      required: required.has(key),
      defaultValue: node.default,
      minLength: asNumber(node.minLength),
      maxLength: asNumber(node.maxLength),
      minimum: asNumber(node.minimum),
      maximum: asNumber(node.maximum),
      minItems: asNumber(node.minItems),
      maxItems: asNumber(node.maxItems)
    };
  });
}

/**
 * 数据动作（取数 / 新增 / 修改 / 删除）参数 schema 里保留给宿主引擎的参数键（与 SDK
 * `direction/biz` 的 DataActionParam* 常量、官方记录控制器同口径）：
 * 引擎文档由官方标准配置面板编辑，写行数上限由「选项」浮层的专用输入框编辑，都不进通用参数表单。
 */
export const DATA_ACTION_ENGINE_PARAM_KEYS: ReadonlySet<string> = new Set([
  'extract_v4',
  'extract_v4_plans',
  'write_v4',
  'max_affected_rows'
]);

/**
 * 数据动作的插件附加业务参数：schema 顶层 properties 里
 * 引擎键以外的项，由标准配置面板的「选项」浮层交通用参数表单渲染。官方动作没有附加参数，返回空数组。
 */
export function dataActionExtraParamFields(fields: GenericParamField[]): GenericParamField[] {
  return fields.filter(f => !DATA_ACTION_ENGINE_PARAM_KEYS.has(f.key));
}

/**
 * 预填 default：只补「参数里还没有该键、schema 声明了 default」的项，已有值（含 false / 0 / 空数组）不覆盖。
 * 返回需要合并进参数的增量；没有可补的返回空对象。default 深拷贝，避免多个节点共享同一份对象。
 */
export function missingDefaults(fields: GenericParamField[], params: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    if (f.defaultValue === undefined) continue;
    if (Object.prototype.hasOwnProperty.call(params, f.key) && params[f.key] !== undefined) continue;
    out[f.key] = JSON.parse(JSON.stringify(f.defaultValue));
  }
  return out;
}

/** 约束提示的一条（交给调用方按语言渲染）。 */
export interface ConstraintHint {
  key: 'length' | 'minLength' | 'maxLength' | 'range' | 'minimum' | 'maximum' | 'items' | 'exactItems' | 'minItems' | 'maxItems';
  params: Record<string, number>;
}

/** 由 schema 约束生成提示（长度 / 范围 / 条数）；没有约束返回空数组。pattern 不提示。 */
export function constraintHints(field: GenericParamField): ConstraintHint[] {
  const out: ConstraintHint[] = [];
  const pair = (
    min: number | undefined,
    max: number | undefined,
    both: ConstraintHint['key'],
    onlyMin: ConstraintHint['key'],
    onlyMax: ConstraintHint['key']
  ) => {
    if (min !== undefined && max !== undefined) out.push({ key: both, params: { min, max } });
    else if (min !== undefined) out.push({ key: onlyMin, params: { min } });
    else if (max !== undefined) out.push({ key: onlyMax, params: { max } });
  };
  if (field.kind === 'string' || field.kind === 'enum') pair(field.minLength, field.maxLength, 'length', 'minLength', 'maxLength');
  if (field.kind === 'number') pair(field.minimum, field.maximum, 'range', 'minimum', 'maximum');
  if (field.kind === 'fieldTargets' || field.kind === 'json') {
    // 上下限相等（如 biz.Targets(1, 1)）时说「选 n 项」，不说「选 1～1 项」。
    if (field.minItems !== undefined && field.minItems === field.maxItems) out.push({ key: 'exactItems', params: { n: field.minItems } });
    else pair(field.minItems, field.maxItems, 'items', 'minItems', 'maxItems');
  }
  return out;
}

/** 下拉选项值：表 ID 与字段 ID 用 U+001F（单元分隔符）拼接，ID 本身不会含该字符。 */
const TARGET_SEP = '\u001f';

export function fieldTargetKey(dataTableId: string, fieldId: string): string {
  return `${dataTableId}${TARGET_SEP}${fieldId}`;
}

/** 下拉值 → 字段目标项；格式不符的值丢弃。 */
export function parseFieldTargetKey(key: string): FieldTargetValue | null {
  const idx = key.indexOf(TARGET_SEP);
  if (idx <= 0 || idx === key.length - 1) return null;
  return { data_table_id: key.slice(0, idx), field_id: key.slice(idx + TARGET_SEP.length) };
}

/** 参数里的字段目标数组 → 下拉值列表（非数组 / 项缺键时跳过该项）。 */
export function fieldTargetsToKeys(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const obj = asNode(item);
    const tid = typeof obj?.data_table_id === 'string' ? obj.data_table_id.trim() : '';
    const fid = typeof obj?.field_id === 'string' ? obj.field_id.trim() : '';
    if (tid && fid) out.push(fieldTargetKey(tid, fid));
  }
  return out;
}

/** 下拉值列表 → 参数值；按 maxItems 截断（保留最后选的，便于单选替换），空列表返回 undefined（删除参数）。 */
export function keysToFieldTargets(keys: string[], maxItems?: number): FieldTargetValue[] | undefined {
  let list = keys.map(parseFieldTargetKey).filter((v): v is FieldTargetValue => v !== null);
  if (maxItems !== undefined && maxItems > 0 && list.length > maxItems) list = list.slice(list.length - maxItems);
  return list.length > 0 ? list : undefined;
}
