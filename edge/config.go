package main

import (
	"log"
	"os"
	"strconv"
	"strings"
	"time"
)

// Config is read entirely from the environment so the Helm chart is the single
// place this is tuned. The values that must agree with the SSR pods
// (CACHE_KEY_PREFIX, CACHE_VERSION, CACHE_AUTH_COOKIES, CACHE_IGNORED_PARAMS,
// CACHE_VARY_HEADERS) are injected into both from one place in values.yaml.
type Config struct {
	Listen   string
	Upstream string

	RedisURL   string
	KeyPrefix  string
	Version    string
	HostHeader string

	AuthCookies   []string
	IgnoredParams map[string]bool
	VaryHeaders   []string

	RedisTimeout    time.Duration
	UpstreamTimeout time.Duration

	LockTTL time.Duration

	// Serve a stale entry and wake the SSR pod behind it. When false a stale
	// entry is treated as a miss and the visitor waits for the render.
	StaleWhileRevalidate bool

	DebugHeaders bool
	AdminPath    string
}

func env(name, fallback string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return fallback
}

func envInt(name string, fallback int) int {
	if v := os.Getenv(name); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
		log.Printf("[config] %s=%q is not a number, using %d", name, v, fallback)
	}
	return fallback
}

func envBool(name string, fallback bool) bool {
	v := os.Getenv(name)
	if v == "" {
		return fallback
	}
	return v == "true" || v == "1" || v == "yes"
}

func envList(name string, fallback []string) []string {
	v := os.Getenv(name)
	if v == "" {
		return fallback
	}
	parts := strings.Split(v, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if t := strings.TrimSpace(p); t != "" {
			out = append(out, t)
		}
	}
	return out
}

func LoadConfig() Config {
	// Defaults mirror DEFAULT_AUTH_COOKIES / DEFAULT_IGNORED_PARAMS in
	// src/runtime/config.js. In a real deploy the chart sets both explicitly.
	defaultAuth := []string{
		"auth_token", "access_token", "refresh_token",
		"authToken", "refreshToken", "session", "auth", "user",
	}
	defaultIgnored := []string{
		"utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
		"utm_id", "gclid", "fbclid", "msclkid", "ref", "_ga",
	}

	ignored := map[string]bool{}
	for _, p := range envList("CACHE_IGNORED_PARAMS", defaultIgnored) {
		ignored[p] = true
	}

	c := Config{
		Listen:   env("LISTEN", ":8080"),
		Upstream: env("UPSTREAM", ""),

		RedisURL:   env("CACHE_REDIS_URL", "redis://127.0.0.1:6379"),
		KeyPrefix:  env("CACHE_KEY_PREFIX", "ssr"),
		Version:    env("CACHE_VERSION", ""),
		HostHeader: env("HOST_HEADER", "x-forwarded-host"),

		AuthCookies:   envList("CACHE_AUTH_COOKIES", defaultAuth),
		IgnoredParams: ignored,
		VaryHeaders:   envList("CACHE_VARY_HEADERS", nil),

		RedisTimeout:    time.Duration(envInt("CACHE_COMMAND_TIMEOUT", 200)) * time.Millisecond,
		UpstreamTimeout: time.Duration(envInt("UPSTREAM_TIMEOUT", 30000)) * time.Millisecond,
		LockTTL:         time.Duration(envInt("CACHE_LOCK_TTL", 10000)) * time.Millisecond,

		StaleWhileRevalidate: envBool("CACHE_STALE_WHILE_REVALIDATE", true),
		DebugHeaders:         envBool("CACHE_DEBUG_HEADERS", true),
		AdminPath:            env("CACHE_ADMIN_PATH", "/_cache"),
	}

	if c.Upstream == "" {
		log.Fatal("[config] UPSTREAM is required (the Knative service URL to proxy misses to)")
	}

	// Without a version the proxy would read from a namespace the SSR pods never
	// write to. Failing loudly beats a silent 0% hit rate.
	if c.Version == "" {
		log.Fatal("[config] CACHE_VERSION is required and must match the SSR deployment")
	}

	return c
}
