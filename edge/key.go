package main

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"

	"sort"
	"strings"
)

// Cache key construction.
//
// THIS FILE IS A CONTRACT. It must produce byte-identical keys to
// src/runtime/key.js in the adapter, or this proxy will never find anything the
// SSR pods wrote — and the failure mode is silent: a 0% hit rate that looks
// like "the cache isn't working" rather than an error. The shared vectors in
// test/key-vectors.json are checked by both sides.
//
//	{prefix}:{version}:{segment}:{host}:{method}:{path}?{query}:{varyHash}

const (
	SegmentPublic = "pub"
	SegmentAnon   = "anon"
	SegmentAuth   = "auth"
)

// encodeURIComponent mirrors the JavaScript global of the same name.
//
// Deliberately not url.QueryEscape: that encodes space as '+' and escapes
// !*'() , none of which encodeURIComponent touches. Getting this wrong would
// desync the two implementations for any URL with punctuation in a query value.
func encodeURIComponent(s string) string {
	const unreserved = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()"

	var b strings.Builder
	b.Grow(len(s))

	for i := 0; i < len(s); i++ {
		c := s[i]
		if strings.IndexByte(unreserved, c) >= 0 {
			b.WriteByte(c)
		} else {
			fmt.Fprintf(&b, "%%%02X", c)
		}
	}
	return b.String()
}

// parseCookies mirrors parse_cookies in key.js.
//
// Deliberately not r.Cookie(): net/http applies RFC 6265 validation and drops
// anything it considers malformed — a value containing a space, for instance —
// whereas the JS side trims and accepts it. That difference decides whether a
// request counts as logged-in, so the two must agree exactly rather than each
// being independently reasonable.
func parseCookies(header string) map[string]string {
	out := map[string]string{}
	if header == "" {
		return out
	}

	for _, part := range strings.Split(header, ";") {
		eq := strings.Index(part, "=")
		if eq < 1 {
			continue
		}
		name := strings.TrimSpace(part[:eq])
		value := strings.TrimSpace(part[eq+1:])
		if name != "" {
			out[name] = value
		}
	}
	return out
}

// isAuthenticated reports whether the request carries a logged-in user's cookie.
//
// Generous by design, matching key.js: a false positive costs a cache miss, a
// false negative could serve someone else's HTML.
func isAuthenticated(r *http.Request, authCookies []string) bool {
	cookies := parseCookies(r.Header.Get("Cookie"))

	for _, name := range authCookies {
		v, ok := cookies[name]
		if !ok {
			continue
		}
		if v != "" && v != "null" && v != "undefined" && v != "deleted" {
			return true
		}
	}
	return false
}

func unhex(c byte) (byte, bool) {
	switch {
	case c >= '0' && c <= '9':
		return c - '0', true
	case c >= 'a' && c <= 'f':
		return c - 'a' + 10, true
	case c >= 'A' && c <= 'F':
		return c - 'A' + 10, true
	}
	return 0, false
}

// decodeFormComponent decodes one query component the way URLSearchParams does:
// '+' is a space, valid %XX pairs decode, and anything malformed is left alone
// rather than raising an error.
//
// (Bytes that don't form valid UTF-8 stay as-is here, where JS would substitute
// U+FFFD. Both sides then re-encode byte-wise, so this only diverges for query
// strings that were already not valid UTF-8.)
func decodeFormComponent(s string) string {
	var b strings.Builder
	b.Grow(len(s))

	for i := 0; i < len(s); i++ {
		switch {
		case s[i] == '+':
			b.WriteByte(' ')
		case s[i] == '%' && i+2 < len(s):
			hi, ok1 := unhex(s[i+1])
			lo, ok2 := unhex(s[i+2])
			if ok1 && ok2 {
				b.WriteByte(hi<<4 | lo)
				i += 2
			} else {
				b.WriteByte(s[i])
			}
		default:
			b.WriteByte(s[i])
		}
	}
	return b.String()
}

// parseQuery splits a raw query string the way URLSearchParams does.
//
// Deliberately not url.ParseQuery: since Go 1.17 that rejects ';' as an illegal
// separator and *drops* the offending segment, while URLSearchParams treats ';'
// as an ordinary character in a value. Using it here made the proxy compute a
// different key than the SSR pods for any URL containing a semicolon — a silent
// 0% hit rate rather than an error.
func parseQuery(raw string) [][2]string {
	var out [][2]string

	for _, seg := range strings.Split(raw, "&") {
		if seg == "" {
			continue
		}
		k, v, _ := strings.Cut(seg, "=")
		out = append(out, [2]string{decodeFormComponent(k), decodeFormComponent(v)})
	}
	return out
}

// normaliseQuery drops tracking params and sorts the rest, so two URLs that
// render identically land on one key.
func normaliseQuery(raw string, ignored map[string]bool) string {
	type pair struct{ k, v string }

	var pairs []pair
	for _, kv := range parseQuery(raw) {
		if ignored[kv[0]] {
			continue
		}
		pairs = append(pairs, pair{kv[0], kv[1]})
	}

	// Byte-order sort. JS sorts by UTF-16 code unit, which agrees with this for
	// everything up to U+FFFF; query keys outside the BMP would diverge, and are
	// not a case either side needs to support.
	sort.Slice(pairs, func(i, j int) bool {
		if pairs[i].k != pairs[j].k {
			return pairs[i].k < pairs[j].k
		}
		return pairs[i].v < pairs[j].v
	})

	parts := make([]string, 0, len(pairs))
	for _, p := range pairs {
		parts = append(parts, encodeURIComponent(p.k)+"="+encodeURIComponent(p.v))
	}
	return strings.Join(parts, "&")
}

// varyHash hashes the request values of the headers we key on.
func varyHash(h http.Header, varyHeaders []string) string {
	if len(varyHeaders) == 0 {
		return "0"
	}

	lowered := make([]string, len(varyHeaders))
	for i, v := range varyHeaders {
		lowered[i] = strings.ToLower(v)
	}
	sort.Strings(lowered)

	parts := make([]string, 0, len(lowered))
	for _, name := range lowered {
		parts = append(parts, name+"="+h.Get(name))
	}

	sum := sha256.Sum256([]byte(strings.Join(parts, "\n")))
	return hex.EncodeToString(sum[:])[:16]
}

// requestHost resolves the host the page is rendered for. Cache keys are
// host-scoped because absolute URLs and canonical tags embed it.
func requestHost(r *http.Request, hostHeader string) string {
	if v := r.Header.Get(hostHeader); v != "" {
		return strings.ToLower(v)
	}
	if r.Host != "" {
		return strings.ToLower(r.Host)
	}
	return "unknown"
}

type keyBase struct {
	Prefix   string
	Version  string
	Host     string
	Method   string
	Pathname string
	Query    string
	VaryHash string
}

func (kb keyBase) key(segment string) string {
	suffix := kb.Pathname
	if kb.Query != "" {
		suffix = kb.Pathname + "?" + kb.Query
	}
	return strings.Join([]string{
		kb.Prefix, kb.Version, segment, kb.Host, kb.Method, suffix, kb.VaryHash,
	}, ":")
}

// lookupKeys returns the keys to check, in priority order: a shared `pub` entry
// beats the segment-specific one. Both are fetched in a single MGET.
func (kb keyBase) lookupKeys(authenticated bool) []string {
	segment := SegmentAnon
	if authenticated {
		segment = SegmentAuth
	}
	return []string{kb.key(SegmentPublic), kb.key(segment)}
}

func lockKey(cacheKey string) string {
	return "lock:" + cacheKey
}
