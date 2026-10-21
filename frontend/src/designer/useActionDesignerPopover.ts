import { onBeforeUnmount, onMounted, ref } from 'vue';

/**
 * 让 Teleport 到 body 的 NaiveUI click-popover 也能响应 Esc 的第一下。
 *
 * 窗口 Esc 由 KLayerStack 仲裁：栈顶层之上有可见的 Naive 浮层（含本 popover）时，
 * 栈整体让位、不处理也不拦截。但 Naive 的 click-popover 自己并不响应 Esc，
 * 所以这里在 popover 展开期间自行监听 window 捕获阶段的 Esc 把它收起，
 * 这样第一下 Esc 只收浮层，第二下才轮到窗口。
 * 收起动作推迟到本次按键分发之后（setTimeout 0）：避免 popover 在栈的监听器之前被同步移除，
 * 导致栈误以为已无浮层、把同一次 Esc 当成「关窗口」。
 */
export function useActionDesignerPopover(initial = false) {
  const visible = ref(initial);
  const onKeydown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || !visible.value) return;
    setTimeout(() => {
      visible.value = false;
    }, 0);
  };
  onMounted(() => window.addEventListener('keydown', onKeydown, true));
  onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown, true));
  return visible;
}
