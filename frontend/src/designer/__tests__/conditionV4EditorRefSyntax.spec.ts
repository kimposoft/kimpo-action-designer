import { describe, expect, it } from 'vitest';
import { defineComponent, h, inject } from 'vue';
import { mount } from '@vue/test-utils';
import { EXPRESSION_HOST, REF_SYNTAX, type ExpressionHost } from '@kimposoft/expression-editor';
import ConditionV4Editor from '../ConditionV4Editor.vue';
import { createFakeAliceV4Host } from './fakeHostApi';

/**
 * ConditionV4Editor 没 provide 方括号引用语法时，共享编辑器缺省走 braces，字段树点击插入 3.4 的
 * `{字段}`，宿主查询服务 V4 分词报 ALICE_SYNTAX_LEX_INVALID。本守护把「子树注入到的 REF_SYNTAX 必须是
 * brackets」钉死。
 *
 * 配置页本身就是表达式编辑界面：编辑本体是内嵌的 AdvancedExpressionPanel。同时钉住「表达式域桥已被
 * V4 适配器接管（带 lowerText）」——它是 V4 tokenize 的唯一入口，缺了就退化成 3.4 降级。
 */
describe('ConditionV4Editor 引用语法与宿主桥注入', () => {
  it('向内嵌 AdvancedExpressionPanel 子树 provide REF_SYNTAX=brackets 且表达式域桥带 lowerText', () => {
    // 用一个只回显注入值的桩替换真实面板：判据只关心 provide 到位，不关心面板内部。
    const Probe = defineComponent({
      name: 'AdvancedExpressionPanel',
      setup() {
        const syntax = inject(REF_SYNTAX, 'braces');
        const host = inject<ExpressionHost | null>(EXPRESSION_HOST, null);
        return () =>
          h('span', {
            'data-testid': 'ref-syntax',
            'data-lower-text': host && typeof host.lowerText === 'function' ? 'yes' : 'no',
            textContent: String(syntax)
          });
      }
    });
    const wrapper = mount(ConditionV4Editor, {
      props: {
        show: true,
        spec: null,
        tables: [],
        expressionHost: {} as ExpressionHost,
        v4Host: createFakeAliceV4Host(),
        conditionId: 'cond_00000001'
      },
      global: { stubs: { AdvancedExpressionPanel: Probe } }
    });
    const probe = wrapper.get('[data-testid="ref-syntax"]');
    expect(probe.text()).toBe('brackets');
    expect(probe.attributes('data-lower-text'), 'V4 适配器必须接管 lowerText').toBe('yes');
  });
});
