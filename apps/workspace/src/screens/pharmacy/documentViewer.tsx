import { useEffect, useRef, useState } from 'react';
import { assistedRefusal, pharmacyAssistedApi } from '@jansetu/api';
import { useSession } from '../../session.tsx';
import { sniffDocument } from './documents.ts';
import { t } from '../../i18n/pharmacy/index.ts';

/**
 * WQ17: a stored file read with the pharmacy token (`/file/fetch`) and shown in the page: the prescription's dispensing
 * copy (WQ12) and a lab test's released report. PDF and images are rendered from their first bytes; anything else is only
 * offered as a download with a neutral type (`documents.ts`). One file at a time; the object URL is released on leave.
 */
export function useDocumentViewer() {
  const { api } = useSession();
  const [preview, setPreview] = useState<{ url: string; kind: 'pdf' | 'image' | 'other' } | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fetching = useRef<AbortController | null>(null);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview.url); }, [preview]);
  useEffect(() => () => fetching.current?.abort(), []);

  async function open(url: string) {
    fetching.current?.abort();
    const ctrl = new AbortController();
    fetching.current = ctrl;
    setOpening(url);
    setError(null);
    try {
      const blob = await pharmacyAssistedApi(api).file(url, ctrl.signal);
      const { kind, type } = await sniffDocument(blob);
      if (ctrl.signal.aborted) return;
      setPreview({ url: URL.createObjectURL(new Blob([blob], { type })), kind });
    } catch (err) {
      if (!ctrl.signal.aborted) setError(assistedRefusal(err).message);
    } finally {
      if (fetching.current === ctrl) setOpening(null);
    }
  }

  return { open, opening, error, preview };
}

/** The opened file: `title` names it for the frame and image; `noun` is the word in the links ("copy", "report"). */
export function DocumentPreview({ preview, title, noun, fileName }: {
  preview: ReturnType<typeof useDocumentViewer>['preview']; title: string; noun: string; fileName: string;
}) {
  if (!preview) return null;
  return (
    <div className="rx-preview-wrap">
      <div className="rx-preview">
        {preview.kind === 'pdf' ? (
          <div className="rx-pdf">
            <iframe src={preview.url} title={title} />
            <a href={preview.url} target="_blank" rel="noopener">{t('documentViewer.openThe')}{noun}{t('documentViewer.inANewTabTo')}</a>
          </div>
        ) : preview.kind === 'image' ? <img src={preview.url} alt={title} />
          : <a href={preview.url} download={fileName}>{t('documentViewer.downloadThe')}{noun}</a>}
      </div>
    </div>
  );
}
