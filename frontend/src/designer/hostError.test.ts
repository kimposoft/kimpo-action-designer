/** 宿主保存错误归一（新宿主 HostApiError / 旧宿主请求库错误对象两种形状）。 */
import { describe, expect, it } from 'vitest';
import { readHostError } from './hostError';

describe('readHostError', () => {
  it('新宿主归一后的 HostApiError：取 code / message / params.node_id', () => {
    expect(
      readHostError({
        code: 'DATA_ACTION_KIND_UNRESOLVED',
        message: '动作节点 关闭订单 引用的数据动作未被声明',
        params: { node_id: 'n_1', node: '关闭订单', action: 'org.example.x.close' }
      })
    ).toEqual({ code: 'DATA_ACTION_KIND_UNRESOLVED', message: '动作节点 关闭订单 引用的数据动作未被声明', nodeId: 'n_1' });
  });

  it('旧宿主透传请求库错误：优先 response.data.error 信封，不展示传输层文案', () => {
    const err = {
      message: 'Request failed with status code 400',
      response: { data: { error: { code: 'DATA_ACTION_KIND_UNRESOLVED', message: 'Node X: unresolved', params: { node_id: 'n_2' } } } }
    };
    expect(readHostError(err)).toEqual({ code: 'DATA_ACTION_KIND_UNRESOLVED', message: 'Node X: unresolved', nodeId: 'n_2' });
  });

  it('无错误 / 无参数时安全返回', () => {
    expect(readHostError(undefined)).toEqual({});
    expect(readHostError({ message: 'Network Error' })).toEqual({ code: undefined, message: 'Network Error', nodeId: undefined });
  });
});
