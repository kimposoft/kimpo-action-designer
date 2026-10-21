<script setup lang="ts">
import { computed } from 'vue';
import { NODE_ICON_PATHS } from './nodeIcons';

/** 画布节点线条图标：按图标键渲染 nodeIcons 路径表，未知键回落通用宫格。 */
const props = withDefaults(defineProps<{ icon: string; size?: number; strokeWidth?: number }>(), { size: 16, strokeWidth: 2 });
const paths = computed(() => NODE_ICON_PATHS[props.icon] ?? NODE_ICON_PATHS.grid);
</script>

<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    :stroke-width="strokeWidth"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path v-for="(d, i) in paths" :key="i" :d="d" />
  </svg>
</template>
