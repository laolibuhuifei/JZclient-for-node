import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Check, MapPin, Search, X } from 'lucide-react';
import { api } from '../../lib/api';
import { Button, Field, Input } from '../ui';
import TileMap, { type MapCoordinates } from './TileMap';
import { readCoordinates } from './locationUtils';
import './guard-place-picker.css';

export type GuardPlace = MapCoordinates & { id?: string; name: string; address?: string };
type Props = { value: GuardPlace | null; onChange: (place: GuardPlace) => void; radius?: number; disabled: boolean; initialCenter?: MapCoordinates | null; purpose?: 'area' | 'message' };

const DEFAULT_CENTER = { latitude: 31.2304, longitude: 121.4737 };

export default function GuardPlacePicker({ value, onChange, radius, disabled, initialCenter, purpose = 'area' }: Props) {
  const [initial] = useState(() => initialCenter || DEFAULT_CENTER);
  const [query, setQuery] = useState('');
  const [places, setPlaces] = useState<GuardPlace[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [cancelled, setCancelled] = useState(false);
  const [viewCenter, setViewCenter] = useState(initial);
  const [recenter, setRecenter] = useState(0);
  const request = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const resultList = useRef<HTMLUListElement>(null);
  const queryHintId = useId();
  const searchErrorId = useId();
  const selectionLabel = purpose === 'message' ? '发送位置' : '区域中心';

  const cancelSearch = useCallback(() => {
    request.current++;
    controller.current?.abort();
    controller.current = null;
    setLoading(false);
  }, []);
  useEffect(() => () => { request.current++; controller.current?.abort(); }, []);
  useEffect(() => { if (disabled) cancelSearch(); }, [disabled, cancelSearch]);
  const updateView = useCallback((point: MapCoordinates) => setViewCenter(previous => previous.latitude === point.latitude && previous.longitude === point.longitude ? previous : point), []);

  async function search() {
    if (disabled) return;
    const keyword = query.trim();
    cancelSearch();
    setCancelled(false);
    setSearchError('');
    setPlaces([]);
    setSearched(false);
    if (Array.from(keyword).length < 2 || Array.from(keyword).length > 80) { setSearchError('请输入 2～80 个字的地点关键词。'); return; }
    const current = ++request.current;
    const ac = new AbortController();
    controller.current = ac;
    setLoading(true);
    try {
      const params = new URLSearchParams({ q: keyword, latitude: String(viewCenter.latitude), longitude: String(viewCenter.longitude) });
      const result = await api(`/api/map/search?${params}`, { signal: ac.signal, timeoutMs: 18000 });
      if (ac.signal.aborted || current !== request.current) return;
      const list = Array.isArray(result?.places) ? result.places : [];
      const valid: GuardPlace[] = [];
      for (const item of list.slice(0, 8)) {
        const point = readCoordinates(item);
        if (!point || item?.coordinateSystem !== 'gcj02') continue;
        valid.push({ ...point, id: String(item.id || `${point.latitude}/${point.longitude}`), name: String(item.name || '未命名地点'), address: String(item.address || '') });
      }
      setPlaces(valid);
      setSearched(true);
    } catch (failure) {
      if (!ac.signal.aborted && current === request.current) setSearchError(failure instanceof Error ? failure.message : '地点搜索失败，请重试。');
    } finally {
      if (current === request.current) { controller.current = null; setLoading(false); }
    }
  }

  function changeQuery(next: string) {
    cancelSearch();
    setQuery(next);
    setPlaces([]);
    setSearched(false);
    setSearchError('');
    setCancelled(false);
  }

  function pickPlace(place: GuardPlace) {
    if (disabled) return;
    onChange(place);
    setRecenter(previous => previous + 1);
  }

  function resultKeyboard(event: React.KeyboardEvent<HTMLUListElement>) {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const buttons = Array.from(resultList.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') || []);
    if (!buttons.length) return;
    const index = buttons.indexOf(event.target as HTMLButtonElement);
    if (index < 0) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next].focus();
  }

  const center = value || initial;
  return <div className="guard-place-picker">
    <div className="guard-place-search">
      <div className="guard-place-search-row">
        <Field label="搜索地点"><Input className="guard-place-query" placeholder="输入城市、学校或地点名称" value={query} maxLength={80} disabled={disabled}
          aria-invalid={searchError ? true : undefined} aria-describedby={`${queryHintId}${searchError ? ` ${searchErrorId}` : ''}`}
          onChange={event => changeQuery(event.target.value)} onKeyDown={event => {
            if (event.key === 'Enter') { event.preventDefault(); if (!event.nativeEvent.isComposing) void search(); }
            if (event.key === 'ArrowDown' && places.length) { event.preventDefault(); resultList.current?.querySelector<HTMLButtonElement>('button')?.focus(); }
          }} /></Field>
        <Button className="guard-place-search-button" variant="secondary" disabled={disabled || loading} onClick={() => void search()} aria-label="搜索地点" aria-busy={loading}><Search size={19} aria-hidden="true" />{loading ? '搜索中' : '搜索'}</Button>
        {loading && <Button variant="ghost" size="icon" className="guard-place-search-cancel" onClick={() => { cancelSearch(); setCancelled(true); }} aria-label="取消地点搜索" disabled={disabled}><X size={19} aria-hidden="true" /></Button>}
      </div>
      <p id={queryHintId} className="guard-place-search-hint">可搜索部分名称。找不到地点时，也可以直接在地图上选择。</p>
      {searchError && <div className="guard-place-search-error" role="alert"><p id={searchErrorId}>{searchError}</p><Button variant="ghost" onClick={() => void search()} disabled={disabled}>重新搜索</Button></div>}
      {loading && <p className="guard-place-search-status" role="status">正在查找地点，可以继续修改关键词或取消搜索。</p>}
      {cancelled && <p className="guard-place-search-status" role="status">搜索已取消。</p>}
      {searched && !loading && !places.length && <p className="guard-place-search-empty" role="status">没有找到地点。试试加入城市名称，或直接在地图上选择。</p>}
      {places.length > 0 && <>
        <p className="guard-place-result-count" role="status">找到 {places.length} 个地点，选择一个作为{selectionLabel}。</p>
        <ul ref={resultList} className="guard-place-results" aria-label="地点搜索结果" onKeyDown={resultKeyboard}>{places.map((place, index) => {
          const selected = !!value && value.id === place.id && value.latitude === place.latitude && value.longitude === place.longitude;
          return <li key={`${place.id}/${index}`}><button type="button" disabled={disabled} aria-pressed={selected} onClick={() => pickPlace(place)}>
            <MapPin size={21} aria-hidden="true" /><span><strong>{place.name}</strong>{place.address && <small>{place.address}</small>}</span>{selected && <Check size={19} aria-hidden="true" />}
          </button></li>;
        })}</ul>
      </>}
    </div>
    <div className="guard-place-map-heading"><h3>{purpose === 'message' ? '选择发送位置' : '在地图上选择'}</h3><p>{purpose === 'message' ? '点击选择位置，或拖动后使用地图中心。' : '点击微调中心，或拖动地图后使用地图中心。'}</p></div>
    <TileMap latitude={center.latitude} longitude={center.longitude} name={value?.name || selectionLabel} selectionLabel={selectionLabel} showMarker={!!value} radius={purpose === 'area' && value ? radius : undefined}
      onPick={point => { if (!disabled) onChange({ ...point, name: '地图选定位置' }); }} onViewChange={updateView} recenterKey={recenter} disabled={disabled} />
    <div className={`guard-place-selection${value ? ' is-selected' : ''}`} aria-live="polite" aria-atomic="true">
      <MapPin size={21} aria-hidden="true" /><div><strong>{value ? value.name : `尚未选择${selectionLabel}`}</strong>
        {value ? <>{value.address && <p>{value.address}</p>}<p className="guard-place-coordinates">{value.latitude.toFixed(6)}, {value.longitude.toFixed(6)}</p></> : <p>{purpose === 'message' ? '搜索后选择地点，或直接在地图上选择要发送的位置。' : '搜索后选择地点，或直接点击地图，再设置范围。'}</p>}
      </div>
    </div>
  </div>;
}
