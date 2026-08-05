{{- define "ssr-knative.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "ssr-knative.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name (include "ssr-knative.name" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "ssr-knative.labels" -}}
app.kubernetes.io/name: {{ include "ssr-knative.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
{{- end -}}

{{- define "ssr-knative.ssrName" -}}
{{- printf "%s-ssr" (include "ssr-knative.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "ssr-knative.edgeName" -}}
{{- printf "%s-edge" (include "ssr-knative.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "ssr-knative.redisName" -}}
{{- printf "%s-redis" (include "ssr-knative.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
The cache namespace. Defaults to the SSR image tag so that shipping a new image
invalidates the cache — serving the previous build's HTML would reference
/_app/immutable chunks that no longer exist in the new image.
*/}}
{{- define "ssr-knative.cacheVersion" -}}
{{- if .Values.cacheVersion -}}
{{- .Values.cacheVersion -}}
{{- else -}}
{{- required "ssr.image.tag is required when cacheVersion is not set" .Values.ssr.image.tag -}}
{{- end -}}
{{- end -}}

{{- define "ssr-knative.redisUrl" -}}
{{- if .Values.redis.external -}}
{{- .Values.redis.external -}}
{{- else -}}
{{- printf "redis://%s.%s.svc.cluster.local:6379" (include "ssr-knative.redisName" .) .Release.Namespace -}}
{{- end -}}
{{- end -}}

{{/*
In-cluster address of the Knative Service. The ksvc is cluster-local, so Knative
points this name at knative-local-gateway and routes on the Host header — which
is why the edge proxy sets Host to this and moves the public host into
X-Forwarded-Host.
*/}}
{{- define "ssr-knative.ssrUpstream" -}}
{{- printf "http://%s.%s.svc.cluster.local" (include "ssr-knative.ssrName" .) .Release.Namespace -}}
{{- end -}}

{{- define "ssr-knative.purgeSecretName" -}}
{{- if .Values.cache.existingSecret -}}
{{- .Values.cache.existingSecret -}}
{{- else -}}
{{- printf "%s-cache" (include "ssr-knative.fullname" .) -}}
{{- end -}}
{{- end -}}

{{/*
Cache settings shared by the SSR pods and the edge proxy. Rendering these from
one template is what stops the two tiers drifting — a mismatch in key prefix,
version, auth cookies or ignored params means the proxy computes keys the SSR
pods never write, and the hit rate silently goes to zero.
*/}}
{{- define "ssr-knative.sharedCacheEnv" -}}
- name: CACHE_ENABLED
  value: {{ .Values.cache.enabled | quote }}
- name: CACHE_REDIS_URL
  value: {{ include "ssr-knative.redisUrl" . | quote }}
- name: CACHE_KEY_PREFIX
  value: {{ .Values.cache.keyPrefix | quote }}
- name: CACHE_VERSION
  value: {{ include "ssr-knative.cacheVersion" . | quote }}
- name: CACHE_AUTH_COOKIES
  value: {{ join "," .Values.cache.authCookies | quote }}
- name: CACHE_IGNORED_PARAMS
  value: {{ join "," .Values.cache.ignoredParams | quote }}
- name: CACHE_VARY_HEADERS
  value: {{ join "," .Values.cache.varyHeaders | quote }}
- name: CACHE_DEBUG_HEADERS
  value: {{ .Values.cache.debugHeaders | quote }}
- name: CACHE_LOCK_TTL
  value: {{ .Values.cache.lockTtl | int64 | quote }}
- name: CACHE_COMMAND_TIMEOUT
  value: {{ .Values.cache.commandTimeout | int64 | quote }}
- name: CACHE_ADMIN_PATH
  value: "/_cache"
{{- end -}}
