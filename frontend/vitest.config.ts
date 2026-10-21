/// <reference types="vitest" />
// 单测运行配置：happy-dom 提供 @vue/test-utils mount() 所需的最小 DOM；
// include 同时收 src 下的 *.test.ts 与 __tests__/*.spec.ts。
import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  resolve: {
    // 强制 vue / naive-ui 只解析出一份，避免共享包各自带一份 Vue / Naive 实例。
    dedupe: ['vue', 'naive-ui']
  },
  test: {
    environment: 'happy-dom',
    include: ['src/**/*.{test,spec}.ts'],
    exclude: ['node_modules/**', 'dist/**']
  }
});
