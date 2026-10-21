import type { InteractiveSessionHandle, InteractiveSessionSnapshot } from '@kimposoft/plugin-sdk';

/**
 * 动作设计器是否可写只由 Host 注入的交互会话裁决。
 * 模板设计态必须持有 edit 模式；任务动作设计器没有 template_design 锁，标准会话仅绑定
 * 登录生命周期，因此 active/view 也可写，但每次保存仍必须经过领域权限校验与版本号 CAS。
 */
export function isActionDesignerSessionEditable(
  snapshot: Readonly<InteractiveSessionSnapshot>,
  targetKind: 'template' | 'job'
): boolean {
  if (snapshot.state !== 'active') return false;
  return targetKind === 'template' ? snapshot.mode === 'edit' : true;
}

/** 嵌套 action-config 必须复用父 surface 的同一个 handle，不能静默创建第二个会话/锁。 */
export function requireInheritedInteractiveSession(
  parent: InteractiveSessionHandle,
  bridge: Readonly<Record<string, unknown>>
): InteractiveSessionHandle {
  const inherited = bridge.interactiveSession;
  if (inherited !== parent) {
    throw new Error('[kimpo-action-designer] action-config 未继承父交互会话');
  }
  return parent;
}

/** auth_ended 会清理敏感草稿；lost 只冻结并保留内容供人工查看。 */
export function shouldScrubActionDraft(snapshot: Readonly<InteractiveSessionSnapshot>): boolean {
  return snapshot.state === 'auth_ended';
}
