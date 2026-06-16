# --- build stage -----------------------------------------------------------
# Pin Go version. CGO disabled so the binary is static & runs on distroless.
FROM golang:1.24-alpine AS build

WORKDIR /src

# Cache modules separately from source so changes to code don't bust
# the (slow) go mod download layer.
COPY go.mod go.sum* ./
RUN go mod download

COPY . .

# -trimpath strips local paths from stack traces (cleaner logs, reproducible
# builds). -ldflags="-s -w" removes debug + symbol tables.
RUN CGO_ENABLED=0 GOOS=linux \
    go build -trimpath -ldflags="-s -w" \
    -o /out/server ./cmd/server

# --- runtime stage ---------------------------------------------------------
# We use alpine (instead of distroless/static) because the Flutterwave
# integration shells out to `curl` for its single HTTP hop. We discovered
# in dev that api.flutterwave.com (Cloudflare-fronted) has a sensitive WAF
# that rejects certain JSON body patterns; curl's behaviour was easier to
# debug against. Keeping curl in the image leaves us with a known-good
# fallback if Cloudflare's rules tighten further.
# Tradeoff: ~5MB bigger image and a shell — still small.
FROM alpine:3.20

RUN apk add --no-cache curl ca-certificates tzdata \
    && adduser -D -u 65532 -g '' nonroot

WORKDIR /
COPY --from=build /out/server /server

USER nonroot:nonroot
EXPOSE 3018
ENTRYPOINT ["/server"]
