import { describe, expect, it } from 'vitest';
import type { InteractiveSessionHandle, InteractiveSessionSnapshot } from '@kimposoft/plugin-sdk';
import {
  isActionDesignerSessionEditable,
  requireInheritedInteractiveSession,
  shouldScrubActionDraft
} from './interactiveSession';

function snapshot(
  state: InteractiveSessionSnapshot['state'],
  mode: InteractiveSessionSnapshot['mode'] = 'edit'
): InteractiveSessionSnapshot {
  return {
    mode,
    state,
    lossReason: null,
    dirty: false,
    epoch: 4,
    expiresAt: null,
    serverTime: null,
    transportCredentialRevision: 0,
    conflict: null,
    canAdminRelease: false,
    canRequestEdit: false
  };
}

function handle(value: InteractiveSessionSnapshot): InteractiveSessionHandle {
  return {
    snapshot: value,
    markDirty: () => undefined,
    onChange: () => () => undefined,
    requestEdit: async () => undefined,
    adminRelease: async () => undefined,
    close: async () => undefined
  };
}

describe('action designer interactive session policy', () => {
  it('模板只允许 active/edit，任务只在 auth-bound active 会话下由权限/CAS继续裁决', () => {
    expect(isActionDesignerSessionEditable(snapshot('active', 'edit'), 'template')).toBe(true);
    expect(isActionDesignerSessionEditable(snapshot('active', 'create'), 'template')).toBe(false);
    expect(isActionDesignerSessionEditable(snapshot('conflicted', 'edit'), 'template')).toBe(false);
    expect(isActionDesignerSessionEditable(snapshot('active', 'view'), 'job')).toBe(true);
    expect(isActionDesignerSessionEditable(snapshot('lost', 'view'), 'job')).toBe(false);
  });

  it('只有 auth_ended 清理敏感草稿，lost 保留内存供人工查看', () => {
    expect(shouldScrubActionDraft(snapshot('auth_ended'))).toBe(true);
    expect(shouldScrubActionDraft(snapshot('lost'))).toBe(false);
  });

  it('嵌套 action-config 必须拿到父 handle 的同一对象', () => {
    const parent = handle(snapshot('active'));
    expect(requireInheritedInteractiveSession(parent, { interactiveSession: parent })).toBe(parent);
    expect(() => requireInheritedInteractiveSession(parent, { interactiveSession: handle(snapshot('active')) })).toThrow(
      '未继承父交互会话'
    );
  });
});
