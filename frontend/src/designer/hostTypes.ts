/**
 * hostTypes.ts —— 与宿主 wire 结构等价的本地类型声明。
 *
 * 本文件不 import 任何宿主代码——字段名与宿主 wire 保持一致，供 hostApi.ts 的接口签名与各组件消费。
 * 若宿主端对应类型加字段，本文件需同步（无自动化守护，人工核对）。
 */

// ── 通用响应信封（对齐宿主 request() 的 { data, error } flat 响应形状） ──────────────
export interface HostApiError {
  code?: string;
  message: string;
  /**
   * 后端错误信封的附加参数：保存闸类错误带 `node_id`（出错节点）等，
   * 设计器据此定位节点。可选：旧宿主不透出时为空，调用方按无参数处理。
   */
  params?: Record<string, unknown>;
}
export interface HostApiResult<T> {
  data?: T;
  error?: HostApiError;
}

// ── 多语言文本 ──────────────────────────────
export type LocalizedText = string | Record<string, string>;

// ── 动作注册中心 ──────────────────────────────────
export interface ActionCapabilities {
  asyncable: boolean;
  side_effecting: boolean;
  expression_based: boolean;
  /**
   * 该动作是否支持在定时任务（无表单/无请求上下文）里执行，供 ActionPanel 的
   * job 模式声明位过滤（contextFilter==='scheduled'）与后端 scheduled 事件派发前门控共用同一份
   * 声明。可选（而非与后端 wire 逐字段对齐设为必填）：本插件仓大量既有测试夹具手搭
   * ActionCapabilities 字面量，未逐一补齐该字段——按 `capabilities?.scheduled_context===true`
   * 判定，缺省即视为「不支持」，语义与后端一致，不需要动那些夹具。
   */
  scheduled_context?: boolean;
}

export interface ActionStyle {
  shape?: string;
  color?: string;
  icon?: string;
}

/** 注册中心动作定义（对齐后端 pipeline.ActionDefinition，GET /action-registry/actions 返回项）。 */
export interface ActionDefinition {
  name: string;
  title: LocalizedText;
  description?: LocalizedText;
  /** 'builtin' | 'plugin' */
  source: string;
  plugin_id?: string;
  instance_id?: string;
  capabilities: ActionCapabilities;
  params_schema?: Record<string, unknown>;
  style?: ActionStyle;
  sort_weight?: number;
  category?: string;
  /**
   * 数据动作的标准操作种类：`fetch` / `create` /
   * `update` / `delete`，由宿主按插件 manifest `capabilities.data_actions`（官方名走内置兼容表）解析后
   * 随动作目录下发；非数据动作省略。设计器按它识别取数 / 写节点，不再按官方动作名硬判。
   */
  operation_kind?: string;
  /**
   * 该动作运行期产出的界面命令：宿主登记期由插件 params_schema 顶层
   * x-editor-commands 注解（标准界面动作由宿主 canonical 表兜底）得出。设计器据此按模板绑定编辑器档案过滤节点；
   * 旧宿主不下发时视为无界面命令（不裁剪）。
   */
  editor_commands?: string[];
}

/**
 * 模板绑定编辑器的能力视图：profiles = 模板回包 editor_profiles[]；
 * commands = 编辑器静态 capabilities.editor.commands（取不到为 null，只按档案判）。
 */
export interface EditorCapabilities {
  pluginId: string;
  designerType: string;
  profiles: string[];
  commands: string[] | null;
}

// ── 模板数据表/字段 ──────────────────────────────
export interface TemplateDataTable {
  data_table_id: string;
  table_code: string;
  table_name: string;
  physical_table_name: string;
  table_role?: string;
  extension_mode?: string;
  sort_no: number;
  field_count: number;
  version_no: number;
}

export interface TemplateField {
  field_id: string;
  field_code: string;
  field_name: string;
  data_type: string;
  control_type?: string;
  display_style: string;
  sort_no: number;
  sort_mode?: string;
  is_searchable: boolean;
  is_filterable: boolean;
  is_sortable: boolean;
  is_list_visible: boolean;
  is_visible?: boolean;
  format_rule_json?: Record<string, unknown> | string | null;
  option_source_json?: Record<string, unknown> | string | null;
}

/**
 * 触发字段按数据表分组的候选（值变动/点击触发字段下拉按数据表分组、只显示表名
 * 与字段名）。TemplateField 本身不带 data_table_id，归组只能在 useActionDesigner 拍平之前按
 * fieldsByTable 的键完成（见 useActionDesigner.fieldGroups）。
 */
export interface TemplateFieldGroup {
  table: TemplateDataTable;
  fields: TemplateField[];
}

/** Sheet 目录条目。 */
export interface SheetCatalogEntry {
  id: string;
  name: string;
  index: number;
  visible: boolean;
  printable: boolean;
  /** 打印区域原文（如 "A1:L30"，未设置为空串）；打印单据选择器按其非空判可选。旧插件二进制不产，缺失视为未设置。 */
  print_area?: string;
  region_role?: 'standalone' | 'primary' | 'stacked' | 'tab-member';
  /** 恒 true 且选择器不读它（旧二进制的 false 是旧口径，读了会锁死分区成员）。 */
  switchable?: boolean;
  /** 分区（表格分区）上下文：容器=页签栏一个页签；container_index=-1 表示无分区布局。 */
  container_id?: string;
  container_index?: number;
  /** 页签名 = 容器代表叶名（代表叶隐藏时顺延首个可见成员）。 */
  container_label?: string;
  region_index?: number;
  region_count?: number;
  region_kind?: 'leaf' | 'tabs';
  /** 页签组内序号（0 基，leaf 为 -1）与成员数（leaf 为 0）。 */
  tab_index?: number;
  tab_count?: number;
}

/**
 * 流程步骤目录条目（触发根「流程步骤门」用）：本模板绑定的一个流程定义 + 其最新版本的
 * 步骤节点清单。供 NodeConfigDialog 触发根门控弹窗（经 hostApi.listTemplateWorkflows 直取一次）与
 * 画布触发根徽标失效判定（经 useActionDesigner.ensureWorkflowStepCatalog 惰性共享一份）共用同一形状。
 */
export interface WorkflowStepCatalogStep {
  node_id: string;
  node_kind: 'START' | 'HANDLE' | 'APPROVE' | 'SUBFLOW';
  node_name: string;
}
export interface WorkflowStepCatalogDefinition {
  definition_id: string;
  name: string;
  status: 'enabled' | 'disabled';
  /** 最新版本号；0 表示尚无已发布版本（该定义整卡不可选，见 gate.unpublished）。 */
  latest_version_no: number;
  steps: WorkflowStepCatalogStep[];
}

/** 应用下模板简要信息（联动表单目标模板选择器用）。 */
export interface TemplateBrief {
  template_id: string;
  template_name: string;
  folder_node_path?: string;
  template_code?: string;
}

/**
 * 应用目录条目（跨应用来源）：对齐 @kimposoft/expression-editor 的
 * AppCatalogEntry（该包 index.ts 未导出此类型，本文件按结构类型独立镜像一份，供
 * ActionDesignerHostApi.listApps 的响应形状使用）。is_current=true 标注当前设计所在应用。
 */
export interface AppCatalogEntry {
  app_id: string;
  app_name: string;
  is_current?: boolean;
}

// ── 动作行为文档作用域/信封 ──────
/**
 * 动作设计器作用域：结构上是宿主 EditorDesignDocumentScope 的子集（本插件只消费
 * appId/templateId/templateVersionNo/pluginId/pluginInstanceId，designerType 透传即可，
 * 不参与本插件任何分支逻辑）。挂载方（DesignerRoot 消费者）按此形状注入。
 */
export interface ActionDesignerScope {
  appId: string;
  templateId: string;
  templateVersionNo: string;
  /** 透传字段，本插件不解读；宿主侧调用设计数据接口时按需回填/校验。 */
  designerType?: string;
  pluginId?: string;
  pluginInstanceId?: string;
}

/** 动作行为文档信封（对齐 EditorActionDocument）。actions 为完整行为文档或 null/undefined。 */
export interface EditorActionDocument {
  template_id: string;
  template_version_no: string;
  actions: unknown;
  checksum?: string;
  content_revision: number;
  version_no: number;
  unauthorized_source_apps?: string[];
}

/**
 * 任务级动作文档信封（job 模式专用；对齐宿主后端任务动作文档接口
 * GET/PUT /api/v1/apps/{appId}/jobs/{id}/action-document 的响应体）。
 * 与 EditorActionDocument 并列但不同源——任务定义按 job_definition_id 唯一持有一份，不挂
 * template_id/template_version_no，也不带 unauthorized_source_apps（任务文档保存期虽仍校验
 * 来源应用设计权，但接口未回传清单，故插件侧对 job 文档恒不展示"跨应用只读"横幅，见
 * useActionDesigner.ts 的 job 分支）。
 */
export interface JobActionDocumentWire {
  job_definition_id: string;
  actions: unknown;
  checksum?: string;
  content_revision: number;
  version_no: number;
}

/**
 * 动作设计器目标判别联合：'template' 模式沿用既有模板设计态作用域；
 * 'job' 模式指向定时任务自身持有的动作文档（无模板/字段目录，固定单一 scheduled 事件）。
 * kind 缺省（undefined）按 'template' 处理——保持既有调用方只传 { scope } 的形态兼容，
 * 不强制其显式补 kind 字段。
 */
export type ActionDesignerTarget =
  | { kind?: 'template'; scope: ActionDesignerScope }
  | { kind: 'job'; appId: string; jobId: string; jobName?: string };

// ── 表达式暂存 schema ──────────
export interface StagingSchemaColumn {
  name: string;
  field_id: string;
  kind: string;
}

// ── action-config surface 挂载请求/结果 ──
export interface ActionConfigSurfaceRequest {
  /** 待挂载的动作名（surface bind 标识，如 "data.extract"）。 */
  actionName: string;
  appId: string;
  templateId: string;
  /** 暂存 schema getter：与 provideExpressionHost 注入的闭包同语义，
   *  供宿主构造 domain:expression bridge 时透传第三参。 */
  getStagingSchema?: () => StagingSchemaColumn[] | undefined;
  /**
   * 数据动作种类：宿主按 `bind == actionName` 找不到面板时，
   * 回落到官方保留命名空间插件声明的 `bind == "operation_kind:<kind>"` 标准面板。非数据动作省略；
   * 旧宿主忽略本字段。
   */
  operationKind?: string;
}

export interface ActionConfigSurfaceMount {
  /** 已挂载的 surface 组件（插件侧负责 markRaw 后渲染）。 */
  component: unknown;
  /** 初始 props（现状消费方改用响应式 :input 范式，本字段仅对齐 SurfaceMountResult 形状保留）。 */
  props?: Record<string, unknown>;
  /**
   * 供插件侧构造响应式 `actionConfigSurfaceInput.hostBridge` 复用的桥对象（宿主已装配好
   * 'domain:expression' + 'i18n' 两键，插件侧原样展开、按需追加自己的 'log' 键）。
   */
  bridge: Record<string, unknown>;
}

// ── Sheet 缩略图渲染 ──────────────────────────
export type SheetThumbnailRenderer = (
  sheetId: string,
  opts: { width: number; height: number; dpr?: number }
) => Promise<string | null>;
