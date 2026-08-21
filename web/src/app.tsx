import { useEffect, useState } from 'react';
import { Intro, hasSeenIntro, markIntroSeen } from './components/intro';
import { Empty } from './components/primitives';
import { Rail, SystemStrip, ToastHost } from './components/shell';
import { VIEWS, useRoute } from './state/router';
import { useSnapshot } from './state/store';
import type { DashboardSnapshot } from './data/types';
import { ActivityView } from './views/activity';
import { ApprovalsView } from './views/approvals';
import { OverviewView } from './views/overview';
import { PositionsView } from './views/positions';
import { SignalsView } from './views/signals';
import { StrategiesView } from './views/strategies';
import type { ViewId } from './state/router';

function renderView(view: ViewId, snap: DashboardSnapshot) {
  switch (view) {
    case 'positions':
      return <PositionsView snap={snap} />;
    case 'approvals':
      return <ApprovalsView snap={snap} />;
    case 'activity':
      return <ActivityView snap={snap} />;
    case 'strategies':
      return <StrategiesView snap={snap} />;
    case 'signals':
      return <SignalsView snap={snap} />;
    case 'overview':
    default:
      return <OverviewView snap={snap} />;
  }
}

export function App() {
  const view = useRoute();
  const snap = useSnapshot();
  const [intro, setIntro] = useState<boolean>(() => !hasSeenIntro());

  useEffect(() => {
    const label = VIEWS.find((v) => v.id === view)?.label ?? 'Control';
    document.title = `${label} · ARI OS Control`;
  }, [view]);

  const closeIntro = (): void => {
    markIntroSeen();
    setIntro(false);
  };

  return (
    <>
      <div className="grain" aria-hidden="true" />

      <div className="shell">
        <Rail view={view} snap={snap} />

        <div className="main">
          <SystemStrip snap={snap} onIntro={() => setIntro(true)} />
          {snap ? (
            renderView(view, snap)
          ) : (
            <div className="view">
              <Empty>connecting to the kernel…</Empty>
            </div>
          )}
        </div>
      </div>

      <ToastHost />
      {intro ? <Intro onClose={closeIntro} /> : null}
    </>
  );
}
