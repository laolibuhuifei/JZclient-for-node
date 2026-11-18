import React, { useEffect, useState } from 'react';
import { UserRound } from 'lucide-react';
import { api } from '../lib/api';
import { safeUrl } from '../lib/utils';

/** Uses the existing, authenticated avatar endpoint, also supported by older servers. */
export default function WatchAvatar({ watchId, chatKey, name = '手表', className = '', url }: { watchId?: string; chatKey?: string; name?: string; className?: string; url?: string }) {
  const [loaded, setLoaded] = useState<{ id: string; url: string } | null>(null);
  const [failed, setFailed] = useState('');
  const identity = watchId ? `watch:${watchId}` : chatKey ? `chat:${chatKey}` : '';
  const providedUrl = safeUrl(url);
  useEffect(() => {
    if (!identity || providedUrl) return;
    const controller = new AbortController();
    const endpoint = watchId ? `/api/watch/${encodeURIComponent(watchId)}/avatar` : `/api/chats/avatar?key=${encodeURIComponent(chatKey || '')}`;
    api(endpoint, { signal: controller.signal })
      .then(data => { if (!controller.signal.aborted) setLoaded({ id: identity, url: safeUrl(data?.url) }); })
      .catch(() => {});
    return () => controller.abort();
  }, [watchId, chatKey, identity, providedUrl]);
  const source = providedUrl || (loaded && loaded.id === identity ? loaded.url : '');
  return <span className={`watch-avatar ${className}`}>
    {source && failed !== source ? <img src={source} alt={`${name}的头像`} loading="lazy" onError={() => setFailed(source)} /> : <UserRound size={26} aria-hidden="true" />}
  </span>;
}
