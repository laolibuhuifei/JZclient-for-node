const DEFAULT_BASE_URL = 'http://127.0.0.1:38787';
const PENDING_AUTHORIZATION_KEY = 'jz_wechat_authorization';
const PENDING_AUTHORIZATION_TTL_MS = 115_000;
const HOST_READY_TIMEOUT_MS = 25_000;

export class WechatBridgeError extends Error {
  code: string;
  status: number;
  wechatErrorCode?: number;
  constructor(code: string, message: string, options: { status?: number; wechatErrorCode?: number; cause?: unknown } = {}) {
    super(message);
    this.name = 'WechatBridgeError';
    this.code = code;
    this.status = options.status || 0;
    this.wechatErrorCode = options.wechatErrorCode;
    if (options.cause !== undefined) (this as Error & { cause?: unknown }).cause = options.cause;
  }
}

function randomState() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = '';
  bytes.forEach(byte => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export type WechatAuthorizationStatus = 'waiting_for_host' | 'awaiting_confirmation' | 'launching_wechat' | 'waiting_for_wechat' | 'logging_in' | 'authorized' | 'authorizing' | 'error';

type PendingAuthorization = {
  state: string;
  status: WechatAuthorizationStatus;
  expiresAt: number;
  handoffStarted?: boolean;
};

function readPendingAuthorization(): PendingAuthorization | null {
  try {
    const stored = sessionStorage.getItem(PENDING_AUTHORIZATION_KEY);
    if (!stored) return null;
    const pending = JSON.parse(stored) as PendingAuthorization;
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(pending.state || '')
        || !Number.isFinite(pending.expiresAt)
        || pending.expiresAt <= Date.now()) {
      sessionStorage.removeItem(PENDING_AUTHORIZATION_KEY);
      return null;
    }
    return pending;
  } catch {
    return null;
  }
}

function savePendingAuthorization(pending: PendingAuthorization | null) {
  try {
    if (pending) sessionStorage.setItem(PENDING_AUTHORIZATION_KEY, JSON.stringify(pending));
    else sessionStorage.removeItem(PENDING_AUTHORIZATION_KEY);
  } catch { /* Storage is an optimization; the in-memory request still works. */ }
}

async function bridgeRequest(path: string, options: RequestInit = {}, validateBody = true) {
  let response: Response;
  try {
    response = await fetch(DEFAULT_BASE_URL + path, {
      mode: 'cors', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer',
      ...options,
      headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    });
  } catch (cause) {
    if (options.signal?.aborted) throw cause;
    throw new WechatBridgeError('bridge_unavailable', '无法连接手机上的微信授权组件。请确认模块已启用，并重新打开小天才家长端。', { cause });
  }
  let body: any;
  try { body = validateBody ? await response.json() : null; }
  catch (cause) { throw new WechatBridgeError('invalid_bridge_response', '微信授权组件返回了无法识别的响应。', { status: response.status, cause }); }
  if (!response.ok) {
    throw new WechatBridgeError(body?.error?.code || 'bridge_http_error', body?.error?.message || `微信授权组件请求失败（HTTP ${response.status}）。`, { status: response.status });
  }
  return body;
}

export async function getWechatBridgeStatus(signal?: AbortSignal) {
  return bridgeRequest('/v1/status', { signal }, false);
}

function delay(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, milliseconds);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function retryBridgeRequest<T>(
  request: () => Promise<T>,
  signal: AbortSignal,
  timeoutMs = 8_000,
) {
  let lastError: unknown;
  const startedAt = Date.now();
  let attempt = 0;
  while (true) {
    attempt++;
    try {
      return await request();
    } catch (error) {
      lastError = error;
      const retryable = error instanceof WechatBridgeError
        && ['bridge_unavailable', 'invalid_bridge_response'].includes(error.code);
      if (!retryable || Date.now() - startedAt >= timeoutMs) throw error;
      await delay(Math.min(1_000, 180 + attempt * 80), signal);
    }
  }
}

export function getPendingWechatAuthorization() {
  const pending = readPendingAuthorization();
  return pending ? { status: pending.status, expiresAt: pending.expiresAt } : null;
}

export async function requestWechatAuthorization({
  signal,
  onStatus,
  onBridgeReady,
  onOpenBridge,
  resumeOnly = false,
  timeoutMs = 125_000,
}: {
  signal?: AbortSignal;
  onStatus?: (status: WechatAuthorizationStatus) => void;
  onBridgeReady?: (state: string) => void;
  onOpenBridge?: (state: string) => void;
  resumeOnly?: boolean;
  timeoutMs?: number;
} = {}) {
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', abort, { once: true });
  let state = '';
  let created = false;
  let terminal = false;
  let timedOut = false;
  const pending = readPendingAuthorization();
  const deadlineMs = Math.max(5_000, Number(timeoutMs) || 125_000);
  let timer: ReturnType<typeof setTimeout> | null = null;
  // Android freezes background browser timers while the native host is in
  // front. Start the deadline after we resume instead of expiring unseen.
  const pauseDeadline = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  const startDeadline = () => {
    pauseDeadline();
    timer = setTimeout(() => { timedOut = true; controller.abort(); }, deadlineMs);
  };
  const visibilityChanged = () => {
    if (document.visibilityState === 'visible') {
      startDeadline();
    }
    else {
      pauseDeadline();
    }
  };

  if (!resumeOnly) {
    state = pending?.state || randomState();
    savePendingAuthorization({
      state,
      status: 'waiting_for_host',
      expiresAt: Date.now() + PENDING_AUTHORIZATION_TTL_MS,
      handoffStarted: true,
    });
    onStatus?.('waiting_for_host');
    onOpenBridge?.(state);
    // The web page owns the result. Background timer throttling is fine here
    // because the loop resumes as soon as the page receives focus again.
    onStatus?.('waiting_for_host');
  }
  try {
    document.addEventListener('visibilitychange', visibilityChanged);
    window.addEventListener('focus', visibilityChanged);
    window.addEventListener('pageshow', visibilityChanged);
    startDeadline();
    // The HTTP bridge exists inside the XTC process. On a cold launch that
    // process needs several seconds for Xposed injection and server startup.
    await retryBridgeRequest(
      () => getWechatBridgeStatus(controller.signal),
      controller.signal,
      HOST_READY_TIMEOUT_MS,
    );
    let snapshot: any;
    if (resumeOnly && pending) {
      state = pending.state;
    }
    if (!state && resumeOnly) {
      throw new WechatBridgeError(
        'authorization_not_pending',
        '没有待恢复的微信授权，请重新点击“使用微信登录”。',
      );
    }
    if (pending?.handoffStarted) {
      state = pending.state;
      try {
        snapshot = await bridgeRequest(`/v1/authorizations/${state}`, { signal: controller.signal });
      } catch (error) {
        if (!(error instanceof WechatBridgeError) || error.status !== 404) throw error;
      }
    }
    if (!snapshot && state && !created) {
      // The deep link has reached XTC and may have already started WeChat.
      // Give its loopback server a moment to register the transferred state
      // before falling back to a new browser-owned request.
      const handoffDeadline = Date.now() + 8_000;
      while (!snapshot && Date.now() < handoffDeadline) {
        await delay(300, controller.signal);
        try {
          snapshot = await bridgeRequest(`/v1/authorizations/${state}`, { signal: controller.signal });
        } catch (error) {
          if (!(error instanceof WechatBridgeError) || error.status !== 404) throw error;
        }
      }
    }
    if (!snapshot) {
      if (!state) state = randomState();
      snapshot = await retryBridgeRequest(
        () => bridgeRequest('/v1/authorizations', {
          method: 'POST', body: JSON.stringify({ state }), signal: controller.signal,
        }),
        controller.signal,
        8_000,
      );
      created = true;
      onBridgeReady?.(state);
    }
    savePendingAuthorization({
      state,
      status: snapshot.status,
      expiresAt: Number(snapshot.expiresAt) || Date.now() + PENDING_AUTHORIZATION_TTL_MS,
      handoffStarted: true,
    });
    onStatus?.(snapshot.status);
    while (true) {
      if (signal?.aborted) throw new WechatBridgeError('aborted', '已取消微信授权。');
      if (snapshot.status === 'error') {
        terminal = true;
        savePendingAuthorization(null);
        throw new WechatBridgeError(snapshot.error?.code || 'authorization_failed', snapshot.error?.message || '微信授权失败。', { wechatErrorCode: snapshot.wechatErrorCode });
      }
      if (snapshot.status === 'authorized') {
        terminal = true;
        savePendingAuthorization(null);
        if (!snapshot.session) throw new WechatBridgeError('missing_session', '小天才登录成功，但没有返回账号会话。');
        return { session: String(snapshot.session), state };
      }
      // Some Android browsers suspend background timers until the page is
      // visible again. Read once immediately after focus, before waiting.
      if (document.visibilityState === 'visible') {
        try {
          snapshot = await bridgeRequest(`/v1/authorizations/${state}`, { signal: controller.signal });
          if (snapshot.state !== state) throw new WechatBridgeError('state_mismatch', '微信授权返回的校验状态不一致，请重试。');
          onStatus?.(snapshot.status);
          continue;
        } catch (error) {
          if (!(error instanceof WechatBridgeError) || error.status !== 404) throw error;
        }
      }
      await delay(800, controller.signal);
      snapshot = await bridgeRequest(`/v1/authorizations/${state}`, { signal: controller.signal });
      if (snapshot.state !== state) throw new WechatBridgeError('state_mismatch', '微信授权返回的校验状态不一致，请重试。');
      onStatus?.(snapshot.status);
      savePendingAuthorization({
        state,
        status: snapshot.status,
        expiresAt: Date.now() + PENDING_AUTHORIZATION_TTL_MS,
        handoffStarted: true,
      });
    }
  } catch (error) {
    if (timedOut) throw new WechatBridgeError('authorization_timeout', '等待微信授权超时，请重新发起。', { cause: error });
    if (signal?.aborted) throw new WechatBridgeError('aborted', '已取消微信授权。', { cause: error });
    throw error;
  } finally {
    pauseDeadline();
    document.removeEventListener('visibilitychange', visibilityChanged);
    window.removeEventListener('focus', visibilityChanged);
    window.removeEventListener('pageshow', visibilityChanged);
    signal?.removeEventListener('abort', abort);
    if (created && !terminal) {
      savePendingAuthorization(null);
      fetch(`${DEFAULT_BASE_URL}/v1/authorizations/${state}`, { method: 'DELETE', mode: 'cors', credentials: 'omit', cache: 'no-store' }).catch(() => {});
    }
  }
}
