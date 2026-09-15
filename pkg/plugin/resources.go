package plugin

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"github.com/grafana/grafana-plugin-sdk-go/backend/log"
)

// The two operator-controlled statuses. Distinct from health, which Lighthouse
// reports separately and which nobody sets by hand.
const (
	statusActive   = "active"
	statusInactive = "inactive"
)

// instanceFields is every field the operator table displays. Lighthouse returns
// only name, status and healthy unless asked for more.
const instanceFields = "name,status,healthy,assembly,exists"

// maxResponseBytes caps what we will read back from Lighthouse.
const maxResponseBytes = 4 << 20

// instance is one managed instance as the operator table shows it. The JSON
// names are Lighthouse's own so there is a single vocabulary end to end;
// `exists` is Lighthouse's name for "a DNS record is currently published for
// this instance" (lighthouse/api.rb, INSTANCE_FIELDS).
type instance struct {
	Name     string `json:"name"`
	Assembly string `json:"assembly"`
	Status   string `json:"status"`
	Healthy  bool   `json:"healthy"`
	Exists   bool   `json:"exists"`
}

// statusRequest is the frontend's request to change one managed instance.
// `name` is a single string, not an array: the single-instance constraint lives
// in the plugin's own wire shape, so a hand-crafted request cannot batch.
type statusRequest struct {
	Environment string `json:"environment"`
	Cell        string `json:"cell"`
	Name        string `json:"name"`
	Status      string `json:"status"`
}

// upstreamError is a Lighthouse failure already mapped to what the plugin will
// answer its own caller with.
type upstreamError struct {
	status  int
	message string
}

// registerRoutes takes a *http.ServeMux and registers the plugin's resources.
func (a *App) registerRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /config", a.handleConfig)
	mux.HandleFunc("GET /instances", a.handleInstances)
	mux.HandleFunc("PUT /instances/status", a.handleSetStatus)
}

// handleConfig returns what the operator page needs to build its selects and run
// its team gate. It never returns the credential, and never the endpoint URLs:
// the frontend has no use for a URL it is not allowed to call.
func (a *App) handleConfig(w http.ResponseWriter, _ *http.Request) {
	type scope struct {
		Environment string `json:"environment"`
		Cell        string `json:"cell"`
	}
	pairs := make([]scope, 0, len(a.settings.Endpoints))
	for _, e := range a.settings.Endpoints {
		pairs = append(pairs, scope{Environment: e.Environment, Cell: e.Cell})
	}

	writeJSON(w, http.StatusOK, struct {
		Pairs []scope `json:"pairs"`
		Team  string  `json:"team"`
	}{Pairs: pairs, Team: a.settings.Team})
}

// handleInstances reads one Lighthouse's instance snapshot. The snapshot
// reflects the last completed reconciliation cycle, so it can be up to one cycle
// behind the cloud provider.
func (a *App) handleInstances(w http.ResponseWriter, req *http.Request) {
	environment := req.URL.Query().Get("environment")
	cell := req.URL.Query().Get("cell")

	base, problem := a.endpointFor(environment, cell)
	if problem != "" {
		writeError(w, http.StatusBadRequest, problem)
		return
	}

	body, upstream := a.callLighthouse(req.Context(), http.MethodGet, base,
		"/instances?fields="+instanceFields, nil, environment, cell)
	if upstream != nil {
		writeError(w, upstream.status, upstream.message)
		return
	}

	var instances []instance
	if err := json.Unmarshal(body, &instances); err != nil {
		writeError(w, http.StatusBadGateway,
			fmt.Sprintf("Lighthouse for %s/%s returned an instance snapshot we could not read.", environment, cell))
		return
	}

	writeJSON(w, http.StatusOK, instances)
}

// handleSetStatus changes the status of exactly one managed instance and writes
// one structured log line recording the attempt and its outcome.
func (a *App) handleSetStatus(w http.ResponseWriter, req *http.Request) {
	var body statusRequest
	status, message := http.StatusBadRequest,
		"The request body must be a JSON object with environment, cell, name and status."
	if err := json.NewDecoder(req.Body).Decode(&body); err == nil {
		status, message = a.setStatus(req.Context(), body)
	}

	result := "ok"
	if message != "" {
		result = message
	}
	logger := log.DefaultLogger.FromContext(req.Context())
	fields := []any{
		"login", loginFrom(req.Context()),
		"environment", body.Environment,
		"cell", body.Cell,
		"instance", body.Name,
		"requestedStatus", body.Status,
		"statusCode", status,
		"result", result,
	}
	if status == http.StatusNoContent {
		logger.Info("Lighthouse instance status change", fields...)
		w.WriteHeader(http.StatusNoContent)
		return
	}
	logger.Error("Lighthouse instance status change failed", fields...)
	writeError(w, status, message)
}

// setStatus validates the request at the plugin's own boundary and, only if it
// is sound, asks Lighthouse to make the change. It returns the status and
// message the caller should receive; an empty message means success.
func (a *App) setStatus(ctx context.Context, r statusRequest) (int, string) {
	base, problem := a.endpointFor(r.Environment, r.Cell)
	if problem != "" {
		return http.StatusBadRequest, problem
	}
	if r.Status != statusActive && r.Status != statusInactive {
		return http.StatusBadRequest, fmt.Sprintf("Status must be %q or %q.", statusActive, statusInactive)
	}
	if strings.TrimSpace(r.Name) == "" {
		return http.StatusBadRequest, "An instance name is required."
	}

	payload := map[string]any{"names": []string{r.Name}, "status": r.Status}
	if _, upstream := a.callLighthouse(ctx, http.MethodPut, base, "/instances/status", payload, r.Environment, r.Cell); upstream != nil {
		return upstream.status, upstream.message
	}
	return http.StatusNoContent, ""
}

// callLighthouse performs one authenticated call and maps its outcome onto what
// the plugin answers. The mapping is chosen so an operator can tell the three
// failure kinds — unreachable, credential rejected, request refused — apart from
// the message alone.
func (a *App) callLighthouse(ctx context.Context, method, base, path string, payload any, environment, cell string) ([]byte, *upstreamError) {
	var reqBody io.Reader
	if payload != nil {
		encoded, err := json.Marshal(payload)
		if err != nil {
			return nil, &upstreamError{http.StatusInternalServerError, "Could not encode the request for Lighthouse."}
		}
		reqBody = bytes.NewReader(encoded)
	}

	req, err := http.NewRequestWithContext(ctx, method, strings.TrimRight(base, "/")+path, reqBody)
	if err != nil {
		return nil, &upstreamError{http.StatusBadGateway,
			fmt.Sprintf("The Lighthouse endpoint configured for %s/%s is not a usable URL.", environment, cell)}
	}
	req.SetBasicAuth(a.username, a.password)
	if reqBody != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	res, err := a.client.Do(req)
	if err != nil {
		// Covers both a refused connection and the client timeout. The message
		// names the scope so "Lighthouse is down" is distinguishable from "the
		// plugin is broken". The underlying error can carry the URL, so it is
		// logged rather than returned.
		log.DefaultLogger.FromContext(ctx).Error("Lighthouse unreachable",
			"environment", environment, "cell", cell, "error", err.Error())
		return nil, &upstreamError{http.StatusBadGateway,
			fmt.Sprintf("Could not reach Lighthouse for %s/%s.", environment, cell)}
	}
	defer func() { _ = res.Body.Close() }()

	body, err := io.ReadAll(io.LimitReader(res.Body, maxResponseBytes))
	if err != nil {
		return nil, &upstreamError{http.StatusBadGateway,
			fmt.Sprintf("Could not read Lighthouse's reply for %s/%s.", environment, cell)}
	}

	switch {
	case res.StatusCode >= 200 && res.StatusCode < 300:
		return body, nil

	case res.StatusCode == http.StatusUnauthorized:
		// Deliberately not passed through as 401: a 401 from a plugin resource
		// route reads to Grafana and to the user as "your session expired", which
		// is the wrong action to prompt.
		return nil, &upstreamError{http.StatusBadGateway,
			fmt.Sprintf("Lighthouse for %s/%s rejected the plugin's credential. Ask a Grafana admin to check the plugin configuration.", environment, cell)}

	case res.StatusCode == http.StatusBadRequest:
		return nil, &upstreamError{http.StatusBadRequest, lighthouseMessage(body,
			fmt.Sprintf("Lighthouse for %s/%s rejected the request.", environment, cell))}

	default:
		return nil, &upstreamError{http.StatusBadGateway, lighthouseMessage(body,
			fmt.Sprintf("Lighthouse for %s/%s failed with status %d.", environment, cell, res.StatusCode))}
	}
}

// lighthouseMessage surfaces Lighthouse's own {"error": …} where it sent one.
func lighthouseMessage(body []byte, fallback string) string {
	var payload struct {
		Error string `json:"error"`
	}
	if err := json.Unmarshal(body, &payload); err == nil && payload.Error != "" {
		return payload.Error
	}
	return fallback
}

// loginFrom returns the Grafana login of whoever made the request, for the log.
func loginFrom(ctx context.Context) string {
	if user := backend.UserFromContext(ctx); user != nil {
		return user.Login
	}
	return "unknown"
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(payload); err != nil {
		log.DefaultLogger.Error("Could not write response", "error", err.Error())
	}
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": message})
}
