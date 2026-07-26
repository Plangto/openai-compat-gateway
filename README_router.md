# OpenAI-Compatible Proxy Worker

A Cloudflare Worker that proxies OpenAI-compatible API requests to one or
more OpenAI-compatible backends, hiding your real provider keys from
clients and automatically falling back to another provider/model if one
fails.

```
Client → (CLIENT_API_KEY) → Worker → (per-provider API key) → Provider 1 → Provider 2 → ...
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
- Routing, auth, and body rewriting are all cheap in-memory operations (see
  Performance notes below) — the dominant latency is still just the
  edge-to-client hop plus the worker-to-origin round trip(s).

## Setup

Set these as Worker secrets/vars:

| Variable              | Required | Description                                                                 |
|-----------------------|----------|------------------------------------------------------------------------------|
| `CLIENT_API_KEY`      | yes      | Key your users must send to reach this worker                               |
| `PROVIDERS`           | yes      | One or more backend providers with keys and model fallback chains (see below) |
| `STRIP_PARAMS`        | no       | Comma-separated list of JSON body fields to strip before forwarding. Defaults to `promptCacheKey,prompt_cache_key`. Set to an empty string to disable stripping. |
| `PROVIDER_TIMEOUT_MS` | no       | Per-attempt timeout in ms before giving up on a provider/model and trying the next one. Defaults to `20000`. |
| `AUTO_THINKING`       | no       | Set to `auto` to turn on auto-thinking (see below) for every provider by default. Defaults to `off`. Can be overridden per-provider in `PROVIDERS`. |

Deploy with `wrangler deploy` (or however you normally ship this Worker).

There are no more `BASE_URL` / `ORIGIN_API_KEY` variables — everything about
your backend(s) now lives in `PROVIDERS`.

## `PROVIDERS` format

```
baseUrl;apiKey;modelSpec;thinking,baseUrl2;apiKey2;modelSpec2;thinking2,...
```

- Providers are comma-separated, and are tried **in order, one at a time**
  — never concurrently.
- Each provider is up to four fields separated by `;`: base URL, API key, a
  model spec, and an optional thinking mode.
- `modelSpec` is a `+`-separated list of model ids to try, in order, against
  that one provider:
  - the token `req` (or an empty model spec, e.g. just `baseUrl;apiKey`)
    means **use whatever `model` the client sent in their request** for
    that attempt
  - any other token is a locked/explicit model id, used regardless of what
    the client asked for
  - every token after the first is a same-provider fallback, tried only if
    the one before it fails
- `thinking` (the 4th field) is optional and controls [auto-thinking](#auto-thinking)
  for that provider: `auto`, `off`, or omitted entirely to fall back to the
  global `AUTO_THINKING` var (default `off`).

### Example

```
https://baseurl.com/v1;sk-aaa;sonnet4+fallbackA+fallbackB,https://ai.com/v1;sk-bbb;req+fallback1
```

Resolution order for an incoming request:

1. **Provider 1** (`baseurl.com`), model `sonnet4` (locked — client's
   requested model is ignored here)
2. If that fails → **Provider 1**, model `fallbackA`
3. If that fails → **Provider 1**, model `fallbackB`
4. If that fails → **Provider 2** (`ai.com`), using the model the *client*
   actually requested (`req`)
5. If that fails → **Provider 2**, model `fallback1`
6. If every one of those fails, the worker returns a single `502` with a
   JSON log of every provider/model it tried and why each one failed.

The first attempt that returns a `2xx` response is streamed straight back
to the client — nothing later in the chain is touched.

Add a 4th field per provider to control [auto-thinking](#auto-thinking):

```
https://baseurl.com/v1;sk-aaa;gpt-5-mini;auto,https://ai.com/v1;sk-bbb;req
```

Here `baseurl.com` auto-enables reasoning for `gpt-5-mini` (since it's
locked, that's known upfront), while `ai.com` leaves thinking untouched
(the field is omitted, so it falls back to the global `AUTO_THINKING`
default) and just passes through whatever the client requested.

A locked model only applies to endpoints whose body actually carries a
`model` field (chat/completions, completions, embeddings, responses,
images, audio, etc.). For endpoints without one (e.g. `GET /v1/models`,
`DELETE /v1/files/{id}`), the worker just tries each provider once, in
order, ignoring the model spec.

## Auto-thinking

Some models support an extended "thinking"/"reasoning" mode, but every
backend expects it turned on a slightly different way — OpenAI's o-series
and GPT-5 use `reasoning_effort`, vLLM-hosted Qwen3/QwQ use
`chat_template_kwargs: { enable_thinking: true }`, DeepSeek-R1 reasons by
default with no flag needed, and so on. Auto-thinking removes the need to
remember which one your provider wants.

When enabled for a provider (`thinking` = `auto`, either per-provider or
via the global `AUTO_THINKING` var):

1. The worker looks at the **model id actually being attempted** (after
   `req`/locked-model resolution) and checks it against a pattern of known
   reasoning-capable families (`o1`, `o3`, `o4`, `gpt-5`, `qwq`, `qwen3`,
   `deepseek-r1`/`deepseek-reasoner`, and a few others with "reasoning" or
   "thinking" in the name).
2. If it doesn't look like a reasoning model, nothing is changed.
3. If it does, and the client's request body **doesn't already** contain a
   recognized reasoning field (`reasoning_effort`, `reasoning`, `thinking`,
   `enable_thinking`, or `chat_template_kwargs.enable_thinking`), the
   worker injects the right one for that model family before forwarding.
4. If the client already sent one of those fields themselves, their choice
   is always respected — auto-thinking only fills in a default, it never
   overrides an explicit client setting.

This is opt-in and off by default, for the same reason `STRIP_PARAMS`
exists: some strict OpenAI-compatible origins reject unrecognized JSON
fields with a `400`, so blindly adding reasoning params to every request
could break otherwise-working providers. Turn it on per-provider (or
globally) once you know the target accepts it.

**Showing thinking output back to the client:** nothing extra is needed
here. The worker never buffers or rewrites the *response* body — it's
streamed straight through — so if a model includes reasoning/thinking
content in its output (as `reasoning_content` deltas, a `thinking` block,
etc.), the client already receives it exactly as the provider sent it.

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

# Chat completion — "your-model-id" is only used if a provider's model spec
# includes "req"; providers with a locked model id ignore it
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

To see a fallback actually kick in, put a bad API key or an invalid model
id on the first provider in `PROVIDERS` and a working one second — the
response should still succeed, just from the second provider.

## Streaming

- **Origin → client**: fully streamed. The winning provider's response body
  — including SSE streams from `"stream": true` chat completions — is
  piped straight back to the client token-by-token, no buffering.
- **Client → origin**: request bodies with a `model` field (JSON or
  multipart/form-data) are read into memory once, since the same body may
  need to be re-sent — with a different `model` — to several
  providers/models in sequence. This is unavoidable with retry/fallback
  logic: you can't replay a one-shot stream a second time. Bodies without a
  rewritable `model` field, and GET/DELETE requests, still pass through
  as-is.

## Performance notes

- **Method-indexed routing**: routes are grouped into a `Map<method, RegExp[]>`
  at module load, so a request only tests regexes for its own HTTP method
  instead of the full route table.
- **No per-request object churn**: CORS headers are applied directly onto a
  `Headers` instance instead of building and spreading a plain object on
  every request.
- **Auth and route checks first**: bad/missing keys and unknown routes are
  rejected before `PROVIDERS` is even parsed or any body is read.
- **Sequential, not parallel, fallback**: only one provider/model attempt is
  in flight at a time, so a fast success never has to "wait out" slower
  parallel requests, and you're never billed for concurrent duplicate
  requests across providers.
- **Per-attempt timeout**: each attempt is bounded by `PROVIDER_TIMEOUT_MS`
  (via `AbortController`) so a hung provider can't stall the whole fallback
  chain.

## Notes

- The worker rewrites the `model` field of the JSON/form body per attempt
  when a provider's model spec calls for it (locked model or `req`).
  Everything else in the body is passed through untouched, aside from any
  fields listed in `STRIP_PARAMS`, and any reasoning field injected by
  [auto-thinking](#auto-thinking) when that's turned on for a provider.
- If every provider/model in the chain fails, the client gets back a `502`
  with a JSON `attempts` array describing what was tried and why each one
  failed (HTTP status or error message) — useful for debugging a bad
  `PROVIDERS` config without digging through Worker logs.
- CORS is wide open (`Access-Control-Allow-Origin: *`) for browser-based
  clients; tighten this in `applyCors()` if you don't need it.

## Credit

Built with Claude Sonnet 5 (Anthropic) on July 13–14, 2026.
