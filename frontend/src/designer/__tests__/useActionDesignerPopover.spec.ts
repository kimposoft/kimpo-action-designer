/**
 * @vitest-environment happy-dom
 *
 * useActionDesignerPopover：展开期间 Esc 收起 click-popover（见该文件头注释）。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { defineComponent, h, type Ref } from 'vue';
import { useActionDesignerPopover } from '../useActionDesignerPopover';

// 把 composable 返回的 ref 取出来给用例断言
let visibleRef: Ref<boolean>;
const Probe = defineComponent({
  setup() {
    visibleRef = useActionDesignerPopover(true);
    return () => h('div');
  }
});

const sleep0 = () => new Promise<void>(resolve => setTimeout(resolve, 0));

describe('useActionDesignerPopover', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('closes an open popover on Escape, deferred until after the keydown dispatch', async () => {
    const wrapper = mount(Probe, { attachTo: document.body });
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    // 同一次分发内还没收起（让栈仍能看到浮层，从而让位）
    expect(visibleRef.value).toBe(true);
    await sleep0();
    expect(visibleRef.value).toBe(false);
    wrapper.unmount();
  });

  it('ignores other keys and stops listening after unmount', async () => {
    const wrapper = mount(Probe, { attachTo: document.body });
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await sleep0();
    expect(visibleRef.value).toBe(true);
    wrapper.unmount();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await sleep0();
    expect(visibleRef.value).toBe(true);
  });
});
