# Lighthouse API Client

Shows the managed instances Lighthouse holds for one Lighthouse scope — an
environment in a cell — and activates or deactivates one of them at a time,
without leaving Grafana.

## Overview

Taking a managed instance out of rotation currently means editing `activation.yml`
and running an Ansible play, or editing a cloud-provider tag by hand. Both need
credentials for the cloud account, both are slow, and neither leaves a record an
operator can point at afterwards. The people who most often need to do it during
a deploy or an incident are already looking at Grafana.

This plugin gives them one page:

1. Pick an environment, then a cell. Only the cells configured for that
   environment are offered, so an unreachable combination cannot be selected.
2. See every managed instance in that scope — instance, assembly, status, health
   and whether Lighthouse currently publishes a DNS record for it — refreshed on
   the Lighthouse reconciliation cadence.
3. Activate or deactivate exactly one instance, behind a confirmation that names
   the environment, cell, instance and target status. The page then watches the
   instance snapshot until the change actually appears.

Status is operator-controlled and distinct from health. Health proves liveness
only: an instance can be healthy, newly inactive, and still finishing in-flight
work. Nothing here claims otherwise.

The browser never talks to Lighthouse. Every call goes through the plugin's Go
backend, which holds the shared Lighthouse credential. The plugin holds no AWS or
OCI credentials and contains no AWS or OCI code.

## Requirements

- Grafana 10.4.15 or later.
- Network reachability from the Grafana host to each cell's Lighthouse over the
  private junction route.

## Getting started

A Grafana admin configures the plugin once, on its Configuration page: the list
of Lighthouse endpoints as environment / cell / URL rows, the Grafana team whose
members may use the operator page, and the shared Lighthouse credential. New
cells are added by adding a row — no rebuild and no release.

The operator page then appears as **Managed instances** in the navigation.

## Documentation

See the repository README for installation, rollback, the backend's resource
routes and error mapping, and the plugin's known ceilings — in particular that
the team gate is a UI gate only and not a security boundary.
