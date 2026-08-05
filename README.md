# knative-ssr

Deploy **any** SSR application on Kubernetes with the deployment shape Vercel and
Cloudflare give you: **Knative Serving** for request-driven scale-to-zero,
**Redis** for the ISR/SWR page cache, and an always-on **edge tier** so a cache
hit never has to wake a pod.

SvelteKit, Next, Nuxt, Astro, Remix, or a hand-rolled Node/Bun/Go server — if it
serves HTTP on a port, this deploys it.

```
Istio Gateway ──► edge-cache ──HIT──► Redis ──► response    (SSR pod stays asleep)
   TLS, host          │
                      └──MISS──► Knative Service ──► SSR pod (minScale 0)
```

| | What |
|---|---|
| `charts/ssr-knative` | Helm chart: Knative Service, edge Deployment, dedicated LRU Redis, Istio routing |
| `edge/` | The Go cache proxy — the always-on tier |
| `install/` | Knative Serving + net-istio manifests and config |
| `spec/` | The canonical cache-key format that adapters implement |

Framework adapters live in their own repos. Today: [`weeb-vip/adapter-knative`](https://github.com/weeb-vip/adapter-knative) (SvelteKit).

## Why an edge tier

A shared Redis cache is only half the problem — a hit still needs a live pod, so
with `minScale: 0` the first request after idle pays a cold start. Vercel avoids
this by serving hits at the edge, where the function is never invoked.

Same idea: keep the *cheap* thing warm, let the *expensive* thing sleep.

```
edge-cache   2 × (10m CPU, 32Mi)     always on
ssr          250m CPU, 512Mi–2Gi     only while rendering
```

Keeping an SSR pod warm instead costs roughly 16× the memory to answer the same
hits.

## Two ways to cache

Decided per response, so you can start with the first and graduate to the second.

**Standalone — no integration.** Your app emits standard headers; the proxy
stores the response. Works with any framework:

```http
Cache-Control: s-maxage=60, stale-while-revalidate=600
X-Cache-Tag: product:123, catalog
X-Cache-Segment: pub
```

**Adapter — richer control.** A framework adapter writes entries itself, with
per-route tags and segments the proxy can't infer from headers, and gets a
purge API. It marks responses with `X-Cache-Origin` so the proxy reads only.

```ts
// SvelteKit, via @weeb-vip/adapter-knative
platform?.cache?.public().ttl(60).swr(600).tag(`show:${id}`);
```

## Caching and login state

The hazard is serving one user's HTML to another. The default is **bypass, not
cache**: a request carrying a non-empty auth cookie is never served a shared
entry, and its response is never stored in a shared segment.

Isolation is enforced by the key rather than by a check after lookup, so a
mismatched request cannot reach the wrong entry at all:

```
ssr:{buildId}:{segment}:{host}:{method}:{path}?{query}:{varyHash}
                  │
                  ├─ pub        declared identical for everyone     shared
                  ├─ anon       no auth cookie                      logged-out only
                  ├─ auth       any logged-in user (opt-in)         never anon
                  └─ user:<id>  one specific user (opt-in)          off by default
```

Three refusals apply at write time whatever the app asked for:

- a response carrying `Set-Cookie` is never stored,
- `Cache-Control: private` / `no-store` is never stored,
- a response rendered for an authenticated request never lands in `pub`/`anon`,
  even if it declared itself public — that claim can't be verified after the
  fact, so it's declined.

> **Set `cache.authCookies` to match your app.** It is the most important value
> in `values.yaml`. If your session cookie isn't listed, logged-in pages can be
> cached and served to strangers. The defaults cover common names
> (`session`, `connect.sid`, `next-auth.session-token`, …) but they are a
> starting point, not an answer.

**The pattern that gets you a hit rate**: cache the public shell, personalise on
the client. Keep user-specific data out of the SSR'd HTML on cacheable routes and
fetch it after hydration. Then the page is `pub` — cached once, served to
everyone.

## Deploys invalidate the cache

Every key is namespaced by a build id, which the chart sets from the image tag.

Not optional hygiene: without it a deploy serves HTML rendered by the *previous*
build, referencing hashed asset URLs the new image doesn't have — pages that load
with 404'd JavaScript and look like a CDN fault.

- **Rollback** restores the old namespace, so unexpired entries are valid again.
- **Traffic splitting** gives each revision its own namespace; canary traffic
  can't poison the stable revision's cache.
- **A deploy starts cold.** Single-flight locking collapses concurrent misses on
  the same URL into one render rather than stampeding your backend.

Set `cacheVersion` to pin the namespace across a release you know can't change
rendered output.

## Install

```bash
# 1. Knative Serving + net-istio
./install/knative-serving/install.sh

# 2. Build and push the edge proxy
docker build -t registry.example.com/org/edge-cache:0.1.0 edge/
docker push registry.example.com/org/edge-cache:0.1.0

# 3. Deploy your app
helm upgrade --install myapp charts/ssr-knative -n web \
  -f charts/ssr-knative/examples/nextjs.yaml \
  --set ssr.image.tag=2024.11.03
```

Worked examples: [`examples/nextjs.yaml`](charts/ssr-knative/examples/nextjs.yaml)
(standalone) and [`examples/weeb-frontend.yaml`](charts/ssr-knative/examples/weeb-frontend.yaml)
(SvelteKit with an adapter). [`docs/cutover.md`](docs/cutover.md) covers moving an
existing Deployment across without downtime.

## Verifying

```bash
curl -sI https://myapp.example.com/ | grep -i x-cache
# x-cache: HIT          served from Redis
# x-cache-tier: edge    without waking an SSR pod
```

| `X-Cache` | Meaning |
|---|---|
| `HIT` | Served fresh from Redis |
| `STALE` | Served stale, revalidating behind it |
| `MISS` | Cacheable, nothing stored — rendered |
| `BYPASS` | Not eligible (POST, auth header, `no-cache`) |

`BYPASS` on a logged-in request is correct. `MISS` forever means nothing opted
in — freshness must be explicit, by design.

```bash
kubectl -n web port-forward deploy/myapp-edge 8080:8080
curl localhost:8080/_edge/metrics
```

## Failure modes

Redis down is a degradation, never an outage. Both tiers fail open, with a
circuit breaker that stops calling Redis after 5 consecutive errors so a dead
Redis doesn't add its timeout to every request. The site serves uncached SSR and
the SSR pods scale up to absorb it. Watch `edge_cache_hits_total` go flat.

The edge tier is the one component with no failover: 2 replicas, a
PodDisruptionBudget, spread across nodes. `edge.enabled=false` routes Istio
straight at the Knative Service if you need it out of the path — caching still
works, it just costs a cold start on hits.

## The cache-key spec

`spec/key-vectors.json` is the canonical definition of how a cache key is built,
generated from the Go implementation here:

```bash
cd edge && go test ./... -run TestSpecVectors -update
```

This repo owns the format because the edge proxy is the one component every
deployment runs. Adapters are consumers: their CI asserts their key builder
against this file and pins `version`.

Take it seriously — a key mismatch between an adapter and the proxy doesn't
error, it just makes the proxy read keys nobody wrote, and the symptom is a 0%
hit rate that reads as "caching isn't working." Writing these vectors caught
three real divergences: Go's `url.ParseQuery` dropping query segments containing
`;`, `net/http` rejecting cookie values the JS parser accepts, and a `null` vs
`[]` mismatch in the published spec.

If you change the format, regenerate the vectors, bump `SpecVersion`, and expect
every adapter's CI to fail until it catches up. That is the mechanism working.

## Development

```bash
cd edge && go test ./...     # key format, storage policy, segment isolation
helm lint charts/ssr-knative
```
