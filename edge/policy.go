package main

import (
	"net/http"
	"strconv"
	"strings"
)

// Storage policy for responses from an arbitrary SSR origin.
//
// THIS FILE IS A CONTRACT, in the same way key.go is. It mirrors
// src/runtime/policy.js. When the SvelteKit adapter is in use it does its own
// storing and this path stays out of the way; for every other framework this is
// the only thing deciding what may be cached and who may see it.
//
// Everything here is biased towards refusing to store. A missed caching
// opportunity is a slow page; a wrong one serves a logged-in user's HTML to a
// stranger.

// Headers an origin uses to control caching without needing an adapter.
const (
	// Set by our own SvelteKit adapter so this proxy doesn't double-store what
	// the origin already wrote (with better information than we have).
	HeaderOrigin  = "X-Cache-Origin"
	HeaderTag     = "X-Cache-Tag"
	HeaderSegment = "X-Cache-Segment"
	HeaderTTL     = "X-Cache-TTL"
	HeaderSWR     = "X-Cache-SWR"
)

// Control headers are stripped before an entry is stored and before the
// response reaches the client — they are our transport, not the app's output.
var controlHeaders = []string{HeaderOrigin, HeaderTag, HeaderSegment, HeaderTTL, HeaderSWR}

type StorageDecision struct {
	Segment string
	TTL     int64
	SWR     int64
	Tags    []string
}

func parseCacheControl(value string) map[string]string {
	out := map[string]string{}
	if value == "" {
		return out
	}
	for _, part := range strings.Split(value, ",") {
		k, v, found := strings.Cut(part, "=")
		k = strings.ToLower(strings.TrimSpace(k))
		if k == "" {
			continue
		}
		if found {
			out[k] = strings.Trim(strings.TrimSpace(v), `"`)
		} else {
			out[k] = ""
		}
	}
	return out
}

func ccSeconds(cc map[string]string, name string) (int64, bool) {
	raw, ok := cc[name]
	if !ok || raw == "" {
		return 0, false
	}
	n, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || n < 0 {
		return 0, false
	}
	return n, true
}

func headerSeconds(h http.Header, name string) (int64, bool) {
	raw := h.Get(name)
	if raw == "" {
		return 0, false
	}
	n, err := strconv.ParseInt(strings.TrimSpace(raw), 10, 64)
	if err != nil || n < 0 {
		return 0, false
	}
	return n, true
}

// RequestCacheable is the cheap pre-check, mirroring request_is_cacheable.
func RequestCacheable(r *http.Request) bool {
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

// DecideStorage reports whether an upstream response may be stored, in which
// segment, and for how long. A nil return means refuse.
func DecideStorage(resp *http.Response, authenticated bool, cfg Config) *StorageDecision {
	// The SvelteKit adapter writes its own entries, with cache tags and segment
	// information this proxy cannot see. Storing again here would produce a
	// second, dumber copy under a key the adapter may consider stale.
	if resp.Header.Get(HeaderOrigin) != "" {
		return nil
	}

	// Only successful, complete responses. 206 and 304 have no full body to
	// store, and error pages must not be pinned for a TTL.
	if resp.StatusCode != http.StatusOK {
		return nil
	}

	// Setting a cookie means the response is establishing state specific to this
	// caller. Storing it would hand that state to whoever reads the entry next.
	if len(resp.Header.Values("Set-Cookie")) > 0 {
		return nil
	}

	cc := parseCacheControl(resp.Header.Get("Cache-Control"))
	if _, no := cc["no-store"]; no {
		return nil
	}
	if _, priv := cc["private"]; priv {
		return nil
	}

	if !varyIsKeyable(resp.Header, cfg) {
		return nil
	}

	segment := resolveSegment(resp.Header.Get(HeaderSegment), authenticated)
	if segment == "" {
		return nil
	}

	// Freshness must be explicit. An origin that says nothing gets nothing
	// cached — the same opt-in default as the adapter's defaultTtl of 0.
	ttl, ok := headerSeconds(resp.Header, HeaderTTL)
	if !ok {
		ttl, ok = ccSeconds(cc, "s-maxage")
	}
	if !ok || ttl <= 0 {
		return nil
	}
	if ttl > cfg.MaxTTL {
		ttl = cfg.MaxTTL
	}

	swr, ok := headerSeconds(resp.Header, HeaderSWR)
	if !ok {
		swr, _ = ccSeconds(cc, "stale-while-revalidate")
	}
	if swr > cfg.MaxTTL {
		swr = cfg.MaxTTL
	}

	return &StorageDecision{Segment: segment, TTL: ttl, SWR: swr, Tags: parseTags(resp.Header)}
}

// varyIsKeyable refuses any Vary we do not key on. Varying on something we
// ignore means storing one variant and serving it to requests that should have
// received another; Cookie and Authorization are called out because those would
// leak rather than merely mis-serve.
func varyIsKeyable(h http.Header, cfg Config) bool {
	keyed := map[string]bool{
		// Bodies are stored decoded, so encoding negotiation happens downstream.
		"accept-encoding": true,
	}
	for _, v := range cfg.VaryHeaders {
		keyed[strings.ToLower(strings.TrimSpace(v))] = true
	}

	for _, value := range h.Values("Vary") {
		for _, field := range strings.Split(value, ",") {
			f := strings.ToLower(strings.TrimSpace(field))
			if f == "" {
				continue
			}
			if f == "*" || f == "cookie" || f == "authorization" {
				return false
			}
			if !keyed[f] {
				return false
			}
		}
	}
	return true
}

// resolveSegment decides which segment a response may be stored in.
//
// The rule that matters: a response rendered for a logged-in user never lands
// in pub or anon. An origin can declare a page public, but that declaration is
// only honoured for requests that carried no auth cookie — otherwise a single
// mis-annotated route leaks on the first logged-in request.
func resolveSegment(declared string, authenticated bool) string {
	switch strings.ToLower(strings.TrimSpace(declared)) {
	case SegmentPublic:
		if authenticated {
			return ""
		}
		return SegmentPublic

	case SegmentAuth:
		if !authenticated {
			return ""
		}
		return SegmentAuth

	case SegmentAnon:
		if authenticated {
			return ""
		}
		return SegmentAnon
	}

	// Nothing declared. An authenticated request is not cached at all; an
	// anonymous one goes to its own segment, where no logged-in request can
	// reach it. Sharing with logged-in users requires opting in explicitly.
	if authenticated {
		return ""
	}
	return SegmentAnon
}

func parseTags(h http.Header) []string {
	var tags []string
	for _, value := range h.Values(HeaderTag) {
		for _, t := range strings.Split(value, ",") {
			if trimmed := strings.TrimSpace(t); trimmed != "" {
				tags = append(tags, trimmed)
			}
		}
	}
	return tags
}

// storableHeaders copies response headers minus the ones that must not be
// replayed to the next visitor.
func storableHeaders(h http.Header) map[string]string {
	skip := map[string]bool{
		"set-cookie":        true,
		"content-encoding":  true,
		"content-length":    true,
		"transfer-encoding": true,
		"connection":        true,
		"keep-alive":        true,
		"upgrade":           true,
	}
	for _, c := range controlHeaders {
		skip[strings.ToLower(c)] = true
	}

	out := map[string]string{}
	for k, v := range h {
		if skip[strings.ToLower(k)] || len(v) == 0 {
			continue
		}
		out[k] = v[0]
	}
	return out
}

func stripControlHeaders(h http.Header) {
	for _, c := range controlHeaders {
		h.Del(c)
	}
}
