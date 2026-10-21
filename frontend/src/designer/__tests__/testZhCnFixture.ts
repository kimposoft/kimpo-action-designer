/**
 * testZhCnFixture.ts —— 测试专用 i18n 查表桩（非生产代码，不参与 vite build 产物）。
 *
 * 背景：插件自带 locale 包（../../../locales/*.json）当前是空壳（见 ../../i18n.ts 顶部注释），
 * 未经 setHostI18n 注入宿主译文时 $t(key) 恒回退 key 原样。部分用例断言依赖具体中文文案
 * （运行时由宿主 vue-i18n 提供）——本文件给出这些用例实际断言到的 key→文案，与宿主中文语言包
 * actionDesigner 命名空间同 key 的文案一致（人工维护，非机器同步：宿主文案若调整，使用本表的测试
 * 可能需要同步更新）。仅覆盖用例实际断言到的 key，不是全量词表，不代表插件自带 locale 包的最终形态。
 */
import { setHostI18n, type HostTranslate } from '../../i18n';

/** key → 中文文案模板（`{param}` 占位对齐宿主 vue-i18n 的具名插值）。 */
const TABLE: Record<string, string> = {
  // events.*（eventLabel 使用，见 labels.ts）
  'actionDesigner.events.createTime': '新建时',
  'actionDesigner.events.beforeSave': '保存前',
  'actionDesigner.events.afterSave': '保存后',
  'actionDesigner.events.valueChange': '值变动',
  'actionDesigner.events.fieldClick': '点击字段时',
  // condition.*（conditionStatement/guardSpecStatement 使用）
  'actionDesigner.condition.unset': '（未设置条件）',
  'actionDesigner.condition.and': '且',
  'actionDesigner.condition.or': '或',
  'actionDesigner.condition.multiSummary': '{first} 等共 {count} 项（{logic}）',
  // outcome.*（outcomeLabel 使用，R5 出口分支）
  'actionDesigner.outcome.hit': '命中',
  'actionDesigner.outcome.miss': '未命中',
  // summary.*（nodeSummary 使用）
  'actionDesigner.summary.event': '事件',
  'actionDesigner.summary.trigger': '触发',
  'actionDesigner.summary.unset': '未设置',
  'actionDesigner.summary.judge': '判断',
  'actionDesigner.summary.action': '动作',
  'actionDesigner.summary.actionDefault': '动作',
  'actionDesigner.summary.source': '来源',
  'actionDesigner.summary.plugin': '插件',
  'actionDesigner.summary.builtin': '内置',
  'actionDesigner.summary.exec': '执行',
  'actionDesigner.summary.async': '异步',
  'actionDesigner.summary.sync': '同步',
  'actionDesigner.summary.triggerFields': '触发字段',
  'actionDesigner.summary.extractSources': '来源表',
  'actionDesigner.summary.extractFilter': '筛选条件',
  'actionDesigner.summary.extractFill': '填充',
  'actionDesigner.summary.extractStaging': '暂存区',
  'actionDesigner.summary.roleMain': '主表',
  'actionDesigner.summary.roleDetail': '扩展表',
  'actionDesigner.summary.fillOverwrite': '覆盖',
  'actionDesigner.summary.fillMerge': '合并',
  'actionDesigner.summary.fillRowMatch': '按行列匹配',
  'actionDesigner.summary.extractSourceCount': '{count} 张',
  'actionDesigner.summary.extractTargetCount': '{count} 个目标',
  'actionDesigner.summary.extractColField': '目标字段',
  'actionDesigner.summary.extractColExpr': '表达式',
  'actionDesigner.summary.extractColStrategy': '方式',
  'actionDesigner.summary.extractColStagingColumn': '暂存列',
  // 写节点指向详情（新增/修改/删除数据，见 labels.writeV4Summary）。
  'actionDesigner.summary.writeTarget': '目标表',
  'actionDesigner.summary.writeFilter': '定位条件',
  'actionDesigner.summary.writeAssignments': '填充字段',
  'actionDesigner.summary.writeAssignmentCount': '{count} 个字段',
  // 不含 writeParent/writeParentKindCurrentForm/writeParentKindInstance：父记录锚定配置项已撤销，
  // 摘要不再产出该行（见 labels.ts writeV4Summary）。
  'actionDesigner.summary.writeDedupe': '防重',
  'actionDesigner.summary.writeOperationInsert': '新增',
  'actionDesigner.summary.writeOperationUpdate': '修改',
  'actionDesigner.summary.writeOperationDelete': '删除',
  'actionDesigner.summary.writeDedupeScopeAll': '全表',
  'actionDesigner.summary.writeDedupeScopeParent': '同父内',
  'actionDesigner.panel.filterOther': '其他',
  // validate.*（validate.ts 校验信息，validate.test.ts 依 message.includes(...) 断言）
  'actionDesigner.validate.noField': '{label}未设置字段',
  'actionDesigner.validate.noSuchField': '{label}引用了不存在的字段 {fieldId}',
  'actionDesigner.validate.noActionSelected': '动作未选择',
  'actionDesigner.validate.noTriggerField': '{event}未设置触发字段',
  'actionDesigner.node.triggerFields': '字段：{fields}',
  'actionDesigner.node.triggerFieldsUnset': '未设置触发字段',
  'actionDesigner.node.startPrefix': '开始',
  'actionDesigner.node.digestFields': '→ {count} 个字段',
  'actionDesigner.node.digestMore': '等',
  'actionDesigner.node.branchThenSteps': '成立 {count} 步',
  'actionDesigner.node.branchElseSteps': '不成立 {count} 步',
  'actionDesigner.node.branchThenEmpty': '成立 未编排',
  'actionDesigner.node.branchElseEmpty': '不成立 未编排',
  'actionDesigner.validate.asyncNotSupported': '该动作不支持异步，却被置为异步',
  'actionDesigner.validate.nodeGuardLabel': '节点门控',
  'actionDesigner.validate.nestTooDeep': '条件嵌套超过 {maxDepth} 层',
  'actionDesigner.validate.bothBranchesEmpty': '条件的成立/不成立分支都为空',
  'actionDesigner.validate.canvasEmpty': '画布为空，未编排任何动作',
  // compile.*（表达式模式非空 else 分支的设计期校验文案）
  'actionDesigner.compile.expressionElseUnsupported':
    '表达式模式的条件节点不支持"不成立"分支（无法生成取反表达式），请改用引导式判断，或清空该分支后再保存',
  // dialog.tabCondition（validate.ts 里作条件 tab 的 label 参数用）
  'actionDesigner.dialog.tabCondition': '条件',
  'actionDesigner.dialog.legacyKimpoSqlRetired': 'KimpoSQL 已退役，请用结构化表达式重建。',
  // 取数节点旧格式（仍带 expression、无 extract_v4）失效横幅文案。
  'actionDesigner.dialog.extractV4LegacyConfig': '此取数节点为旧格式配置，已停用；请重新配置后保存',
  // 写动作（新增/修改/删除数据）参数键为 write_v4——旧格式失效横幅文案。
  'actionDesigner.dialog.writeV4LegacyConfig': '此节点使用旧配置格式（已退役），请重新配置写入规则',
  'actionDesigner.dialog.testFailedWith': '校验未通过：{msg}',
  'actionDesigner.dialog.noExtConfig': '该动作暂无扩展配置。插件可在此提供自定义配置内容（待接线）。',
  'actionDesigner.dialog.standardPanelMissing': '未找到该数据动作的官方标准配置面板，请确认官方记录控制器插件已安装并启用后重新打开。',
  'actionDesigner.dialog.pluginParams': '插件参数',
  // dialog.message.*（MessagePanel 预览文案/持续时间注脚）
  'actionDesigner.dialog.message.previewSample': '订单保存成功，已同步更新库存。',
  'actionDesigner.dialog.message.durationHint': '提示显示 {n} 秒后自动关闭。',
  'actionDesigner.dialog.message.durationHintPermanent': '提示不会自动关闭，需用户手动点关闭。',
  // 未声明 x-tabs 的动作其头部选项组显示名 + 打印目标未设打印区域的置灰提示。
  'actionDesigner.dialog.tabOptions': '选项',
  'actionDesigner.dialog.print.noPrintArea': '未设置打印区域',
  // 打印目标卡片状态文字 + 切换Sheet 卡片状态文字（两面板共用 SheetCardGrid）。
  'actionDesigner.dialog.print.statusTarget': '打印目标',
  'actionDesigner.dialog.print.statusArea': '打印区域 {area}',
  'actionDesigner.dialog.sheetPicker.statusTarget': '切换目标',
  'actionDesigner.dialog.sheetPicker.statusPick': '点击选择',
  'actionDesigner.dialog.sheetPicker.statusHidden': '已隐藏',
  // 按处境分档的三条切换状态文字 + 分组/失效文案
  'actionDesigner.dialog.sheetPicker.statusSwitchTab': '切换页签',
  'actionDesigner.dialog.sheetPicker.statusTabPage': '切到该页签 · 第 {n} 页',
  'actionDesigner.dialog.sheetPicker.statusLocate': '定位到该分区',
  'actionDesigner.dialog.sheetPicker.groupFallback': '页签 {n}',
  'actionDesigner.dialog.sheetPicker.invalidTarget': '已选的目标 Sheet 不存在或已被删除，请重新选择（原配置未清空）。'
};

/** 极简 `{param}` 具名插值替换，够用即可（非完整 vue-i18n 插值实现）。 */
function interpolate(template: string, params?: Record<string, unknown>): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (matched, key: string) => (key in params ? String(params[key]) : matched));
}

const stubTranslate: HostTranslate = {
  t: (key, params) => {
    const template = TABLE[key];
    return template ? interpolate(template, params) : key;
  }
};

/**
 * 装配查表桩（建议在 beforeEach 调用）；返回的函数用于 afterEach 复原（setHostI18n 是模块级
 * 单例，不复原会串到同进程内其他测试文件）。
 */
export function installTestZhCn(): () => void {
  setHostI18n(stubTranslate);
  return () => setHostI18n(undefined);
}
