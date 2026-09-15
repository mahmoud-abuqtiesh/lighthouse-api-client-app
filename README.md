# Lighthouse API Client

A Grafana app plugin that shows the managed instances Lighthouse holds for one
**Lighthouse scope** (an environment in a cell) and activates or deactivates one
of them at a time.

The browser never talks to Lighthouse. Every call goes to the plugin's Go
backend, which holds the shared Lighthouse Basic Auth credential and reaches the
cell's Lighthouse over the private junction route. **The plugin holds no AWS or
OCI credentials and contains no AWS or OCI code.**

## Vocabulary

| Term                  | Meaning                                                                           |
| --------------------- | --------------------------------------------------------------------------------- |
| **Lighthouse scope**  | An environment in a cell, e.g. `staging` / `mq`. One Lighthouse serves one scope. |
| **Managed instance**  | An instance Lighthouse knows about and reconciles.                                |
| **Status**            | `active` or `inactive`. Operator-controlled. **Not** health.                      |
| **Health**            | Whether the instance passes its health check. Proves liveness only.               |
| **In DNS**            | Whether Lighthouse currently publishes a DNS record for the instance.             |
| **Instance snapshot** | The last completed reconciliation cycle, up to one cycle (≈10 s) stale.           |

Health is not drainedness. An instance can be healthy, newly inactive, and still
finishing in-flight work. Nothing in this plugin claims otherwise.

## Requirements

- Grafana **10.4.15** or later (`grafanaDependency: >=10.4.15`). The frontend is
  pinned to the `@grafana/*` 10.4.15 packages, which is what production runs.
- Network reachability from the Grafana host to each Lighthouse over the private
  junction route.

## Install

The plugin is unsigned, so Grafana must be told to load it:

1. Build both halves:

   ```bash
   npm ci && npm run build
   mage -v build:linux          # or: go run github.com/magefile/mage@latest -v build:linux
   ```

2. Copy `dist/` to the Grafana plugin directory as
   `<plugins>/maqsam-lighthouse-api-client-app`.

3. Allow the unsigned plugin in `grafana.ini`:

   ```ini
   [plugins]
   allow_loading_unsigned_plugins = maqsam-lighthouse-api-client-app
   ```

4. Restart Grafana. **A restart is required** — Grafana reads `plugin.json` only
   at startup, so any change to the plugin manifest (including this first
   install) needs one.

5. Enable the app: **Administration → Plugins → Lighthouse API Client → Enable**.

### Rollback

1. Remove `<plugins>/maqsam-lighthouse-api-client-app`.
2. Remove the `allow_loading_unsigned_plugins` entry from `grafana.ini`.
3. Delete the plugin's settings row:
   `DELETE FROM plugin_setting WHERE plugin_id = 'maqsam-lighthouse-api-client-app';`
4. Restart Grafana.

## Configure

**Administration → Plugins → Lighthouse API Client → Configuration.** The page is
restricted to Grafana admins by `plugin.json`.

- **Lighthouse endpoints** — one row per scope: environment, cell and URL. Adding
  a cell is a configuration change, not a release: no rebuild, no restart beyond
  the save-and-reload the page does itself. The URLs are stored in `jsonData` and
  are never returned to a browser.
- **Grafana team** — the team whose members may use the operator page. Defaults
  to `root`, so the plugin is not wide open before it is configured.
- **Lighthouse credential** — one shared Basic Auth username and password, stored
  in `secureJsonData`. Grafana replaces secure settings wholesale rather than
  merging keys, so the two move as one unit: resetting either clears both, and
  both must be re-entered together. Rotating the credential means resetting and
  re-entering it — no reinstall.

Saving does not contact Lighthouse. An endpoint can be configured before its
private DNS record exists.

## Use

**Managed instances** in the navigation.

1. Choose an environment, then a cell. The cell options are only those configured
   for the chosen environment, so an unreachable combination cannot be selected.
2. The table lists every managed instance in that scope — instance, assembly,
   status, health, in DNS — sorted by assembly then instance name. It refreshes
   every 10 seconds, the Lighthouse reconciliation cadence, and there is a manual
   **Refresh**.
3. Each row offers only the transition that makes sense: **Deactivate** for an
   active instance, **Activate** for an inactive one. A confirmation names the
   environment, cell, instance and target status before anything is sent.
4. After confirming, the page polls the instance snapshot until the requested
   status appears, giving up after 60 seconds with a "still pending" message. It
   never shows the requested status in place of the real one.

Automatic refresh pauses while a change is in flight and stops when you leave the
page. If a refresh fails, the last rows stay on screen marked stale and every
action is disabled until a refresh succeeds.

## Known ceilings

- **The team gate is a UI gate only.** The backend does not repeat the check, so
  any signed-in Grafana user who knows the resource route can call it directly.
  Making it real enforcement would require the backend to read team membership,
  which in Grafana OSS means giving the plugin a Grafana service account token —
  a new credential this design deliberately avoids. Treat the gate as a guard
  rail, not a security boundary.
- **Transport to Lighthouse is plain HTTP with Basic auth**, per ADR-0001: every
  caller and every Lighthouse sits inside the same trusted private subnet. If the
  Lighthouse API is ever exposed beyond that boundary, this must be revisited.
- **One shared credential for every endpoint**, even though Lighthouse's own
  deployment renders one credential per environment. If that divergence becomes a
  problem, the credential moves into each endpoint row.
- **One instance per action**, enforced at the backend boundary and not only in
  the UI. There is no batch route.
- **Concurrent conflicting changes are last-write-wins.** Status changes are
  idempotent at the Lighthouse end, so retrying after an ambiguous failure is
  safe.

## Backend resource routes

All are under `/api/plugins/maqsam-lighthouse-api-client-app/resources`.

| Route                               | Does                                                                                                                                |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `GET /config`                       | The configured `{environment, cell}` pairs and the team name. Never the credential, never the endpoint URLs.                        |
| `GET /instances?environment=&cell=` | Validates the pair, then reads that Lighthouse's instance snapshot.                                                                 |
| `PUT /instances/status`             | Body `{environment, cell, name, status}`. Validates, then sends Lighthouse `{"names": [name], "status": status}`. `204` on success. |

Error mapping, chosen so the three failure kinds are distinguishable from the
message alone:

| Condition                                   | Plugin answers | Why                                                                                                                                                      |
| ------------------------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pair not configured, bad status, empty name | `400`          | Caller error; no Lighthouse call is made.                                                                                                                |
| Lighthouse unreachable or timed out         | `502`          | Message names the environment and cell.                                                                                                                  |
| Lighthouse `401`                            | `502`          | Deliberately not `401`: that reads as "your Grafana session expired", which is the wrong action to prompt. The message says the credential was rejected. |
| Lighthouse `400`                            | `400`          | Lighthouse's own `{"error": …}` message, verbatim.                                                                                                       |
| Lighthouse `500` or anything else           | `502`          | With Lighthouse's message where there is one.                                                                                                            |

Every status-change attempt and its outcome is written to Grafana's server log as
one structured line carrying the Grafana login, environment, cell, instance name,
requested status and result. Failed attempts are logged as well as successful
ones. The credential never appears in a log line or an API response.

## Develop

```bash
npm ci
npm run dev            # frontend, watch mode
npm run typecheck
npm run test:ci        # jest
npm run lint
go test ./...          # backend
mage -v build:linux    # backend binary
npm run server         # Grafana in Docker; GRAFANA_VERSION=10.4.15 npm run server
npm run e2e            # Playwright, against the container above
```

### Tests

Two seams, both driven the way a real caller drives them:

- **`pkg/plugin/resources_test.go`** builds the app through its constructor and
  drives `CallResource`, with endpoint URLs pointing at an `httptest` server
  playing Lighthouse. This covers route dispatch, settings parsing, validation,
  the outbound call and error mapping in one place.
- **`src/components/App/App.test.tsx`** renders the page and interacts with it as
  an operator would. The only thing stubbed is Grafana's backend service, the
  single boundary through which the page reaches both the plugin's resource
  routes and Grafana's user API.

End-to-end coverage of the operator flow waits on a stub Lighthouse being
available to the test Grafana container; `tests/appConfig.spec.ts` covers the
configuration page today.
