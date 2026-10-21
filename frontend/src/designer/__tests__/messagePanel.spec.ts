/**
 * 提示语（ui.message）专用面板挂载级回归：
 * - 类型分段切换与提示内容输入的 patch 产物形状（level/text 走插件契约）；
 * - 持续时间档位的契约门控：schema 未声明 duration 属性时仅改本地预览、绝不落 params
 *   （后端 ValidateParams 会拒绝多余键），声明后才 emit patch { duration }；
 * - 实时预览卡片还原填报态真实观感（宿主 naive-ui message）：无标题行、正文即用户文案、
 *   关闭角标仅「永久」档才画（与宿主表格编辑器填报态的提示语时长判据一致），
 *   预览口径见 MessagePanel.vue 头注。
 *
 * 文案说明：MessagePanel.vue 内部文案经本地 $t 取值，未注入宿主译文时恒回退 key 原样（见 ../../i18n.ts）
 * ——本文件依赖具体中文文案（previewSample/durationHint/durationHintPermanent）的用例在 beforeEach 里经
 * installTestZhCn() 装配一份中文查表桩，其余断言（data-testid/CSS class/emit 产物形状）不受影响。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { NInputNumber } from 'naive-ui';
import MessagePanel from '../MessagePanel.vue';
import { installTestZhCn } from './testZhCnFixture';

let restoreI18n: () => void;
beforeEach(() => {
  restoreI18n = installTestZhCn();
});
afterEach(() => {
  restoreI18n();
});

function mountPanel(props: Record<string, unknown> = {}) {
  return mount(MessagePanel, {
    props: { params: {}, ...props }
  });
}

/**
 * 点选分段片（分段器是 NRadioGroup/NRadioButton，选中经内部 radio input 的 change 触发，
 * data-testid 落在 label 根上，故测试对其内部 input 派发 change）。
 */
function pickSeg(wrapper: ReturnType<typeof mountPanel>, testid: string) {
  return wrapper.find(`[data-testid="${testid}"] input`).trigger('change');
}

describe('MessagePanel（提示语专用面板）', () => {
  it('缺省态：信息档选中，预览卡片走信息样式且回落示例文案', () => {
    const wrapper = mountPanel();
    expect(wrapper.findAll('[data-testid^="message-level-"]').length).toBe(4 + 1); // 4 片 + 分段器容器自身
    expect(wrapper.find('[data-testid="message-level-info"]').classes()).toContain('n-radio-button--checked');
    const card = wrapper.find('[data-testid="message-preview-card"]');
    expect(card.classes()).toContain('msg-toast-info');
    expect(card.text()).toContain('订单保存成功');
  });

  it('宽度档位已摘除：面板不再渲染任何 message-width-* 分段片', () => {
    const wrapper = mountPanel();
    expect(wrapper.findAll('[data-testid^="message-width-"]').length).toBe(0);
  });

  it('预览还原填报态观感：无标题行，正文即用户文案（不落次要副文位）', () => {
    const wrapper = mountPanel({ params: { level: 'success', text: '订单已提交。' } });
    const card = wrapper.find('[data-testid="message-preview-card"]');
    // 运行态 naive message 无标题位：预览卡片不得出现「成功」这类级别标题文字
    expect(card.find('.msg-toast-title').exists()).toBe(false);
    expect(card.text()).toBe('订单已提交。');
    expect(card.find('.msg-toast-content').text()).toBe('订单已提交。');
  });

  it('切换提示类型：emit patch { level }，且历史脏 level 容错回落 info', () => {
    const wrapper = mountPanel({ params: { level: 'not-a-level' } });
    expect(wrapper.find('[data-testid="message-level-info"]').classes()).toContain('n-radio-button--checked');
    pickSeg(wrapper, 'message-level-success');
    expect(wrapper.emitted('patch')).toEqual([[{ level: 'success' }]]);
  });

  it('params.level 为权威：error 时预览卡片换 error 样式类', () => {
    const wrapper = mountPanel({ params: { level: 'error' } });
    expect(wrapper.find('[data-testid="message-level-error"]').classes()).toContain('n-radio-button--checked');
    expect(wrapper.find('[data-testid="message-preview-card"]').classes()).toContain('msg-toast-error');
  });

  it('输入提示内容：emit patch { text }，预览正文跟随 params.text', async () => {
    const wrapper = mountPanel({ params: { text: '库存不足，请先补货。' } });
    expect(wrapper.find('[data-testid="message-preview-card"]').text()).toContain('库存不足，请先补货。');
    await wrapper.find('[data-testid="message-content-input"] textarea').setValue('已提交审批');
    const patches = wrapper.emitted('patch');
    expect(patches?.at(-1)).toEqual([{ text: '已提交审批' }]);
  });

  // ── ③ 持续时间（快捷 3/5/10/永久 + 1~60 自定义，缺省 3 秒）────────────────────
  describe('持续时间', () => {
    /** 插件已声明 duration，故门控放行、档位真落 params（未声明时的降级态见本组末尾用例）。 */
    const withDurationSchema = {
      properties: { level: {}, text: {}, duration: { type: 'integer', default: 3 } }
    };

    it('缺省态：3 秒档选中，自定义输入框不出现，注脚说明 3 秒后自动关闭', () => {
      const wrapper = mountPanel({ paramsSchema: withDurationSchema });
      expect(wrapper.find('[data-testid="message-duration-3"]').classes()).toContain('n-radio-button--checked');
      expect(wrapper.find('[data-testid="message-duration-custom-input"]').exists()).toBe(false);
      expect(wrapper.find('[data-testid="message-duration-hint"]').text()).toContain('3');
    });

    it('点快捷档 10 秒 / 永久：emit patch { duration }，永久落 0 且注脚换「不会自动关闭」', async () => {
      const wrapper = mountPanel({ paramsSchema: withDurationSchema });
      await pickSeg(wrapper, 'message-duration-10');
      expect(wrapper.emitted('patch')?.at(-1)).toEqual([{ duration: 10 }]);

      await wrapper.setProps({ params: { duration: 0 } });
      expect(wrapper.find('[data-testid="message-duration-permanent"]').classes()).toContain('n-radio-button--checked');
      expect(wrapper.find('[data-testid="message-duration-hint"]').text()).toContain('不会自动关闭');
    });

    /**
     * 关闭角标与填报态同判据：宿主表格编辑器只在 duration=0 时
     * 回 { duration: 0, closable: true }，其余档位宿主按时长自动收起、运行时并无角标。
     */
    it('关闭角标只在「永久」档出现，秒数档一律不画', async () => {
      const wrapper = mountPanel({ paramsSchema: withDurationSchema });
      expect(wrapper.find('[data-testid="message-preview-close"]').exists()).toBe(false);

      await wrapper.setProps({ params: { duration: 0 } });
      expect(wrapper.find('[data-testid="message-preview-close"]').exists()).toBe(true);

      await wrapper.setProps({ params: { duration: 5 } });
      expect(wrapper.find('[data-testid="message-preview-close"]').exists()).toBe(false);
    });

    it('自定义：点自定义档出输入框，输入 45 秒 emit patch { duration: 45 }', async () => {
      const wrapper = mountPanel({ paramsSchema: withDurationSchema });
      await pickSeg(wrapper, 'message-duration-custom');
      const input = wrapper.findComponent(NInputNumber);
      expect(input.exists()).toBe(true);
      // NInputNumber 只在 change/blur 提交，DOM setValue 到不了面板；直接走组件 update:value 契约。
      input.vm.$emit('update:value', 45);
      await wrapper.vm.$nextTick();
      expect(wrapper.emitted('patch')?.at(-1)).toEqual([{ duration: 45 }]);
    });

    it('自定义越界夹到 1~60（与插件 ValidateParams 判据同源），清空回落 3 秒', async () => {
      const wrapper = mountPanel({ params: { duration: 45 }, paramsSchema: withDurationSchema });
      const input = wrapper.findComponent(NInputNumber);
      input.vm.$emit('update:value', 999);
      await wrapper.vm.$nextTick();
      expect(wrapper.emitted('patch')?.at(-1)).toEqual([{ duration: 60 }]);
      input.vm.$emit('update:value', null);
      await wrapper.vm.$nextTick();
      expect(wrapper.emitted('patch')?.at(-1)).toEqual([{ duration: 3 }]);
    });

    it('params.duration 为非快捷值时自定义档自动选中，输入框回显该值', () => {
      const wrapper = mountPanel({ params: { duration: 45 }, paramsSchema: withDurationSchema });
      expect(wrapper.find('[data-testid="message-duration-custom"]').classes()).toContain('n-radio-button--checked');
      expect(wrapper.find('[data-testid="message-duration-custom-input"] input').attributes('value')).toBe('45');
    });

    it('从「永久」切到自定义：补默认 3 秒，避免输入框显示越界的 0', async () => {
      const wrapper = mountPanel({ params: { duration: 0 }, paramsSchema: withDurationSchema });
      await pickSeg(wrapper, 'message-duration-custom');
      expect(wrapper.emitted('patch')?.at(-1)).toEqual([{ duration: 3 }]);
    });

    it('历史脏值（越界/带小数）回落 3 秒档，不把非法值带进 UI', () => {
      const wrapper = mountPanel({ params: { duration: 999 }, paramsSchema: withDurationSchema });
      expect(wrapper.find('[data-testid="message-duration-3"]').classes()).toContain('n-radio-button--checked');
    });

    it('门控：schema 未声明 duration（旧插件二进制）时点 5 秒只改本地，绝不落 params', async () => {
      const wrapper = mountPanel();
      await pickSeg(wrapper, 'message-duration-5');
      expect(wrapper.emitted('patch')).toBeUndefined();
      expect(wrapper.find('[data-testid="message-duration-5"]').classes()).toContain('n-radio-button--checked');
    });
  });
});
