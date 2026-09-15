package plugin

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
)

// mockCallResourceResponseSender implements backend.CallResourceResponseSender
// for use in tests.
type mockCallResourceResponseSender struct {
	response *backend.CallResourceResponse
}

// Send sets the received *backend.CallResourceResponse to s.response
func (s *mockCallResourceResponseSender) Send(response *backend.CallResourceResponse) error {
	s.response = response
	return nil
}

// fakeLighthouse stands in for a cell's Lighthouse. It records what it was asked
// so that a test can assert both what was sent and that nothing was sent at all.
type fakeLighthouse struct {
	server *httptest.Server

	calls      int
	lastPath   string
	lastQuery  string
	lastUser   string
	lastPass   string
	lastMethod string
	lastBody   string

	// canned response
	status int
	body   string
	delay  time.Duration
}

// lighthouseInstanceFields is Lighthouse's own INSTANCE_FIELDS (lighthouse/api.rb).
// The real API answers 400 "Unknown field: …" for anything outside it, so the
// fake does too — that is what stops a wrong field name (`dns_present` for
// `exists`, say) from silently yielding an empty column instead of an error.
var lighthouseInstanceFields = map[string]bool{
	"name": true, "status": true, "healthy": true, "private_ip": true,
	"provider": true, "assembly": true, "succession": true, "exists": true,
}

func newFakeLighthouse(t *testing.T) *fakeLighthouse {
	t.Helper()
	f := &fakeLighthouse{status: http.StatusOK, body: `[]`}
	f.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sent, _ := io.ReadAll(r.Body)

		f.calls++
		f.lastPath = r.URL.Path
		f.lastQuery = r.URL.RawQuery
		f.lastMethod = r.Method
		f.lastBody = string(sent)
		f.lastUser, f.lastPass, _ = r.BasicAuth()

		if f.delay > 0 {
			time.Sleep(f.delay)
		}
		w.Header().Set("Content-Type", "application/json")

		if fields := r.URL.Query().Get("fields"); fields != "" {
			for _, field := range strings.Split(fields, ",") {
				if !lighthouseInstanceFields[field] {
					w.WriteHeader(http.StatusBadRequest)
					_, _ = w.Write([]byte(`{"error":"Unknown field: ` + field + `"}`))
					return
				}
			}
		}

		w.WriteHeader(f.status)
		if f.body != "" {
			_, _ = w.Write([]byte(f.body))
		}
	}))
	t.Cleanup(f.server.Close)
	return f
}

const (
	testUser = "lighthouse"
	testPass = "s3cret-do-not-log"
	testTeam = "platform"
)

// newTestApp builds the app the way Grafana does: through its constructor, with
// instance settings carrying the endpoint list, team and credential.
func newTestApp(t *testing.T, lighthouseURL string) *App {
	t.Helper()

	jsonData, err := json.Marshal(map[string]any{
		"team": testTeam,
		"endpoints": []map[string]string{
			{"environment": "staging", "cell": "mq", "url": lighthouseURL},
			{"environment": "production", "cell": "gl", "url": lighthouseURL},
		},
	})
	if err != nil {
		t.Fatalf("marshal settings: %s", err)
	}

	inst, err := NewApp(context.Background(), backend.AppInstanceSettings{
		JSONData: jsonData,
		DecryptedSecureJSONData: map[string]string{
			secretUsernameKey: testUser,
			secretPasswordKey: testPass,
		},
	})
	if err != nil {
		t.Fatalf("new app: %s", err)
	}
	app, ok := inst.(*App)
	if !ok {
		t.Fatal("inst must be of type *App")
	}
	return app
}

// call drives the same entry point Grafana drives.
func call(t *testing.T, app *App, method, path, query string, body string) *backend.CallResourceResponse {
	t.Helper()

	url := "/" + path
	if query != "" {
		url += "?" + query
	}
	var r mockCallResourceResponseSender
	err := app.CallResource(context.Background(), &backend.CallResourceRequest{
		Method: method,
		Path:   path,
		URL:    url,
		Body:   []byte(body),
		PluginContext: backend.PluginContext{
			User: &backend.User{Login: "operator@example.com"},
		},
	}, &r)
	if err != nil {
		t.Fatalf("CallResource error: %s", err)
	}
	if r.response == nil {
		t.Fatal("no response received from CallResource")
	}
	return r.response
}

func errorMessage(t *testing.T, res *backend.CallResourceResponse) string {
	t.Helper()
	var body struct {
		Error string `json:"error"`
	}
	if err := json.Unmarshal(res.Body, &body); err != nil {
		t.Fatalf("error response is not JSON: %s (body %q)", err, res.Body)
	}
	return body.Error
}

func TestGetConfig(t *testing.T) {
	lh := newFakeLighthouse(t)
	app := newTestApp(t, lh.server.URL)

	res := call(t, app, http.MethodGet, "config", "", "")
	if res.Status != http.StatusOK {
		t.Fatalf("status should be 200, got %d (%s)", res.Status, res.Body)
	}

	var got struct {
		Team  string `json:"team"`
		Pairs []struct {
			Environment string `json:"environment"`
			Cell        string `json:"cell"`
		} `json:"pairs"`
	}
	if err := json.Unmarshal(res.Body, &got); err != nil {
		t.Fatalf("decode config: %s", err)
	}
	if got.Team != testTeam {
		t.Errorf("team should be %q, got %q", testTeam, got.Team)
	}
	if len(got.Pairs) != 2 || got.Pairs[0].Environment != "staging" || got.Pairs[0].Cell != "mq" {
		t.Errorf("unexpected pairs: %+v", got.Pairs)
	}

	// Asserted against the serialised body so a future field addition cannot leak
	// the credential or an endpoint URL silently.
	for _, secret := range []string{testUser, testPass, lh.server.URL} {
		if strings.Contains(string(res.Body), secret) {
			t.Errorf("GET /config body must not contain %q, got %s", secret, res.Body)
		}
	}
}

func TestGetInstances(t *testing.T) {
	lh := newFakeLighthouse(t)
	lh.body = `[
		{"name":"mq-audion-2","assembly":"audion","status":"active","healthy":true,"exists":true},
		{"name":"mq-cable-1","assembly":"cable","status":"inactive","healthy":false,"exists":false}
	]`
	app := newTestApp(t, lh.server.URL)

	res := call(t, app, http.MethodGet, "instances", "environment=staging&cell=mq", "")
	if res.Status != http.StatusOK {
		t.Fatalf("status should be 200, got %d (%s)", res.Status, res.Body)
	}

	var got []instance
	if err := json.Unmarshal(res.Body, &got); err != nil {
		t.Fatalf("decode instances: %s", err)
	}
	if len(got) != 2 {
		t.Fatalf("expected 2 instances, got %d", len(got))
	}
	want := instance{Name: "mq-audion-2", Assembly: "audion", Status: "active", Healthy: true, Exists: true}
	if got[0] != want {
		t.Errorf("first instance should be %+v, got %+v", want, got[0])
	}
	if got[1].Exists {
		t.Errorf("second instance should not be in DNS, got %+v", got[1])
	}

	if lh.lastPath != "/instances" {
		t.Errorf("Lighthouse path should be /instances, got %q", lh.lastPath)
	}
	// Every field the table displays must be requested; Lighthouse only returns
	// name, status and healthy by default. The fake rejects a field name
	// Lighthouse does not know, so `exists` being wrong fails here rather than
	// silently producing an empty "In DNS" column.
	for _, field := range []string{"name", "status", "healthy", "assembly", "exists"} {
		if !strings.Contains(lh.lastQuery, field) {
			t.Errorf("Lighthouse query %q should request field %q", lh.lastQuery, field)
		}
	}
	if lh.lastUser != testUser || lh.lastPass != testPass {
		t.Errorf("Lighthouse should receive the configured basic auth credential, got %q/%q", lh.lastUser, lh.lastPass)
	}
}

// The DNS-presence field is Lighthouse's `exists`. Getting this name wrong
// would yield an empty column rather than an error, so it is pinned here
// against Lighthouse's real field list.
func TestInstanceFieldsAreNamesLighthouseKnows(t *testing.T) {
	for _, field := range strings.Split(instanceFields, ",") {
		if !lighthouseInstanceFields[field] {
			t.Errorf("instanceFields asks Lighthouse for %q, which is not one of its INSTANCE_FIELDS", field)
		}
	}
	if !strings.Contains(instanceFields, "exists") {
		t.Error("the table's In DNS column reads Lighthouse's `exists` field; it must be requested")
	}
}

func TestSetStatus(t *testing.T) {
	lh := newFakeLighthouse(t)
	lh.status = http.StatusNoContent
	lh.body = ""
	app := newTestApp(t, lh.server.URL)

	res := call(t, app, http.MethodPut, "instances/status", "",
		`{"environment":"staging","cell":"mq","name":"mq-cable-1","status":"inactive"}`)
	if res.Status != http.StatusNoContent {
		t.Fatalf("status should be 204, got %d (%s)", res.Status, res.Body)
	}

	if lh.lastMethod != http.MethodPut || lh.lastPath != "/instances/status" {
		t.Errorf("Lighthouse should receive PUT /instances/status, got %s %s", lh.lastMethod, lh.lastPath)
	}

	var sent struct {
		Names  []string `json:"names"`
		Status string   `json:"status"`
	}
	if err := json.Unmarshal([]byte(lh.lastBody), &sent); err != nil {
		t.Fatalf("decode body sent to Lighthouse: %s (body %q)", err, lh.lastBody)
	}
	if len(sent.Names) != 1 || sent.Names[0] != "mq-cable-1" {
		t.Errorf("Lighthouse should receive exactly one name, got %+v", sent.Names)
	}
	if sent.Status != "inactive" {
		t.Errorf("Lighthouse should receive status inactive, got %q", sent.Status)
	}
}

// Caller errors must be rejected at the plugin's own boundary, before any
// outbound call — the fake Lighthouse records that it was never contacted.
func TestRejectedBeforeCallingLighthouse(t *testing.T) {
	for _, tc := range []struct {
		name    string
		method  string
		path    string
		query   string
		body    string
		wantMsg string
	}{
		{
			name:   "unknown environment/cell pair on read",
			method: http.MethodGet,
			path:   "instances",
			query:  "environment=staging&cell=nowhere",
			// message names the pair so the operator can see what was rejected
			wantMsg: "staging/nowhere",
		},
		{
			name:   "missing environment on read",
			method: http.MethodGet,
			path:   "instances",
			query:  "cell=mq",
		},
		{
			name:   "unknown environment/cell pair on status change",
			method: http.MethodPut,
			path:   "instances/status",
			body:   `{"environment":"staging","cell":"nowhere","name":"mq-cable-1","status":"inactive"}`,
		},
		{
			name:    "invalid status",
			method:  http.MethodPut,
			path:    "instances/status",
			body:    `{"environment":"staging","cell":"mq","name":"mq-cable-1","status":"drained"}`,
			wantMsg: "active",
		},
		{
			name:   "empty name",
			method: http.MethodPut,
			path:   "instances/status",
			body:   `{"environment":"staging","cell":"mq","name":"","status":"inactive"}`,
		},
		{
			// The plugin's wire shape has no room for a batch: `name` is one
			// string, so a body carrying several names cannot even be decoded.
			name:   "several names cannot be expressed, let alone sent",
			method: http.MethodPut,
			path:   "instances/status",
			body:   `{"environment":"staging","cell":"mq","name":["mq-cable-1","mq-cable-2"],"status":"inactive"}`,
		},
		{
			name:   "malformed body",
			method: http.MethodPut,
			path:   "instances/status",
			body:   `not json`,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			lh := newFakeLighthouse(t)
			app := newTestApp(t, lh.server.URL)

			res := call(t, app, tc.method, tc.path, tc.query, tc.body)
			if res.Status != http.StatusBadRequest {
				t.Fatalf("status should be 400, got %d (%s)", res.Status, res.Body)
			}
			if lh.calls != 0 {
				t.Errorf("Lighthouse must not be contacted, got %d call(s)", lh.calls)
			}
			msg := errorMessage(t, res)
			if msg == "" {
				t.Error("error response should carry a message")
			}
			if tc.wantMsg != "" && !strings.Contains(msg, tc.wantMsg) {
				t.Errorf("error message %q should contain %q", msg, tc.wantMsg)
			}
		})
	}
}

func TestLighthouseErrorMapping(t *testing.T) {
	for _, tc := range []struct {
		name string

		lighthouseStatus int
		lighthouseBody   string

		wantStatus int
		wantMsg    string
	}{
		{
			name:             "401 becomes 502 so it does not read as an expired Grafana session",
			lighthouseStatus: http.StatusUnauthorized,
			lighthouseBody:   `{"error":"Unauthorized"}`,
			wantStatus:       http.StatusBadGateway,
			wantMsg:          "credential",
		},
		{
			name:             "400 is passed through with Lighthouse's own message",
			lighthouseStatus: http.StatusBadRequest,
			lighthouseBody:   `{"error":"Unmanaged instance: mq-cable-1"}`,
			wantStatus:       http.StatusBadRequest,
			wantMsg:          "Unmanaged instance: mq-cable-1",
		},
		{
			name:             "500 becomes 502 carrying Lighthouse's message",
			lighthouseStatus: http.StatusInternalServerError,
			lighthouseBody:   `{"error":"Status update failed"}`,
			wantStatus:       http.StatusBadGateway,
			wantMsg:          "Status update failed",
		},
		{
			name:             "unexpected status becomes 502",
			lighthouseStatus: http.StatusTeapot,
			lighthouseBody:   ``,
			wantStatus:       http.StatusBadGateway,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			lh := newFakeLighthouse(t)
			lh.status = tc.lighthouseStatus
			lh.body = tc.lighthouseBody
			app := newTestApp(t, lh.server.URL)

			res := call(t, app, http.MethodPut, "instances/status", "",
				`{"environment":"staging","cell":"mq","name":"mq-cable-1","status":"inactive"}`)
			if res.Status != tc.wantStatus {
				t.Fatalf("status should be %d, got %d (%s)", tc.wantStatus, res.Status, res.Body)
			}
			msg := errorMessage(t, res)
			if tc.wantMsg != "" && !strings.Contains(msg, tc.wantMsg) {
				t.Errorf("error message %q should contain %q", msg, tc.wantMsg)
			}
			if strings.Contains(msg, testPass) {
				t.Errorf("error message must not contain the credential: %q", msg)
			}
		})
	}
}

func TestLighthouseUnreachable(t *testing.T) {
	// A port nothing is listening on: connection refused, no waiting.
	closed := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	url := closed.URL
	closed.Close()

	app := newTestApp(t, url)

	res := call(t, app, http.MethodGet, "instances", "environment=staging&cell=mq", "")
	if res.Status != http.StatusBadGateway {
		t.Fatalf("status should be 502, got %d (%s)", res.Status, res.Body)
	}
	msg := errorMessage(t, res)
	// The message names the scope so "Lighthouse is down" is distinguishable
	// from "the plugin is broken".
	for _, want := range []string{"staging", "mq"} {
		if !strings.Contains(msg, want) {
			t.Errorf("error message %q should name %q", msg, want)
		}
	}
}

func TestLighthouseHangs(t *testing.T) {
	restore := clientTimeout
	clientTimeout = 50 * time.Millisecond
	t.Cleanup(func() { clientTimeout = restore })

	lh := newFakeLighthouse(t)
	lh.delay = 2 * time.Second
	app := newTestApp(t, lh.server.URL)

	start := time.Now()
	res := call(t, app, http.MethodGet, "instances", "environment=staging&cell=mq", "")
	if res.Status != http.StatusBadGateway {
		t.Fatalf("status should be 502, got %d (%s)", res.Status, res.Body)
	}
	if elapsed := time.Since(start); elapsed > time.Second {
		t.Errorf("request should give up on the client timeout, took %s", elapsed)
	}
}

func TestUnknownRoute(t *testing.T) {
	lh := newFakeLighthouse(t)
	app := newTestApp(t, lh.server.URL)

	res := call(t, app, http.MethodGet, "ping", "", "")
	if res.Status != http.StatusNotFound {
		t.Errorf("status should be 404, got %d", res.Status)
	}
}

func TestNoEndpointsConfigured(t *testing.T) {
	inst, err := NewApp(context.Background(), backend.AppInstanceSettings{})
	if err != nil {
		t.Fatalf("new app with empty settings: %s", err)
	}
	app := inst.(*App)

	res := call(t, app, http.MethodGet, "config", "", "")
	if res.Status != http.StatusOK {
		t.Fatalf("GET /config should work before the plugin is configured, got %d", res.Status)
	}
	if got := string(res.Body); !strings.Contains(got, `"pairs":[]`) {
		t.Errorf("unconfigured plugin should report no pairs, got %s", got)
	}
}
