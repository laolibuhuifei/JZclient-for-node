export function formatTimestamp(value: any) {
  if (value == null || value === '') return '—';
  const numeric = Number(value);
  const date = new Date(Number.isFinite(numeric) ? (numeric < 1e12 ? numeric * 1000 : numeric) : value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('zh-CN', { hour12: false });
}
export const fmtTime = formatTimestamp;
export const getErrorMessage = (error: any) => error?.message || String(error || '请求失败，请重试');
export const pickArray = (value: any, ...keys: string[]): any[] => {
  if (Array.isArray(value)) return value;
  for (const key of keys) if (Array.isArray(value?.[key])) return value[key];
  return [];
};
export function safeUrl(value: any, allowDataImage = false) {
  const text = String(value || '').trim();
  if (allowDataImage && /^data:image\/(png|jpe?g|gif|webp);base64,/i.test(text)) return text;
  if (/^(https?:|blob:)/i.test(text) || (text.startsWith('/') && !text.startsWith('//'))) return text;
  return '';
}
export async function copyText(value: any) {
  const text = String(value ?? '');
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
  const input = document.createElement('textarea');
  input.value = text; input.style.position = 'fixed'; input.style.opacity = '0';
  document.body.append(input); input.select();
  const copied = document.execCommand('copy'); input.remove();
  if (!copied) throw new Error('无法复制，请手动选择文本');
}
