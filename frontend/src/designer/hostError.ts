/**
 * 宿主错误归一：把 hostApi 返回的 error 读成 { code, message, nodeId }。
 *
 * 链路：插件 kimpo-action-designer · 设计层（动作文档保存失败展示）。新宿主在 hostApi 实现
 * 里已把错误归一成 HostApiError（code / 后端按请求语言渲染的 message / params）；旧宿主直接透传
 * 请求库的错误对象，后端信封在 response.data.error 里——这里两种形状都认，优先后端信封，
 * 避免把「Request failed with status code 400」这类传输层文案展示给设计者。
 */
export interface NormalizedHostError {
  code?: string;
  message?: string;
  /** 后端错误参数里的出错节点 ID（保存闸类错误，如 DATA_ACTION_KIND_UNRESOLVED）。 */
  nodeId?: string;
}

interface ErrorEnvelopeLike {
  code?: unknown;
  message?: unknown;
  params?: unknown;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function nodeIdOf(params: unknown): string | undefined {
  return params && typeof params === 'object' ? str((params as Record<string, unknown>).node_id) : undefined;
}

/** 读宿主错误；无错误时返回空对象。 */
export function readHostError(error: unknown): NormalizedHostError {
  if (!error || typeof error !== 'object') return {};
  const envelope = (error as { response?: { data?: { error?: ErrorEnvelopeLike } } }).response?.data?.error;
  if (envelope && typeof envelope === 'object') {
    return { code: str(envelope.code), message: str(envelope.message), nodeId: nodeIdOf(envelope.params) };
  }
  const flat = error as ErrorEnvelopeLike;
  return { code: str(flat.code), message: str(flat.message), nodeId: nodeIdOf(flat.params) };
}
