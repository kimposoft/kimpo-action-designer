/**
 * action-designer 插件前端 i18n 出口。
 *
 * 现状：本文件只实现"回退链"骨架——
 * 宿主注入的 t 非空串则用宿主译文，否则原样返回 key（开发期醒目暴露漏翻，不做静默吞没）。
 *
 * 与 @kimposoft/plugin-sdk 的 createPluginI18n 四级查找链（① 插件自带包 → ② 宿主中央包 →
 * ③ 插件默认语言包 → ④ key 原样）对齐：本文件当前只实现 ②④ 两级（插件自带语言包位留空，
 * 见下方 TODO）；把 `frontend/locales/*.json` 词条接入 createPluginI18n 后，
 * 本模块可直接切换为该 SDK 实现，无需改动调用方（$t 签名不变）。
 */

/** 宿主注入的最小 t 函数契约：与 @kimposoft/plugin-sdk HostI18n.t 同签名。 */
export interface HostTranslate {
  t(key: string, params?: Record<string, unknown>): string;
}

// 模块级单例：由 surface 挂载时（createSurface）经 setHostI18n 注入，模块内其余各文件的
// `$t` 调用共享同一份，避免每个组件各自持有一份宿主引用。
let hostI18n: HostTranslate | undefined;

/** surface 挂载时调用：注入宿主 i18n 能力（未注入时 t() 恒回退 key 原样）。 */
export function setHostI18n(i18n: HostTranslate | undefined): void {
  hostI18n = i18n;
}

/**
 * 两级回退取文案：
 *   ① 宿主 t(key) —— 非空串则采用（宿主已合并中央包 + 管理员补 locale）；
 *   ② key 原样返回 —— TODO：插件自带语言包位应插在本级之前，
 *      即"宿主未命中 → 查插件自带包 → 仍未命中才原样返回 key"，对齐 SDK 四级链的 ①③ 两级。
 */
export function t(key: string, params?: Record<string, unknown>): string {
  const fromHost = hostI18n?.t(key, params);
  if (fromHost) return fromHost;
  return key;
}
