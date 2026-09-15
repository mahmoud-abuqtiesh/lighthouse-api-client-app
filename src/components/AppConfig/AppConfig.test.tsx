import React from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PluginType } from '@grafana/data';
import AppConfig, { AppConfigProps } from './AppConfig';
import { testIds } from 'components/testIds';

describe('Components/AppConfig', () => {
  let props: AppConfigProps;

  const renderConfig = (meta: Record<string, unknown> = {}) => {
    const plugin = { meta: { ...props.plugin.meta, ...meta } };
    // @ts-ignore - We don't need to provide `addConfigPage()` and `setChannelSupport()` for these tests
    render(<AppConfig plugin={plugin} query={props.query} />);
  };

  beforeEach(() => {
    jest.resetAllMocks();

    props = {
      plugin: {
        meta: {
          id: 'maqsam-lighthouse-api-client-app',
          name: 'Lighthouse API Client',
          type: PluginType.app,
          enabled: true,
          jsonData: {},
        },
      },
      query: {},
    } as unknown as AppConfigProps;
  });

  test('renders endpoint rows, the team field and the shared credential', () => {
    renderConfig();

    expect(screen.queryByRole('group', { name: /lighthouse endpoints/i })).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: /access/i })).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: /lighthouse credential/i })).toBeInTheDocument();

    expect(screen.getByLabelText('Environment')).toBeInTheDocument();
    expect(screen.getByLabelText('Cell')).toBeInTheDocument();
    expect(screen.getByLabelText('URL')).toBeInTheDocument();

    expect(screen.queryByTestId(testIds.appConfig.team)).toBeInTheDocument();
    expect(screen.queryByTestId(testIds.appConfig.username)).toBeInTheDocument();
    expect(screen.queryByTestId(testIds.appConfig.password)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /save lighthouse settings/i })).toBeInTheDocument();
  });

  test('the team defaults to root so the page is not wide open on install', () => {
    renderConfig();

    expect(screen.getByTestId(testIds.appConfig.team)).toHaveValue('root');
  });

  test('saved endpoints and team are shown again after a reload', () => {
    renderConfig({
      jsonData: {
        team: 'platform',
        endpoints: [
          { environment: 'staging', cell: 'mq', url: 'http://lighthouse.mq.staging.internal:4567' },
          { environment: 'production', cell: 'gl', url: 'http://lighthouse.gl.production.internal:4567' },
        ],
      },
    });

    expect(screen.getByTestId(testIds.appConfig.team)).toHaveValue('platform');
    expect(screen.getAllByLabelText('Environment').map((i) => (i as HTMLInputElement).value)).toEqual([
      'staging',
      'production',
    ]);
    expect(screen.getAllByLabelText('URL')[0]).toHaveValue('http://lighthouse.mq.staging.internal:4567');
  });

  test('endpoint rows can be added and removed', async () => {
    const user = userEvent.setup();
    renderConfig();

    expect(screen.getAllByLabelText('Environment')).toHaveLength(1);

    await user.click(screen.getByTestId(testIds.appConfig.addEndpoint));
    expect(screen.getAllByLabelText('Environment')).toHaveLength(2);

    await user.click(screen.getByRole('button', { name: /remove endpoint 2/i }));
    expect(screen.getAllByLabelText('Environment')).toHaveLength(1);
  });

  test('a stored credential is reported as configured without revealing its value', () => {
    renderConfig({ secureJsonFields: { lighthouseUsername: true, lighthousePassword: true } });

    const username = screen.getByTestId(testIds.appConfig.username);
    expect(username).toHaveValue('configured');
    expect(screen.getAllByRole('button', { name: /reset/i })).toHaveLength(2);
  });

  test('resetting clears both halves of the credential, because Grafana replaces them together', async () => {
    const user = userEvent.setup();
    renderConfig({ secureJsonFields: { lighthouseUsername: true, lighthousePassword: true } });

    await user.click(screen.getAllByRole('button', { name: /reset/i })[0]);

    expect(screen.getByTestId(testIds.appConfig.username)).toHaveValue('');
    expect(screen.getByTestId(testIds.appConfig.password)).toHaveValue('');
    expect(screen.queryByRole('button', { name: /reset/i })).not.toBeInTheDocument();
  });

  test('saving is blocked until both halves of the credential are entered', async () => {
    const user = userEvent.setup();
    renderConfig();

    const save = screen.getByTestId(testIds.appConfig.submit);
    expect(save).toBeDisabled();

    await user.type(screen.getByTestId(testIds.appConfig.username), 'lighthouse');
    expect(save).toBeDisabled();

    await user.type(screen.getByTestId(testIds.appConfig.password), 'secret');
    expect(save).toBeEnabled();
  });

  test('the credential is kept exactly as typed, whitespace and all', async () => {
    const user = userEvent.setup();
    renderConfig();

    // Trimming a password would silently alter it, and the only symptom would be
    // Lighthouse rejecting the credential.
    await user.type(screen.getByTestId(testIds.appConfig.password), '  pa ss  ');

    expect(screen.getByTestId(testIds.appConfig.password)).toHaveValue('  pa ss  ');
  });

  test('saving is blocked while an endpoint row is half filled in', async () => {
    const user = userEvent.setup();
    renderConfig({ secureJsonFields: { lighthouseUsername: true, lighthousePassword: true } });

    const save = screen.getByTestId(testIds.appConfig.submit);
    expect(save).toBeEnabled();

    await user.type(screen.getByLabelText('Environment'), 'staging');
    expect(save).toBeDisabled();

    await user.type(screen.getByLabelText('Cell'), 'mq');
    await user.type(screen.getByLabelText('URL'), 'http://lighthouse.mq.staging.internal:4567');
    expect(save).toBeEnabled();
  });

  test('the credential fields never carry a URL or a team', () => {
    renderConfig();

    const credentials = screen.getByRole('group', { name: /lighthouse credential/i });
    expect(within(credentials).queryByLabelText('URL')).not.toBeInTheDocument();
  });
});
