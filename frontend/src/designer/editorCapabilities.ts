/**
 * editorCapabilities.ts —— 动作节点按模板绑定编辑器档案过滤。
 *
 * 链路：插件 kimpo-action-designer（设计层）。动作运行期产出的界面命令随动作目录下发（ActionDefinition.editor_commands，
 * 宿主登记期由 x-editor-commands 注解 / 标准动作 canonical 表得出）；模板绑定编辑器的能力经 hostApi.getEditorCapabilities
 * 取（editor_profiles + 静态 commands）。只裁 P 级命令（需档案）：缺档案或编辑器未声明该命令的动作在面板置灰、画布上已有的
 * 节点报错阻止保存（宿主保存期再校验一次）。H / C 级命令不裁。
 *
 * 分级表与 SDK `@kimposoft/plugin-sdk/editor`（EDITOR_HOST_COMMANDS / EDITOR_CORE_COMMANDS / EDITOR_PROFILE_COMMANDS /
 * editorCommandProfile）逐字一致；本文件镜像一份是因为插件构建依赖的 SDK 版本可能落后于最新 SDK（SDK 改表须同步改这里）。
 */
import type { ActionDefinition, EditorCapabilities } from './hostTypes';

/** P 级命令 → 所需档案。 */
export const PROFILE_COMMANDS: Readonly<Record<string, string>> = {
  'sheet.switch': 'sheet-catalog',
  'sheet.print': 'print.basic',
  'chart.set-inline-data': 'chart',
  'preview.enter': 'ai-proposal',
  'preview.exit': 'ai-proposal',
  'highlight.set': 'ai-proposal',
  'highlight.clear': 'ai-proposal',
  'design.save': 'ai-proposal'
};

/** 按前缀整族归档案的 P 级命令。 */
const PROFILE_COMMAND_FAMILIES: Readonly<Record<string, string>> = {
  'preview.': 'ai-proposal',
  'highlight.': 'ai-proposal'
};

/** P 级命令所需档案；不是 P 级命令返回 null。 */
export function profileForCommand(command: string): string | null {
  const c = command.trim();
  if (Object.prototype.hasOwnProperty.call(PROFILE_COMMANDS, c)) return PROFILE_COMMANDS[c];
  for (const [prefix, profile] of Object.entries(PROFILE_COMMAND_FAMILIES)) {
    if (c.startsWith(prefix) && c.length > prefix.length) return profile;
  }
  return null;
}

/** 一个动作在当前编辑器下不可用的原因（可用时为 null）。 */
export interface ActionEditorGap {
  command: string;
  profile: string;
}

/**
 * 判定动作在模板绑定编辑器下是否可用：caps 为 null（宿主未提供 / 读取失败 / 定时任务模式）时不裁剪（旧宿主行为不变）；
 * 否则对动作声明的每条 P 级命令，要求编辑器声明了对应档案，且（静态 commands 可得时）声明了该命令。
 */
export function actionEditorGap(def: Pick<ActionDefinition, 'editor_commands'> | undefined, caps: EditorCapabilities | null): ActionEditorGap | null {
  if (!def || !caps) return null;
  for (const raw of def.editor_commands ?? []) {
    const command = String(raw ?? '').trim();
    const profile = profileForCommand(command);
    if (!profile) continue;
    const hasProfile = caps.profiles.includes(profile);
    const hasCommand = caps.commands === null || caps.commands.includes(command);
    if (!hasProfile || !hasCommand) return { command, profile };
  }
  return null;
}
