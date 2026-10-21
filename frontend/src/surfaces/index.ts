/**
 * action-designer 插件前端 UMD 入口的 createSurface 分发实现。
 *
 * 用 @kimposoft/plugin-sdk 的 definePluginSurface 做类型收敛（参照
 * kimpo-workflow/frontend/src/surfaces/index.ts 的分发器写法）；本插件当前只声明一个
 * surfaceType（'action-designer'），挂载 DesignerRoot。
 *
 * 非法/未声明的 surfaceType 显式抛错，便于宿主接线错误在开发期第一时间暴露
 * （对齐 kimpo-workflow / kimpo-records-view 的既有约定）。
 *
 * hostApi 注入方式：改走 hostBridge['domain:action-designer']（与 record-controllers
 * 的 'domain:expression' 先例同款、与本插件 manifest.json 声明的 host_caps 一致），不再走
 * input.props.input.hostApi 扁平注入——缺失即抛明确错误，避免宿主接线遗漏时插件内部各处
 * 静默拿到 undefined hostApi 才在深层调用处炸。
 */
import { definePluginSurface, type SurfaceCreateInput } from '@kimposoft/plugin-sdk/surface';
import type { InteractiveSessionHandle } from '@kimposoft/plugin-sdk';
import DesignerRoot, { type ActionDesignerSurfaceInput } from '../DesignerRoot.vue';
import type { ActionDesignerHostApi } from '../designer/hostApi';
import { setHostI18n, type HostTranslate } from '../i18n';

export const createSurface = definePluginSurface((input: SurfaceCreateInput) => {
  switch (input.surfaceType) {
    case 'action-designer': {
      // i18n：按 SDK SurfaceCreateInput 现状（对齐 kimpo-workflow/frontend/src/surfaces/designer.ts
      // 的取法）经 input.hostBridge.i18n 注入；hostBridge 类型为 unknown（SDK 契约，避免反向依赖），
      // 此处按约定断言。老宿主/未授予 'i18n' hostCaps 时该键为 undefined，$t 回退 key 原样（见 ../i18n.ts）。
      const hostBridge = input.hostBridge as
        | {
            i18n?: HostTranslate;
            'domain:action-designer'?: ActionDesignerHostApi;
            interactiveSession?: InteractiveSessionHandle;
          }
        | undefined;
      setHostI18n(hostBridge?.i18n);

      const hostApi = hostBridge?.['domain:action-designer'];
      if (!hostApi) {
        throw new Error('[kimpo-action-designer] 宿主未注入 domain:action-designer');
      }
      const interactiveSession = hostBridge?.interactiveSession;
      if (!interactiveSession) {
        throw new Error('[kimpo-action-designer] 宿主未注入 platform.interactiveSession');
      }
      return {
        component: DesignerRoot,
        // input.props.input 承载 DesignerRoot 消费的业务形状（scope/visible/requestClose/title，
        // 不含 hostApi——hostApi 改走上面的 hostBridge['domain:action-designer'] 单独传参），
        // 见 ../DesignerRoot.vue 顶部注释与 ../designer/hostApi.ts。
        props: { input: input.props?.input as ActionDesignerSurfaceInput, hostApi, interactiveSession }
      };
    }
    default:
      throw new Error(`[kimpo-action-designer] unsupported surface: ${input.surfaceType}`);
  }
});
