<script setup lang="ts">
import { computed } from 'vue';
import type { LayoutEdge, Orientation, PositionedNode } from './layout';
import { outcomeLabel } from './labels';
import { t as $t } from '../i18n';

const props = defineProps<{
  nodes: PositionedNode[];
  edges: LayoutEdge[];
  width: number;
  height: number;
  orientation?: Orientation;
}>();

interface DrawnEdge {
  path: string;
  kind: LayoutEdge['kind'];
  /** 分支标签：仅每个「父节点 × 分支」组的首条边带，避免多子节点时标签重复堆叠。 */
  label?: string;
  /** 标签中心点（贝塞尔中点，即两端点中点）。 */
  lx?: number;
  ly?: number;
}

/** 分支边的标签文字：成立 / 不成立 / 出口名；顺序边无标签。 */
function branchLabel(edge: LayoutEdge): string | undefined {
  if (edge.kind === 'then') return $t('actionDesigner.canvas.branchThen');
  if (edge.kind === 'else') return $t('actionDesigner.canvas.branchElse');
  if ((edge.kind === 'outcome' || edge.kind === 'outcome-alt') && edge.branch) return outcomeLabel(edge.branch);
  return undefined;
}

/** 胶囊宽度：按字符估算（中日文约 11px/字、其余约 6.5px），左右各留 8px。 */
function labelWidth(text: string): number {
  let w = 0;
  for (const ch of text) w += /[\u2E80-\uFFFF]/.test(ch) ? 11 : 6.5;
  return Math.round(w + 16);
}

const byId = computed(() => Object.fromEntries(props.nodes.map(n => [n.id, n])));

const drawn = computed<DrawnEdge[]>(() => {
  const map = byId.value;
  const result: DrawnEdge[] = [];
  const labelled = new Set<string>();
  for (const edge of props.edges) {
    const from = map[edge.fromId];
    const to = map[edge.toId];
    if (!from || !to) continue;
    if (props.orientation === 'vertical') {
      // 纵向：父下中 → 子上中，竖向贝塞尔。
      const x1 = from.x + from.width / 2;
      const y1 = from.y + from.height;
      const x2 = to.x + to.width / 2;
      const y2 = to.y;
      const dy = Math.max(32, (y2 - y1) / 2);
      result.push({ path: `M ${x1} ${y1} C ${x1} ${y1 + dy}, ${x2} ${y2 - dy}, ${x2} ${y2}`, kind: edge.kind, ...labelOf(edge, x1, y1, x2, y2) });
    } else {
      // 横向：父右中 → 子左中，横向贝塞尔。
      const x1 = from.x + from.width;
      const y1 = from.y + from.height / 2;
      const x2 = to.x;
      const y2 = to.y + to.height / 2;
      const dx = Math.max(32, (x2 - x1) / 2);
      result.push({ path: `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`, kind: edge.kind, ...labelOf(edge, x1, y1, x2, y2) });
    }
  }
  return result;

  // 每组首条分支边带标签（组 = 父节点 + 分支键），位置取连线中点（对称贝塞尔的中点即两端点中点）。
  function labelOf(edge: LayoutEdge, x1: number, y1: number, x2: number, y2: number): Partial<DrawnEdge> {
    // 空分支占位胶囊自带「成立·空」等文字，不再重复贴标签。
    const label = byId.value[edge.toId]?.kind === 'empty-branch' ? undefined : branchLabel(edge);
    const groupKey = `${edge.fromId}|${edge.branch ?? ''}`;
    if (!label || labelled.has(groupKey)) return {};
    labelled.add(groupKey);
    return { label, lx: (x1 + x2) / 2, ly: (y1 + y2) / 2 };
  }
});
</script>

<template>
  <!-- 连线：顺序=中性实线、成立=绿色实线、不成立=灰虚线、出口=琥珀；统一带箭头标识流向。
       分支组的首条边在中点贴「成立 / 不成立 / 出口名」胶囊（每组只贴一次，避免多子节点重复堆叠）。 -->
  <svg class="connectors" :width="width" :height="height" :viewBox="`0 0 ${width} ${height}`">
    <defs>
      <marker id="ad-edge-arrow" viewBox="0 0 8 8" refX="6.5" refY="4" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
        <path d="M0,0 L8,4 L0,8 z" fill="context-stroke" />
      </marker>
    </defs>
    <path
      v-for="(edge, index) in drawn"
      :key="index"
      :d="edge.path"
      fill="none"
      marker-end="url(#ad-edge-arrow)"
      :class="['edge', `edge-${edge.kind}`]"
    />
    <g v-for="(edge, index) in drawn.filter(e => e.label)" :key="`l${index}`" :class="['edge-label', `edge-label-${edge.kind}`]">
      <rect :x="edge.lx! - labelWidth(edge.label!) / 2" :y="edge.ly! - 10" :width="labelWidth(edge.label!)" height="20" rx="10" ry="10" />
      <text :x="edge.lx" :y="edge.ly! + 4" text-anchor="middle">{{ edge.label }}</text>
    </g>
  </svg>
</template>

<style scoped>
.connectors {
  position: absolute;
  left: 0;
  top: 0;
  pointer-events: none;
  overflow: visible;
}
.edge {
  stroke-width: 1.6;
}
/* 顺序（父子/兄弟流转）：中性实线 */
.edge-flow {
  stroke: rgb(var(--base-text-color) / 0.45);
  stroke-width: 1.6;
}
/* 成立分支：绿色实线、略粗（用绿色而非主色，与选中态主色区分） */
.edge-then {
  stroke: #16a34a;
  stroke-width: 1.8;
}
/* 不成立分支：灰色虚线 */
.edge-else {
  stroke: rgb(var(--base-text-color) / 0.42);
  stroke-dasharray: 4 3;
}
/* 出口分支（动作按 x-outcomes 分流，如提取数据的 有数据/无数据）：琥珀色，
   与 then(主色)/else(灰虚线) 区分——出口是「按结果分流」而非布尔判断，不借用真假语义配色；
   按声明序号再细分线型（与 then/else 的成立实线/不成立虚线同构）：首个出口(正向/命中)实线，
   其余出口虚线——同一序号档内颜色统一，不逐个出口再配色（靠节点旁的分支标签文字区分具体含义）。 */
.edge-outcome {
  stroke: rgb(var(--warning-color, 240, 160, 30));
  stroke-width: 1.8;
}
.edge-outcome-alt {
  stroke: rgb(var(--warning-color, 240, 160, 30));
  stroke-width: 1.8;
  stroke-dasharray: 4 3;
}
/* 分支标签胶囊：底色随分支语义 */
.edge-label text {
  font-size: 11px;
  stroke: none;
}
.edge-label-then rect {
  fill: #ecfdf3;
  stroke: #abefc6;
}
.edge-label-then text {
  fill: #15803d;
}
.edge-label-else rect {
  fill: rgb(var(--container-bg-color));
  stroke: rgb(var(--base-text-color) / 0.25);
}
.edge-label-else text {
  fill: rgb(var(--base-text-color) / 0.7);
}
.edge-label-outcome rect,
.edge-label-outcome-alt rect {
  fill: #fff7e8;
  stroke: #f5cf8f;
}
.edge-label-outcome text,
.edge-label-outcome-alt text {
  fill: #b45309;
}
</style>
