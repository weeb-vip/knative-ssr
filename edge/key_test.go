package main

import (
	"encoding/json"
	"net/http"
	"os"
	"testing"
)

// These tests assert that the Go key builder produces byte-identical output to
// the JavaScript one in src/runtime/key.js. The vectors are generated from the
// JS side (go test ./... -run TestSpecVectors -update), so a drift in either direction
// fails here.
//
// This matters more than it looks: a key mismatch doesn't error, it just makes
// the proxy look up keys nobody wrote. The symptom is a 0% hit rate that reads
// as "caching isn't working" rather than as a bug.

type vectors struct {
	Keys []struct {
		Name  string `json:"name"`
		Input struct {
			Prefix   string   `json:"prefix"`
			Version  string   `json:"version"`
			Segment  string   `json:"segment"`
			Host     string   `json:"host"`
			Method   string   `json:"method"`
			Pathname string   `json:"pathname"`
			RawQuery string   `json:"rawQuery"`
			Ignored  []string `json:"ignored"`
		} `json:"input"`
		NormalisedQuery string `json:"normalisedQuery"`
		Key             string `json:"key"`
	} `json:"keys"`

	Vary []struct {
		Name        string            `json:"name"`
		Headers     map[string]string `json:"headers"`
		VaryHeaders []string          `json:"varyHeaders"`
		Hash        string            `json:"hash"`
	} `json:"vary"`

	Auth []struct {
		Cookie        string   `json:"cookie"`
		AuthCookies   []string `json:"authCookies"`
		Authenticated bool     `json:"authenticated"`
	} `json:"auth"`
}

func load(t *testing.T) vectors {
	t.Helper()

	raw, err := os.ReadFile("../spec/key-vectors.json")
	if err != nil {
		t.Fatalf("read vectors (run: go test ./... -run TestSpecVectors -update): %v", err)
	}

	var v vectors
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatalf("parse vectors: %v", err)
	}
	if len(v.Keys) == 0 {
		t.Fatal("no key vectors")
	}
	return v
}

func TestKeyMatchesJavaScript(t *testing.T) {
	v := load(t)

	for _, c := range v.Keys {
		t.Run(c.Name, func(t *testing.T) {
			ignored := map[string]bool{}
			for _, p := range c.Input.Ignored {
				ignored[p] = true
			}

			gotQuery := normaliseQuery(c.Input.RawQuery, ignored)
			if gotQuery != c.NormalisedQuery {
				t.Errorf("query\n  go = %q\n  js = %q", gotQuery, c.NormalisedQuery)
			}

			kb := keyBase{
				Prefix:   c.Input.Prefix,
				Version:  c.Input.Version,
				Host:     c.Input.Host,
				Method:   c.Input.Method,
				Pathname: c.Input.Pathname,
				Query:    gotQuery,
				VaryHash: "0",
			}

			if got := kb.key(c.Input.Segment); got != c.Key {
				t.Errorf("key\n  go = %q\n  js = %q", got, c.Key)
			}
		})
	}
}

func TestVaryHashMatchesJavaScript(t *testing.T) {
	v := load(t)

	for _, c := range v.Vary {
		t.Run(c.Name, func(t *testing.T) {
			h := http.Header{}
			for k, val := range c.Headers {
				h.Set(k, val)
			}
			if got := varyHash(h, c.VaryHeaders); got != c.Hash {
				t.Errorf("vary hash\n  go = %q\n  js = %q", got, c.Hash)
			}
		})
	}
}

func TestAuthDetectionMatchesJavaScript(t *testing.T) {
	v := load(t)

	for _, c := range v.Auth {
		t.Run(c.Cookie, func(t *testing.T) {
			r := &http.Request{Header: http.Header{}}
			if c.Cookie != "" {
				r.Header.Set("Cookie", c.Cookie)
			}
			if got := isAuthenticated(r, c.AuthCookies); got != c.Authenticated {
				t.Errorf("authenticated for %q: go = %v, js = %v", c.Cookie, got, c.Authenticated)
			}
		})
	}
}

// A logged-in request must never be able to read an anonymous entry, and vice
// versa. Segment isolation is structural — different segments are different
// keys — but mayServe is the backstop if the key format ever regresses.
func TestSegmentIsolation(t *testing.T) {
	cases := []struct {
		segment       string
		authenticated bool
		want          bool
	}{
		{SegmentPublic, false, true},
		{SegmentPublic, true, true},
		{SegmentAnon, false, true},
		{SegmentAnon, true, false}, // the leak this whole design exists to prevent
		{SegmentAuth, true, true},
		{SegmentAuth, false, false},
		{"user:42", true, false}, // proxy has no identity to compare
		{"user:42", false, false},
		{"", false, false},
		{"garbage", true, false},
	}

	for _, c := range cases {
		e := &Entry{Segment: c.segment}
		if got := e.mayServe(c.authenticated); got != c.want {
			t.Errorf("segment %q authed=%v: got %v want %v",
				c.segment, c.authenticated, got, c.want)
		}
	}
}
