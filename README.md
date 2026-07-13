# OpenAI-Compatible Proxy Worker

A Cloudflare Worker that proxies OpenAI-compatible API requests to any
OpenAI-compatible backend, while hiding your real provider key from clients.

```
Client → (CLIENT_API_KEY) → Worker → (ORIGIN_API_KEY) → BASE_URL
```

## Why a Cloudflare Worker

The point of building this on Cloudflare Workers instead of a regular VPS/
serverless function is latency. Workers run on Cloudflare's edge network —
your code executes on the datacenter physically closest to the client, not
in one fixed region. That means:

- The client's connection to the worker is a short edge hop instead of a
  long round trip to a single origin server.
- No cold-start VM/container spin-up — Workers use isolates, which start in
  low single-digit milliseconds.
- The worker adds effectively zero processing overhead of its own (see
  Performance notes below) — it streams bytes through rather than buffering
  or parsing them, so the dominant latency is just the edge-to-client hop
  plus the unavoidable worker-to-origin round trip.

In short: this exists to shave latency off every request by moving the
proxy hop as close to the client as possible, not just to hide an API key.

## Setup

Set these as Worker secrets/vars:

| Variable          | Description                                              |
|-------------------|------------------------------------------------------------|
| `CLIENT_API_KEY`  | Key your users must send to reach this worker             |
| `ORIGIN_API_KEY`  | Real provider key, never exposed to clients                |
| `BASE_URL`        | Provider's API base, e.g. `https://integrate.api.nvidia.com/v1` |

Deploy with `wrangler deploy` (or however you normally ship this Worker).

## Base URL

Since every route is declared with a leading `/v1`, your public
OpenAI-compatible base URL for clients is:

```
https://<your-domain>/v1
```

Example: `https://your-domain.example/v1/chat/completions`

## Authentication

Send your `CLIENT_API_KEY` as a standard Bearer token:

```
Authorization: Bearer YOUR_CLIENT_API_KEY
```

Any request with a missing or wrong key gets a **bare `404`** — empty body,
no headers, no JSON. This is intentional: it makes an invalid key
indistinguishable from a route that doesn't exist at all, so scanners can't
map your valid endpoints without a working key.

## Supported endpoints

- `/v1/chat/completions`, `/v1/completions`, `/v1/embeddings`
- `/v1/models`, `/v1/models/{id}`
- `/v1/responses`, `/v1/responses/{id}`, `/v1/responses/{id}/cancel`, `/v1/responses/{id}/input_items`
- `/v1/images/generations`, `/v1/images/edits`, `/v1/images/variations`
- `/v1/audio/transcriptions`, `/v1/audio/translations`, `/v1/audio/speech`
- `/v1/moderations`
- `/v1/files`, `/v1/files/{id}`, `/v1/files/{id}/content`
- `/v1/uploads`, `/v1/uploads/{id}/parts`, `/v1/uploads/{id}/complete`, `/v1/uploads/{id}/cancel`
- `/v1/fine_tuning/jobs`, `/v1/fine_tuning/jobs/{id}`, `/v1/fine_tuning/jobs/{id}/cancel`, `/v1/fine_tuning/jobs/{id}/events`, `/v1/fine_tuning/jobs/{id}/checkpoints`
- `/v1/batches`, `/v1/batches/{id}`, `/v1/batches/{id}/cancel`
- `/v1/assistants`, `/v1/assistants/{id}`
- `/v1/threads/*` (threads, messages, runs, run steps)
- `/v1/vector_stores/*` (vector stores, files, file batches)

Any request outside this list — regardless of key validity — gets the same
bare `404`.

## Testing (PowerShell)

```powershell
# No/bad key -> bare 404
Invoke-WebRequest -Uri "https://your-domain.example/v1/models"

# Valid key -> list models
Invoke-RestMethod -Uri "https://your-domain.example/v1/models" `
  -Headers @{ Authorization = "Bearer YOUR_CLIENT_API_KEY" }

# Chat completion
$result = Invoke-RestMethod -Uri "https://your-domain.example/v1/chat/completions" `
  -Method POST `
  -Headers @{ Authorization = "Bearer YOUR_CLIENT_API_KEY" } `
  -ContentType "application/json" `
  -Body '{"model":"your-model-id","messages":[{"role":"user","content":"Say hello."}]}'

$result.choices[0].message.content
```

For streaming responses, use `curl.exe` (the real curl binary on Windows,
not the `Invoke-WebRequest` alias) with `-N`:

```powershell
curl.exe -N https://your-domain.example/v1/chat/completions `
  -H "Authorization: Bearer YOUR_CLIENT_API_KEY" `
  -H "Content-Type: application/json" `
  -d '{"model":"your-model-id","messages":[{"role":"user","content":"count to 5"}],"stream":true}'
```

## Streaming

Fully supported, both directions:

- **Request → origin**: the request body streams straight to `BASE_URL` as
  it arrives (no buffering), so large uploads (audio files, batch inputs)
  don't wait for the full body before forwarding starts.
- **Origin → client**: the origin's response body — including SSE streams
  from `"stream": true` chat completions — is piped straight back to the
  client token-by-token, no buffering.

The worker never reads, parses, or reconstructs either body. This is both
the fastest and the only correct way to proxy streaming responses.

## Performance notes

- **Method-indexed routing**: routes are grouped into a `Map<method, RegExp[]>`
  at module load, so a request only tests regexes for its own HTTP method
  instead of the full route table.
- **No per-request object churn**: CORS headers are applied directly onto a
  `Headers` instance instead of building and spreading a plain object on
  every request.
- **Auth checked before routing, before any URL/env work**: bad or missing
  keys are rejected as early as possible, before touching route matching or
  building the target URL.
- **Zero body parsing**: request and response bodies are never read into
  memory — always streamed straight through.

## Notes

- The worker does not inspect or modify request bodies — `"model"` and
  everything else in the JSON body is passed straight through to `BASE_URL`
  untouched.
- CORS is wide open (`Access-Control-Allow-Origin: *`) for browser-based
  clients; tighten this in `applyCors()` if you don't need it.

## Credit

Built with Claude Sonnet 5 (Anthropic) on July 13, 2026.
