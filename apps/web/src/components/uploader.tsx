'use client';

import { useRouter } from 'next/navigation';
import { useRef, useState, type DragEvent } from 'react';
import type { ActionResult } from '@/lib/action-types';
import { buttonClass, cx } from './ui';

interface Item {
  name: string;
  progress: number;
  status: 'waiting' | 'uploading' | 'done' | 'error';
  error?: string;
}

function send(url: string, file: File, onProgress: (fraction: number) => void): Promise<ActionResult> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      try {
        resolve(JSON.parse(xhr.responseText) as ActionResult);
      } catch {
        resolve({ ok: false, error: `The server answered with an error (${xhr.status}).` });
      }
    };
    xhr.onerror = () => resolve({ ok: false, error: 'The upload was interrupted. Check your connection and try again.' });
    xhr.send(file);
  });
}

/**
 * Uploads files one after another straight to disk on the server, with a progress bar each.
 * `endpoint` already carries the destination (order and document type) in its query string.
 */
export function Uploader({ endpoint, multiple = true, label = 'Add files', compact, accept }: { endpoint: string; multiple?: boolean; label?: string; compact?: boolean; accept?: string }) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);

  async function upload(list: File[]) {
    if (list.length === 0 || busy) return;
    const chosen = multiple ? list : list.slice(0, 1);
    setBusy(true);
    setItems(chosen.map((f) => ({ name: f.name, progress: 0, status: 'waiting' })));
    const update = (index: number, patch: Partial<Item>) => setItems((prev) => prev.map((it, i) => (i === index ? { ...it, ...patch } : it)));
    for (const [index, file] of chosen.entries()) {
      update(index, { status: 'uploading' });
      const separator = endpoint.includes('?') ? '&' : '?';
      const result = await send(`${endpoint}${separator}name=${encodeURIComponent(file.name)}`, file, (progress) => update(index, { progress }));
      update(index, result.ok ? { status: 'done', progress: 1 } : { status: 'error', error: result.error });
    }
    setBusy(false);
    if (input.current) input.current.value = '';
    router.refresh();
    // Keep failures on screen; clear the successes after a moment.
    setTimeout(() => setItems((prev) => prev.filter((it) => it.status === 'error')), 2500);
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setOver(false);
    void upload(Array.from(event.dataTransfer.files));
  }

  return (
    <div>
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
        className={cx(
          'flex flex-wrap items-center gap-3 rounded-md border border-dashed px-3',
          compact ? 'py-2' : 'py-4',
          over ? 'border-brand-500 bg-brand-50' : 'border-slate-300 bg-slate-50/60',
        )}
      >
        <input ref={input} type="file" multiple={multiple} accept={accept} className="sr-only" onChange={(e) => void upload(Array.from(e.target.files ?? []))} />
        <button type="button" disabled={busy} className={buttonClass('secondary', 'sm')} onClick={() => input.current?.click()}>
          {busy ? 'Uploading…' : label}
        </button>
        <span className="text-xs text-slate-500">or drop {multiple ? 'files' : 'a file'} here</span>
      </div>
      {items.length > 0 && (
        <ul className="mt-2 space-y-1.5" aria-live="polite">
          {items.map((it, i) => (
            <li key={i} className="text-xs">
              <div className="flex items-center justify-between gap-3">
                <span className="truncate text-slate-700">{it.name}</span>
                <span className={cx('shrink-0', it.status === 'error' ? 'text-red-600' : it.status === 'done' ? 'text-emerald-600' : 'text-slate-500')}>
                  {it.status === 'error' ? 'Failed' : it.status === 'done' ? 'Uploaded' : it.status === 'uploading' ? `${Math.round(it.progress * 100)}%` : 'Waiting'}
                </span>
              </div>
              {it.status === 'uploading' && (
                <div className="mt-1 h-1 overflow-hidden rounded bg-slate-200">
                  <div className="h-full bg-brand-500 transition-[width]" style={{ width: `${Math.round(it.progress * 100)}%` }} />
                </div>
              )}
              {it.error && (
                <p role="alert" className="mt-0.5 text-red-600">
                  {it.error}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
