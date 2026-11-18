import React, { useState } from 'react';
import { Modal } from '../components/ui';
import './announcements-md3.css';

function safeUrl(raw: string, image = false) {
  const value = String(raw || '').trim();
  const normalized = value.replace(/[\u0000-\u0020\u007f]+/g, '');
  if (!normalized) return '';
  if (image && /^data:image\/(?:png|jpe?g|gif|webp);base64,/i.test(normalized)) return value;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(normalized);
  if (scheme && !/^(https?|mailto|tel)$/i.test(scheme[1])) return '';
  if (image && scheme && !/^https?$/i.test(scheme[1])) return '';
  return value;
}

type ImageView = { src: string; alt: string };
type InlineRule = { type: string; expression: RegExp };
const RULES: InlineRule[] = [
  { type: 'code', expression: /`([^`]+)`/ },
  { type: 'image', expression: /!\[([^\]]*)\]\(([^\s)]+)(?:\s+"([^"]*)")?\)/ },
  { type: 'link', expression: /\[([^\]]+)\]\(([^\s)]+)(?:\s+"([^"]*)")?\)/ },
  { type: 'strong', expression: /\*\*(.+?)\*\*|__(.+?)__/ },
  { type: 'delete', expression: /~~(.+?)~~/ },
  { type: 'em', expression: /\*([^*\n]+)\*|_([^_\n]+)_/ },
];

function inline(text: string, onImage: (image: ImageView) => void, prefix: string, depth = 0): React.ReactNode[] {
  if (depth > 8) return [text];
  const result: React.ReactNode[] = [];
  let rest = text, index = 0;
  while (rest) {
    let selected: { rule: InlineRule; match: RegExpExecArray } | null = null;
    for (const rule of RULES) {
      const match = rule.expression.exec(rest);
      if (match && (!selected || match.index < selected.match.index)) selected = { rule, match };
    }
    if (!selected) { result.push(rest); break; }
    const { rule, match } = selected;
    if (match.index) result.push(rest.slice(0, match.index));
    const key = `${prefix}-${index++}`;
    const children = () => inline(match[1] || match[2] || '', onImage, key, depth + 1);
    if (rule.type === 'code') result.push(<code key={key}>{match[1]}</code>);
    else if (rule.type === 'strong') result.push(<strong key={key}>{children()}</strong>);
    else if (rule.type === 'em') result.push(<em key={key}>{children()}</em>);
    else if (rule.type === 'delete') result.push(<del key={key}>{children()}</del>);
    else if (rule.type === 'link') {
      const href = safeUrl(match[2]);
      result.push(href ? <a key={key} href={href} target="_blank" rel="noopener noreferrer" title={match[3]}>{inline(match[1], onImage, key, depth + 1)}</a> : <span key={key}>{match[1]}</span>);
    } else if (rule.type === 'image') {
      const src = safeUrl(match[2], true);
      result.push(src ? <button key={key} type="button" className="announcement-image" title={match[3] || '点击查看大图'} aria-label={`查看图片：${match[1] || '公告配图'}`} onClick={() => onImage({ src, alt: match[1] })}><img src={src} alt={match[1]} loading="lazy" /></button> : <span key={key}>{match[1]}</span>);
    }
    rest = rest.slice(match.index + match[0].length);
  }
  return result;
}

const isTableDivider = (line: string) => /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(line);
const tableCells = (line: string) => line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split(/(?<!\\)\|/).map(cell => cell.trim().replace(/\\\|/g, '|'));
const blockStart = (line: string) => /^\s*$|^#{1,6}\s|^\s*(?:```|~~~)|^\s*>|^\s*[-*+]\s|^\s*\d+[.)]\s|^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line);

function blocks(source: string, onImage: (image: ImageView) => void, prefix: string): React.ReactNode[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const output: React.ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const key = `${prefix}-block-${i}`;
    if (!line.trim()) { i++; continue; }
    const fence = /^\s*(```+|~~~+)(.*)$/.exec(line);
    if (fence) {
      const marker = fence[1][0], count = fence[1].length, code: string[] = [];
      i++;
      while (i < lines.length && !(lines[i].trim().startsWith(marker.repeat(count)))) code.push(lines[i++]);
      if (i < lines.length) i++;
      output.push(<pre key={key} className="announcement-code-block" tabIndex={0} aria-label={fence[2].trim() ? `${fence[2].trim()} 代码块` : '代码块'}><code data-language={fence[2].trim()}>{code.join('\n')}</code></pre>);
      continue;
    }
    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      output.push(React.createElement(`h${level}`, { key }, inline(heading[2], onImage, key)));
      i++; continue;
    }
    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { output.push(<hr key={key} />); i++; continue; }
    if (/^\s*>/.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) quoted.push(lines[i++].replace(/^\s*> ?/, ''));
      output.push(<blockquote key={key}>{blocks(quoted.join('\n'), onImage, key)}</blockquote>);
      continue;
    }
    if (line.includes('|') && i + 1 < lines.length && isTableDivider(lines[i + 1])) {
      const headers = tableCells(line), dividers = tableCells(lines[i + 1]);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(tableCells(lines[i++]));
      output.push(<div key={key} className="announcement-table-wrap" role="region" aria-label="公告表格" tabIndex={0}><table><thead><tr>{headers.map((header, col) => <th key={col} scope="col" style={{ textAlign: dividers[col]?.startsWith(':') && dividers[col]?.endsWith(':') ? 'center' : dividers[col]?.endsWith(':') ? 'right' : 'left' }}>{inline(header, onImage, `${key}-h-${col}`)}</th>)}</tr></thead><tbody>{rows.map((row, r) => <tr key={r}>{headers.map((_, col) => <td key={col}>{inline(row[col] || '', onImage, `${key}-${r}-${col}`)}</td>)}</tr>)}</tbody></table></div>);
      continue;
    }
    const list = /^\s*(?:([-*+])|(\d+)[.)])\s+(.+)$/.exec(line);
    if (list) {
      const ordered = !!list[2], items: string[] = [], start = Number(list[2]) || 1;
      while (i < lines.length) {
        const item = /^\s*(?:([-*+])|(\d+)[.)])\s+(.+)$/.exec(lines[i]);
        if (!item || !!item[2] !== ordered) break;
        let content = item[3]; i++;
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*(?:[-*+]|\d+[.)])\s/.test(lines[i])) content += ` ${lines[i++].trim()}`;
        items.push(content);
      }
      output.push(React.createElement(ordered ? 'ol' : 'ul', { key, ...(ordered ? { start } : {}) }, items.map((item, index) => <li key={index}>{inline(item, onImage, `${key}-${index}`)}</li>)));
      continue;
    }
    const paragraph = [line]; i++;
    while (i < lines.length && !blockStart(lines[i]) && !(lines[i].includes('|') && i + 1 < lines.length && isTableDivider(lines[i + 1]))) paragraph.push(lines[i++]);
    output.push(<p key={key}>{inline(paragraph.join('\n'), onImage, key)}</p>);
  }
  return output;
}

export default function AnnouncementMarkdown({ source }: { source?: string }) {
  const [image, setImage] = useState<ImageView | null>(null);
  return <>
    <div className="announcement-markdown">{blocks(String(source || ''), setImage, 'markdown')}</div>
    <Modal open={!!image} onClose={() => setImage(null)} title={image?.alt || '查看图片'} size="xl" className="announcement-image-dialog">
      {image && <img src={image.src} alt={image.alt} className="announcement-image-full" />}
    </Modal>
  </>;
}
