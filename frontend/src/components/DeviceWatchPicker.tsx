import React, { useEffect, useState } from 'react';
import { useApp } from '../context/AppContext';
import HomeWatchPicker from '../pages/HomeWatchPicker';
import HomeWatchInfoDialog from '../pages/HomeWatchInfoDialog';
import './device-watch-picker.css';

/** Two small watch cards beside the page title; a single card keeps its width. */
export default function DeviceWatchPicker() {
  const { watches, watchId, setWatchId, navigate, account, tokenInvalid } = useApp();
  const [infoId, setInfoId] = useState<string | null>(null);
  const loginReady = !!account?.loggedIn && !tokenInvalid;
  const available = loginReady ? watches.map(watch => ({
    ...watch,
    online: typeof watch.onlineStatus === 'boolean' ? watch.onlineStatus : null,
  })) : [];
  const infoWatch = available.find(watch => String(watch.watchId) === infoId);
  const infoAvailable = !!infoWatch;
  useEffect(() => { if (infoId && !infoAvailable) setInfoId(null); }, [infoId, infoAvailable]);

  if (!available.length) return null;
  return <div className="device-watch-picker" aria-label="选择手表">
    <HomeWatchPicker variant="title" watches={available} selectedId={watchId} onSelect={setWatchId} onInfo={setInfoId} />
    <HomeWatchInfoDialog watch={infoWatch} onClose={() => setInfoId(null)} onOpenDetails={() => {
      if (!infoWatch) return;
      setWatchId(String(infoWatch.watchId));
      setInfoId(null);
      navigate('overview');
    }} />
  </div>;
}
