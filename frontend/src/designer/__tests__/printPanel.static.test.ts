import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 打印单据（ui.print）专用面板静态强约束（动作设计器设计层，遵循宿主设计规范）：
 * 钉死视觉规范关键量（28px 步骤圆点、280×100 模式卡、选中态浅蓝底+品牌描边、右上角勾选角标、
 * 推荐徽标成功色、596px 开关行）与 NodeConfigDialog 的 x-picker:sheet-print 分派接线，
 * 防后续改动无感漂移。readFileSync 路径相对 process.cwd()（即本仓库 frontend/ 目录）。
 */
const panel = readFileSync(join(process.cwd(), 'src/designer/PrintPanel.vue'), 'utf8');
const dialog = readFileSync(join(process.cwd(), 'src/designer/NodeConfigDialog.vue'), 'utf8');

describe('PrintPanel 视觉规范钉死量', () => {
  it('双步骤：28px 品牌色圆点 + 2px 连线，步骤②随打印目标点亮', () => {
    expect(panel).toContain('class="pp-dot active">1<');
    expect(panel).toContain(':class="{ active: step2Active }">2<');
    expect(panel).toContain('width: 28px;');
    expect(panel).toContain('height: 28px;');
    expect(panel).toContain("const step2Active = computed(() => sheetId.value !== '')");
  });

  it('打印方式两卡：280×100、选中=浅蓝底+品牌描边+右上角勾选角标，预览卡带成功色推荐徽标', () => {
    expect(panel).toContain('data-testid="print-mode-preview"');
    expect(panel).toContain('data-testid="print-mode-direct"');
    expect(panel).toContain('width: 280px;');
    expect(panel).toContain('height: 100px;');
    expect(panel).toContain('background-color: rgb(var(--primary-50-color) / 0.5);');
    expect(panel).toContain('border-color: rgb(var(--primary-color));');
    // 角标与切换Sheet面板同款：24px 方块、右上/左下 8px 圆角衔接卡片圆角
    expect(panel).toContain('border-radius: 0 8px 0 8px;');
    expect(panel).toContain('background-color: rgb(var(--success-color, 103 194 58) / 0.15);');
  });

  it('允许调整开关行：描边圆角容器、宽度对齐两卡总宽 596，直打模式附风险提示', () => {
    expect(panel).toContain('data-testid="print-allow-adjust"');
    expect(panel).toContain('data-testid="print-direct-warning"');
    expect(panel).toContain('width: 596px;');
    expect(panel).toContain("v-if=\"gateMode === 'direct'\"");
  });

  it('参数产物：sheet_id + gate 整体重建（只含 mode/allow_adjust，洗历史脏键）', () => {
    // 卡片点选只写入、无清空操作（原下拉 clearable 的 sheet_id=undefined 分支随之移除）
    expect(panel).toContain("emit('patch', { sheet_id: s.id })");
    expect(panel).toContain("emit('patch', { gate: { mode: gateMode.value, allow_adjust: allowAdjust.value, ...partial } })");
  });

  // 不按 printable（手动打印「可打印」策略位）过滤——全量列出、按 print_area 判可选；
  // 第一步用与切换Sheet 同款的共用卡片网格 + 预览图（不是下拉），置灰卡带悬停提示。
  // 挂载级行为见 printPanel.spec.ts。
  it('全量 Sheet 卡片 + 预览图、按打印区域判可选（不再按 printable 过滤），空目录给 emptyPrintable 空态', () => {
    expect(panel).not.toContain('s.printable === true');
    expect(panel).not.toContain('<NSelect');
    expect(panel).toContain('<SheetCardGrid');
    expect(panel).toContain(':locked-tip="lockedTip"');
    expect(panel).toContain('useSheetThumbnails({');
    expect(panel).toContain("return printAreaOf(s) === '';");
    expect(panel).toContain("$t('actionDesigner.dialog.sheetPicker.emptyPrintable')");
  });
});

describe('NodeConfigDialog 打印面板接线（x-picker=sheet-print 分派）', () => {
  it('按 schema 的 x-picker 升级为专用面板，且通用参数分支不再含 sheet-print 下拉', () => {
    expect(dialog).toContain("const isPrintAction = computed(() => paramFields.value.some(f => f.picker === 'sheet-print'))");
    expect(dialog).toContain('<PrintPanel');
    expect(dialog).toContain('v-else-if="node.kind === \'action\' && isPrintAction"');
    // 旧通用分支已摘除：模板不应再出现 sheet-print 的 field.picker 判定
    expect(dialog).not.toContain("field.picker === 'sheet-print'");
  });
});
