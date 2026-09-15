import React, { useEffect, useState } from 'react';
import { PluginPage } from '@grafana/runtime';
import { Alert, LoadingPlaceholder } from '@grafana/ui';
import { fetchConfig, fetchUserTeams, messageOf, PluginConfig } from '../../api';
import { InstancesPage } from '../InstancesPage/InstancesPage';

type GateState =
  | { phase: 'loading' }
  | { phase: 'allowed'; config: PluginConfig }
  | { phase: 'denied'; team: string }
  | { phase: 'error'; message: string };

/**
 * The root page. It gates on membership of the configured Grafana team.
 *
 * This is a UI gate only and that is an accepted, documented ceiling: the
 * backend does not repeat the check, so any signed-in Grafana user who knows the
 * resource route can call it. Real enforcement would need the backend to read
 * team membership, which in Grafana OSS means giving the plugin a Grafana
 * service account token — a new credential this design deliberately avoids.
 */
function App() {
  const [state, setState] = useState<GateState>({ phase: 'loading' });

  useEffect(() => {
    let cancelled = false;

    Promise.all([fetchConfig(), fetchUserTeams()])
      .then(([config, teams]) => {
        if (cancelled) {
          return;
        }
        // An unconfigured team denies rather than admits: the plugin must not be
        // wide open in the window between installing it and configuring it.
        const allowed = Boolean(config.team) && teams.some((team) => team.name === config.team);
        setState(allowed ? { phase: 'allowed', config } : { phase: 'denied', team: config.team });
      })
      .catch((e) => {
        if (!cancelled) {
          setState({ phase: 'error', message: messageOf(e) });
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <PluginPage>
      {state.phase === 'loading' && <LoadingPlaceholder text="Checking your access…" />}

      {state.phase === 'error' && (
        <Alert severity="error" title="Could not check your access">
          {state.message}
        </Alert>
      )}

      {state.phase === 'denied' && (
        <Alert severity="warning" title="You do not have access to this page">
          {state.team
            ? `This page is limited to members of the "${state.team}" Grafana team. Ask a Grafana admin to add you.`
            : 'No Grafana team has been configured for this plugin yet. Ask a Grafana admin to configure it.'}
        </Alert>
      )}

      {state.phase === 'allowed' && <InstancesPage pairs={state.config.pairs} />}
    </PluginPage>
  );
}

export default App;
