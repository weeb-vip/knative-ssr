{{- define "weeb-ssr.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "weeb-ssr.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name (include "weeb-ssr.name" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "weeb-ssr.labels" -}}
app.kubernetes.io/name: {{ include "weeb-ssr.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
{{- end -}}

{{- define "weeb-ssr.ssrName" -}}
{{- printf "%s-ssr" (include "weeb-ssr.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "weeb-ssr.edgeName" -}}
{{- printf "%s-edge" (include "weeb-ssr.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "weeb-ssr.redisName" -}}
{{- printf "%s-redis" (include "weeb-ssr.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
The cache namespace. Defaults to the SSR image tag so that shipping a new image
invalidates the cache — serving the previous build's HTML would reference
/_app/immutable chunks that no longer exist in the new image.
*/}}
{{- define "weeb-ssr.cacheVersion" -}}
{{- if .Values.cacheVersion -}}
{{- .Values.cacheVersion -}}
{{- else -}}
{{- required "ssr.image.tag is required when cacheVersion is not set" .Values.ssr.image.tag -}}
{{- end -}}
{{- end -}}

{{- define "weeb-ssr.redisUrl" -}}
{{- if .Values.redis.external -}}
{{- .Values.redis.external -}}
{{- else -}}
{{- printf "redis://%s.%s.svc.cluster.local:6379" (include "weeb-ssr.redisName" .) .Release.Namespace -}}
{{- end -}}
{{- end -}}

{{/*
In-cluster address of the Knative Service. The ksvc is cluster-local, so Knative
points this name at knative-local-gateway and routes on the Host header — which
is why the edge proxy sets Host to this and moves the public host into
X-Forwarded-Host.
*/}}
{{- define "weeb-ssr.ssrUpstream" -}}
{{- printf "http://%s.%s.svc.cluster.local" (include "weeb-ssr.ssrName" .) .Release.Namespace -}}
{{- end -}}

{{- define "weeb-ssr.purgeSecretName" -}}
{{- if .Values.cache.existingSecret -}}
{{- .Values.cache.existingSecret -}}
{{- else -}}
{{- printf "%s-cache" (include "weeb-ssr.fullname" .) -}}
{{- end -}}
{{- end -}}

{{/*
Cache settings shared by the SSR pods and the edge proxy. Rendering these from
one template is what stops the two tiers drifting — a mismatch in key prefix,
version, auth cookies or ignored params means the proxy computes keys the SSR
pods never write, and the hit rate silently goes to zero.
*/}}
{{- define "weeb-ssr.sharedCacheEnv" -}}
- name: CACHE_ENABLED
  value: {{ .Values.cache.enabled | quote }}
- name: CACHE_REDIS_URL
  value: {{ include "weeb-ssr.redisUrl" . | quote }}
- name: CACHE_KEY_PREFIX
  value: {{ .Values.cache.keyPrefix | quote }}
- name: CACHE_VERSION
  value: {{ include "weeb-ssr.cacheVersion" . | quote }}
- name: CACHE_AUTH_COOKIES
  value: {{ join "," .Values.cache.authCookies | quote }}
- name: CACHE_IGNORED_PARAMS
  value: {{ join "," .Values.cache.ignoredParams | quote }}
- name: CACHE_VARY_HEADERS
  value: {{ join "," .Values.cache.varyHeaders | quote }}
- name: CACHE_DEBUG_HEADERS
  value: {{ .Values.cache.debugHeaders | quote }}
- name: CACHE_LOCK_TTL
  value: {{ .Values.cache.lockTtl | quote }}
- name: CACHE_COMMAND_TIMEOUT
  value: {{ .Values.cache.commandTimeout | quote }}
- name: CACHE_ADMIN_PATH
  value: "/_cache"
{{- end -}}
