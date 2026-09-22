# Lighthouse API Client — Grafana app plugin

> Spec derived from `.hermes/plans/2026-09-15_143106-lighthouse-api-client-app.md`,
> the Lighthouse API sketch, the Lighthouse CONTEXT glossary, and ADR-0001
> (trust the private subnet for Lighthouse API transport).
>
> Vocabulary follows the Lighthouse glossary: **Lighthouse scope** (environment +
> cell + cloud provider), **managed instance**, **status** (`active`/`inactive`,
> operator-controlled, distinct from health), **instance snapshot** (the last
> completed reconciliation cycle, up to one cycle stale). Do not write "server",
> "host", "region", "cluster", "activation status" or "live inventory".

## Problem Statement

Changing the status of a managed instance today means editing `activation.yml` and
running an Ansible play, or editing a cloud-provider tag by hand in the AWS or OCI
console. Both routes require credentials for the cloud account, both are slow
enough that nobody does them under pressure without a second person watching, and
neither leaves a record that an operator can point at afterwards.

The people who most often need to take an instance out of rotation — during a
deploy, an incident, or a suspected bad node — are already looking at Grafana.
They can see that an instance is unhealthy there, but they cannot act on it there.
They have to leave, find the right tooling, work out which Lighthouse scope the
instance belongs to, and hope they typed the instance name correctly.

There is also no single place to answer the question "which managed instances does
Lighthouse currently consider active in staging mq?". The answer exists — it is the
instance snapshot each Lighthouse holds in memory — but it is only reachable by
someone with SSH access and knowledge of where Lighthouse runs.

## Solution

A Grafana app plugin, installed on the existing production Grafana, that gives an
operator one page:

1. Pick an **environment**, then a **cell**. The cell options are only the ones
   actually configured for that environment, so an unreachable combination cannot
   be selected.
2. See every managed instance in that Lighthouse scope in a table — instance name,
   assembly, status, health, and whether Lighthouse currently publishes a DNS
   record for it. The table refreshes on the same cadence as the Lighthouse
   reconciliation cycle.
3. Press Activate or Deactivate on exactly one instance. A confirmation names the
   environment, the cell, the instance and the target status before anything is
   sent. After confirming, the page watches the table until the requested status
   appears in the instance snapshot.

The browser never talks to Lighthouse. Every call goes to the plugin's Go backend,
which holds the shared Lighthouse Basic Auth credential and talks to the cell's
Lighthouse over the private junction route. The plugin holds no AWS or OCI
credentials and contains no AWS or OCI code.

An admin configures the plugin once: the list of Lighthouse endpoints as
`environment` / `cell` / `URL` rows, the Grafana team allowed to use the page, and
the shared Lighthouse credential. New cells are added by editing that list — no
rebuild, no release.

## User Stories

### Operating on managed instances

1. As an operator responding to an incident, I want to open one Grafana page and
   see every managed instance in a Lighthouse scope, so that I do not have to SSH
   anywhere to find out what Lighthouse currently believes.
2. As an operator, I want to choose an environment first and then a cell, so that
   I am always working inside one explicitly chosen Lighthouse scope and never
   guessing which one the page is showing me.
3. As an operator, I want the cell choices to be limited to the cells configured
   for the environment I picked, so that I cannot select a combination that has no
   Lighthouse behind it.
4. As an operator, I want the page to remember nothing between visits and start
   from an unselected state, so that I never act on a scope I did not deliberately
   choose in this sitting.
5. As an operator, I want to see each managed instance's status and health as two
   separate columns, so that I do not confuse "an operator took this out of
   rotation" with "this instance is failing its health check".
6. As an operator, I want to see whether Lighthouse currently publishes a DNS
   record for each managed instance, so that I can tell whether a status change has
   actually propagated to traffic routing.
7. As an operator, I want to see each managed instance's assembly, so that I can
   tell at a glance which service I am about to affect.
8. As an operator, I want the table sorted by assembly and then by instance name,
   so that instances of the same service are adjacent and the ordering is stable
   between refreshes.
9. As an operator, I want to deactivate a single managed instance, so that I can
   take a suspect instance out of rotation without touching its neighbours.
10. As an operator, I want to activate a single managed instance, so that I can
    return it to rotation once I am satisfied it is well.
11. As an operator, I want the action button on each row to offer only the
    transition that makes sense — Deactivate for an active instance, Activate for
    an inactive one — so that I cannot ask for a no-op.
12. As an operator, I want a confirmation step that names the environment, the
    cell, the instance and the target status in full, so that I catch a misclick
    before it reaches a cloud provider.
13. As an operator, I want to be able to cancel at the confirmation step with
    nothing sent, so that opening the confirmation is never itself a commitment.
14. As an operator, I want to change exactly one managed instance at a time, so
    that a single mistake cannot remove a whole assembly from rotation.
15. As an operator, after I confirm a change, I want the page to keep checking
    until the requested status appears in the instance snapshot, so that I know the
    change actually took effect rather than merely being accepted.
16. As an operator, I want that waiting period to be bounded and to end with a
    clear "still pending" message, so that the page never leaves me watching a
    spinner indefinitely.
17. As an operator, I want actions disabled while a change is in flight, so that I
    cannot stack a second request on top of one I am still waiting for.
18. As an operator, I want the table to refresh by itself on roughly the Lighthouse
    reconciliation cadence, so that what I am looking at is never much staler than
    what Lighthouse itself knows.
19. As an operator, I want a manual refresh control, so that I can pull the latest
    instance snapshot without waiting for the next automatic cycle.
20. As an operator, I want automatic refresh to pause while an action is pending,
    so that the table does not shuffle under my cursor at the moment I am acting.
21. As an operator, I want automatic refresh to stop when I navigate away from the
    page, so that the plugin is not quietly calling Lighthouse forever in a
    forgotten browser tab.

### When things go wrong

22. As an operator, when a refresh fails, I want the last successfully loaded rows
    to stay on screen and be marked stale, so that I keep whatever information I
    had instead of being dropped to an empty page.
23. As an operator, when the data is stale, I want every action disabled, so that
    I cannot act on a picture that I have been told is no longer trustworthy.
24. As an operator, when Lighthouse cannot be reached, I want a message that says
    so plainly and names the environment and cell, so that I can tell the
    difference between "Lighthouse is down" and "the plugin is broken".
25. As an operator, when Lighthouse rejects the plugin's credential, I want a
    message that says the credential was rejected, so that I escalate to a Grafana
    admin instead of retrying.
26. As an operator, when Lighthouse rejects my request as invalid — for instance
    because the instance name is no longer in its snapshot — I want to see
    Lighthouse's own explanation, so that I am not left guessing at a generic
    failure.
27. As an operator, when a status change fails, I want the table to keep showing
    the real current status rather than the status I asked for, so that I am never
    misled into believing a change landed.
28. As an operator, I want an error to leave the page usable — I can retry,
    refresh, or change scope — so that one failure does not require a page reload.

### Configuring the plugin

29. As a Grafana admin, I want to enter the list of Lighthouse endpoints as rows of
    environment, cell and URL, so that I can add a new cell without a plugin
    rebuild or release.
30. As a Grafana admin, I want to add and remove endpoint rows freely, so that I
    can retire a cell as easily as I added one.
31. As a Grafana admin, I want to enter one shared Lighthouse username and password
    stored as Grafana secure settings, so that the credential is never returned to
    a browser and never appears in the plugin's configuration JSON.
32. As a Grafana admin, I want the configuration page to show me that a credential
    is already set without showing me its value, so that I can confirm the plugin
    is configured without the secret being on screen.
33. As a Grafana admin, I want to replace the stored credential by resetting it and
    entering a new one, so that credential rotation does not require reinstalling
    the plugin.
34. As a Grafana admin, I want to name the Grafana team whose members may use the
    operator page, so that the page is not exposed to every signed-in Grafana user.
35. As a Grafana admin, I want that team to default to a sensible value, so that
    the plugin is not wide open the moment it is installed and before I have
    finished configuring it.
36. As a Grafana admin, I want my saved configuration to survive a page reload and
    a Grafana restart, so that configuring the plugin is a one-time act.
37. As a Grafana admin, I want the configuration page to be reachable only by
    Grafana admins, so that an operator cannot read or change which endpoints and
    team are configured.
38. As a Grafana admin, I want saving the configuration to not require Lighthouse
    to be reachable, so that I can configure a cell before its private DNS record
    exists.

### Access and accountability

39. As a Grafana admin, I want users outside the configured team to be told they
    lack access rather than shown an empty or broken page, so that the boundary is
    legible instead of looking like a bug.
40. As a user whose team membership is still loading, I want to see a loading state
    rather than a flash of "access denied", so that the page does not accuse me of
    something that is merely not yet known.
41. As a platform owner, I want every status-change attempt and its outcome written
    to Grafana's server log with the Grafana login, environment, cell, instance and
    requested status, so that I can reconstruct who did what after an incident.
42. As a platform owner, I want failed attempts logged as well as successful ones,
    so that the log shows attempts and not only effects.
43. As a platform owner, I want the Lighthouse credential to never appear in any
    log line or API response, so that the log itself is not a new place to leak it.

### Installation and maintenance

44. As a Grafana admin, I want the plugin to load on the Grafana version actually
    running in production, so that installing it is not gated on a Grafana upgrade.
45. As a platform owner, I want the repository to contain no AWS or OCI code or
    credentials at all, so that the plugin's blast radius is exactly "can call
    Lighthouse" and nothing more.
46. As a platform owner, I want a documented rollback that removes the plugin and
    its configuration, so that backing the change out is a known five-minute
    operation.
47. As a plugin maintainer, I want the backend's behaviour covered by tests that
    drive it the way Grafana does, so that a refactor that breaks the contract
    fails in CI rather than in production.
48. As a plugin maintainer, I want the operator page's behaviour covered by tests
    that drive the rendered page, so that the tests survive being reorganised
    internally.

## Implementation Decisions

### Target Grafana version — do this before anything else

The scaffold targets Grafana 12.3.0; production Grafana is OSS **10.4.15**. The
whole plugin must be retargeted before any feature work, because several of the
things below cannot be verified otherwise.

- The `@grafana/*` frontend packages are pinned to `10.4.15`, and the plugin's
  declared Grafana dependency becomes `>=10.4.15`.
- `@grafana/i18n` is removed. It does not exist for 10.4.15 and nothing in the
  plugin imports it.
- `rxjs` is pinned to the version Grafana 10.4.15 supplies, because the bundler
  treats it as an external and it is therefore resolved at runtime from Grafana,
  not from the plugin's bundle.
- Any `Combobox` / `ComboboxOption` usage is replaced with `Select` and
  `SelectableValue`, which are the 10.4.15 equivalents.

**Remove react-router from the plugin entirely.** This is a correction to the
plan, not a preference. Grafana 10.4.15 ships `react-router` 5.3.3 and the bundler
marks `react-router` as an external, so it is supplied by Grafana at runtime. The
scaffold bundles `react-router-dom` 6.22, whose `Routes` and `Route` are re-exports
from `react-router` — which will resolve to Grafana's v5. The scaffold's routing
would fail at runtime on the target Grafana. Since the plugin has exactly one
operator page, the fix is to delete the router rather than to reconcile versions:
the root component renders the operator page directly, and the routing helpers,
route constants and the unused template pages are deleted along with their
navigation entries in the plugin manifest.

Changing the plugin manifest requires a **Grafana server restart** to take effect.

### Backend

The Go backend is the only component that speaks to Lighthouse. Existing scaffold
example endpoints (`ping`, `echo`) are deleted.

**Settings**, read from the app instance settings Grafana hands the backend:

- Non-secret (`jsonData`): an ordered list of endpoints, each
  `{ environment, cell, url }`; and the name of the Grafana team permitted to use
  the operator page.
- Secret (`secureJsonData`): the shared Lighthouse Basic Auth username and
  password.

One shared credential is used for every endpoint. This diverges from Lighthouse's
own deployment, which renders one credential per environment; if that divergence
becomes a problem the credential moves into each endpoint row, which is an additive
change to the settings shape.

Because Grafana replaces the secure settings object wholesale on save rather than
merging keys, the configuration page treats the username and password as a single
unit: resetting one clears both, and both must be entered together. This avoids a
save that silently blanks the half the admin did not retype.

**Resource routes** exposed to the frontend:

- `GET /config` → the configured `{ environment, cell }` pairs and the team name.
  Never returns the credential or the endpoint URLs; the frontend has no use for a
  URL it is not allowed to call.
- `GET /instances?environment=&cell=` → validates the pair against the configured
  endpoints, then reads that Lighthouse's instance snapshot, requesting every field
  the table displays, and returns the list.
- `PUT /instances/status` with body `{ environment, cell, name, status }` →
  validates the pair, validates `status ∈ {active, inactive}`, validates that
  `name` is a single non-empty string, then sends Lighthouse
  `PUT /instances/<name>` with `{"status": status}`. Success is `204`.

The backend accepts one instance name per request, matching Lighthouse's own
per-instance write route. The constraint is enforced at the plugin's own
boundary, not only in the UI, so that a hand-crafted request cannot batch.

**Error mapping**, chosen so that an operator can tell the three failure kinds
apart from the message alone:

| Condition | Plugin responds | Why |
|---|---|---|
| Environment/cell pair not configured | `400` | Caller error; no Lighthouse call is made. |
| Invalid status, or empty/multiple names | `400` | Caller error; no Lighthouse call is made. |
| Lighthouse unreachable or timed out | `502` | Upstream failure; message names environment and cell. |
| Lighthouse returns `401` | `502` | Deliberately **not** passed through as `401`. A `401` from a plugin resource route reads to Grafana and to the user as "your session expired", which is the wrong action to prompt. The message says the credential was rejected. |
| Lighthouse returns `400` | `400` | Lighthouse's own `{"error": …}` message is surfaced verbatim. |
| Lighthouse returns `500` | `502` | Upstream failure, with Lighthouse's message where one is present. |

Validation happens before any outbound HTTP call, so an invalid request never
reaches Lighthouse.

The HTTP client carries a short timeout — Lighthouse answers from an in-memory
snapshot and never calls a cloud provider on the read path, so a few seconds is
generous. The timeout value is overridable from tests so that the timeout branch is
reachable without a slow test.

Transport is plain HTTP with Basic auth, per ADR-0001: every caller and every
Lighthouse endpoint sits inside the same trusted private subnet, and TLS is
deliberately deferred rather than forgotten. If the API is ever exposed beyond that
boundary, this decision must be revisited.

Every status-change attempt and its outcome is logged as one structured line
through Grafana's plugin logger, carrying the Grafana login (taken from the plugin
context the SDK attaches to the request), environment, cell, instance name,
requested status and result. The credential never appears in a log line.

### Admin configuration page

Endpoint rows with add and remove controls; a team name field defaulting to `root`;
the shared username and password as Grafana secret inputs that report "configured"
without revealing a value. Saving keeps the scaffold's existing save-and-reload
behaviour, which is the supported way to make new app settings reach the backend.

There is no "test connection" control and no validation call to Lighthouse on save,
because the private DNS records the endpoints will point at do not exist yet and an
admin must be able to configure a cell before it is reachable.

### Operator page

The root component performs the team gate: it reads the configured team name from
`GET /config`, reads the signed-in user's teams from Grafana's own user API, and
renders the operator page only on a match. Note that the scaffold has no existing
team gate to copy — this is new. A loading state renders while either call is in
flight, so an authorised user never sees a flash of "access denied".

**This is a UI gate only, and that is an accepted, documented ceiling.** The backend
does not repeat the check, so any signed-in Grafana user who knows the resource
route can call it. Making it real enforcement would require the backend to read
team membership, which in Grafana OSS means giving the plugin a Grafana service
account token — a new credential, which this design deliberately avoids. The README
must state this ceiling plainly.

The page is: an environment select; a cell select whose options are derived from
the configured pairs for the chosen environment; and a table of managed instances
with columns Instance, Assembly, Status, Health, In DNS, and Action, sorted by
assembly then instance name.

The action flow is: press the row's action button → confirmation naming
environment, cell, instance and target status → send the change → poll the instance
snapshot until the requested status is observed, bounded at roughly 60 seconds →
otherwise report "still pending" and leave the table showing the real current
status. The bound exists because Lighthouse's snapshot only reflects a status
change after its next reconciliation cycle, normally within 10 seconds; 60 seconds
is several cycles' grace.

Automatic refresh runs on the Lighthouse cadence (10 seconds), pauses while an
action is pending, and stops on unmount. A manual refresh control sits alongside
it. A failed refresh keeps the previous rows, marks them stale, and disables every
action until a refresh succeeds.

The UI must not imply anything about draining. Health proves liveness only; an
instance can be healthy, newly inactive, and still finishing in-flight work. No
column, label or message may suggest otherwise.

## Testing Decisions

A good test here drives the same entry point a real caller drives and asserts on
what that caller can observe. It does not reach into internal helpers, assert on
intermediate state, or assume a particular internal decomposition — all of which
would have to be rewritten during any refactor and none of which would catch a
real regression. Concretely: the backend tests go through the resource-call entry
point Grafana itself uses, and the frontend tests render the page and interact with
it as an operator would.

**Two seams, both already present in the repository. No new seams are introduced.**

### Seam 1 — the backend's resource-call entry point

The scaffold already tests the backend by building the app through its constructor
and driving `CallResource` with a fake response sender; that existing test file is
the prior art and the new tests replace its example cases in place. Settings
containing endpoints and credentials are supplied to the constructor, and the
endpoint URLs point at a `httptest` server playing Lighthouse. This single seam
covers route dispatch, settings parsing, request validation, the outbound call, and
error mapping.

Cases:

- A configured environment/cell pair returns the managed instances the fake
  Lighthouse serves.
- An unknown environment/cell pair is rejected before any HTTP call is made — the
  fake Lighthouse records that it was never contacted.
- An invalid status, an empty name, and more than one name are each rejected before
  any HTTP call is made.
- A valid change sends Lighthouse `PUT /instances/<name>` carrying only the requested
  status, and reports success on `204`.
- Lighthouse `401` surfaces as `502` with a credential-rejected message, not as
  `401`.
- Lighthouse `400` surfaces as `400` carrying Lighthouse's own message.
- Lighthouse `500` surfaces as `502`.
- An unreachable or hanging Lighthouse surfaces as `502`, using the overridable
  client timeout so the case runs fast.
- `GET /config` returns the configured pairs and team name and does not contain the
  credential — asserted against the serialised response body, so that a future
  field addition cannot leak it silently.

### Seam 2 — the rendered operator page

The scaffold already renders the root component in a test and waits for its content;
that existing test file is the prior art. The only thing mocked is Grafana's backend
service, which is the single boundary through which the page reaches both the
plugin's resource routes and Grafana's user API. Everything else — selects, table,
confirmation, polling, staleness — is exercised through the rendered page.

Cases:

- A user in the configured team sees the page; a user outside it sees the access
  message; neither sees the access message while team membership is still loading.
- Choosing an environment offers only the cells configured for it.
- Choosing a cell loads and renders the managed instances, sorted by assembly then
  name.
- Each row offers only the opposite transition to its current status.
- The action does nothing until the confirmation is accepted, and the confirmation
  names environment, cell, instance and target status.
- Cancelling the confirmation sends nothing.
- After a confirmed change, polling stops as soon as the requested status appears.
- After a confirmed change that never takes effect, polling stops at the bound and
  reports "still pending".
- A failed refresh keeps the previous rows, marks them stale, and disables actions.

The admin configuration page keeps its own existing render test, extended to cover
endpoint rows and the team field. It is a separate render entry point only because
Grafana mounts it separately from the operator page; it is not a new kind of seam.

### End-to-end

The existing end-to-end suite navigates the template pages that this work deletes,
so it must be updated rather than left to fail: the navigation spec is removed and
the configuration spec is updated to the real fields. Full end-to-end coverage of
the operator flow waits on a stub Lighthouse being available to the test Grafana
container.

### Manual verification

1. The plugin loads on a Grafana 10.4.15 container with unsigned plugin loading
   allowed for this plugin ID.
2. The configuration page saves endpoints, team and credential, and a reload keeps
   them.
3. Against a stub Lighthouse: selection, table, activate, deactivate, polling,
   stale state and the disabled-action path all behave.
4. Against a real cell — staging first — status changes only after a confirmed
   action and the table reflects it within one refresh cycle.
5. The repository contains no AWS or OCI code or credentials.

## Out of Scope

- **Batch status changes.** One managed instance per action, enforced at the
  backend boundary, not only in the UI.
- **Backend enforcement of the team gate.** Accepted ceiling; would require a
  Grafana service account token.
- **Any drained indicator or claim about in-flight work.** Health proves liveness
  only. A real drained signal requires in-flight reporting from audion,
  switchboard, cable and eigen, and is separate future work.
- **TLS to Lighthouse.** Deliberately deferred per ADR-0001 while both ends sit in
  the same trusted private subnet.
- **Per-environment Lighthouse credentials.** One shared credential by decision,
  even though Lighthouse's deployment renders one per environment.
- **Changes to `prodops`.** The private DNS records, junction routes, vault entries
  and the eventual retirement of `activation.yml` are the user's own work and stay
  out of this repository.
- **A "test connections" control** on the configuration page.
- **Any AWS or OCI SDK usage.** The plugin reaches cloud providers only through
  Lighthouse, never directly.
- **Plugin signing and publication.** First installs are manual and unsigned.
- **Alerting, dashboards or annotations** driven by status changes.

## Further Notes

**Open question — the DNS-presence field name.** The plan records the Lighthouse
field as `exists`; the API sketch records it as `dns_present`. These cannot both be
right. Confirm against the landed Lighthouse API before implementing the instances
read; the wrong name will silently yield an empty column rather than an error,
which is the worst failure mode available. Nothing else in the spec depends on
which one it is.

**The private DNS records do not exist yet.** This is why endpoint URLs are
configuration rather than code, and why nothing in the plugin may hard-code a
Lighthouse URL. It also means end-to-end verification against a real cell is
blocked until those records land; a stub Lighthouse covers everything until then.

**Lighthouse's junction endpoint name is undecided.** The URL field absorbs
whatever is chosen, so no code changes when it is settled.

**The instance snapshot lags.** It reflects the last completed reconciliation
cycle, so it can be up to one cycle — normally 10 seconds — behind the cloud
provider. Both the refresh cadence and the post-change polling bound are set from
that fact. The UI should never present the table as live.

**Status changes are idempotent** at the Lighthouse end, so a retry after an
ambiguous failure is safe. Concurrent conflicting requests are last-write-wins,
which the single-instance-at-a-time constraint makes unlikely but does not prevent
across two operators.

**Modifying the plugin manifest requires a Grafana server restart.** This affects
the retargeting work and the removal of the template page entries, and must be in
the install documentation.
