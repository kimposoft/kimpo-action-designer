import { describe, expect, it } from 'vitest';
import type { SurfaceCreateInput } from '@kimposoft/plugin-sdk';
import { createFakeHostApi, createFakeInteractiveSession } from '../designer/__tests__/fakeHostApi';
import { createSurface } from './index';

function input(hostBridge: Record<string, unknown>): SurfaceCreateInput {
  return {
    surfaceType: 'action-designer',
    hostCaps: ['platform.interactiveSession', 'domain:action-designer', 'i18n'],
    hostContext: { appId: 'app-1', templateId: 'tpl-1' },
    runtime: undefined,
    props: {
      input: {
        kind: 'template',
        scope: { appId: 'app-1', templateId: 'tpl-1', templateVersionNo: '1.0' },
        visible: true,
        interactiveSessionOwnership: 'inherited',
        requestClose: async () => true
      }
    },
    hostBridge
  };
}

describe('action-designer surface interactive session boundary', () => {
  it('缺少 Host 标准 handle 时 fail-closed，不存在生产回落路径', () => {
    expect(() => createSurface(input({ 'domain:action-designer': createFakeHostApi() }))).toThrow(
      '宿主未注入 platform.interactiveSession'
    );
  });

  it('把 Host 注入的同一 handle 原样传给 DesignerRoot', () => {
    const interactiveSession = createFakeInteractiveSession();
    const mounted = createSurface(input({
      'domain:action-designer': createFakeHostApi(),
      interactiveSession
    }));

    expect(mounted.props?.interactiveSession).toBe(interactiveSession);
  });
});
