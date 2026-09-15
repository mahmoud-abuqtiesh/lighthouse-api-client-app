package plugin

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"github.com/grafana/grafana-plugin-sdk-go/backend/instancemgmt"
	"github.com/grafana/grafana-plugin-sdk-go/backend/resource/httpadapter"
)

// Make sure App implements required interfaces. This is important to do
// since otherwise we will only get a not implemented error response from plugin in
// runtime. Plugin should not implement all these interfaces - only those which are
// required for a particular task.
var (
	_ backend.CallResourceHandler   = (*App)(nil)
	_ instancemgmt.InstanceDisposer = (*App)(nil)
	_ backend.CheckHealthHandler    = (*App)(nil)
)

// Keys under which the shared Lighthouse credential is stored in Grafana's
// secure settings. Both are written together: Grafana replaces secureJsonData
// wholesale on save rather than merging keys.
const (
	secretUsernameKey = "lighthouseUsername"
	secretPasswordKey = "lighthousePassword"
)

// clientTimeout bounds every call to Lighthouse. Lighthouse answers from an
// in-memory snapshot and never calls a cloud provider on the read path, so a few
// seconds is generous. Tests lower it to reach the timeout branch quickly.
var clientTimeout = 5 * time.Second

// endpoint is one configured Lighthouse: the scope it serves and where it lives.
// Transport is plain HTTP with Basic auth per ADR-0001 — every caller and every
// Lighthouse sits inside the same trusted private subnet. If the API is ever
// exposed beyond that boundary this decision must be revisited.
type endpoint struct {
	Environment string `json:"environment"`
	Cell        string `json:"cell"`
	URL         string `json:"url"`
}

// appSettings is the non-secret half of the plugin's instance settings.
type appSettings struct {
	Endpoints []endpoint `json:"endpoints"`
	Team      string     `json:"team"`
}

// App is the Lighthouse API client app plugin. It is the only component that
// speaks to Lighthouse; the browser reaches Lighthouse only through it.
type App struct {
	backend.CallResourceHandler

	settings appSettings
	username string
	password string
	client   *http.Client
}

// NewApp creates a new *App instance from the settings Grafana hands the backend.
func NewApp(_ context.Context, s backend.AppInstanceSettings) (instancemgmt.Instance, error) {
	app := App{
		username: s.DecryptedSecureJSONData[secretUsernameKey],
		password: s.DecryptedSecureJSONData[secretPasswordKey],
		client:   &http.Client{Timeout: clientTimeout},
	}

	if len(s.JSONData) > 0 {
		if err := json.Unmarshal(s.JSONData, &app.settings); err != nil {
			return nil, fmt.Errorf("parse plugin settings: %w", err)
		}
	}

	// Use a httpadapter (provided by the SDK) for resource calls. This allows us
	// to use a *http.ServeMux for resource calls, so we can map multiple routes
	// to CallResource without having to implement extra logic.
	mux := http.NewServeMux()
	app.registerRoutes(mux)
	app.CallResourceHandler = httpadapter.New(mux)

	return &app, nil
}

// endpointFor returns the configured Lighthouse URL for a scope, or a message
// explaining why that scope cannot be served. An unconfigured pair is a caller
// error, so no outbound call is ever made for one.
func (a *App) endpointFor(environment, cell string) (url string, problem string) {
	if environment == "" || cell == "" {
		return "", "Both an environment and a cell are required."
	}
	for _, e := range a.settings.Endpoints {
		if e.Environment == environment && e.Cell == cell {
			return e.URL, ""
		}
	}
	return "", fmt.Sprintf("No Lighthouse endpoint is configured for %s/%s.", environment, cell)
}

// Dispose here tells plugin SDK that plugin wants to clean up resources when a new instance
// created.
func (a *App) Dispose() {
	a.client.CloseIdleConnections()
}

// CheckHealth handles health checks sent from Grafana to the plugin. It reports
// on the plugin's own configuration only: Lighthouse need not be reachable for
// the plugin to be correctly configured.
func (a *App) CheckHealth(_ context.Context, _ *backend.CheckHealthRequest) (*backend.CheckHealthResult, error) {
	if len(a.settings.Endpoints) == 0 {
		return &backend.CheckHealthResult{
			Status:  backend.HealthStatusError,
			Message: "No Lighthouse endpoints are configured.",
		}, nil
	}
	if a.username == "" || a.password == "" {
		return &backend.CheckHealthResult{
			Status:  backend.HealthStatusError,
			Message: "The shared Lighthouse credential is not set.",
		}, nil
	}
	return &backend.CheckHealthResult{
		Status:  backend.HealthStatusOk,
		Message: fmt.Sprintf("%d Lighthouse endpoint(s) configured.", len(a.settings.Endpoints)),
	}, nil
}
