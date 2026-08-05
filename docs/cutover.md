# Cutting staging over

Moving `staging.weeb.vip` from the existing `weeb-frontend-staging` Deployment to
the Knative stack. Production is untouched — it stays on Cloudflare Pages.

## What exists today

In `weeb-argocd/weeb-frontend-staging/`:

- `Deployment` + `Service` `weeb-frontend-staging` in namespace `weeb-staging`
- `Gateway` `weeb-frontend-staging-gateway` (cert `weeb-frontend-staging-cert`)
- `VirtualService` `weeb-frontend-staging-sv` → the Service on port 80
- `ConfigMap` `weeb-frontend-staging-config` mounting `config.json`

The chart replaces the Deployment, Service and VirtualService. **The Gateway and
its certificate are worth reusing** rather than recreating, so that TLS is never
in flux during the cutover.

## Order of operations

### 1. Install Knative

```bash
./install/knative-serving/install.sh
kubectl -n knative-serving get pods    # all Running
```

Nothing serves traffic yet — this only adds CRDs and a control plane.

### 2. Build and push the edge proxy

```bash
docker build -t harbor.floret.dev/weeb-vip/edge-cache:0.1.0 edge/
docker push harbor.floret.dev/weeb-vip/edge-cache:0.1.0
```

### 3. Create the purge token

```bash
kubectl -n weeb-staging create secret generic weeb-frontend-cache \
  --from-literal=purge-token="$(openssl rand -hex 32)"
```

Keeping it out of `values.yaml` keeps it out of git.

### 4. Ship an image built with the adapter

The chart expects `build/index.js` to be the adapter's output. Deploying the
current image against the chart works — it's still a Node server on port 3000 —
but nothing will be cached, and `/_cache/health` won't exist, so the readiness
probe will fail. Build and push a frontend image with the adapter first (see
[`integrating-weeb-frontend.md`](integrating-weeb-frontend.md)).

### 5. Deploy alongside, without taking traffic

Install with Istio disabled so nothing is routed yet:

```bash
helm upgrade --install weeb-frontend charts/weeb-ssr-knative \
  -n weeb-staging \
  --set fullnameOverride=weeb-frontend \
  --set ssr.image.tag=<new-tag> \
  --set cache.existingSecret=weeb-frontend-cache \
  --set istio.enabled=false
```

Verify from inside the cluster, before any user can reach it:

```bash
kubectl -n weeb-staging run curl --rm -it --image=curlimages/curl --restart=Never -- \
  curl -sI http://weeb-frontend-edge/airing

# Expect X-Cache: MISS, then HIT on a second call.
# Watch the SSR pod appear on the miss and disappear ~5 min later:
kubectl -n weeb-staging get pods -l app.kubernetes.io/component=ssr -w
```

Confirm the auth bypass before exposing anything:

```bash
kubectl -n weeb-staging run curl --rm -it --image=curlimages/curl --restart=Never -- \
  curl -sI -H 'Cookie: auth_token=fake' http://weeb-frontend-edge/airing
# X-Cache: BYPASS
```

### 6. Point the existing Gateway at the edge

Reuse the Gateway you already have instead of creating a second one:

```bash
helm upgrade weeb-frontend charts/weeb-ssr-knative \
  -n weeb-staging \
  --reuse-values \
  --set istio.enabled=true \
  --set istio.gateway.create=false \
  --set istio.gateway.name=weeb-frontend-staging-gateway
```

Then delete the old VirtualService so two don't claim the same host — Istio's
behaviour when two VirtualServices bind the same host and gateway is to merge
them, and the result is order-dependent and not what you want:

```bash
kubectl -n weeb-staging delete virtualservice weeb-frontend-staging-sv
```

Traffic is now on the new stack.

### 7. Remove the old Deployment

Leave it running for a day first — it costs one pod and it's the rollback.

```bash
kubectl -n weeb-staging delete deployment weeb-frontend-staging
kubectl -n weeb-staging delete service weeb-frontend-staging
```

Then delete `weeb-argocd/weeb-frontend-staging/templates/deployment.yaml` and
`virtual-service.yaml` so ArgoCD doesn't recreate them.

## Rolling back

The old Deployment is still in git, so the fast path is to restore the old
VirtualService — that moves traffic back in one step without touching the
Knative resources:

```bash
kubectl -n weeb-staging apply -f weeb-argocd/weeb-frontend-staging/templates/
kubectl -n weeb-staging delete virtualservice weeb-frontend
```

Nothing about the Knative stack needs uninstalling to roll back; it just stops
receiving traffic.

## Known sharp edges

**Istio sidecars and Knative.** Knative injects its own `queue-proxy` into every
SSR pod, so those pods run three containers. If you see requests hang at exactly
the readiness timeout, check whether the Istio sidecar is ready before
queue-proxy starts probing — `holdApplicationUntilProxyStarts: true` in the Istio
mesh config fixes it.

**mTLS with STRICT PeerAuthentication.** Knative's activator and autoscaler probe
your pods from `knative-serving`. Under a mesh-wide STRICT policy those probes
are rejected and revisions never become ready. Either exclude the probe paths or
allow `knative-serving` in the `weeb-staging` PeerAuthentication.

**Cold start is real.** A miss on a scaled-to-zero service waits for an image
pull (cached on the node after the first), Node boot, and SvelteKit init —
budget 1–3s. That is why `edge.upstreamTimeout` is 30s and the VirtualService
timeout is 60s. If cold starts prove painful before the hit rate is good, set
`ssr.autoscaling.minScale=1` temporarily; it costs a warm pod but nothing else
changes.

**The first deploy after cutover starts cold**, as does every deploy. Expected —
the build id namespaces the cache. Single-flight keeps the GraphQL gateway from
being stampeded while it refills.
