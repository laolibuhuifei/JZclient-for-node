export type ChatTarget = { key: string; name: string; type: 'single' | 'group'; sub?: string; count?: number; watchId?: string; avatarUrl?: string };
export type ChatMessage = { self?: boolean; text?: string; kind?: string; url?: string; time?: string | number; id?: string | number };
export type KeyedMessage = { key: string; message: ChatMessage };
export type IMState = { connected?: boolean; alive?: boolean; lastError?: string; lastRecvAgo?: number | null };

function fingerprint(message: ChatMessage) {
  return JSON.stringify([message.id, !!message.self, message.time, message.kind, message.url, message.text]);
}

// The server keeps a sliding window without message IDs. Retain the existing React
// keys and object references for matching entries so polling never resets players.
export function reconcileMessages(previous: KeyedMessage[], incoming: ChatMessage[], allocateKey: () => string): KeyedMessage[] {
  const available = new Map<string, KeyedMessage[]>();
  for (const item of previous) {
    const identity = fingerprint(item.message);
    const queue = available.get(identity) || [];
    queue.push(item);
    available.set(identity, queue);
  }
  const next = incoming.map(message => {
    const existing = available.get(fingerprint(message))?.shift();
    return existing || { key: allocateKey(), message };
  });
  return next.length === previous.length && next.every((item, index) => item === previous[index]) ? previous : next;
}

export function imStateText(im?: IMState | null) {
  if (!im) return '正在获取连接状态';
  if (!im.connected) return `IM 未连接${im.lastError ? ` · ${im.lastError}` : ''}`;
  if (!im.alive) return 'IM 连接异常，正在重连…';
  if (im.lastRecvAgo == null) return 'IM 已连接 · 等待接收数据';
  if (im.lastRecvAgo <= 90) return `IM 已连接 · ${im.lastRecvAgo} 秒前收到数据`;
  return `IM 已连接 · ${Math.round(im.lastRecvAgo / 60)} 分钟前收到数据`;
}

export function safeMessageUrl(value?: string) {
  if (!value) return '';
  if (/^\/(?!\/)/.test(value)) return value;
  if (/^https?:\/\//i.test(value)) return value;
  return '';
}

export function formatMessageTime(value?: string | number) {
  if (value == null || value === '') return '';
  let time = Number(value);
  if (!Number.isFinite(time)) time = Date.parse(String(value));
  if (!time) return '';
  if (time < 1e12) time *= 1000;
  return new Date(time).toLocaleString('zh-CN', { hour12: false });
}

export function fileDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('读取文件失败'));
    reader.readAsDataURL(file);
  });
}

export async function resizeImage(file: File, maxSide: number, mime: string, quality?: number) {
  const source = await fileDataUrl(file);
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('这不是一张有效的图片'));
    img.src = source;
  });
  const scale = Math.min(1, maxSide / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('当前浏览器无法处理图片，请选择更小的文件');
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL(mime, quality);
}
