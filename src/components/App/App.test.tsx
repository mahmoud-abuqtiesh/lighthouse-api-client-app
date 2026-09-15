import React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BackendSrv, setBackendSrv } from '@grafana/runtime';
import App from './App';
import { Instance, PluginConfig } from '../../api';

/**
 * The only thing stubbed is Grafana's backend service — the single boundary
 * through which the page reaches both the plugin's resource routes and Grafana's
 * user API. Everything else is exercised through the rendered page.
 */

const CONFIG: PluginConfig = {
  team: 'platform',
  pairs: [
    { environment: 'staging', cell: 'mq' },
    { environment: 'staging', cell: 'gl' },
    { environment: 'production', cell: 'sa' },
  ],
};

const SNAPSHOT: Instance[] = [
  { name: 'mq-cable-1', assembly: 'cable', status: 'active', healthy: true, exists: true },
  { name: 'mq-audion-2', assembly: 'audion', status: 'inactive', healthy: false, exists: false },
  { name: 'mq-audion-1', assembly: 'audion', status: 'active', healthy: true, exists: true },
];

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** A Lighthouse whose snapshot the test can change, the way a real one changes. */
let snapshot: Instance[];
let teams: Promise<Array<{ id: number; name: string }>>;
let instancesFailure: unknown;
let statusFailure: unknown;

const get = jest.fn(async (url: string) => {
  if (url.endsWith('/resources/config')) {
    return CONFIG;
  }
  if (url === '/api/user/teams') {
    return teams;
  }
  if (url.endsWith('/resources/instances')) {
    if (instancesFailure) {
      throw instancesFailure;
    }
    return snapshot;
  }
  throw new Error(`unexpected GET ${url}`);
});

const put = jest.fn(async (_url: string, body: { name: string; status: Instance['status'] }) => {
  if (statusFailure) {
    throw statusFailure;
  }
  // The real Lighthouse only reflects a change on its next reconciliation
  // cycle, so the test moves the snapshot on deliberately, never here.
  return { accepted: body };
});

beforeEach(() => {
  jest.useFakeTimers();
  get.mockClear();
  put.mockClear();
  snapshot = SNAPSHOT.map((i) => ({ ...i }));
  teams = Promise.resolve([{ id: 1, name: 'platform' }]);
  instancesFailure = undefined;
  statusFailure = undefined;
  setBackendSrv({ get, put } as unknown as BackendSrv);
});

afterEach(() => {
  jest.runOnlyPendingTimers();
  jest.useRealTimers();
});

const user = () => userEvent.setup({ advanceTimers: jest.advanceTimersByTime });

/** Picks an option from a Grafana Select the way an operator would. */
async function choose(label: string, option: string) {
  const input = screen.getByLabelText(label);
  await user().click(input);
  await user().type(input, option);
  await user().keyboard('{Enter}');
}

/** Renders the page and selects staging / mq, the scope most tests work in. */
async function openStagingMq() {
  render(<App />);
  await screen.findByLabelText('Environment');
  await choose('Environment', 'staging');
  await choose('Cell', 'mq');
  await screen.findByText('mq-audion-1');
}

function rowFor(name: string) {
  return screen.getByRole('row', { name: new RegExp(name) });
}

describe('the team gate', () => {
  test('a user in the configured team sees the page', async () => {
    render(<App />);
    expect(await screen.findByLabelText('Environment')).toBeInTheDocument();
    expect(screen.queryByText(/do not have access/i)).not.toBeInTheDocument();
  });

  test('a user outside the configured team is told they lack access', async () => {
    teams = Promise.resolve([{ id: 2, name: 'interns' }]);

    render(<App />);

    expect(await screen.findByText(/do not have access/i)).toBeInTheDocument();
    expect(screen.getByText(/"platform" Grafana team/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Environment')).not.toBeInTheDocument();
  });

  test('nobody is accused of lacking access while team membership is still loading', async () => {
    const pendingTeams = deferred<Array<{ id: number; name: string }>>();
    teams = pendingTeams.promise;

    render(<App />);

    expect(await screen.findByText(/checking your access/i)).toBeInTheDocument();
    expect(screen.queryByText(/do not have access/i)).not.toBeInTheDocument();

    pendingTeams.resolve([{ id: 1, name: 'platform' }]);
    expect(await screen.findByLabelText('Environment')).toBeInTheDocument();
  });
});

describe('choosing a Lighthouse scope', () => {
  test('a cell cannot be chosen before an environment', async () => {
    render(<App />);
    await screen.findByLabelText('Environment');

    expect(screen.getByLabelText('Cell')).toBeDisabled();
  });

  test('only the cells configured for the chosen environment are offered', async () => {
    render(<App />);
    await screen.findByLabelText('Environment');

    await choose('Environment', 'staging');
    await user().click(screen.getByLabelText('Cell'));

    expect(await screen.findByText('mq')).toBeInTheDocument();
    expect(screen.getByText('gl')).toBeInTheDocument();
    // 'sa' is configured, but only for production.
    expect(screen.queryByText('sa')).not.toBeInTheDocument();
  });

  test('the page starts from an unselected state and shows no table', async () => {
    render(<App />);
    await screen.findByLabelText('Environment');

    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.getByText(/choose an environment and a cell/i)).toBeInTheDocument();
  });
});

describe('the managed instances table', () => {
  test('renders the scope’s instances sorted by assembly then name', async () => {
    await openStagingMq();

    const names = screen
      .getAllByRole('row')
      .slice(1)
      .map((row) => within(row).getAllByRole('cell')[0].textContent);
    expect(names).toEqual(['mq-audion-1', 'mq-audion-2', 'mq-cable-1']);

    const audion1 = within(rowFor('mq-audion-1')).getAllByRole('cell');
    expect(audion1.map((c) => c.textContent)).toEqual([
      'mq-audion-1',
      'audion',
      'active',
      'Healthy',
      'Yes',
      'Deactivate',
    ]);
  });

  test('each row offers only the opposite transition to its current status', async () => {
    await openStagingMq();

    expect(within(rowFor('mq-audion-1')).getByRole('button')).toHaveTextContent('Deactivate');
    expect(within(rowFor('mq-audion-2')).getByRole('button')).toHaveTextContent('Activate');
  });
});

describe('changing the status of one managed instance', () => {
  test('nothing is sent until the confirmation is accepted, and it names the whole scope', async () => {
    await openStagingMq();

    await user().click(within(rowFor('mq-audion-1')).getByRole('button'));

    expect(put).not.toHaveBeenCalled();
    expect(
      screen.getByText(/Deactivate mq-audion-1 in staging \/ mq\? Its status will be set to "inactive"\./)
    ).toBeInTheDocument();
  });

  test('cancelling the confirmation sends nothing', async () => {
    await openStagingMq();

    await user().click(within(rowFor('mq-audion-1')).getByRole('button'));
    await user().click(screen.getByRole('button', { name: 'Cancel' }));

    expect(put).not.toHaveBeenCalled();
    expect(screen.queryByText(/Its status will be set to/)).not.toBeInTheDocument();
  });

  test('a confirmed change is sent for exactly one instance', async () => {
    await openStagingMq();

    await user().click(within(rowFor('mq-audion-2')).getByRole('button'));
    await user().click(screen.getByRole('button', { name: /yes, activate/i }));

    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    expect(put).toHaveBeenCalledWith(expect.stringContaining('/resources/instances/status'), {
      environment: 'staging',
      cell: 'mq',
      name: 'mq-audion-2',
      status: 'active',
    });
  });

  test('polling stops as soon as the requested status appears in the snapshot', async () => {
    await openStagingMq();

    await user().click(within(rowFor('mq-audion-2')).getByRole('button'));
    await user().click(screen.getByRole('button', { name: /yes, activate/i }));

    expect(await screen.findByText(/change in flight/i)).toBeInTheDocument();

    // Lighthouse reconciles and the change lands.
    snapshot = snapshot.map((i) => (i.name === 'mq-audion-2' ? { ...i, status: 'active' } : i));
    await jest.advanceTimersByTimeAsync(4_000);

    await waitFor(() => expect(screen.queryByText(/change in flight/i)).not.toBeInTheDocument());
    expect(within(rowFor('mq-audion-2')).getAllByRole('cell')[2]).toHaveTextContent('active');
    expect(screen.queryByText(/still pending/i)).not.toBeInTheDocument();
  });

  test('a change that never takes effect ends at the bound with a still-pending message', async () => {
    await openStagingMq();

    await user().click(within(rowFor('mq-audion-2')).getByRole('button'));
    await user().click(screen.getByRole('button', { name: /yes, activate/i }));

    expect(await screen.findByText(/change in flight/i)).toBeInTheDocument();

    // The snapshot never moves.
    await jest.advanceTimersByTimeAsync(70_000);

    expect(await screen.findByText(/still pending/i)).toBeInTheDocument();
    // The table keeps showing the real current status, not the requested one.
    expect(within(rowFor('mq-audion-2')).getAllByRole('cell')[2]).toHaveTextContent('inactive');
  });

  test('a change whose outcome could not be read says so rather than claiming it is merely pending', async () => {
    await openStagingMq();

    await user().click(within(rowFor('mq-audion-2')).getByRole('button'));
    await user().click(screen.getByRole('button', { name: /yes, activate/i }));

    expect(await screen.findByText(/change in flight/i)).toBeInTheDocument();

    // Lighthouse goes away while we are waiting, so we never learn the outcome.
    instancesFailure = { status: 502, data: { error: 'Could not reach Lighthouse for staging/mq.' } };
    await jest.advanceTimersByTimeAsync(70_000);

    expect(await screen.findByText(/could not be read while waiting/i)).toBeInTheDocument();
    expect(screen.queryByText(/has not reached "active" in the instance snapshot yet/i)).not.toBeInTheDocument();
  });

  test('a rejected change surfaces Lighthouse’s own explanation and leaves the real status showing', async () => {
    await openStagingMq();

    statusFailure = { status: 400, data: { error: 'Unmanaged instance: mq-audion-2' } };

    await user().click(within(rowFor('mq-audion-2')).getByRole('button'));
    await user().click(screen.getByRole('button', { name: /yes, activate/i }));

    expect(await screen.findByText('Unmanaged instance: mq-audion-2')).toBeInTheDocument();
    expect(within(rowFor('mq-audion-2')).getAllByRole('cell')[2]).toHaveTextContent('inactive');
    // The page stays usable.
    expect(within(rowFor('mq-audion-2')).getByRole('button')).toBeEnabled();
  });
});

describe('automatic refresh', () => {
  test('keeps up with Lighthouse on its own, and stops when the page is left', async () => {
    const { unmount } = render(<App />);
    await screen.findByLabelText('Environment');
    await choose('Environment', 'staging');
    await choose('Cell', 'mq');
    await screen.findByText('mq-audion-1');

    const loadsAfterFirstRender = get.mock.calls.filter(([url]) => url.endsWith('/resources/instances')).length;

    await jest.advanceTimersByTimeAsync(35_000);
    const loadsWhileMounted = get.mock.calls.filter(([url]) => url.endsWith('/resources/instances')).length;
    expect(loadsWhileMounted).toBeGreaterThan(loadsAfterFirstRender);

    unmount();
    await jest.advanceTimersByTimeAsync(60_000);

    expect(get.mock.calls.filter(([url]) => url.endsWith('/resources/instances')).length).toBe(loadsWhileMounted);
  });
});

describe('when a refresh fails', () => {
  test('the last rows stay on screen, are marked stale, and every action is disabled', async () => {
    await openStagingMq();

    instancesFailure = { status: 502, data: { error: 'Could not reach Lighthouse for staging/mq.' } };
    await user().click(screen.getByRole('button', { name: 'Refresh' }));

    expect(await screen.findByText(/this data is stale/i)).toBeInTheDocument();
    expect(screen.getByText('Could not reach Lighthouse for staging/mq.')).toBeInTheDocument();

    // The rows we had are still there.
    expect(rowFor('mq-audion-1')).toBeInTheDocument();
    expect(within(rowFor('mq-audion-1')).getByRole('button')).toBeDisabled();
    expect(within(rowFor('mq-audion-2')).getByRole('button')).toBeDisabled();

    // A refresh that succeeds clears the staleness and re-enables the actions.
    instancesFailure = undefined;
    await user().click(screen.getByRole('button', { name: 'Refresh' }));

    await waitFor(() => expect(screen.queryByText(/this data is stale/i)).not.toBeInTheDocument());
    expect(within(rowFor('mq-audion-1')).getByRole('button')).toBeEnabled();
  });
});
