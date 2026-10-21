/**
 * fakeHostApi.ts —— 测试专用夹具（非生产代码，不参与 vite build 产物）。
 *
 * 插件经 hostApi 注入面访问宿主能力，用例因此构造一个满足 ActionDesignerHostApi 接口的假对象注入，
 * 而不是 vi.mock 宿主模块。本文件提供该假对象的默认版本：所有方法均为 vi.fn()，默认返回值取"空但类型合法"
 * （data 为空集合/undefined），调用方按各自用例需要以 overrides 覆盖具体方法的返回值/实现。
 */
import { vi } from 'vitest';
import type { InteractiveSessionHandle, InteractiveSessionSnapshot } from '@kimposoft/plugin-sdk';
import type { AliceV4Host } from '@kimposoft/expression-editor';
import type { ActionDesignerHostApi } from '../hostApi';

/**
 * 宿主查询服务 V4 桥假体：条件节点的判断表达式编辑器经 hostApi.createAliceV4Host 取它。
 * tokenize 恒成功并回一份**可断言的**绑定表——用例据此核验保存出去的 V4 文档 refs 完整、
 * expression_id 稳定；restore 回一句可读原文，供「重开已有条件补齐 readableText」那条用例断言。
 * diagnose/loadCatalog/compile/setScope 只留 vi.fn 桩：本插件侧不测它们的语义（属共享包/宿主职责），
 * 但要能被调用而不抛错，且可被用例断言"有没有被调用/带了什么作用域"。
 */
export function createFakeAliceV4Host(overrides: Partial<AliceV4Host> = {}): AliceV4Host {
  return {
    loadCatalog: vi.fn(async () => ({ report: { tables: [] }, extract: { candidates: [] } }) as never),
    diagnose: vi.fn(async () => ({ ok: true, diagnostics: [] }) as never),
    tokenize: vi.fn(async () => ({
      ok: true,
      source_text: '[t].[f]#{r1}',
      refs: [{ ref_id: 'r1', kind: 'report_field', table_id: 'tbl_main', field_id: 'f_main', last_label: '主表字段' }],
      digest: 'd1',
      diagnostics: []
    })) as never,
    restore: vi.fn(async () => ({ ok: true, text: '[t].[f]#{r1}', readable_text: '本报表.[主表].[主表字段] > 0', diagnostics: [] })) as never,
    compile: vi.fn(async () => ({ ok: true, targets: [] })),
    setScope: vi.fn(),
    setNodeId: vi.fn(),
    ...overrides
  } as AliceV4Host;
}

/**
 * 产出一个默认全空返回、类型完整的 ActionDesignerHostApi 假对象。
 * 未被用例覆盖的方法即使被意外调用也不会抛错（返回空集合/null），但也不会推进任何真实业务逻辑
 * ——只有 overrides 显式提供的方法才具备用例期望的行为，其余方法调用到即代表用例假设有误。
 */
export function createFakeHostApi(overrides: Partial<ActionDesignerHostApi> = {}): ActionDesignerHostApi {
  const fakeAliceV4Host = createFakeAliceV4Host();
  return {
    openActionDocument: vi.fn().mockResolvedValue({ data: undefined }),
    saveActionDocument: vi.fn().mockResolvedValue({ data: undefined }),
    // job 模式：任务级动作文档打开/保存，默认桩同模板侧（空但类型合法）。
    openJobActionDocument: vi.fn().mockResolvedValue({ data: undefined }),
    saveJobActionDocument: vi.fn().mockResolvedValue({ data: undefined }),
    listTemplateTables: vi.fn().mockResolvedValue({ data: { items: [] } }),
    listTemplateFields: vi.fn().mockResolvedValue({ data: { items: [] } }),
    listActionRegistry: vi.fn().mockResolvedValue({ data: { actions: [] } }),
    getSupportedTriggers: vi.fn().mockResolvedValue(null),
    // 无节点级上下文的默认桩：返回值类型断言为 ExpressionHost（本文件不 import 该类型以保持
    // 夹具本身足够轻量），用例若要断言表达式宿主行为应另行以 overrides 提供真实实现。
    createExpressionHost: vi.fn(() => ({}) as ReturnType<ActionDesignerHostApi['createExpressionHost']>),
    // 同一份假体在同一个 hostApi 内复用（工厂闭包外先造好），用例才能对 setScope/restore
    // 这类"调过没调过"的判据做断言——每次调用现造一个新对象会让 spy 永远看不到调用记录。
    createAliceV4Host: vi.fn(() => fakeAliceV4Host),
    createActionConfigSurface: vi.fn().mockResolvedValue(null),
    listAppTemplates: vi.fn().mockResolvedValue({ data: { items: [] } }),
    listSheetCatalog: vi.fn().mockResolvedValue({ data: { sheets: [] } }),
    createSheetThumbnailRenderer: vi.fn().mockResolvedValue(null),
    loadWindowSize: vi.fn(() => null),
    saveWindowSize: vi.fn(),
    // 流程步骤目录默认空但类型合法（无绑定流程），用例需要非空目录时以 overrides 覆盖。
    listTemplateWorkflows: vi.fn().mockResolvedValue({ data: { definitions: [] } }),
    ...overrides
  };
}

/** 纯测试父 handle；生产 surface 仍由 createSurface 强制校验 Host 注入。 */
export function createFakeInteractiveSession(
  overrides: Partial<InteractiveSessionHandle> = {}
): InteractiveSessionHandle {
  const snapshot: InteractiveSessionSnapshot = {
    mode: 'edit',
    state: 'active',
    lossReason: null,
    dirty: false,
    epoch: 1,
    expiresAt: null,
    serverTime: null,
    transportCredentialRevision: 0,
    conflict: null,
    canAdminRelease: false,
    canRequestEdit: false
  };
  return {
    snapshot,
    markDirty: vi.fn(),
    onChange: vi.fn(() => () => undefined),
    requestEdit: vi.fn(async () => undefined),
    adminRelease: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    ...overrides
  };
}
