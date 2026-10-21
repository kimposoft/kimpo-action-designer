/** 数据动作种类解析（动作目录 operation_kind 优先，官方兼容表兜底）。 */
import { describe, expect, it } from 'vitest';
import { isDataActionKind, isWriteKind, resolveOperationKind } from './dataActionKind';

describe('resolveOperationKind', () => {
  it('动作目录定义带 operation_kind 时取定义值（第三方动作）', () => {
    expect(resolveOperationKind('org.example.x.pull', { operation_kind: 'fetch' })).toBe('fetch');
    expect(resolveOperationKind('org.example.x.close', { operation_kind: 'update' })).toBe('update');
  });

  it('种类不在闭集内按非数据动作处理（fail-closed）', () => {
    expect(resolveOperationKind('org.example.x.y', { operation_kind: 'upsert' })).toBeUndefined();
    expect(isDataActionKind('upsert')).toBe(false);
  });

  it('无定义 / 定义未带种类时，官方四个名字按兼容表解析，其它名字不解析', () => {
    expect(resolveOperationKind('data.extract_record')).toBe('fetch');
    expect(resolveOperationKind('data.create_record', {})).toBe('create');
    expect(resolveOperationKind('data.update_record', null)).toBe('update');
    expect(resolveOperationKind('data.delete_record')).toBe('delete');
    expect(resolveOperationKind('org.example.x.close')).toBeUndefined();
    expect(resolveOperationKind('ui.print', {})).toBeUndefined();
    expect(resolveOperationKind(undefined)).toBeUndefined();
  });

  it('isWriteKind：create / update / delete 为写，fetch 与空不是', () => {
    expect(['create', 'update', 'delete'].every(k => isWriteKind(k as 'create'))).toBe(true);
    expect(isWriteKind('fetch')).toBe(false);
    expect(isWriteKind(undefined)).toBe(false);
  });
});
