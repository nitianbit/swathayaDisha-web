import type { ReactNode } from 'react';

export function PageHeading({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <header className="ws-page-head">
      <h1 id="page-title" tabIndex={-1}>{title}</h1>
      {children && <div className="ws-page-sub">{children}</div>}
    </header>
  );
}
