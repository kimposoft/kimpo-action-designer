import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 动作节点的框架级选项（异步执行）只有一个入口——NodeConfigDialog 头部「启用」左侧的「选项」按钮。
 * 专属面板若各自再画一个「选项」按钮，改的是同一个 draft.async，用户会看到两个入口。
 * 本文件钉死：面板不再持有异步开关 / 选项气泡，挂载点不再往面板递 async 三件套，回落组显示名为「选项」。
 */
const read = (name: string) => readFileSync(join(process.cwd(), 'src/designer', name), 'utf8');

const PANELS = ['LinkedFormPanel.vue', 'FormControlPanel.vue', 'MessagePanel.vue', 'SwitchSheetPanel.vue', 'PrintPanel.vue', 'DetailSortPanel.vue'];

describe('专属面板不再自带「选项」入口', () => {
  it.each(PANELS)('%s：无 asyncValue/asyncable 属性、无异步开关、无选项气泡', name => {
    const src = read(name);
    expect(src).not.toContain('asyncValue');
    expect(src).not.toContain('asyncable');
    expect(src).not.toContain("$t('actionDesigner.dialog.asyncExec')");
    expect(src).not.toContain('optionsVisible');
    expect(src).not.toMatch(/dialog\.[A-Za-z]+\.options'\)/);
  });

  it('NodeConfigDialog：挂载专属面板不再递 async 三件套，头部浮层仍承载异步开关', () => {
    const dialog = read('NodeConfigDialog.vue');
    expect(dialog).not.toContain(':async-value=');
    expect(dialog).not.toContain('@update:async-value=');
    // 头部唯一入口：选项浮层按钮 + 浮层内异步开关（before-save 根下写动作置灰链不变）。
    expect(dialog).toContain('<NButton size="tiny" type="primary" ghost class="ncd-options-btn">{{ optionsTabLabel }}</NButton>');
    expect(dialog).toContain(':disabled="!asyncable || asyncBlockedByBeforeSave" @update:value="v => (draft.async = v)"');
  });

  it('未声明 x-tabs 的回落选项组显示名走 tabOptions（「选项」），tabExt 已退役', () => {
    const dialog = read('NodeConfigDialog.vue');
    expect(dialog).toContain("{ key: 'ext', label: $t('actionDesigner.dialog.tabOptions'), options: true }");
    expect(dialog).not.toContain('actionDesigner.dialog.tabExt');
  });
});
