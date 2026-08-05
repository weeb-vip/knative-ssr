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

USER nonroot:nonroot
EXPOSE 8080

ENTRYPOINT ["/edge-cache"]
