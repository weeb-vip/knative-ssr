# ---- build ----
FROM golang:1.23-alpine AS build

WORKDIR /src

COPY go.mod go.sum* ./
RUN go mod download

COPY *.go ./
# Static binary so the runtime image can be scratch — nothing to patch, nothing
# to exploit, and the image is a few MB.
RUN CGO_ENABLED=0 GOOS=linux go build \
    -ldflags="-s -w" \
    -o /out/edge-cache .

# ---- runtime ----
FROM gcr.io/distroless/static-debian12:nonroot

COPY --from=build /out/edge-cache /edge-cache

# Numeric, not `nonroot:nonroot`. Kubernetes cannot verify a *named* user is
# non-root, so a pod with runAsNonRoot: true fails to start against an image
# whose USER is a name. 65532 is the UID distroless calls "nonroot".
USER 65532:65532
EXPOSE 8080

ENTRYPOINT ["/edge-cache"]
