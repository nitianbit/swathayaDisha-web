import { useEffect, useRef, useState } from 'react';
import { FileText } from 'lucide-react';
import { Alert, Button } from '@jansetu/ui';
import { messageOf } from './common.tsx';

export type FileKind = 'image' | 'pdf' | 'other';

/**
 * Decides how a private file may be opened from its first bytes, never from the server's content type or the file
 * name: only PNG/JPEG/GIF/WebP images and PDF get their own type; anything else is offered only as a download with a
 * neutral type, so no uploaded HTML or SVG can run in the app's origin. (Same rule as the workspace's documents.ts.)
 */
export async function sniffFile(blob: Blob): Promise<{ kind: FileKind; type: string }> {
  const b = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
  const starts = (...bytes: number[]) => bytes.every((v, i) => b[i] === v);
  const ascii = (from: number, text: string) => [...text].every((ch, i) => b[from + i] === ch.charCodeAt(0));
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return { kind: 'image', type: 'image/png' };
  if (starts(0xff, 0xd8, 0xff)) return { kind: 'image', type: 'image/jpeg' };
  if (ascii(0, 'GIF87a') || ascii(0, 'GIF89a')) return { kind: 'image', type: 'image/gif' };
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return { kind: 'image', type: 'image/webp' };
  if (ascii(0, '%PDF-')) return { kind: 'pdf', type: 'application/pdf' };
  return { kind: 'other', type: 'application/octet-stream' };
}

const EXT: Record<string, string> = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp', 'application/pdf': '.pdf' };

/**
 * A private file (lab report, bill PDF) read with the customer's token through the API client, then offered from a
 * `blob:` URL that lives only in this page's memory (revoked when it goes away). `id` names exactly which document
 * (and version) it is. Nothing is put in a link that carries
 * a token, and nothing is stored on the device until the customer chooses Save.
 */
export function PrivateFile(props: { id: string; label: string; baseName: string; load: (signal: AbortSignal) => Promise<Blob> }) {
  // A different document (another bill, another version, another report) starts from nothing: the previous one's
  // fetch is aborted and its blob URL revoked by the unmount, so a link never shows one document under another's name.
  return <FileForDocument key={props.id} {...props} />;
}

function FileForDocument({ label, baseName, load }: { id: string; label: string; baseName: string; load: (signal: AbortSignal) => Promise<Blob> }) {
  const [state, setState] = useState<{ status: 'idle' | 'loading' } | { status: 'ready'; url: string; kind: FileKind; type: string } | { status: 'failed'; message: string }>({ status: 'idle' });
  const ctrl = useRef<AbortController | null>(null);
  const url = state.status === 'ready' ? state.url : null;
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);
  useEffect(() => () => ctrl.current?.abort(), []);

  async function get() {
    ctrl.current?.abort();
    const c = new AbortController();
    ctrl.current = c;
    setState({ status: 'loading' });
    try {
      const blob = await load(c.signal);
      const { kind, type } = await sniffFile(blob);
      if (c.signal.aborted) return;
      setState({ status: 'ready', url: URL.createObjectURL(new Blob([blob], { type })), kind, type });
    } catch (err) {
      if (c.signal.aborted) return;
      setState({ status: 'failed', message: messageOf(err) });
    }
  }

  if (state.status === 'ready') {
    const name = `${baseName.replace(/[^A-Za-z0-9-]+/g, '-')}${EXT[state.type] ?? '.bin'}`;
    return (
      <div className="stack" role="group" aria-label={label}>
        <div className="row">
          {state.kind !== 'other' && <a className="j-btn j-btn--secondary" href={state.url} target="_blank" rel="noopener">Open {label}</a>}
          <a className="j-btn j-btn--ghost" href={state.url} download={name}>Save {label}</a>
        </div>
        {state.kind === 'other' && <p className="muted">This file can only be saved to your device.</p>}
      </div>
    );
  }
  return (
    <div className="stack">
      <Button variant="secondary" busy={state.status === 'loading'} onClick={() => void get()}>
        <FileText size={16} aria-hidden="true" /> Get {label}
      </Button>
      {state.status === 'failed' && <Alert>{label} could not be loaded: {state.message}</Alert>}
    </div>
  );
}
