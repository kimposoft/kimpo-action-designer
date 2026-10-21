/**
 * 自定义拖拽幽灵图：拖动动作/节点时显示一张随光标移动的卡片（替代浏览器默认半透明镜像）。
 * 用 dataTransfer.setDragImage 实现，浏览器原生跟随光标，无需手动监听。
 */

export function setCustomDragImage(e: DragEvent, label: string): void {
  if (!e.dataTransfer) return;
  const el = document.createElement('div');
  el.textContent = label;
  el.style.cssText = [
    'position:fixed',
    'top:-1000px',
    'left:-1000px',
    'padding:8px 14px',
    'border-radius:10px',
    'background-color:rgb(var(--container-bg-color))',
    'border:1px solid rgb(var(--primary-color))',
    'color:rgb(var(--primary-color))',
    'font-size:13px',
    'font-weight:600',
    'white-space:nowrap',
    'box-shadow:0 6px 18px rgb(0 0 0 / 0.18)',
    'pointer-events:none',
    'z-index:9999'
  ].join(';');
  document.body.appendChild(el);
  e.dataTransfer.setDragImage(el, 16, 18);
  // 拖拽镜像捕获后即可移除占位元素。
  window.setTimeout(() => el.remove(), 0);
}
