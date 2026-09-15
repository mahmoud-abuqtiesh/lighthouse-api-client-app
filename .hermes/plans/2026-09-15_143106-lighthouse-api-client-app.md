# Lighthouse API Client — Grafana app plugin (plan)

> **For the next agent:** this is the *basic plan*. Turn it into a spec with the
> `to-spec` skill, then implement it in this repository.

**Goal:** a Grafana app plugin that shows the Lighthouse-managed instances of a
chosen cell-environment and activates/deactivates a single instance by calling
the Lighthouse control API.

**Architecture:** browser → plugin frontend → plugin Go backend → Lighthouse
control API on the cell's private junction route. The browser never talks to
Lighthouse; the plugin holds no AWS or OCI credentials.

**Repo:** `github.com/mahmoud-abuqtiesh/lighthouse-api-client-app` (private),
scaffolded with `@grafana/create-plugin` 7.10.1 (app plugin, Go backend).
Plugin ID `maqsam-lighthouse-api-client-app`.

---

## 1. Ground truth

| Fact | Source |
|---|---|
| Production Grafana is **OSS 10.4.15**, `https://monitor.tool.maqsam.com` | `prodops/config/monitor.yml` |
| Grafana runs on the `monitor` instance in cell **gl** | `prodops/config/monitor.yml`, `Group:monitor` |
| Lighthouse control API: `GET /ping` (no auth), `GET /instances?fields=`, `PUT /instances/status`, HTTP Basic | unlanded branch `infra/lighthouse-api`, commit `3ec3bae5c` |
| API credentials: `API_CREDENTIALS="user:pass"` in each lighthouse `.env`, one credential per environment | `prodops/templates/lighthouse/dotenv.j2` |
| `GET /instances` default fields: `name,status,healthy`; also allowed: `private_ip,provider,assembly,succession,exists` | `lighthouse/api.rb` |
| `PUT /instances/status` body `{"names":[...],"status":"active\|inactive"}` → `204`; `400 {"error":...}`; `401`; `500` | `lighthouse/api.rb` |
| Lighthouse exposes a snapshot refreshed every 10 s; the API never calls the cloud | `lighthouse/daemon.rb` |
| Grafana can reach every cell over private routing (verified gl → mq/sa `200`) | live probe from `monitor-grafana-primary` |
| Cells: production gl/mq/av/sa, staging gl/mq | `prodops/config/junction.yml` |

Not yet true: the per-cell private DNS records pointing at each Lighthouse (the
pending piece in the user's own work). The plugin therefore must not hard-code
URLs.

## 2. Decisions already taken (do not re-open)

1. Go backend proxies every Lighthouse call; browser calls only the plugin backend.
2. One **shared** Basic Auth credential for all Lighthouse endpoints, entered by
   an admin in the plugin configuration page (secure field). No AWS/OCI
   credentials, no service-account token.
3. Endpoint list configured on the admin page as rows of
   `environment`, `cell`, `URL`. Future cells need no rebuild.
4. UI gate only: the app page requires membership in a configurable Grafana
   Team (default `root`), checked in the frontend against `/api/user/teams`.
   The backend does **not** repeat the check — accepted, documented ceiling:
   a signed-in user could call the resource endpoints directly.
5. Operator flow: choose Environment, then Cell (options filtered by the
   configured endpoints), then see the instance table.
6. One instance changed at a time, with an explicit confirmation naming
   environment, cell, instance and target status. No batch UI.
7. After a change, poll `GET /instances` until the requested status appears;
   show Status, Health and DNS presence as separate fields.
8. Auto-refresh every 10 s plus a manual refresh; pause while an action is pending.
9. Refresh failure: keep the last rows, mark them stale, disable actions.
10. Log every attempt and result in Grafana's server log (Grafana login,
    environment, cell, instance, requested status, outcome).
11. No "Test connections" button. No drained indicator, no claim about draining.

## 3. Phases

### Phase 0 — make the scaffold load on Grafana 10.4.15
Required before anything else; the fresh scaffold targets 12.3.0.
- `package.json`: `@grafana/data|runtime|ui|schema` → `10.4.15`, pin `rxjs`
  `7.8.1`, remove `@grafana/i18n` if present.
- `src/plugin.json`: `grafanaDependency` → `>=10.4.15`.
- Replace any `Combobox`/`ComboboxOption` with `Select` + `SelectableValue`.
- Verify: frontend build, `go build ./...`, then `docker run` Grafana 10.4.15
  with `GF_PLUGINS_ALLOW_LOADING_UNSIGNED_PLUGINS=maqsam-lighthouse-api-client-app`
  and the plugin mounted; page loads.

### Phase 1 — backend
Rewrite `pkg/plugin/resources.go`; extend `pkg/plugin/app.go` settings struct.
- Settings from `AppInstanceSettings`: `jsonData` = `endpoints[]`, `team`;
  `secureJsonData` = `{lighthouseUsername, lighthousePassword}`.
- Routes:
  - `GET /config` → configured `{environment, cell}` pairs + team name (no secrets).
  - `GET /instances?environment=&cell=` → validate the pair against config, then
    Lighthouse `GET /instances` with all display fields needed by the table;
    return the list.
  - `PUT /instances/status` → body `{environment, cell, name, status}`; validate
    status ∈ `active|inactive`, name non-empty and single; send
    `{"names":[name],"status":...}`; `204` on success.
- Error mapping: unreachable/timeout → `502` with a plain message; Lighthouse
  `401` → `502`/`401` surfaced as "Lighthouse rejected our credentials";
  Lighthouse `400` → `400` with its message.
- Timeout on the HTTP client (Lighthouse answers from memory; a few seconds is enough).
- Log one structured line per attempt and result, including
  `backend.UserFromContext(ctx).Login`.
- No AWS/OCI imports anywhere — delete the scaffold's example endpoints.

### Phase 2 — admin configuration page
`src/components/AppConfig/AppConfig.tsx`: endpoint rows (environment, cell, URL,
add/remove), team name (default `root`), shared Lighthouse username/password as
`SecretInput`; keep the scaffold's save-and-reload behaviour. No validation call
to Lighthouse.

### Phase 3 — operator page
Replace the scaffold's `PageOne` (`src/pages/PageOne.tsx`) and delete the unused
template pages/`PageTwo`–`PageFour` routes.
- `src/components/App/App.tsx`: keep the scaffold team gate pattern, but compare
  against the configured team name and render a loading state before routing.
- Environment `Select`, then Cell `Select` whose options come from the
  configured endpoints for that environment (invalid pairs impossible).
- Table sorted by assembly then instance name: Instance, Assembly, Status,
  Health, In DNS (`exists`), Action.
- Action button (Activate when `inactive`, Deactivate when `active`) →
  confirmation → `PUT` → poll until the requested status is observed (bounded,
  e.g. ~60 s) → otherwise show "still pending".
- 10 s auto-refresh (stop on unmount), manual Refresh, stale banner + disabled
  actions on failure.

### Phase 4 — tests
- Go: `httptest` fake Lighthouse for success, `401`, `400`, `500`, timeout, and
  for rejecting an unknown environment/cell pair and an invalid status before any
  HTTP call.
- Jest: dependent cell options, actions disabled while stale, poll ends when the
  status changes, confirmation-required path.
- Manual: app on 10.4.15 in Docker with a stub Lighthouse; then a real staging
  cell once DNS exists.

### Phase 5 — packaging notes
- Build: `npm run build`, `mage -v build:linux`; document the install path and
  the `allow_loading_unsigned_plugins` setting for a first manual install.
- Rollback: remove the plugin directory and the config entry, restart Grafana.
- No changes to `prodops` from this repository; deployment work stays with the
  user.

## 4. Files likely to change

- `pkg/plugin/resources.go` — replace entirely.
- `pkg/plugin/app.go` — settings struct, route registration.
- `pkg/plugin/resources_test.go` — new backend tests.
- `src/components/AppConfig/AppConfig.tsx` — admin config.
- `src/components/App/App.tsx` — team gate, routing.
- `src/pages/PageOne.tsx` — operator page (rest of `src/pages/*` deleted).
- `src/plugin.json`, `package.json`, `src/constants.ts` — config/version/target.
- `README.md` — install, configure, operate, known ceilings.

## 5. Verification of "done"

1. Plugin loads on a Grafana 10.4.15 container; config page saves endpoints,
   team and credential; reload keeps them.
2. Backend unit tests pass, including the negative cases above.
3. With a stub Lighthouse: environment/cell selection, table, activate,
   deactivate, polling, stale state and the disabled-action path all behave.
4. Against a real cell (staging first): instance status changes only after
   `PUT`, and the table reflects it within one refresh cycle.
5. No AWS/OCI code or credentials anywhere in the repository.

## 6. Risks and open questions

- **DNS pending.** Until the private records exist there is nothing to point at;
  the configurable URL list is the answer, and testing waits on that record.
- **Lighthouse's junction endpoint name is undecided**; the URL field absorbs the
  choice, so no code change when it is settled.
- **Shared credential vs per-environment credentials.** The API branch keeps one
  credential per environment. The plugin stores one shared credential by
  decision; if that diverges later, move the credential into each endpoint entry.
- **Staleness.** The table is a snapshot up to 10 s old; status polling is
  bounded by that interval.
- **"Healthy" is not "drained".** The health check only proves liveness, so the
  UI must not imply draining; the drained indicator is a separate future piece
  (audion, switchboard, cable, eigen need an in-flight signal).
- **UI-only team gate.** Accepted above; if it must become real enforcement, the
  backend needs a Grafana service-account token to read team membership
  (Grafana OSS gives app plugins no other route).
