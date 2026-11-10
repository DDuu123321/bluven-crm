import type { ReactNode } from 'react';
import { formatBytes } from '@bluven/core/domain';
import { fmtDate, fmtDateTime } from '@/lib/fmt';
import { Badge } from './ui';

export interface DocTileData {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  hasThumb: boolean;
  createdAt: Date;
  takenAt: Date | null;
  uploadedBy?: string | null;
  source?: string;
  note?: string;
}

function kind(mimeType: string, fileName: string): string {
  if (mimeType === 'application/pdf') return 'PDF';
  if (mimeType.startsWith('image/')) return mimeType === 'image/heic' ? 'HEIC' : 'IMG';
  const ext = /\.([A-Za-z0-9]{1,5})$/.exec(fileName)?.[1];
  return (ext ?? 'FILE').toUpperCase();
}

/** One file: preview or type badge, name, facts, and whatever actions the caller passes in. */
export function DocTile({ doc, actions }: { doc: DocTileData; actions?: ReactNode }) {
  const href = `/api/documents/${doc.id}`;
  return (
    <li className="flex gap-3 rounded-md border border-slate-200 bg-white p-2.5">
      <a href={href} target="_blank" rel="noreferrer" className="flex size-16 shrink-0 items-center justify-center overflow-hidden rounded bg-slate-100 text-xs font-semibold text-slate-500 hover:opacity-80" title="Open in a new tab">
        {doc.hasThumb ? (
          // eslint-disable-next-line @next/next/no-img-element -- access-controlled thumbnail served by our own route
          <img src={`${href}/thumb`} alt="" loading="lazy" className="size-full object-cover" />
        ) : (
          kind(doc.mimeType, doc.fileName)
        )}
      </a>
      <div className="min-w-0 flex-1">
        <a href={href} target="_blank" rel="noreferrer" className="block truncate text-sm font-medium text-slate-900 hover:text-brand-700" title={doc.fileName}>
          {doc.fileName}
        </a>
        <p className="mt-0.5 text-xs text-slate-500">
          {formatBytes(doc.sizeBytes)} · <span title={fmtDateTime(doc.createdAt)}>added {fmtDate(doc.createdAt)}</span>
          {doc.uploadedBy ? ` by ${doc.uploadedBy}` : ''}
        </p>
        <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-slate-500">
          {doc.takenAt && <span>Photo taken {fmtDate(doc.takenAt)}</span>}
          {doc.source === 'REUSED' && <Badge tone="blue" title={doc.note}>Reused</Badge>}
          {doc.source === 'PYLON' && <Badge tone="violet">From Pylon</Badge>}
        </p>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          <a href={`${href}?download=1`} className="font-medium text-brand-700 hover:underline">
            Download
          </a>
          {actions}
        </div>
      </div>
    </li>
  );
}
