export type ApiOptions = Omit<RequestInit, 'body'> & { body?: any; timeoutMs?: number; timeout?: number };

export class ApiError extends Error {
  status: number;
  data: any;
  constructor(message: string, status = 0, data?: any) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.data = data;
  }
}

export async function api<T = any>(url: string, options: ApiOptions = {}): Promise<T> {
  const { timeoutMs = options.timeout ?? 30000, timeout, body, signal, ...rest } = options;
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  const timer = timeoutMs > 0 ? setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs) : null;
  const headers = new Headers(options.headers);
  let payload = body;
  if (body != null && typeof body === 'object' && !(body instanceof Blob) && !(body instanceof FormData)
      && !(body instanceof URLSearchParams) && !(body instanceof ArrayBuffer) && !ArrayBuffer.isView(body)) {
    headers.set('Content-Type', 'application/json');
    payload = JSON.stringify(body);
  }
  try {
    const response = await fetch(url, { ...rest, headers, body: payload, credentials: 'same-origin', signal: controller.signal });
    let result: any;
    try { result = await response.json(); }
    catch { throw new ApiError(`服务器返回了无效响应（${response.status}）`, response.status); }
    if (response.status === 401 || result?.unauthorized) {
      window.dispatchEvent(new CustomEvent('jz:unauthorized'));
      throw new ApiError('访问令牌已失效，请重新验证', 401, result);
    }
    const expired = result?.parentSessionExpired || result?.data?.sessionExpired || result?.data?.account?.sessionExpired;
    if (expired) {
      window.dispatchEvent(new CustomEvent('jz:parent-session-expired'));
      if (result?.ok === false) throw new ApiError('家长账号登录已失效，请重新登录', response.status, result);
    }
    if (!response.ok || result?.ok === false) {
      throw new ApiError(result?.error || result?.message || `请求失败（${response.status}）`, response.status, result);
    }
    return Object.prototype.hasOwnProperty.call(result || {}, 'data') ? result.data : result;
  } catch (error) {
    if (timedOut) throw new ApiError(`请求超时（${Math.round(timeoutMs / 1000)} 秒），请重试`);
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

export const post = <T = any>(url: string, body: any = {}, options: ApiOptions = {}) =>
  api<T>(url, { ...options, method: 'POST', body });
