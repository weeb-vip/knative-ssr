package main

import (
	"net/http"
	"testing"
)

// Mirrors test/policy.test.js. These are the rules that stop one user seeing
// another user's page, and they now exist in two languages — the adapter
// enforces them for its own writes, this proxy enforces them for every other
// framework. They must not drift.

func testConfig() Config {
	return Config{MaxTTL: 86400, VaryHeaders: nil}
}

func resp(status int, headers map[string]string) *http.Response {
	h := http.Header{}
	for k, v := range headers {
		h.Add(k, v)
	}
	return &http.Response{StatusCode: status, Header: h}
}

func TestAuthenticatedRequestNotStoredByDefault(t *testing.T) {
	d := DecideStorage(resp(200, map[string]string{"Cache-Control": "s-maxage=60"}), true, testConfig())
	if d != nil {
		t.Fatalf("stored an authenticated render in segment %q", d.Segment)
	}
}

func TestPublicRefusedForAuthenticatedRequest(t *testing.T) {
	// An origin claiming a page is public cannot be verified once it has
	// rendered with a logged-in user's data, so the claim is declined.
	d := DecideStorage(
		resp(200, map[string]string{"Cache-Control": "s-maxage=60", HeaderSegment: "pub"}),
		true, testConfig(),
	)
	if d != nil {
		t.Fatalf("honoured pub for an authenticated request: %q", d.Segment)
	}
}

func TestPublicHonouredForAnonymousRequest(t *testing.T) {
	d := DecideStorage(
		resp(200, map[string]string{"Cache-Control": "s-maxage=60", HeaderSegment: "pub"}),
		false, testConfig(),
	)
	if d == nil || d.Segment != SegmentPublic {
		t.Fatalf("expected pub, got %+v", d)
	}
}

func TestAnonymousDefaultsToAnonNotPub(t *testing.T) {
	// Sharing with logged-in users must be opted into explicitly; an origin that
	// says nothing gets the isolated segment.
	d := DecideStorage(resp(200, map[string]string{"Cache-Control": "s-maxage=60"}), false, testConfig())
	if d == nil || d.Segment != SegmentAnon {
		t.Fatalf("expected anon, got %+v", d)
	}
}

func TestSharedSegmentRequiresAuthentication(t *testing.T) {
	if d := DecideStorage(
		resp(200, map[string]string{"Cache-Control": "s-maxage=60", HeaderSegment: "auth"}),
		false, testConfig(),
	); d != nil {
		t.Fatalf("stored auth segment for an anonymous request: %+v", d)
	}

	d := DecideStorage(
		resp(200, map[string]string{"Cache-Control": "s-maxage=60", HeaderSegment: "auth"}),
		true, testConfig(),
	)
	if d == nil || d.Segment != SegmentAuth {
		t.Fatalf("expected auth, got %+v", d)
	}
}

func TestSetCookieNeverStored(t *testing.T) {
	d := DecideStorage(
		resp(200, map[string]string{
			"Cache-Control": "s-maxage=60",
			HeaderSegment:   "pub",
			"Set-Cookie":    "auth_token=fresh; Path=/",
		}),
		false, testConfig(),
	)
	if d != nil {
		t.Fatal("stored a response that sets a cookie")
	}
}

func TestPrivateAndNoStoreRefused(t *testing.T) {
	for _, cc := range []string{"private, s-maxage=60", "no-store, s-maxage=60"} {
		if d := DecideStorage(
			resp(200, map[string]string{"Cache-Control": cc, HeaderSegment: "pub"}),
			false, testConfig(),
		); d != nil {
			t.Errorf("stored %q", cc)
		}
	}
}

func TestVaryRefusals(t *testing.T) {
	for _, vary := range []string{"Cookie", "cookie, accept-encoding", "Authorization", "*", "Accept-Language"} {
		if d := DecideStorage(
			resp(200, map[string]string{"Cache-Control": "s-maxage=60", HeaderSegment: "pub", "Vary": vary}),
			false, testConfig(),
		); d != nil {
			t.Errorf("stored despite Vary: %s", vary)
		}
	}
}

func TestVaryOnKeyedHeaderAllowed(t *testing.T) {
	cfg := testConfig()
	cfg.VaryHeaders = []string{"accept-language"}

	d := DecideStorage(
		resp(200, map[string]string{"Cache-Control": "s-maxage=60", HeaderSegment: "pub", "Vary": "Accept-Language"}),
		false, cfg,
	)
	if d == nil {
		t.Fatal("refused a Vary on a keyed header")
	}
}

func TestVaryOnAcceptEncodingAllowed(t *testing.T) {
	// Bodies are stored decoded; encoding is negotiated downstream.
	d := DecideStorage(
		resp(200, map[string]string{"Cache-Control": "s-maxage=60", HeaderSegment: "pub", "Vary": "Accept-Encoding"}),
		false, testConfig(),
	)
	if d == nil {
		t.Fatal("refused Vary: Accept-Encoding")
	}
}

func TestNonOKNeverStored(t *testing.T) {
	for _, status := range []int{301, 404, 500, 206, 304} {
		if d := DecideStorage(
			resp(status, map[string]string{"Cache-Control": "s-maxage=60", HeaderSegment: "pub"}),
			false, testConfig(),
		); d != nil {
			t.Errorf("stored status %d", status)
		}
	}
}

func TestAdapterManagedResponsesAreSkipped(t *testing.T) {
	// The adapter already wrote this entry with tags and a segment the proxy
	// cannot infer. Storing again would produce a competing, dumber copy.
	d := DecideStorage(
		resp(200, map[string]string{
			"Cache-Control": "s-maxage=60",
			HeaderOrigin:    "adapter-knative",
		}),
		false, testConfig(),
	)
	if d != nil {
		t.Fatal("double-stored an adapter-managed response")
	}
}

func TestFreshnessMustBeExplicit(t *testing.T) {
	// No s-maxage and no X-Cache-TTL: an origin that says nothing gets nothing
	// cached, matching the adapter's defaultTtl of 0.
	if d := DecideStorage(resp(200, map[string]string{HeaderSegment: "pub"}), false, testConfig()); d != nil {
		t.Fatal("cached a response with no freshness directive")
	}
}

func TestExplicitHeadersBeatCacheControl(t *testing.T) {
	d := DecideStorage(
		resp(200, map[string]string{
			"Cache-Control": "s-maxage=10, stale-while-revalidate=20",
			HeaderTTL:       "300",
			HeaderSWR:       "600",
			HeaderSegment:   "pub",
		}),
		false, testConfig(),
	)
	if d == nil || d.TTL != 300 || d.SWR != 600 {
		t.Fatalf("expected 300/600, got %+v", d)
	}
}

func TestTTLClampedToMax(t *testing.T) {
	d := DecideStorage(
		resp(200, map[string]string{HeaderTTL: "999999", HeaderSWR: "999999", HeaderSegment: "pub"}),
		false, testConfig(),
	)
	if d == nil || d.TTL != 86400 || d.SWR != 86400 {
		t.Fatalf("expected clamping to 86400, got %+v", d)
	}
}

func TestStaleWhileRevalidateParsed(t *testing.T) {
	d := DecideStorage(
		resp(200, map[string]string{"Cache-Control": "s-maxage=60, stale-while-revalidate=600", HeaderSegment: "pub"}),
		false, testConfig(),
	)
	if d == nil || d.TTL != 60 || d.SWR != 600 {
		t.Fatalf("expected 60/600, got %+v", d)
	}
}

func TestTagsParsed(t *testing.T) {
	h := http.Header{}
	h.Set("Cache-Control", "s-maxage=60")
	h.Set(HeaderSegment, "pub")
	h.Add(HeaderTag, "show:123, airing")
	h.Add(HeaderTag, "home")

	d := DecideStorage(&http.Response{StatusCode: 200, Header: h}, false, testConfig())
	if d == nil {
		t.Fatal("refused")
	}
	want := []string{"show:123", "airing", "home"}
	if len(d.Tags) != len(want) {
		t.Fatalf("got %v want %v", d.Tags, want)
	}
	for i := range want {
		if d.Tags[i] != want[i] {
			t.Fatalf("got %v want %v", d.Tags, want)
		}
	}
}

func TestControlHeadersNotStored(t *testing.T) {
	h := http.Header{}
	h.Set("Content-Type", "text/html")
	h.Set("Set-Cookie", "a=b")
	h.Set("Content-Encoding", "gzip")
	h.Set("Content-Length", "123")
	h.Set(HeaderTag, "x")
	h.Set(HeaderSegment, "pub")
	h.Set(HeaderOrigin, "adapter")

	stored := storableHeaders(h)

	for _, banned := range []string{"Set-Cookie", "Content-Encoding", "Content-Length", HeaderTag, HeaderSegment, HeaderOrigin} {
		if _, present := stored[banned]; present {
			t.Errorf("%s must not be stored", banned)
		}
	}
	if stored["Content-Type"] != "text/html" {
		t.Error("content-type should survive")
	}
}

func TestRequestCacheable(t *testing.T) {
	cases := []struct {
		method  string
		headers map[string]string
		want    bool
	}{
		{"GET", nil, true},
		{"HEAD", nil, true},
		{"POST", nil, false},
		{"PUT", nil, false},
		{"DELETE", nil, false},
		{"GET", map[string]string{"Authorization": "Bearer x"}, false},
		{"GET", map[string]string{"Cache-Control": "no-cache"}, false},
		{"GET", map[string]string{"Cache-Control": "no-store"}, false},
		{"GET", map[string]string{"Upgrade": "websocket"}, false},
	}

	for _, c := range cases {
		r := &http.Request{Method: c.method, Header: http.Header{}}
		for k, v := range c.headers {
			r.Header.Set(k, v)
		}
		if got := RequestCacheable(r); got != c.want {
			t.Errorf("%s %v: got %v want %v", c.method, c.headers, got, c.want)
		}
	}
}
