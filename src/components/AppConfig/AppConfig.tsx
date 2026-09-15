import React, { ChangeEvent, FormEvent, useState } from 'react';
import { lastValueFrom } from 'rxjs';
import { css } from '@emotion/css';
import { AppPluginMeta, GrafanaTheme2, PluginConfigPageProps, PluginMeta } from '@grafana/data';
import { getBackendSrv } from '@grafana/runtime';
import { Button, Field, FieldSet, Input, SecretInput, useStyles2 } from '@grafana/ui';
import { testIds } from '../testIds';

/** One Lighthouse: the scope it serves and where to reach it. */
type Endpoint = {
  environment: string;
  cell: string;
  url: string;
};

type AppPluginSettings = {
  endpoints?: Endpoint[];
  team?: string;
};

/** Not wide open the moment the plugin is installed. */
const DEFAULT_TEAM = 'root';

const EMPTY_ENDPOINT: Endpoint = { environment: '', cell: '', url: '' };

type State = {
  endpoints: Endpoint[];
  team: string;
  username: string;
  password: string;
  /** Grafana replaces secureJsonData wholesale, so the two move as one unit. */
  isCredentialSet: boolean;
};

const isBlank = (e: Endpoint) => !e.environment && !e.cell && !e.url;
const isComplete = (e: Endpoint) => Boolean(e.environment && e.cell && e.url);

export interface AppConfigProps extends PluginConfigPageProps<AppPluginMeta<AppPluginSettings>> {}

const AppConfig = ({ plugin }: AppConfigProps) => {
  const s = useStyles2(getStyles);
  const { enabled, pinned, jsonData, secureJsonFields } = plugin.meta;

  const [state, setState] = useState<State>({
    endpoints: jsonData?.endpoints?.length ? jsonData.endpoints : [{ ...EMPTY_ENDPOINT }],
    team: jsonData?.team ?? DEFAULT_TEAM,
    username: '',
    password: '',
    isCredentialSet: Boolean(secureJsonFields?.lighthousePassword),
  });

  const filledEndpoints = state.endpoints.filter((e) => !isBlank(e));
  const endpointsAreSound = filledEndpoints.every(isComplete);
  const credentialIsSound = state.isCredentialSet || Boolean(state.username && state.password);
  const isSubmitDisabled = !endpointsAreSound || !credentialIsSound || !state.team;

  const onResetCredential = () =>
    setState({
      ...state,
      username: '',
      password: '',
      isCredentialSet: false,
    });

  const onChange = (event: ChangeEvent<HTMLInputElement>) =>
    setState((current) => ({ ...current, [event.target.name]: event.target.value.trim() }));

  const onChangeEndpoint = (index: number, field: keyof Endpoint) => (event: ChangeEvent<HTMLInputElement>) => {
    const value = event.target.value.trim();
    setState((current) => ({
      ...current,
      endpoints: current.endpoints.map((e, i) => (i === index ? { ...e, [field]: value } : e)),
    }));
  };

  const onAddEndpoint = () =>
    setState((current) => ({ ...current, endpoints: [...current.endpoints, { ...EMPTY_ENDPOINT }] }));

  const onRemoveEndpoint = (index: number) =>
    setState((current) => {
      const endpoints = current.endpoints.filter((_, i) => i !== index);
      return { ...current, endpoints: endpoints.length ? endpoints : [{ ...EMPTY_ENDPOINT }] };
    });

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isSubmitDisabled) {
      return;
    }

    updatePluginAndReload(plugin.meta.id, {
      enabled,
      pinned,
      jsonData: {
        endpoints: filledEndpoints,
        team: state.team,
      },
      // Grafana replaces this object wholesale rather than merging keys, so
      // either both halves of the credential are sent or neither is.
      secureJsonData: state.isCredentialSet
        ? undefined
        : {
            lighthouseUsername: state.username,
            lighthousePassword: state.password,
          },
    });
  };

  return (
    <form onSubmit={onSubmit}>
      <FieldSet label="Lighthouse endpoints">
        <p className={s.colorWeak}>
          One row per Lighthouse scope. Adding a cell here is all that is needed — no plugin rebuild or release. These
          URLs are never returned to the browser.
        </p>

        {state.endpoints.map((endpoint, index) => (
          <div key={index} className={s.endpointRow}>
            <Field label="Environment">
              <Input
                width={20}
                id={`endpoint-environment-${index}`}
                name={`endpoint-environment-${index}`}
                value={endpoint.environment}
                placeholder="E.g.: staging"
                onChange={onChangeEndpoint(index, 'environment')}
              />
            </Field>
            <Field label="Cell">
              <Input
                width={20}
                id={`endpoint-cell-${index}`}
                name={`endpoint-cell-${index}`}
                value={endpoint.cell}
                placeholder="E.g.: mq"
                onChange={onChangeEndpoint(index, 'cell')}
              />
            </Field>
            <Field label="URL">
              <Input
                width={45}
                id={`endpoint-url-${index}`}
                name={`endpoint-url-${index}`}
                value={endpoint.url}
                placeholder="E.g.: http://lighthouse.mq.staging.internal:4567"
                onChange={onChangeEndpoint(index, 'url')}
              />
            </Field>
            <Button
              type="button"
              variant="secondary"
              className={s.removeEndpoint}
              aria-label={`Remove endpoint ${index + 1}`}
              onClick={() => onRemoveEndpoint(index)}
            >
              Remove
            </Button>
          </div>
        ))}

        <Button type="button" variant="secondary" data-testid={testIds.appConfig.addEndpoint} onClick={onAddEndpoint}>
          Add endpoint
        </Button>
      </FieldSet>

      <FieldSet label="Access">
        <Field
          label="Grafana team"
          description="Members of this Grafana team may use the operator page. This is a UI gate only — see the README."
        >
          <Input
            width={40}
            id="config-team"
            data-testid={testIds.appConfig.team}
            name="team"
            value={state.team}
            placeholder={DEFAULT_TEAM}
            onChange={onChange}
          />
        </Field>
      </FieldSet>

      <FieldSet label="Lighthouse credential">
        <p className={s.colorWeak}>
          One shared Basic Auth credential, used for every endpoint above. Stored as Grafana secure settings and never
          returned to a browser. Resetting either field clears both: Grafana replaces stored secrets wholesale, so both
          must be entered together.
        </p>

        <Field label="Username">
          <SecretInput
            width={40}
            id="config-lighthouse-username"
            data-testid={testIds.appConfig.username}
            name="username"
            value={state.username}
            isConfigured={state.isCredentialSet}
            placeholder="Lighthouse API username"
            onChange={onChange}
            onReset={onResetCredential}
          />
        </Field>

        <Field label="Password" className={s.marginTop}>
          <SecretInput
            width={40}
            id="config-lighthouse-password"
            data-testid={testIds.appConfig.password}
            name="password"
            value={state.password}
            isConfigured={state.isCredentialSet}
            placeholder="Lighthouse API password"
            onChange={onChange}
            onReset={onResetCredential}
          />
        </Field>

        <div className={s.marginTop}>
          <Button type="submit" data-testid={testIds.appConfig.submit} disabled={isSubmitDisabled}>
            Save Lighthouse settings
          </Button>
        </div>
      </FieldSet>
    </form>
  );
};

export default AppConfig;

const getStyles = (theme: GrafanaTheme2) => ({
  colorWeak: css`
    color: ${theme.colors.text.secondary};
  `,
  marginTop: css`
    margin-top: ${theme.spacing(3)};
  `,
  endpointRow: css`
    display: flex;
    align-items: flex-end;
    gap: ${theme.spacing(2)};
    flex-wrap: wrap;
  `,
  removeEndpoint: css`
    margin-bottom: ${theme.spacing(2)};
  `,
});

const updatePluginAndReload = async (pluginId: string, data: Partial<PluginMeta<AppPluginSettings>>) => {
  try {
    await updatePlugin(pluginId, data);

    // Reloading the page as the changes made here wouldn't be propagated to the actual plugin otherwise.
    // This is not ideal, however unfortunately currently there is no supported way for updating the plugin state.
    window.location.reload();
  } catch (e) {
    console.error('Error while updating the plugin', e);
  }
};

const updatePlugin = async (pluginId: string, data: Partial<PluginMeta>) => {
  const response = await getBackendSrv().fetch({
    url: `/api/plugins/${pluginId}/settings`,
    method: 'POST',
    data,
  });

  return lastValueFrom(response);
};
