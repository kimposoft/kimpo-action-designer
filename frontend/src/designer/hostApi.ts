/**
 * hostApi.ts —— action-designer 插件的宿主能力注入面。
 *
 * 设计器里凡"影响业务数据/依赖宿主专属服务"的调用（动作文档读写、模板表/字段目录、动作注册中心、
 * 子插件配置面板装配、Sheet 缩略图、窗口尺寸记忆等）一律经本接口由宿主注入——插件内部只持有
 * ActionDesignerHostApi 这一个注入点，不直接引用任何宿主内部模块（编译期由 tsconfig 保证）。
 *
 * ── input 形状（DesignerRoot.vue props.input，供宿主挂载方对齐） ──────────────────
 * ```ts
 * interface ActionDesignerSurfaceInput {
 *   /** 动作设计器作用域（appId/templateId/templateVersionNo/pluginId 等，见 hostTypes.ActionDesignerScope）。 *\/
 *   scope: ActionDesignerScope;
 *   /** 弹窗显隐（受控）；DesignerRoot 内部渲染 ActionDesignerDialog + ActionDesigner。 *\/
 *   visible: boolean;
 *   /** 请求 Host 统一执行 dirty 确认和 owned 会话关闭；取消返回 false。 *\/
 *   requestClose: () => Promise<boolean>;
 *   /** 对话框标题（缺省回退插件自带 i18n key 'actionDesigner.dialogWin.title'）。 *\/
 *   title?: string;
 * }
 * ```
 * hostApi（本文件定义的宿主能力注入面）不在上面这个 input 形状内：走
 * SurfaceCreateInput.hostBridge['domain:action-designer']（与 record-controllers 的
 * 'domain:expression' 同款、与本插件 manifest.json 声明的 host_caps 一致），由
 * surfaces/index.ts 的 createSurface 分发处取出后作为 DesignerRoot.vue 的独立 hostApi prop
 * 传入。宿主挂载方须实现 ActionDesignerHostApi 并挂在 hostBridge['domain:action-designer'] 上。
 *
 * i18n 同样不在本 input 形状内：宿主经 SurfaceCreateInput.hostBridge.i18n 注入，由
 * surfaces/index.ts 的 createSurface 分发处调用 setHostI18n 统一处理，不进 DesignerRoot 的 input 参数。
 *
 * 各方法的语义要点：
 * - getSupportedTriggers：按 pluginId 取载体插件 manifest 的
 *   capabilities.runtimeActionCapabilities.supportedTriggers 原样返回，与 ACTION_TRIGGER_EVENT_KEYS
 *   的交集运算由插件侧 useActionDesigner.ts 承担；
 * - createActionConfigSurface：宿主解析子插件的 action-config surface 并装配其 hostBridge
 *   （含 'domain:expression' 与 i18n）后挂载；
 * - createSheetThumbnailRenderer：宿主取设计文件并加载表格编辑器前端 bundle 的
 *   renderDesignSheetThumbnail 导出；
 * - loadWindowSize/saveWindowSize：按登录用户分桶的窗口尺寸记忆；
 * - createExpressionHost：按当前节点现场构造 getStagingSchema 闭包并产出实例（非共享单例），
 *   详见本文件 createExpressionHost 字段注释；
 * - listApps：与 ExpressionHost.listApps 同一份工作台应用目录取数口径。
 */
import type { AliceV4Host, ExpressionHost } from '@kimposoft/expression-editor';
import type {
  ActionConfigSurfaceMount,
  ActionConfigSurfaceRequest,
  ActionDefinition,
  ActionDesignerScope,
  AppCatalogEntry,
  EditorCapabilities,
  EditorActionDocument,
  HostApiResult,
  JobActionDocumentWire,
  SheetCatalogEntry,
  SheetThumbnailRenderer,
  StagingSchemaColumn,
  TemplateBrief,
  TemplateDataTable,
  TemplateField,
  WorkflowStepCatalogDefinition
} from './hostTypes';

export interface ActionDesignerHostApi {
  /** 打开动作行为文档（对应 fetchOpenActionDocument(scope)）。 */
  openActionDocument(scope: ActionDesignerScope): Promise<HostApiResult<EditorActionDocument>>;
  /** 保存动作行为文档（对应 fetchSaveActionDocument(scope, body)）。 */
  saveActionDocument(
    scope: ActionDesignerScope,
    body: { actions: unknown; expectedVersionNo: number }
  ): Promise<HostApiResult<EditorActionDocument>>;

  /**
   * 打开任务级动作行为文档（job 模式专用；对应 GET
   * /api/v1/apps/{appId}/jobs/{id}/action-document）。从未保存过时后端返回空文档语义
   * （version_no=0、actions=null），非 HTTP 错误——与 openActionDocument 的空文档语义一致。
   */
  openJobActionDocument(appId: string, jobId: string): Promise<HostApiResult<JobActionDocumentWire>>;
  /** 保存任务级动作行为文档（job 模式专用；对应 PUT
   *  /api/v1/apps/{appId}/jobs/{id}/action-document，乐观锁语义同 saveActionDocument）。 */
  saveJobActionDocument(
    appId: string,
    jobId: string,
    body: { actions: unknown; expectedVersionNo: number }
  ): Promise<HostApiResult<JobActionDocumentWire>>;

  /** 模板数据表目录。 */
  listTemplateTables(appId: string, templateId: string, versionNo?: string): Promise<HostApiResult<{ items: TemplateDataTable[] }>>;
  /** 数据表字段目录；
   *  versionNo 必须显式传参（可为 undefined），dataTableId 恒必填。 */
  listTemplateFields(
    appId: string,
    templateId: string,
    versionNo: string | undefined,
    dataTableId: string
  ): Promise<HostApiResult<{ items: TemplateField[] }>>;

  /**
   * 动作注册中心扁平清单。
   * `ready`（按容错读取）：false 表示注册中心为空/未就绪（如插件系统
   * 尚在启动），供 useActionDesigner.loadRegistry 三分状态（成功/失败/未就绪）；宿主旧版本响应
   * 缺省该字段时按 true（就绪）向后兼容处理，不影响既有行为。
   */
  listActionRegistry(): Promise<HostApiResult<{ actions: ActionDefinition[]; ready?: boolean }>>;

  /**
   * 载体插件声明支持的触发事件原始清单（按 pluginId 命中的插件 manifest
   * capabilities.runtimeActionCapabilities.supportedTriggers）。
   * 返回 null 表示未命中插件/未声明/拉取失败——调用方按全量 7 锚点回退，不在本方法内求交集
   * （交集运算需要插件侧 ACTION_TRIGGER_EVENT_KEYS 常量，留在 useActionDesigner.ts）。
   */
  getSupportedTriggers(pluginId: string): Promise<string[] | null>;

  /**
   * 创建表达式编辑器宿主适配器（appId 已在宿主侧构造 hostApi 时闭包绑定，此处只需按当前节点传入
   * getStagingSchema）。NodeConfigDialog 按当前编辑节点的
   * stagingSource.columns 现场构造 getStagingSchema 闭包并调用本工厂，产出的实例既用于
   * provideExpressionHost 注入子树，也供「测试」按钮的 compilePreview 复用
   * （同一节点、同一份 staging_schema 语义）——不是跨节点共享的单例。
   * getStagingSchema 缺省（undefined）时退化为无暂存场景，第三参恒 undefined，零行为回归。
   *
   * 🔴 跨应用/视图来源透传说明：返回类型 ExpressionHost 是共享包声明的完整接口（含可选
   * listApps/listViews/getViewSchema 三方法），本方法原样返回宿主产出的整个对象——不逐字段挑选转发——故
   * 宿主侧实现这三个方法后，取数节点①来源面板与条件节点判断表达式编辑器（均经本方法拿到宿主）
   * 就能直接用上，无需改动本接口签名。
   */
  createExpressionHost(getStagingSchema?: () => StagingSchemaColumn[] | undefined): ExpressionHost;

  /**
   * 应用目录（可选）：与 ExpressionHost.listApps 同一份数据来源，但作为
   * hostApi 顶层方法单独暴露——供画布节点「指向详情」Popover（NodeDetailPopover.vue，经
   * useActionDesigner.ts 的 appName 解析口）在**未打开**取数/条件编辑器时也能把跨应用来源的
   * app_id 解析成可读应用名，展示「应用名 › 名称」（labels.ts crossAppPrefix）。
   * 旧宿主（未提供）时 useActionDesigner 判空降级——appName 解析口对任何 appId 恒回退原样，
   * 跨应用来源摘要不产出前缀（不阻断，仅少一层可读性）。
   */
  listApps?(): Promise<HostApiResult<{ items: AppCatalogEntry[] }>>;

  /**
   * 创建 V4 生产桥：条件节点的判断表达式
   * 编辑器直接开在设计器壳里（不经 action-config surface，那条路上的 V4 桥只挂进 surface 的
   * hostBridge，条件节点够不着），故在 hostApi 上单独开这个工厂。
   *
   * scope 由调用方按**当前模板**现场传入（与 createActionConfigSurface 同一取值范式）；
   * templateVersionNo 缺省由宿主回落其构造期闭包绑定值。
   *
   * **可选**是刻意的：旧宿主不提供本方法，调用方须以可选链短路并降级为
   * 「宿主未提供条件编辑能力」提示（actionDesigner.dialog.conditionHostUnavailable）——条件
   * 摘要与旧格式提示照常渲染，只是「编辑条件」入口不可用，绝不因缺桥而抛错崩掉整个设计器。
   * job 模式（无模板，templateId 为空串）下条件分支整体不可用，调用方不应调用本方法。
   */
  createAliceV4Host?(scope: { appId: string; templateId: string; templateVersionNo?: string }): AliceV4Host;

  /**
   * 加载/挂载 action-config surface（NodeConfigDialog 引导式区域的插件化渲染）。
   * 返回 null 表示无匹配插件面板/加载失败——调用方静默回退框架自带 ExpressionEditor（现状语义）。
   */
  createActionConfigSurface(req: ActionConfigSurfaceRequest): Promise<ActionConfigSurfaceMount | null>;

  // ── 选择器、缩略图、窗口尺寸记忆等辅助能力 ─────────────────
  /** 应用下模板简要目录，LinkedFormPanel 目标模板选择器用。 */
  listAppTemplates(appId: string, keyword?: string): Promise<HostApiResult<{ items: TemplateBrief[] }>>;
  /** Sheet 目录，sheet-switch/sheet-print 选择器用。 */
  listSheetCatalog(appId: string, templateId: string): Promise<HostApiResult<{ sheets: SheetCatalogEntry[] }>>;
  /**
   * 解析出一个绑定了设计文件 + 表格编辑器 bundle 的按 sheetId 缩略图渲染函数；返回 null 表示当前
   * scope/目录为空、或命中的 sheet 插件 bundle 未提供缩略图渲染导出（feature-detect 未命中）。
   */
  createSheetThumbnailRenderer(scope: {
    appId: string;
    templateId: string;
    templateVersionNo: string;
    pluginId?: string;
  }): Promise<SheetThumbnailRenderer | null>;

  /**
   * 模板绑定编辑器的能力视图（可选）：设计器按它把需要编辑器档案的节点（切换 Sheet /
   * 打印 / 填充到图表等）置灰并在保存前点名。返回 null 表示读不到（按「不支持任何档案」降级）；旧宿主未提供本方法时
   * 设计器不裁剪。
   */
  getEditorCapabilities?(scope: { appId: string; templateId: string }): Promise<EditorCapabilities | null>;

  /** 动作设计器弹窗尺寸记忆（按当前登录用户分桶）：无登录用户/未记忆过时返回 null。 */
  loadWindowSize(): { width?: number; height?: number; wr?: number; hr?: number } | null;
  /** 保存动作设计器弹窗尺寸（按当前登录用户分桶）；无登录用户时静默忽略。 */
  saveWindowSize(size: { width: number; height: number; wr?: number; hr?: number }): void;

  /**
   * 本模板绑定的流程定义 + 各自最新版本的步骤节点目录（触发根「流程步骤门」用）。
   * 两处消费方各自独立取数、不互相依赖：NodeConfigDialog 打开触发根弹窗时直接调用本方法取一次
   * （同 listSheetCatalog 范式）；useActionDesigner.ensureWorkflowStepCatalog 供画布触发根徽标失效
   * 判定惰性共享一份（同一份数据、两条独立请求路径，任一份先到都不阻塞另一份）。
   * data 缺失/调用失败均视为「加载失败」——调用方按 gate.loadFailed 提示，且区内已有门条目只保留
   * 移除操作（既有步骤在「查不到定义」的失效口径下天然只给移除，无需额外分支）。
   */
  listTemplateWorkflows(appId: string, templateId: string): Promise<HostApiResult<{ definitions: WorkflowStepCatalogDefinition[] }>>;
}
