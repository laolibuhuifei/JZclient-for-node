import React, { useState } from 'react';
import { Send } from 'lucide-react';
import { Button } from '../ui';
import GuardPlacePicker, { type GuardPlace } from '../location/GuardPlacePicker';

/** Picking is local; only the explicit send button submits a chat message. */
export default function ChatLocationComposer({ busy, onSend, onClose }: {
  busy: boolean; onSend: (kind: string, extra: any) => Promise<boolean>; onClose: () => void;
}) {
  const [place, setPlace] = useState<GuardPlace | null>(null);
  return <form className="chat-location-composer stack" onSubmit={async event => {
    event.preventDefault();
    if (!place || busy) return;
    if (await onSend('location', { latitude: place.latitude, longitude: place.longitude, poi: place.address ? `${place.name} · ${place.address}` : place.name })) onClose();
  }}>
    <GuardPlacePicker purpose="message" value={place} onChange={setPlace} disabled={busy} />
    <div className="chat-composer-actions action-row"><Button variant="secondary" disabled={busy} onClick={onClose}>取消</Button><Button type="submit" disabled={busy || !place} loading={busy}><Send size={18} aria-hidden="true" />{busy ? '发送中…' : '发送位置'}</Button></div>
  </form>;
}
