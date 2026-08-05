// Command edge-cache is the always-on tier in front of a scale-to-zero Knative
// SSR service.
//
// It answers cache hits straight from Redis without waking an SSR pod, and
// proxies everything else upstream. It is deliberately dumb: it never writes
// cache entries and knows nothing about the framework. The adapter is the only
// writer, because it is the only side that knows the render, the tags and the
// TTL.
//
//	Istio ──► edge-cache ──HIT──► Redis ──► response      (SSR pod stays asleep)
//	                     └─MISS─► Knative Service ──► SSR pod
package main

import (
	"context"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"os/signal"
	"strings"
	"sync/atomic"
	"syscall"
	"time"
)

type metrics struct {
	hit        atomic.Int64
	stale      atomic.Int64
	miss       atomic.Int64
	bypass     atomic.Int64
	revalidate atomic.Int64
	upstream   atomic.Int64
	errors     atomic.Int64
}

type server struct {
	cfg      Config
	cache    *Cache
	proxy    *httputil.ReverseProxy
	upstream *url.URL
	client   *http.Client
	m        metrics
}

func main() {
	log.SetFlags(0)
	cfg := LoadConfig()

	upstream, err := url.Parse(cfg.Upstream)
	if err != nil {
		log.Fatalf("[config] UPSTREAM %q is not a valid URL: %v", cfg.Upstream, err)
	}

	cache, err := NewCache(cfg)
	if err != nil {
		log.Fatalf("[cache] %v", err)
	}
	defer cache.Close()

	s := &server{
		cfg:      cfg,
		cache:    cache,
		upstream: upstream,
		client: &http.Client{
			Timeout: cfg.UpstreamTimeout,
			Transport: &http.Transport{
				MaxIdleConns:        200,
				MaxIdleConnsPerHost: 100,
				IdleConnTimeout:     90 * time.Second,
			},
		},
	}

	s.proxy = &httputil.ReverseProxy{
		Director:      s.director,
		FlushInterval: -1, // stream SSR responses through rather than buffering
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			s.m.errors.Add(1)
			log.Printf("[proxy] %s %s: %v", r.Method, r.URL.Path, err)
			// A cold Knative pod that takes too long looks like this. 502 is
			// honest; Istio will surface it and the retry lands on a warm pod.
			http.Error(w, "Bad Gateway", http.StatusBadGateway)
		},
		Transport: &http.Transport{
			MaxIdleConns:        200,
			MaxIdleConnsPerHost: 100,
			IdleConnTimeout:     90 * time.Second,
			// Waking a scaled-to-zero pod goes through Knative's activator, which
			// holds the connection while the pod starts. Must exceed cold-start.
			ResponseHeaderTimeout: cfg.UpstreamTimeout,
		},
	}

	httpServer := &http.Server{
		Addr:              cfg.Listen,
		Handler:           s,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       65 * time.Second,
	}

	go func() {
		log.Printf("[edge] listening on %s → %s (namespace %s:%s)",
			cfg.Listen, cfg.Upstream, cfg.KeyPrefix, cfg.Version)
		if err := httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("[edge] %v", err)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGTERM, syscall.SIGINT)
	<-stop

	log.Print("[edge] draining")
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	_ = httpServer.Shutdown(ctx)
	log.Print("[edge] stopped")
}

// director rewrites a request for the upstream Knative service.
func (s *server) director(r *http.Request) {
	original := r.Host

	r.URL.Scheme = s.upstream.Scheme
	r.URL.Host = s.upstream.Host
	// Knative routes by Host header, so it must be the service's internal name.
	// The public host travels in X-Forwarded-Host, which is what the adapter
	// keys on — that is why HOST_HEADER defaults to x-forwarded-host on both sides.
	r.Host = s.upstream.Host

	if r.Header.Get("X-Forwarded-Host") == "" {
		r.Header.Set("X-Forwarded-Host", original)
	}
	if r.Header.Get("X-Forwarded-Proto") == "" {
		r.Header.Set("X-Forwarded-Proto", "https")
	}
	if ip, _, err := net.SplitHostPort(r.RemoteAddr); err == nil {
		prior := r.Header.Get("X-Forwarded-For")
		if prior == "" {
			r.Header.Set("X-Forwarded-For", ip)
		}
	}
}

func (s *server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	switch r.URL.Path {
	case "/_edge/healthz":
		w.Header().Set("content-type", "application/json")
		fmt.Fprintf(w, `{"status":"ok","redis":%q,"namespace":"%s:%s"}`+"\n",
			s.cache.Status(), s.cfg.KeyPrefix, s.cfg.Version)
		return
	case "/_edge/metrics":
		s.writeMetrics(w)
		return
	}

	// Cache admin lives on the SSR pods (they own the writes, so they own the
	// purges). Waking a pod to serve a purge is fine — purges are rare.
	if strings.HasPrefix(r.URL.Path, s.cfg.AdminPath) {
		s.m.upstream.Add(1)
		s.proxy.ServeHTTP(w, r)
		return
	}

	if !s.cacheable(r) {
		s.m.bypass.Add(1)
		s.setCacheHeader(w, "BYPASS")
		s.m.upstream.Add(1)
		s.proxy.ServeHTTP(w, r)
		return
	}

	authenticated := isAuthenticated(r, s.cfg.AuthCookies)

	kb := keyBase{
		Prefix:   s.cfg.KeyPrefix,
		Version:  s.cfg.Version,
		Host:     requestHost(r, s.cfg.HostHeader),
		Method:   "GET",
		Pathname: r.URL.Path,
		Query:    normaliseQuery(r.URL.RawQuery, s.cfg.IgnoredParams),
		VaryHash: varyHash(r.Header, s.cfg.VaryHeaders),
	}

	keys := kb.lookupKeys(authenticated)

	if entry, ok := s.cache.Get(r.Context(), keys); ok && entry.mayServe(authenticated) {
		switch entry.freshness(time.Now()) {
		case Fresh:
			s.m.hit.Add(1)
			s.writeEntry(w, r, entry, "HIT")
			return

		case Stale:
			if s.cfg.StaleWhileRevalidate {
				s.m.stale.Add(1)
				// Serve now, wake the SSR pod behind the response. The visitor pays
				// nothing for the staleness and the pod re-stores the fresh render.
				go s.revalidate(kb, r, authenticated)
				s.writeEntry(w, r, entry, "STALE")
				return
			}
		}
	}

	s.m.miss.Add(1)
	s.setCacheHeader(w, "MISS")
	s.m.upstream.Add(1)
	s.proxy.ServeHTTP(w, r)
}

// cacheable is the cheap pre-check, mirroring request_is_cacheable in policy.js.
func (s *server) cacheable(r *http.Request) bool {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		return false
	}
	if r.Header.Get("Authorization") != "" {
		return false
	}
	cc := strings.ToLower(r.Header.Get("Cache-Control"))
	if strings.Contains(cc, "no-cache") || strings.Contains(cc, "no-store") {
		return false
	}
	if r.Header.Get("Upgrade") != "" {
		return false
	}
	return true
}

func (s *server) writeEntry(w http.ResponseWriter, r *http.Request, e *Entry, state string) {
	h := w.Header()
	for k, v := range e.Headers {
		h.Set(k, v)
	}
	if s.cfg.DebugHeaders {
		h.Set("X-Cache", state)
		h.Set("X-Cache-Age", fmt.Sprintf("%d", (time.Now().UnixMilli()-e.StoredAt)/1000))
		h.Set("X-Cache-Tier", "edge")
	}

	h.Set("Content-Length", fmt.Sprintf("%d", len(e.Body)))
	w.WriteHeader(e.Status)

	if r.Method == http.MethodHead {
		return
	}
	if _, err := w.Write(e.Body); err != nil {
		s.m.errors.Add(1)
	}
}

func (s *server) setCacheHeader(w http.ResponseWriter, state string) {
	if s.cfg.DebugHeaders {
		w.Header().Set("X-Cache", state)
		w.Header().Set("X-Cache-Tier", "edge")
	}
}

// revalidate wakes the SSR pod for a stale page. One replica wins the lock, so
// a stale hot page doesn't wake the pod once per concurrent request.
func (s *server) revalidate(kb keyBase, original *http.Request, authenticated bool) {
	segment := SegmentAnon
	if authenticated {
		segment = SegmentAuth
	}
	name := kb.key(segment)

	ctx, cancel := context.WithTimeout(context.Background(), s.cfg.UpstreamTimeout)
	defer cancel()

	if !s.cache.AcquireLock(ctx, name) {
		return
	}
	defer s.cache.ReleaseLock(ctx, name)

	s.m.revalidate.Add(1)

	target := *s.upstream
	target.Path = original.URL.Path
	target.RawQuery = original.URL.RawQuery

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target.String(), nil)
	if err != nil {
		return
	}

	// Carry the cookies through: the SSR pod re-derives the segment from them,
	// so a stale `anon` entry must be revalidated by an anonymous-looking request.
	for _, name := range []string{"Cookie", "Accept", "Accept-Language", "User-Agent"} {
		if v := original.Header.Get(name); v != "" {
			req.Header.Set(name, v)
		}
	}
	req.Header.Set("X-Forwarded-Host", kb.Host)
	req.Header.Set("X-Forwarded-Proto", "https")
	req.Header.Set("X-Cache-Revalidate", "1")
	req.Host = s.upstream.Host

	resp, err := s.client.Do(req)
	if err != nil {
		log.Printf("[revalidate] %s: %v", original.URL.Path, err)
		s.m.errors.Add(1)
		return
	}
	defer resp.Body.Close()
	// Draining matters: the SSR pod only stores the entry once it has finished
	// writing the response.
	_, _ = io.Copy(io.Discard, resp.Body)
}

func (s *server) writeMetrics(w http.ResponseWriter) {
	w.Header().Set("content-type", "text/plain; version=0.0.4")

	write := func(name, help string, value int64) {
		fmt.Fprintf(w, "# HELP %s %s\n# TYPE %s counter\n%s %d\n", name, help, name, name, value)
	}

	write("edge_cache_hits_total", "Responses served fresh from Redis.", s.m.hit.Load())
	write("edge_cache_stale_total", "Responses served stale while revalidating.", s.m.stale.Load())
	write("edge_cache_misses_total", "Cacheable requests with no usable entry.", s.m.miss.Load())
	write("edge_cache_bypass_total", "Requests ineligible for caching.", s.m.bypass.Load())
	write("edge_cache_revalidations_total", "Background revalidations started.", s.m.revalidate.Load())
	write("edge_upstream_requests_total", "Requests forwarded to the SSR service.", s.m.upstream.Load())
	write("edge_errors_total", "Proxy and upstream errors.", s.m.errors.Load())
}
