/**
 * 数据动作种类识别。
 *
 * 链路：插件 kimpo-action-designer · 设计层。宿主按插件 manifest `capabilities.data_actions` 解析出
 * 动作的标准操作种类，随动作目录 `ActionDefinition.operation_kind` 下发；设计器据此识别取数 / 写节点
 * （保存前触发根下写节点强制同步、节点图标、详情浮层图标、配置面板回落），不再按官方动作名硬判。
 *
 * 官方兼容表：与宿主后端的内置兼容表同口径（四个官方名 → 种类，
 * 宿主永久保留）。宿主下发的官方动作本就带 operation_kind；本表只在「动作目录未加载 / 加载失败、
 * 拿不到定义」时兜底，保证官方写节点在这种情况下仍被强制同步，不因目录缺失而静默放宽。
 */
import type { ActionDefinition } from './hostTypes';

/** 标准操作种类闭集。 */
export type DataActionKind = 'fetch' | 'create' | 'update' | 'delete';

const DATA_ACTION_KINDS: ReadonlySet<string> = new Set<DataActionKind>(['fetch', 'create', 'update', 'delete']);

/** 写类种类：新增 / 修改 / 删除（before-save 根下必须同步执行，见 compile.ts）。 */
const WRITE_KINDS: ReadonlySet<DataActionKind> = new Set<DataActionKind>(['create', 'update', 'delete']);

/** 官方兼容表（与宿主内置兼容表同口径，见文件头）。 */
const OFFICIAL_COMPAT_KINDS: Readonly<Record<string, DataActionKind>> = {
  'data.extract_record': 'fetch',
  'data.create_record': 'create',
  'data.update_record': 'update',
  'data.delete_record': 'delete'
};

/** 值是否属于种类闭集（宿主下发值不在闭集内时按「非数据动作」处理，fail-closed）。 */
export function isDataActionKind(value: unknown): value is DataActionKind {
  return typeof value === 'string' && DATA_ACTION_KINDS.has(value);
}

/** 种类是否为写类（create / update / delete）。 */
export function isWriteKind(kind: DataActionKind | undefined): boolean {
  return !!kind && WRITE_KINDS.has(kind);
}

/**
 * 解析动作的数据动作种类：优先取动作目录定义上的 operation_kind（第三方与官方同口径）；
 * 定义缺失或未带合法种类时回落官方兼容表（只含 `data.` 保留名，第三方无法占用），
 * 兼容未下发 operation_kind 的旧宿主；都没有 → undefined（普通动作）。
 */
export function resolveOperationKind(
  actionName: string | undefined,
  definition?: Pick<ActionDefinition, 'operation_kind'> | null
): DataActionKind | undefined {
  if (definition && isDataActionKind(definition.operation_kind)) return definition.operation_kind;
  return actionName ? OFFICIAL_COMPAT_KINDS[actionName] : undefined;
}
