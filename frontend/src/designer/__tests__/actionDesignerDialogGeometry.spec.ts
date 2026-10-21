/**
 * @vitest-environment happy-dom
 *
 * ActionDesignerDialog 外壳适配层测试：窗口外壳基于 @kimposoft/ui-kit 的 KDialog。
 *
 * 缩放手柄命中区、Esc 窗口栈仲裁等通用几何能力由 KDialog / KLayerStack 提供并在 @kimposoft/ui-kit
 * 内有自己的单测；这里只验证本插件的适配契约：
 *   1. 默认尺寸走 XL 档：视口 86%（不小于基准 1200×800），最小 960×620；缩放完成后经
 *      hostApi.saveWindowSize 落盘（含相对视口的 wr/hr 比例）；
 *   2. 已记忆的尺寸经 hostApi.loadWindowSize 读回（仍受最小尺寸约束）；
 *   3. Esc 经弹层栈：栈顶层先关，嵌套的两层只关栈顶；栈顶层之上有 Naive 弹层时让位；
 *   4. 点遮罩无动作；
 *   5. 兼容类名 adlg-window / adlg-root 仍挂在外壳上（宿主表单弹窗的 Esc 判断与 e2e 依赖）；
 *   6. minimizable=false 时没有最小化按钮；
 *   7. escapeInterceptor 透传 KDialog：窗内有内层 Esc 语义时先消费，下一次 Esc 才关窗。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import ActionDesignerDialog from '../ActionDesignerDialog.vue';
import { createFakeHostApi } from './fakeHostApi';

type WindowSize = { width?: number; height?: number };
const storageState = { store: new Map<string, unknown>() };

const hostApi = createFakeHostApi({
  loadWindowSize: (): WindowSize | null => {
    const sizes = storageState.store.get('actionDesignerDialogSizes') as Record<string, WindowSize> | undefined;
    return sizes?.['dialog-user'] ?? null;
  },
  saveWindowSize: (size: { width: number; height: number }) => {
    const sizes = (storageState.store.get('actionDesignerDialogSizes') as Record<string, WindowSize>) ?? {};
    storageState.store.set('actionDesignerDialogSizes', { ...sizes, 'dialog-user': size });
  }
});

const escape = () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

describe('ActionDesignerDialog（KDialog 适配层）', () => {
  beforeEach(() => {
    storageState.store.clear();
    (window as unknown as { innerWidth: number }).innerWidth = 1400;
    (window as unknown as { innerHeight: number }).innerHeight = 900;
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('uses the approved default size and persists a completed resize per user', async () => {
    const wrapper = mount(ActionDesignerDialog, {
      props: { show: true, hostApi },
      attachTo: document.body
    });
    await nextTick();
    const windowEl = document.querySelector<HTMLElement>('.adlg-window');
    expect(windowEl?.style.width).toBe('1204px');
    expect(windowEl?.style.height).toBe('800px');

    const handle = document.querySelector<HTMLElement>('.kdlg-rz-se');
    handle?.dispatchEvent(new PointerEvent('pointerdown', { clientX: 0, clientY: 0, bubbles: true }));
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: 20, clientY: 10 }));
    window.dispatchEvent(new PointerEvent('pointerup'));
    await nextTick();

    expect(storageState.store.get('actionDesignerDialogSizes')).toEqual({
      'dialog-user': { width: 1224, height: 810, wr: 1224 / 1400, hr: 810 / 900 }
    });
    wrapper.unmount();
  });

  it('restores the remembered size through hostApi.loadWindowSize, clamped to the minimum size', async () => {
    storageState.store.set('actionDesignerDialogSizes', { 'dialog-user': { width: 900, height: 600 } });
    const wrapper = mount(ActionDesignerDialog, {
      props: { show: true, hostApi },
      attachTo: document.body
    });
    await nextTick();
    const windowEl = document.querySelector<HTMLElement>('.adlg-window');
    expect(windowEl?.style.width).toBe('960px');
    expect(windowEl?.style.height).toBe('620px');
    wrapper.unmount();
  });

  it('keeps the compatibility class names on the shell and renders the minimize button by default', async () => {
    const wrapper = mount(ActionDesignerDialog, {
      props: { show: true, hostApi },
      attachTo: document.body
    });
    await nextTick();
    const shell = document.querySelector<HTMLElement>('.kdlg-shell');
    expect(shell?.classList.contains('adlg-window')).toBe(true);
    expect(shell?.classList.contains('adlg-root')).toBe(true);
    // 标题栏窗控：最小化 + 最大化 + 关闭
    expect(document.querySelectorAll('.kdlg-controls .kdlg-btn').length).toBe(3);
    wrapper.unmount();
  });

  it('hides the minimize button when minimizable is false', async () => {
    const wrapper = mount(ActionDesignerDialog, {
      props: { show: true, minimizable: false, hostApi },
      attachTo: document.body
    });
    await nextTick();
    expect(document.querySelectorAll('.kdlg-controls .kdlg-btn').length).toBe(2);
    wrapper.unmount();
  });

  it('does nothing when the mask is clicked', async () => {
    const wrapper = mount(ActionDesignerDialog, {
      props: { show: true, hostApi },
      attachTo: document.body
    });
    await nextTick();
    const mask = document.querySelector<HTMLElement>('.n-modal-mask');
    mask?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await nextTick();
    expect(wrapper.emitted('update:show')).toBeUndefined();
    expect(wrapper.emitted('close')).toBeUndefined();
    wrapper.unmount();
  });

  it('closes on Escape and emits both update:show and close', async () => {
    const wrapper = mount(ActionDesignerDialog, {
      props: { show: true, hostApi },
      attachTo: document.body
    });
    await nextTick();
    escape();
    await nextTick();
    expect(wrapper.emitted('update:show')).toEqual([[false]]);
    expect(wrapper.emitted('close')).toHaveLength(1);
    wrapper.unmount();
  });

  it('lets the escapeInterceptor consume Escape first, then closes on the next one', async () => {
    let editing = true;
    const wrapper = mount(ActionDesignerDialog, {
      props: { show: true, hostApi, escapeInterceptor: () => { const consumed = editing; editing = false; return consumed; } },
      attachTo: document.body
    });
    await nextTick();
    escape();
    await nextTick();
    expect(wrapper.emitted('update:show')).toBeUndefined();
    escape();
    await nextTick();
    expect(wrapper.emitted('update:show')).toEqual([[false]]);
    wrapper.unmount();
  });

  it('lets a visible Naive overlay above the designer consume Escape before closing it', async () => {
    const wrapper = mount(ActionDesignerDialog, {
      props: { show: true, hostApi },
      attachTo: document.body
    });
    await nextTick();
    // 对齐 NaiveUI Popover / Select 下拉：vueuc follower 容器 + 内容，z-index 高于窗口、排在窗口之后
    const container = document.createElement('div');
    container.className = 'v-binder-follower-container';
    const content = document.createElement('div');
    content.className = 'v-binder-follower-content';
    content.style.zIndex = '3000';
    content.getBoundingClientRect = () => ({ width: 400, height: 300 }) as DOMRect;
    container.append(content);
    document.body.append(container);

    escape();
    expect(wrapper.emitted('update:show')).toBeUndefined();

    container.remove();
    escape();
    await nextTick();
    expect(wrapper.emitted('update:show')).toEqual([[false]]);
    wrapper.unmount();
  });

  it('only the top layer handles Escape when designers are stacked, and it never leaks to a host-like ancestor modal', async () => {
    // 模拟宿主单据编辑弹窗：先于两个设计器窗口就存在于 body 中的恒久可见 NModal 容器
    const hostModal = document.createElement('div');
    hostModal.className = 'n-modal-container';
    hostModal.append(document.createElement('div'));
    hostModal.getBoundingClientRect = () => ({ width: 800, height: 600 }) as DOMRect;
    document.body.append(hostModal);

    const outer = mount(ActionDesignerDialog, { props: { show: true, hostApi }, attachTo: document.body });
    const inner = mount(ActionDesignerDialog, { props: { show: true, minimizable: false, hostApi }, attachTo: document.body });
    await nextTick();

    escape();
    await nextTick();
    // 栈顶（后开的节点配置层）先关，外层与宿主不受影响
    expect(inner.emitted('update:show')).toEqual([[false]]);
    expect(outer.emitted('update:show')).toBeUndefined();

    inner.unmount();
    outer.unmount();
    hostModal.remove();
  });
});
