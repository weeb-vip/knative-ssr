package main

import (
	"fmt"
	"io"
	"net/http"
	"sort"
	"sync"
	"sync/atomic"
	"time"
)

// Prometheus exposition, hand-rolled.
//
// The client library would pull in a dependency tree larger than this whole
// program, for four metric families. The format is stable and simple enough
// that emitting it directly is the smaller risk.

// Bucket boundaries in seconds. Chosen around what this system actually does:
// sub-millisecond for a Redis hit, tens of milliseconds for a warm render, and
// 1-5s for a Knative cold start — the range that matters most is 0.5-5s, since
// that is where scale-to-zero pain shows up.
var durationBuckets = []float64{
	0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30,
}

type histogram struct {
	counts []atomic.Int64 // one per bucket, cumulative computed at render
	sum    atomic.Int64   // microseconds, to stay integral
	total  atomic.Int64
}

func newHistogram() *histogram {
	return &histogram{counts: make([]atomic.Int64, len(durationBuckets))}
}

func (h *histogram) observe(d time.Duration) {
	s := d.Seconds()
	for i, b := range durationBuckets {
		if s <= b {
			h.counts[i].Add(1)
			break
		}
	}
	h.sum.Add(d.Microseconds())
	h.total.Add(1)
}

func (h *histogram) write(w io.Writer, name, labels string) {
	sep := ","
	if labels == "" {
		sep = ""
	}

	var cumulative int64
	for i, b := range durationBuckets {
		cumulative += h.counts[i].Load()
		fmt.Fprintf(w, "%s_bucket{%s%sle=\"%g\"} %d\n", name, labels, sep, b, cumulative)
	}
	// +Inf must equal the observation count, including anything above the last
	// finite bucket.
	fmt.Fprintf(w, "%s_bucket{%s%sle=\"+Inf\"} %d\n", name, labels, sep, h.total.Load())

	braces := ""
	if labels != "" {
		braces = "{" + labels + "}"
	}
	fmt.Fprintf(w, "%s_sum%s %f\n", name, braces, float64(h.sum.Load())/1e6)
	fmt.Fprintf(w, "%s_count%s %d\n", name, braces, h.total.Load())
}

// labelled is a small map of label-value to histogram, created on demand.
type labelled struct {
	mu sync.RWMutex
	m  map[string]*histogram
}

func newLabelled() *labelled { return &labelled{m: map[string]*histogram{}} }

func (l *labelled) get(key string) *histogram {
	l.mu.RLock()
	h, ok := l.m[key]
	l.mu.RUnlock()
	if ok {
		return h
	}

	l.mu.Lock()
	defer l.mu.Unlock()
	if h, ok := l.m[key]; ok {
		return h
	}
	h = newHistogram()
	l.m[key] = h
	return h
}

func (l *labelled) each(fn func(key string, h *histogram)) {
	l.mu.RLock()
	keys := make([]string, 0, len(l.m))
	for k := range l.m {
		keys = append(keys, k)
	}
	l.mu.RUnlock()

	sort.Strings(keys)
	for _, k := range keys {
		l.mu.RLock()
		h := l.m[k]
		l.mu.RUnlock()
		fn(k, h)
	}
}

func counter(w io.Writer, name, help string, value int64) {
	fmt.Fprintf(w, "# HELP %s %s\n# TYPE %s counter\n%s %d\n", name, help, name, name, value)
}

func gauge(w io.Writer, name, help string, value float64) {
	fmt.Fprintf(w, "# HELP %s %s\n# TYPE %s gauge\n%s %g\n", name, help, name, name, value)
}

func (s *server) writeMetrics(w io.Writer) {
	m := &s.m

	counter(w, "edge_cache_hits_total", "Responses served fresh from Redis.", m.hit.Load())
	counter(w, "edge_cache_stale_total", "Responses served stale while revalidating.", m.stale.Load())
	counter(w, "edge_cache_misses_total", "Cacheable requests with no usable entry.", m.miss.Load())
	counter(w, "edge_cache_bypass_total", "Requests ineligible for caching.", m.bypass.Load())
	counter(w, "edge_cache_revalidations_total", "Background revalidations started.", m.revalidate.Load())
	counter(w, "edge_cache_stored_total", "Origin responses cached by the proxy.", m.stored.Load())
	counter(w, "edge_upstream_requests_total", "Requests forwarded to the SSR service.", m.upstream.Load())
	counter(w, "edge_errors_total", "Proxy and upstream errors.", m.errors.Load())

	// 1 when Redis is reachable and the breaker is closed. A cache that has
	// silently fallen back to pass-through looks healthy on every other metric,
	// so this is the one that tells you the hit rate is zero for a reason.
	up := 0.0
	if s.cache.Status() == "ready" {
		up = 1
	}
	gauge(w, "edge_redis_up", "1 if Redis is reachable and the circuit breaker is closed.", up)

	fmt.Fprint(w, "# HELP edge_request_duration_seconds Time to serve a request, by outcome.\n")
	fmt.Fprint(w, "# TYPE edge_request_duration_seconds histogram\n")
	m.requestDuration.each(func(outcome string, h *histogram) {
		h.write(w, "edge_request_duration_seconds", fmt.Sprintf("outcome=%q", outcome))
	})

	// Separated from request duration because this is where a Knative cold
	// start shows up: the p99 here jumping to seconds while the hit path stays
	// flat is exactly the scale-to-zero tradeoff becoming visible.
	fmt.Fprint(w, "# HELP edge_upstream_duration_seconds Time for the SSR service to respond, including any cold start.\n")
	fmt.Fprint(w, "# TYPE edge_upstream_duration_seconds histogram\n")
	m.upstreamDuration.write(w, "edge_upstream_duration_seconds", "")
}

// observe records the outcome of a request. Called once per request, from the
// deferred path in ServeHTTP.
func (m *metrics) observe(outcome string, started time.Time) {
	m.requestDuration.get(outcome).observe(time.Since(started))
}

// timedTransport records how long the SSR service took to respond, which is
// where a Knative cold start becomes visible — separately from the hit path,
// which never leaves the proxy.
type timedTransport struct {
	m    *metrics
	next http.RoundTripper
}

func (t *timedTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	started := time.Now()
	resp, err := t.next.RoundTrip(r)
	t.m.upstreamDuration.observe(time.Since(started))
	return resp, err
}
