# knative-ssr

SSR deployment for Kubernetes, shaped like Vercel/Cloudflare but running on your
own cluster: **Knative Serving** for request-driven scale-to-zero, **Redis** for
the ISR/SWR page cache, and an always-on **edge tier** so a cache hit never has
to wake a pod.

Built for `weeb-frontend` on staging. Production stays on Cloudflare.

```
Istio Gateway ──► edge-cache ──HIT──► Redis ──► response    (SSR pod stays asleep)
   TLS, host          │
                      └──MISS──► Knative Service ──► SSR pod (minScale 0)
                                                        │
                                                        └─► renders, writes to Redis
```

Three pieces:

| | What it is | Why |
|---|---|---|
| `@weeb-vip/adapter-knative` | SvelteKit adapter wrapping `adapter-node` | The **writer**. Only it knows the render, the cache tags and the TTL. |
| `edge/` | ~500 lines of Go | The **reader**. Small enough to keep always-on cheaply, so SSR can scale to zero. |
| `charts/weeb-ssr-knative` | Helm chart | Knative Service, edge Deployment, dedicated Redis, Istio routing. |

## Why an edge tier at all

An in-process cache is shared (the data is in Redis, not pod memory), but a hit
still needs a live pod. With `minScale: 0` that means a cold start on the first
request after idle — the exact thing Vercel avoids by serving hits at the edge,
where the function is never invoked.

So: keep the *cheap* thing warm and let the *expensive* thing sleep.

```
edge-cache   2 × (10m CPU, 32Mi)     always on
ssr          250m CPU, 512Mi–2Gi     only while rendering
```

Keeping an SSR pod warm instead would cost ~16× the memory to answer the same
cache hits.

## Caching and login state

The hazard is serving one user's HTML to another. The default is therefore
**bypass, not cache**: any request carrying a non-empty auth cookie is neither
read from nor written to the cache unless a route opts in.

Isolation is enforced by the key, not by a check after lookup — a mismatched
request cannot reach the wrong entry at all:

```
ssr:{buildId}:{segment}:{host}:{method}:{path}?{query}:{varyHash}
                  │
                  ├─ pub        declared identical for everyone     shared
                  ├─ anon       no auth cookie                      logged-out only
                  ├─ auth       any logged-in user (opt-in)         never anon
                  └─ user:<id>  one specific user (opt-in)          off by default
```

Three refusals apply at write time regardless of what a route asked for:

- a response carrying `Set-Cookie` is never stored (this catches the token
  refresh in `hooks.server.ts` automatically),
- `Cache-Control: private` / `no-store` is never stored,
- a response rendered for an authenticated request never lands in `pub`/`anon`,
  even if the route called `.public()` — the claim can't be verified after the
  fact, so it's declined.

**The pattern that gets you a hit rate**: cache the public shell, personalise on
the client. A show page is public content wrapped in a personalised header —
keep the user-specific parts out of the SSR'd HTML and let TanStack Query fetch
them after hydration. Then the page is `pub`, cached once, served to everyone.

## Deploys invalidate the cache

Every key is namespaced by a build id, defaulting to `kit.version.name` at build
time and overridden by `CACHE_VERSION` (the chart sets it from the image tag).

This is not optional hygiene. Without it, a deploy serves HTML rendered by the
*previous* build, referencing `/_app/immutable/*` chunks that don't exist in the
new image — pages that load with 404'd JavaScript and look like a CDN fault.

Consequences that fall out of it:

- **Rollback** restores the old prefix, so unexpired entries are valid again.
- **Traffic splitting** gives each revision its own namespace; canary traffic
  can't poison the stable revision's cache.
- **A deploy starts cold.** Single-flight locking means concurrent misses on the
  same URL collapse to one render rather than stampeding your GraphQL gateway.

Set `cacheVersion` explicitly to pin the namespace across a release you know
can't change rendered output.

## Usage

```js
// svelte.config.js
import knative from '@weeb-vip/adapter-knative';

export default {
  kit: {
    adapter: knative({
      out: 'build',
      cache: { defaultTtl: 0 }   // opt-in per route; see below
    })
  }
};
```

Routes opt in through `platform.cache`:

```ts
// src/routes/show/[id]/+page.server.ts
export const load = async ({ params, platform }) => {
  platform?.cache
    ?.public()                  // identical for every visitor
    .ttl(60)                    // fresh for 60s
    .swr(600)                   // then serve stale up to 10min while refreshing
    .tag(`show:${params.id}`);  // purgeable when the show changes

  return { show: await getShow(params.id) };
};
```

`platform.cache` is absent on Cloudflare, so the optional chaining keeps the
same source building for both targets.

Purge by tag when upstream data changes:

```bash
curl -X POST https://staging.weeb.vip/_cache/purge \
  -H "Authorization: Bearer $CACHE_PURGE_TOKEN" \
  -d '{"tags":["show:12345"]}'
```

## Install

```bash
# 1. Knative Serving + net-istio (not currently in the cluster)
./install/knative-serving/install.sh

# 2. Build and push the edge proxy
docker build -t harbor.floret.dev/weeb-vip/edge-cache:0.1.0 edge/
docker push harbor.floret.dev/weeb-vip/edge-cache:0.1.0

# 3. Deploy
helm upgrade --install weeb-frontend charts/weeb-ssr-knative \
  -n weeb-staging \
  --set fullnameOverride=weeb-frontend \
  --set ssr.image.tag=1.98.0 \
  --set cache.existingSecret=weeb-frontend-cache
```

See [`docs/cutover.md`](docs/cutover.md) for moving staging off the existing
Deployment, and [`docs/integrating-weeb-frontend.md`](docs/integrating-weeb-frontend.md)
for the app-side changes.

## Verifying

```bash
curl -sI https://staging.weeb.vip/airing | grep -i x-cache
# x-cache: HIT          served from Redis
# x-cache-tier: edge    without waking an SSR pod
```

| `X-Cache` | Meaning |
|---|---|
| `HIT` | Served fresh from Redis |
| `STALE` | Served stale, revalidating behind it |
| `MISS` | Cacheable, nothing stored — rendered |
| `BYPASS` | Not eligible (POST, auth header, `no-cache`) |

`BYPASS` on a logged-in request is correct. `MISS` forever means the route never
opted in — `defaultTtl` is 0 by design.

Stats and metrics:

```bash
curl -H "Authorization: Bearer $TOKEN" https://staging.weeb.vip/_cache/stats
kubectl -n weeb-staging port-forward deploy/weeb-frontend-edge 8080:8080
curl localhost:8080/_edge/metrics
```

## Failure modes

Redis down is a degradation, never an outage. Both tiers fail open — a circuit
breaker stops calling Redis after 5 consecutive errors so a dead Redis doesn't
add its timeout to every request. The site serves uncached SSR, and the SSR pods
scale up to absorb it. Watch `edge_cache_hits_total` going flat.

The edge tier is the one component with no failover; it runs 2 replicas with a
PodDisruptionBudget and spreads across nodes. Set `edge.enabled=false` to route
Istio straight at the Knative Service if you ever need to take it out of the
path — the cache keeps working, it just costs a cold start on hits.

## Development

```bash
node --test 'test/*.test.js'        # policy and segmentation rules
npm run test:contract               # Go and JS must build identical keys
cd edge && go test ./...
```

The key format is a contract between two implementations in different
languages. `test/key-vectors.json` is generated from the JS side and asserted by
the Go tests. A mismatch does not error at runtime — it silently produces a 0%
hit rate — so if you change `src/runtime/key.js`, regenerate the vectors and run
the Go tests.
