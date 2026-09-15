import { getBackendSrv } from '@grafana/runtime';
import pluginJson from './plugin.json';

const RESOURCE_BASE = `/api/plugins/${pluginJson.id}/resources`;

/** A Lighthouse scope: one environment in one cell, served by one Lighthouse. */
export type Scope = {
  environment: string;
  cell: string;
};

/** Operator-controlled status. Distinct from health, which nobody sets by hand. */
export type Status = 'active' | 'inactive';

/**
 * One managed instance as the last completed reconciliation cycle saw it.
 * `exists` is Lighthouse's own name for "a DNS record is currently published
 * for this instance".
 */
export type Instance = {
  name: string;
  assembly: string;
  status: Status;
  healthy: boolean;
  exists: boolean;
};

/** What the backend is willing to tell the browser about its own configuration. */
export type PluginConfig = {
  pairs: Scope[];
  team: string;
};

export type StatusChange = Scope & {
  name: string;
  status: Status;
};

type Team = {
  id: number;
  name: string;
};

export const fetchConfig = (): Promise<PluginConfig> => getBackendSrv().get<PluginConfig>(`${RESOURCE_BASE}/config`);

export const fetchInstances = (environment: string, cell: string): Promise<Instance[]> =>
  getBackendSrv().get<Instance[]>(`${RESOURCE_BASE}/instances`, { environment, cell });

export const setInstanceStatus = (change: StatusChange): Promise<unknown> =>
  getBackendSrv().put(`${RESOURCE_BASE}/instances/status`, change);

/** Grafana's own user API — the team gate reads the signed-in user's teams from it. */
export const fetchUserTeams = (): Promise<Team[]> => getBackendSrv().get<Team[]>('/api/user/teams');

/**
 * Pulls the human-readable message out of a rejected backend call. The plugin's
 * resource routes always answer a failure with {"error": …}, and that message is
 * the only thing that tells "Lighthouse is down" apart from "the credential was
 * rejected" apart from "Lighthouse refused this request".
 */
export function messageOf(e: unknown): string {
  const err = e as { data?: { error?: string; message?: string }; statusText?: string; message?: string } | undefined;
  return err?.data?.error || err?.data?.message || err?.message || err?.statusText || 'Unexpected error.';
}
