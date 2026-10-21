import { onBeforeUnmount, ref, watch, type Ref } from 'vue';
import type { ActionDesignerHostApi } from './hostApi';
import type { SheetCatalogEntry, SheetThumbnailRenderer } from './hostTypes';

/**
 * Sheet 缩略图（卡片预览图）生成——切换Sheet / 打印单据两个专属面板共用。
 *
 * 通路：hostApi.createSheetThumbnailRenderer（宿主闭包：取设计文档 → 解析表格编辑器前端 bundle → 取其
 * renderDesignSheetThumbnail 出口）→ 逐 sheet **顺序**渲染（每张出图即上屏，弹窗打开不被阻塞）。
 * 三级静默回退保持灰色占位块：① scope 缺版本号/目录为空；② 旧 bundle 无渲染出口（返回 null）；
 * ③ 取数/渲染任一异常。生成结果按 sheetId 缓存于调用方组件实例，面板内的过滤切换不重渲。
 */
export const SHEET_THUMB_WIDTH = 240; // 卡片内容宽（264 - 12×2 padding）
export const SHEET_THUMB_HEIGHT = 113; // 缩略块高

/** 缩略图渲染所需的设计上下文（与 NodeConfigDialog 递给面板的 scope 同形）。 */
export interface SheetThumbnailScope {
  appId: string;
  templateId: string;
  templateVersionNo?: string;
  pluginId?: string;
}

export function useSheetThumbnails(source: {
  scope: () => SheetThumbnailScope | undefined;
  sheets: () => SheetCatalogEntry[];
  hostApi: () => ActionDesignerHostApi;
}): { thumbs: Ref<Record<string, string>> } {
  const thumbs = ref<Record<string, string>>({});
  /** 任务代际号：scope/目录变更或卸载时自增，旧任务在下一次 await 后自行退出。 */
  let thumbJobSeq = 0;

  async function runThumbnailJob(): Promise<void> {
    const job = ++thumbJobSeq;
    thumbs.value = {};
    const scope = source.scope();
    const sheets = source.sheets();
    const appId = scope?.appId;
    const templateId = scope?.templateId;
    const versionNo = scope?.templateVersionNo;
    if (!appId || !templateId || !versionNo || sheets.length === 0) return;
    try {
      const render: SheetThumbnailRenderer | null = await source.hostApi().createSheetThumbnailRenderer({
        appId,
        templateId,
        templateVersionNo: versionNo,
        pluginId: scope?.pluginId
      });
      if (job !== thumbJobSeq) return;
      if (!render) return; // 旧 bundle：无缩略图出口，保留占位块

      // 逐张顺序渲染：目录序（index）即生成序；每张 await 之间 Vue 正常刷新，缩略图渐次上屏。
      const ordered = [...sheets].sort((a, b) => a.index - b.index);
      for (const s of ordered) {
        if (job !== thumbJobSeq) return;
        // dpr 恒 1 + 插件侧有损编码（低质量快速档）：缩略图只求轮廓可辨，换更快的逐张生成
        const url = await render(s.id, { width: SHEET_THUMB_WIDTH, height: SHEET_THUMB_HEIGHT, dpr: 1 });
        if (job !== thumbJobSeq) return;
        if (url) thumbs.value = { ...thumbs.value, [s.id]: url };
      }
    } catch {
      // 静默回退：缩略图属增强展示，任何失败都不影响面板可用性
    }
  }

  watch(
    () => {
      const scope = source.scope();
      return [scope?.appId, scope?.templateId, scope?.templateVersionNo, source.sheets()] as const;
    },
    () => {
      void runThumbnailJob();
    },
    { immediate: true }
  );
  onBeforeUnmount(() => {
    thumbJobSeq += 1; // 打断在途任务
  });

  return { thumbs };
}
