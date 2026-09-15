import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { css } from '@emotion/css';
import { GrafanaTheme2, SelectableValue } from '@grafana/data';
import { Alert, Button, ConfirmModal, Field, Select, useStyles2 } from '@grafana/ui';
import { fetchInstances, Instance, messageOf, Scope, setInstanceStatus, Status } from '../../api';
import { testIds } from '../testIds';

/**
 * Lighthouse rebuilds its instance snapshot every 10 seconds and the API always
 * answers from that snapshot, so refreshing faster than this buys nothing.
 */
const REFRESH_INTERVAL_MS = 10_000;

/**
 * A status change only shows up in the snapshot on Lighthouse's next
 * reconciliation cycle, normally within 10 seconds. 60 seconds is several
 * cycles' grace before we stop waiting and say so.
 */
const POLL_INTERVAL_MS = 3_000;
const POLL_TIMEOUT_MS = 60_000;

type Change = {
  name: string;
  status: Status;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const unique = (values: string[]) => Array.from(new Set(values));

const toOptions = (values: string[]): Array<SelectableValue<string>> => values.map((v) => ({ label: v, value: v }));

const byAssemblyThenName = (a: Instance, b: Instance) =>
  a.assembly.localeCompare(b.assembly) || a.name.localeCompare(b.name);

const opposite = (status: Status): Status => (status === 'active' ? 'inactive' : 'active');

const verb = (status: Status) => (status === 'active' ? 'Activate' : 'Deactivate');

export function InstancesPage({ pairs }: { pairs: Scope[] }) {
  const s = useStyles2(getStyles);

  const [environment, setEnvironment] = useState<string | undefined>();
  const [cell, setCell] = useState<string | undefined>();
  const [rows, setRows] = useState<Instance[] | undefined>();
  const [stale, setStale] = useState(false);
  // Two different failures, so two pieces of state. A refresh that succeeds
  // clears the refresh error, but must never clear the report of an action that
  // Lighthouse rejected — that one is dismissed by the operator.
  const [loadError, setLoadError] = useState<string | undefined>();
  const [actionError, setActionError] = useState<string | undefined>();
  const [notice, setNotice] = useState<string | undefined>();
  const [pending, setPending] = useState<Change | undefined>();
  const [confirming, setConfirming] = useState<Change | undefined>();

  // Nothing may keep calling Lighthouse from a tab the operator has left.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const environments = useMemo(() => unique(pairs.map((p) => p.environment)), [pairs]);
  const cells = useMemo(
    () => unique(pairs.filter((p) => p.environment === environment).map((p) => p.cell)),
    [pairs, environment]
  );

  const load = useCallback(
    async (env = environment, c = cell): Promise<Instance[] | undefined> => {
      if (!env || !c) {
        return undefined;
      }
      try {
        const next = (await fetchInstances(env, c)).slice().sort(byAssemblyThenName);
        if (!mounted.current) {
          return undefined;
        }
        setRows(next);
        setStale(false);
        setLoadError(undefined);
        return next;
      } catch (e) {
        // Keep whatever rows we had; an operator with old information is better
        // off than one dropped to an empty page, as long as they are told.
        if (mounted.current) {
          setStale(true);
          setLoadError(messageOf(e));
        }
        return undefined;
      }
    },
    [environment, cell]
  );

  // A new scope is a fresh start: never show one Lighthouse's rows under another's name.
  const resetScope = () => {
    setRows(undefined);
    setStale(false);
    setLoadError(undefined);
    setActionError(undefined);
    setNotice(undefined);
  };

  const chooseEnvironment = (next?: string) => {
    setEnvironment(next);
    setCell(undefined);
    resetScope();
  };

  const chooseCell = (next?: string) => {
    setCell(next);
    resetScope();
    if (environment && next) {
      load(environment, next);
    }
  };

  // The effect owns only the subscription: while a scope is chosen and nothing is
  // in flight, keep up with Lighthouse's own cadence, and stop on unmount.
  useEffect(() => {
    if (!environment || !cell || pending) {
      return;
    }
    const id = setInterval(() => load(), REFRESH_INTERVAL_MS);
    return () => clearInterval(id);
  }, [environment, cell, pending, load]);

  const waitForStatus = async (target: Change) => {
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    while (mounted.current && Date.now() < deadline) {
      await sleep(POLL_INTERVAL_MS);
      const next = await load();
      if (next?.some((i) => i.name === target.name && i.status === target.status)) {
        return true;
      }
    }
    return false;
  };

  const applyChange = async (target: Change) => {
    if (!environment || !cell) {
      return;
    }
    setConfirming(undefined);
    setNotice(undefined);
    setActionError(undefined);
    setPending(target);

    try {
      await setInstanceStatus({ environment, cell, name: target.name, status: target.status });
    } catch (e) {
      // Show the real current status, never the one that was asked for.
      await load();
      if (mounted.current) {
        setActionError(messageOf(e));
        setPending(undefined);
      }
      return;
    }

    const observed = await waitForStatus(target);
    if (!mounted.current) {
      return;
    }
    if (!observed) {
      setNotice(
        `Lighthouse accepted the change, but ${target.name} has not reached "${target.status}" in the instance snapshot yet. It may still be pending — refresh to check again.`
      );
    }
    setPending(undefined);
  };

  const actionsDisabled = Boolean(pending) || stale;

  return (
    <div>
      <div className={s.selectors}>
        <Field label="Environment">
          <Select
            inputId="lh-environment"
            width={30}
            options={toOptions(environments)}
            value={environment ?? null}
            placeholder="Choose an environment"
            onChange={(v) => chooseEnvironment(v?.value)}
          />
        </Field>
        <Field label="Cell">
          <Select
            inputId="lh-cell"
            width={30}
            options={toOptions(cells)}
            value={cell ?? null}
            disabled={!environment}
            placeholder={environment ? 'Choose a cell' : 'Choose an environment first'}
            onChange={(v) => chooseCell(v?.value)}
          />
        </Field>
        <Button
          className={s.refresh}
          variant="secondary"
          data-testid={testIds.instances.refresh}
          disabled={!environment || !cell || Boolean(pending)}
          onClick={() => load()}
        >
          Refresh
        </Button>
      </div>

      {actionError && (
        <Alert severity="error" title="The status change was not made" onRemove={() => setActionError(undefined)}>
          {actionError}
        </Alert>
      )}

      {loadError && (
        <Alert severity="error" title="Could not load the managed instances">
          {loadError}
        </Alert>
      )}

      {stale && (
        <Alert severity="warning" title="This data is stale">
          Showing the last managed instances that loaded successfully. Actions stay disabled until a refresh succeeds.
        </Alert>
      )}

      {notice && (
        <Alert severity="info" title="Still pending" onRemove={() => setNotice(undefined)}>
          {notice}
        </Alert>
      )}

      {pending && (
        <Alert severity="info" title="Change in flight">
          Waiting for {pending.name} to reach &quot;{pending.status}&quot; in the instance snapshot.
        </Alert>
      )}

      {!environment || !cell ? (
        <p>Choose an environment and a cell to see the managed instances Lighthouse holds for that scope.</p>
      ) : !rows ? (
        <p>Loading managed instances for {`${environment} / ${cell}`}…</p>
      ) : rows.length === 0 ? (
        <p>Lighthouse reports no managed instances in {`${environment} / ${cell}`}.</p>
      ) : (
        <>
          <p className={s.caption}>
            The last completed Lighthouse reconciliation cycle for {`${environment} / ${cell}`}. Lighthouse reconciles
            roughly every 10 seconds, so this can be up to one cycle behind the cloud provider.
          </p>
          <table className={s.table} data-testid={testIds.instances.table}>
            <thead>
              <tr>
                <th>Instance</th>
                <th>Assembly</th>
                <th>Status</th>
                <th>Health</th>
                <th>In DNS</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((i) => (
                <tr key={i.name}>
                  <td>{i.name}</td>
                  <td>{i.assembly}</td>
                  <td>{i.status}</td>
                  <td>{i.healthy ? 'Healthy' : 'Unhealthy'}</td>
                  <td>{i.exists ? 'Yes' : 'No'}</td>
                  <td>
                    <Button
                      size="sm"
                      variant={i.status === 'active' ? 'destructive' : 'primary'}
                      disabled={actionsDisabled}
                      onClick={() => setConfirming({ name: i.name, status: opposite(i.status) })}
                    >
                      {verb(opposite(i.status))}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {confirming && (
        <ConfirmModal
          isOpen
          title={`${verb(confirming.status)} managed instance`}
          body={`${verb(confirming.status)} ${confirming.name} in ${environment} / ${cell}? Its status will be set to "${confirming.status}".`}
          confirmText={`Yes, ${verb(confirming.status).toLowerCase()}`}
          dismissText="Cancel"
          onConfirm={() => applyChange(confirming)}
          onDismiss={() => setConfirming(undefined)}
        />
      )}
    </div>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  selectors: css`
    display: flex;
    align-items: flex-end;
    gap: ${theme.spacing(2)};
    flex-wrap: wrap;
  `,
  refresh: css`
    margin-bottom: ${theme.spacing(2)};
  `,
  caption: css`
    color: ${theme.colors.text.secondary};
  `,
  table: css`
    width: 100%;
    border-collapse: collapse;

    th,
    td {
      text-align: left;
      padding: ${theme.spacing(1)};
      border-bottom: 1px solid ${theme.colors.border.weak};
    }

    th {
      color: ${theme.colors.text.secondary};
      font-weight: ${theme.typography.fontWeightMedium};
    }
  `,
});
