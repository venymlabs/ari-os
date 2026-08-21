import { useEffect, useState } from 'react';

export const VIEWS = [
  { id: 'overview', idx: '01', label: 'Overview' },
  { id: 'positions', idx: '02', label: 'Positions' },
  { id: 'approvals', idx: '03', label: 'Approvals' },
  { id: 'activity', idx: '04', label: 'Activity' },
  { id: 'strategies', idx: '05', label: 'Strategies' },
  { id: 'signals', idx: '06', label: 'Signals' },
] as const;

export type ViewId = (typeof VIEWS)[number]['id'];

const IDS = VIEWS.map((v) => v.id) as readonly string[];

function readHash(): ViewId {
  const raw = window.location.hash.replace(/^#\/?/, '');
  return (IDS.includes(raw) ? raw : 'overview') as ViewId;
}

export function useRoute(): ViewId {
  const [view, setView] = useState<ViewId>(() => readHash());
  useEffect(() => {
    const on = (): void => setView(readHash());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return view;
}

export function navigate(id: ViewId): void {
  window.location.hash = `#/${id}`;
  window.scrollTo({ top: 0, behavior: 'auto' });
}
