# Integrating with weeb-frontend

App-side changes needed to build for Knative. Production keeps using
`adapter-cloudflare`; this only affects the default (k8s) build.

## 1. Add the adapter

```bash
yarn add -D github:weeb-vip/knative-ssr
```

## 2. Switch the k8s branch of svelte.config.js

`svelte.config.js` already forks on `DEPLOY_TARGET`. Only the non-Cloudflare
branch changes:

```js
import knativeAdapter from '@weeb-vip/adapter-knative';
import cloudflareAdapter from '@sveltejs/adapter-cloudflare';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

// DEPLOY_TARGET=cloudflare builds for Cloudflare Pages (deploy-cloudflare
// workflow); the default build is what the k8s image runs
const adapter = process.env.DEPLOY_TARGET === 'cloudflare'
  ? cloudflareAdapter()
  : knativeAdapter({ out: 'build' });

export default {
  preprocess: vitePreprocess(),
  compilerOptions: {
    warningFilter: (warning) => !warning.message.includes('experimental_async_ssr')
  },
  kit: {
    adapter,
    files: { assets: 'public' },
    alias: {
      $components: 'src/svelte/components',
      $stores: 'src/svelte/stores'
    },
    // The cache namespace derives from this. The default is a build timestamp,
    // which is correct but opaque; using the release version makes
    // `X-Cache` debugging and rollback reasoning much easier.
    version: { name: process.env.VITE_APP_VERSION || 'dev' }
  }
};
```

The output shape is unchanged — still `build/index.js` plus `build/client`, so
the existing `Dockerfile` (`COPY --from=build /app/build ./build`,
`CMD ["bun", "run", "./build/index.js"]`) keeps working as-is.

> One caveat on Bun: the runtime bundles `ioredis`, which uses Node's `net` and
> `tls`. Bun implements both, but if you hit anything odd, switching the runtime
> stage to `node:22-alpine` is a one-line change and the build stage can stay on
> Bun.

## 3. Opt routes in

Nothing is cached until a route asks, because `defaultTtl` is 0. Start with the
pages that are pure public content.

```ts
// src/routes/show/[id]/+page.server.ts
export const load = async ({ params, platform }) => {
  platform?.cache
    ?.public()
    .ttl(60)
    .swr(600)
    .tag(`show:${params.id}`);

  return { show: await getShow(params.id) };
};
```

`platform.cache` doesn't exist on Cloudflare, so `?.` keeps one source building
for both targets.

Good first candidates:

| Route | Segment | TTL / SWR | Tag |
|---|---|---|---|
| `/airing` | `public()` | 300 / 3600 | `airing` |
| `/show/[id]` | `public()` | 60 / 600 | `show:{id}` |
| `/` | `public()` | 60 / 600 | `home` |
| `/profile` | — | never | — |

## 4. The part that actually matters: personalisation

A route is only safe to mark `public()` if its **rendered HTML is byte-identical
for every visitor**. Today it probably isn't — the header renders an avatar and
the show page renders your watchlist status.

Two options.

**Preferred — move personalisation client-side.** You already use TanStack Query;
fetch user-specific data after hydration instead of during SSR. The HTML becomes
shared and cacheable, and the personalised bits fill in on the client. This is
what Vercel calls partial prerendering, and it's the reason their cache hit rates
look the way they do.

**Fallback — segment it.** If a page must render login state server-side, use
`.shared()` instead of `.public()`. That caches one variant for anonymous and one
for "any logged-in user":

```ts
platform?.cache?.shared().ttl(30).tag(`show:${params.id}`);
```

Only correct when the page varies by *whether* you're logged in, not by *who* you
are. If it renders a username, an avatar URL, or a watchlist, `.shared()` will
leak one user's data to another. Use `.user(id)` or don't cache.

The adapter refuses to store an authenticated render into `pub` or `anon`
regardless, so a mistake here degrades to "not cached" rather than a leak — but
`.shared()` is the one call that can genuinely go wrong, so audit those routes.

## 5. Verify locally

```bash
docker run -d --name redis -p 6379:6379 redis:7-alpine

yarn build
CACHE_REDIS_URL=redis://127.0.0.1:6379 \
CACHE_VERSION=local \
CACHE_PURGE_TOKEN=dev \
node build/index.js
```

```bash
curl -sI localhost:3000/airing | grep -i x-cache   # MISS
curl -sI localhost:3000/airing | grep -i x-cache   # HIT

# A logged-in request must not get the shared entry
curl -sI -H 'Cookie: auth_token=fake' localhost:3000/airing | grep -i x-cache
# BYPASS — correct

curl -s -X POST localhost:3000/_cache/purge \
  -H 'Authorization: Bearer dev' -d '{"tags":["airing"]}'
```

If the third command returns `HIT`, stop and open an issue — that is the leak
this design exists to prevent, and it should be structurally impossible.

## 6. Wiring purges to data changes

Tags are only useful if something purges them. The natural trigger is wherever
`anime-sync` / `thetvdb-enrichment` write a show:

```bash
curl -X POST https://staging.weeb.vip/_cache/purge \
  -H "Authorization: Bearer $CACHE_PURGE_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"tags":["show:12345","airing"]}'
```

Until that exists, TTL and SWR are what bound staleness — which is why the
suggested TTLs above are minutes, not hours.
