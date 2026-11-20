const DEFAULT_BASE_URL = 'http://127.0.0.1:38787';

export class WechatBridgeError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = 'WechatBridgeError';
    this.code = code;
    this.status = options.status || 0;
    this.wechatErrorCode = options.wechatErrorCode;
  }
}

function randomState() {
  if (!globalThis.crypto?.getRandomValues) {
    throw new WechatBridgeError('secure_random_unavailable', '当前浏览器无法生成安全随机数。');
  }
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '');
}

async function request(baseUrl, path, options = {}) {
  let response;
  try {
    response = await fetch(baseUrl + path, {
      mode: 'cors',
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      ...options,
      headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    });
  } catch (cause) {
    if (options.signal?.aborted) throw cause;
    throw new WechatBridgeError(
      'bridge_unavailable',
      '无法连接手机上的微信授权桥。请确认模块已启用，小天才家长端已打开。',
      { cause },
    );
  }
  let body;
  try { body = await response.json(); }
  catch (cause) {
    throw new WechatBridgeError('invalid_bridge_response', '授权桥返回了无法识别的响应。', {
      cause, status: response.status,
    });
  }
  if (!response.ok) {
    throw new WechatBridgeError(body?.error?.code || 'bridge_http_error',
      body?.error?.message || `授权桥请求失败（HTTP ${response.status}）。`,
      { status: response.status });
  }
  return body;
}

export async function getWechatBridgeStatus({ baseUrl = DEFAULT_BASE_URL, signal } = {}) {
  return request(baseUrl, '/v1/status', { signal });
}

function delay(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

const HANDOFF_QUERY = new URLSearchParams(globalThis.location?.search || '');
const RESUME_ONLY = HANDOFF_QUERY.has('state');

/** Starts a real WeChat login through JzLoginBridge and com.xtc.watch. */
export async function requestWechatAuthorization({
  baseUrl = DEFAULT_BASE_URL,
  signal,
  onStatus,
  pollIntervalMs = 800,
  timeoutMs = 125_000,
} = {}) {
  const resumedState = HANDOFF_QUERY.get('state');
  const state = resumedState && /^[A-Za-z0-9_-]{16,128}$/.test(resumedState)
    ? resumedState
    : randomState();
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', abort, { once: true });
  let timedOut = false;
  let created = false;
  let terminal = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);

  const notify = snapshot => {
    if (snapshot.state !== state) {
      throw new WechatBridgeError('state_mismatch', '授权桥返回的 state 不匹配。');
    }
    onStatus?.(snapshot);
    if (snapshot.status === 'error') {
      terminal = true;
      throw new WechatBridgeError(snapshot.error?.code || 'authorization_failed',
        snapshot.error?.message || '微信授权失败。',
        { wechatErrorCode: snapshot.wechatErrorCode });
    }
    return snapshot;
  };

  try {
    await getWechatBridgeStatus({ baseUrl, signal: controller.signal });
    const initial = resumedState
      ? await request(baseUrl, `/v1/authorizations/${state}`, { signal: controller.signal })
      : await request(baseUrl, '/v1/authorizations', {
          method: 'POST',
          body: JSON.stringify({ state }),
          signal: controller.signal,
        });
    created = !resumedState;
    notify(initial);
    if (!resumedState) {
      const handoff = new URLSearchParams({ state });
      globalThis.location?.assign(
        `jzloginbridge://authorize?${handoff}`);
    }

    while (true) {
      await delay(pollIntervalMs, controller.signal);
      const snapshot = notify(await request(baseUrl, `/v1/authorizations/${state}`, {
        signal: controller.signal,
      }));
      if (snapshot.status === 'authorized') {
        terminal = true;
        if (!snapshot.session) {
          throw new WechatBridgeError('missing_session', '小天才登录成功，但响应中没有账号会话。');
        }
        return { session: snapshot.session, state };
      }
    }
  } catch (error) {
    if (timedOut) {
      throw new WechatBridgeError('authorization_timeout', '等待微信授权超时，请重新发起。', { cause: error });
    }
    if (signal?.aborted) {
      throw new WechatBridgeError('aborted', '已取消微信授权。', { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    if (created && !terminal) {
      // Use a fresh request because the polling controller may be aborted.
      fetch(`${baseUrl}/v1/authorizations/${state}`, {
        method: 'DELETE', mode: 'cors', credentials: 'omit', cache: 'no-store',
      }).catch(() => {});
    }
  }
}
