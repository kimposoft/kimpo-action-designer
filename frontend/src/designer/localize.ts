/**
 * resolveLocalized —— 与宿主前端同名多语言解析逻辑一致的本地实现（纯函数、零宿主状态依赖），
 * 供本插件内 title/description 等多语言文本解析使用。插件不能引用宿主内部模块，故本地留一份；
 * 宿主实现是权威口径，两处逻辑须保持一致。
 *
 * LocalizedText：动作 title/description 等面向用户文字的多语言对象形式。
 * - 键使用标准 BCP-47 language tag（如 "zh-CN"/"en-US"）。
 * - 旧版插件可能直接返回 string（单语言），resolveLocalized 向后兼容。
 */
export type LocalizedText = string | Record<string, string>;

const DEFAULT_LOCALE = 'zh-CN';

/** 把 locale-key 里的下划线统一为连字符（如 zh_CN → zh-CN）。 */
function normalizeLocaleKeys(map: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(map)) {
    result[k.replace(/_/g, '-')] = v;
  }
  return result;
}

/** 取 BCP-47 language tag 的基础语言部分（如 zh-CN → zh）。 */
function baseLang(locale: string): string {
  return locale.split('-')[0] ?? locale;
}

/**
 * resolveLocalized 按当前/指定 locale 从 LocalizedText 解析文字串。
 *
 * 兜底链（优先级从高到低）：
 *   1. 精确匹配（如 zh-CN）
 *   2. 基础语言匹配（如 zh-CN → zh）
 *   3. 默认语言（zh-CN）
 *   4. 任意首个有值的语言
 *   5. 空串（返回 ''，不抛异常）
 *
 * 向后兼容：value 为 string 时直接返回（旧版单语言插件）。
 */
export function resolveLocalized(value: LocalizedText | null | undefined, locale?: string): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;

  const norm = normalizeLocaleKeys(value);
  const lang = locale ?? DEFAULT_LOCALE;
  return (
    norm[lang] ??
    norm[baseLang(lang)] ??
    norm[DEFAULT_LOCALE] ??
    Object.values(norm)[0] ??
    ''
  );
}
