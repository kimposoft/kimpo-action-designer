import { defineComponent, h, nextTick } from 'vue';
import { mount, type VueWrapper } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import type { InteractiveSessionHandle, InteractiveSessionSnapshot } from '@kimposoft/plugin-sdk';

const actionProbe = vi.hoisted(() => ({
  scrub: vi.fn(),
  invalidate: vi.fn(),
  reload: vi.fn()
}));

vi.mock('./designer/ActionDesignerDialog.vue', () => ({
  default: defineComponent({
    emits: ['close', 'resize'],
    setup(_, { emit, slots }) {
      return () => h('div', [h('button', { class: 'close', onClick: () => emit('close') }), slots.default?.()]);
    }
  })
}));
vi.mock('./designer/ActionDesigner.vue', () => ({
  default: defineComponent({
    name: 'ActionDesigner',
    props: { sessionEditable: Boolean },
    setup(_, { expose }) {
      expose({
        refit: () => undefined,
        reloadAuthority: actionProbe.reload,
        scrubSession: actionProbe.scrub,
        invalidateAsyncBackfill: actionProbe.invalidate
      });
      return () => h('div', { class: 'action-probe' });
    }
  })
}));

import DesignerRoot from './DesignerRoot.vue';
import type { ActionDesignerHostApi } from './designer/hostApi';

function snapshot(
  state: InteractiveSessionSnapshot['state'],
  patch: Partial<InteractiveSessionSnapshot> = {}
): InteractiveSessionSnapshot {
  return {
    mode: 'edit',
    state,
    lossReason: null,
    dirty: false,
    expiresAt: null,
    serverTime: null,
    epoch: 1,
    transportCredentialRevision: 0,
    conflict: null,
    canAdminRelease: false,
    canRequestEdit: false,
    ...patch
  };
}

function session(initial = snapshot('active')) {
  let current = initial;
  let listener: ((next: Readonly<InteractiveSessionSnapshot>) => void) | undefined;
  const handle = {
    get snapshot() {
      return current;
    },
    markDirty: vi.fn(),
    onChange: vi.fn((next) => {
      listener = next;
      return () => {
        listener = undefined;
      };
    }),
    requestEdit: vi.fn(async () => undefined),
    adminRelease: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined)
  } satisfies InteractiveSessionHandle;
  return {
    handle,
    publish(next: InteractiveSessionSnapshot) {
      current = next;
      listener?.(next);
    }
  };
}

function deferred() {
  let resolve!: (value: undefined) => void;
  const promise = new Promise<undefined>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

function mountRoot(
  ownership: 'inherited' | 'owned',
  currentSession = session(),
  kind: 'template' | 'job' = 'template'
) {
  const requestClose = vi.fn(async () => true);
  const wrapper = mount(DesignerRoot, {
    props: {
      input: kind === 'job'
        ? { kind: 'job', appId: 'app-1', jobId: 'job-1', visible: true, requestClose, interactiveSessionOwnership: ownership }
        : {
            kind: 'template',
            scope: { appId: 'app-1', templateId: 'tpl-1', templateVersionNo: '1.0' },
            visible: true,
            requestClose,
            interactiveSessionOwnership: ownership
          },
      hostApi: {} as ActionDesignerHostApi,
      interactiveSession: currentSession.handle
    }
  });
  return { wrapper, currentSession, requestClose };
}

describe('DesignerRoot interactive session ownership', () => {
  it('继承父会话的嵌套 surface 只请求 Host 关闭，绝不直接关闭父 handle', async () => {
    const { wrapper, currentSession, requestClose } = mountRoot('inherited');
    await wrapper.get('button.close').trigger('click');
    await Promise.resolve();
    wrapper.unmount();

    expect(requestClose).toHaveBeenCalledOnce();
    expect(currentSession.handle.close).not.toHaveBeenCalled();
  });

  it('owned surface 同样委托 Host 统一确认和关闭，不从插件直接 close', async () => {
    const currentSession = session(snapshot('active', { mode: 'view' }));
    const { wrapper, requestClose } = mountRoot('owned', currentSession, 'job');
    await wrapper.get('button.close').trigger('click');
    await Promise.resolve();
    wrapper.unmount();

    expect(requestClose).toHaveBeenCalledOnce();
    expect(currentSession.handle.close).not.toHaveBeenCalled();
  });

  it('lost 冻结写入但保留已加载画布供只读查看', async () => {
    const { wrapper, currentSession } = mountRoot('inherited');
    await nextTick();
    currentSession.publish(snapshot('lost', { lossReason: 'offline' }));
    await nextTick();

    expect(wrapper.find('.action-probe').exists()).toBe(true);
    expect(wrapper.get('[data-session-state="lost"]').classes()).toContain('action-session-blocker--retained');
    expect(actionProbe.invalidate).toHaveBeenCalled();
    wrapper.unmount();
  });

  it('auth_ended 在公开终态渲染前同步 scrub，并清除 dirty', async () => {
    actionProbe.scrub.mockClear();
    let wrapper!: VueWrapper;
    actionProbe.scrub.mockImplementationOnce(() => {
      // Vue 尚未把 auth_ended 快照渲染出来，证明插件草稿清理先发生。
      expect(wrapper.find('[data-session-state="auth_ended"]').exists()).toBe(false);
    });
    const mounted = mountRoot('inherited');
    wrapper = mounted.wrapper;
    await nextTick();

    mounted.currentSession.publish(snapshot('auth_ended', { lossReason: 'auth-ended', dirty: true }));
    expect(actionProbe.scrub).toHaveBeenCalledOnce();
    expect(mounted.currentSession.handle.markDirty).toHaveBeenCalledWith(false);
    await nextTick();
    expect(wrapper.find('[data-session-state="auth_ended"]').exists()).toBe(true);
    wrapper.unmount();
  });

  it('conflicted 的申请编辑和管理员释放只使用当前公开 epoch', async () => {
    const { wrapper, currentSession } = mountRoot('inherited');
    currentSession.publish(snapshot('conflicted', {
      epoch: 9,
      conflict: { ownerDisplayName: '张三', isSelf: false },
      canRequestEdit: true,
      canAdminRelease: true
    }));
    await nextTick();

    const buttons = wrapper.findAll('.action-session-actions button');
    await buttons[0].trigger('click');
    await buttons[1].trigger('click');
    expect(currentSession.handle.requestEdit).toHaveBeenCalledWith(9);
    expect(currentSession.handle.adminRelease).toHaveBeenCalledWith(9);
    wrapper.unmount();
  });

  it('丢弃 requestEdit 晚到反馈，不允许覆盖 lost 稳定终态', async () => {
    const pending = deferred();
    const { wrapper, currentSession } = mountRoot('inherited');
    currentSession.handle.requestEdit.mockImplementationOnce(() => pending.promise);
    currentSession.publish(snapshot('conflicted', {
      epoch: 9,
      canRequestEdit: true,
      conflict: { ownerDisplayName: '张三', isSelf: false }
    }));
    await nextTick();

    await wrapper.get('.action-session-actions button').trigger('click');
    currentSession.publish(snapshot('lost', { epoch: 9, lossReason: 'offline' }));
    pending.resolve(undefined);
    await Promise.resolve();
    await nextTick();

    expect(wrapper.get('[data-session-state="lost"]').text()).toContain('actionDesigner.session.lost');
    expect(wrapper.text()).not.toContain('actionDesigner.session.requestSent');
    wrapper.unmount();
  });

  it('丢弃 adminRelease 晚到失败反馈，不允许覆盖 auth_ended 稳定终态', async () => {
    let reject!: (error: Error) => void;
    const pending = new Promise<undefined>((_, fail) => {
      reject = fail;
    });
    const { wrapper, currentSession } = mountRoot('inherited');
    currentSession.handle.adminRelease.mockImplementationOnce(() => pending);
    currentSession.publish(snapshot('conflicted', { epoch: 11, canAdminRelease: true }));
    await nextTick();

    await wrapper.get('.action-session-actions button').trigger('click');
    currentSession.publish(snapshot('auth_ended', { epoch: 11, lossReason: 'auth-ended' }));
    reject(new Error('late failure'));
    await Promise.resolve();
    await nextTick();

    expect(wrapper.get('[data-session-state="auth_ended"]').text()).toContain('actionDesigner.session.authEnded');
    expect(wrapper.text()).not.toContain('actionDesigner.session.adminReleaseFailed');
    wrapper.unmount();
  });

  it('丢弃 requestEdit 晚到成功反馈，不允许覆盖 closed 稳定终态', async () => {
    const pending = deferred();
    const { wrapper, currentSession } = mountRoot('inherited');
    currentSession.handle.requestEdit.mockImplementationOnce(() => pending.promise);
    currentSession.publish(snapshot('conflicted', { epoch: 12, canRequestEdit: true }));
    await nextTick();

    await wrapper.get('.action-session-actions button').trigger('click');
    currentSession.publish(snapshot('closed', { epoch: 12 }));
    pending.resolve(undefined);
    await Promise.resolve();
    await nextTick();

    expect(wrapper.get('[data-session-state="closed"]').text()).toContain('actionDesigner.session.closed');
    expect(wrapper.text()).not.toContain('actionDesigner.session.requestSent');
    wrapper.unmount();
  });
});
