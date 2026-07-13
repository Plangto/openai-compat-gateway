/** @type {[string, RegExp][]} */
const ROUTES = [
  ["POST", /^\/v1\/chat\/completions$/],
  ["POST", /^\/v1\/completions$/],
  ["POST", /^\/v1\/embeddings$/],
  ["GET", /^\/v1\/models$/],
  ["GET", /^\/v1\/models\/[^/]+$/],
  ["DELETE", /^\/v1\/models\/[^/]+$/],

  ["POST", /^\/v1\/responses$/],
  ["GET", /^\/v1\/responses\/[^/]+$/],
  ["DELETE", /^\/v1\/responses\/[^/]+$/],
  ["POST", /^\/v1\/responses\/[^/]+\/cancel$/],
  ["GET", /^\/v1\/responses\/[^/]+\/input_items$/],

  ["POST", /^\/v1\/images\/generations$/],
  ["POST", /^\/v1\/images\/edits$/],
  ["POST", /^\/v1\/images\/variations$/],

  ["POST", /^\/v1\/audio\/transcriptions$/],
  ["POST", /^\/v1\/audio\/translations$/],
  ["POST", /^\/v1\/audio\/speech$/],

  ["POST", /^\/v1\/moderations$/],

  ["POST", /^\/v1\/files$/],
  ["GET", /^\/v1\/files$/],
  ["GET", /^\/v1\/files\/[^/]+$/],
  ["DELETE", /^\/v1\/files\/[^/]+$/],
  ["GET", /^\/v1\/files\/[^/]+\/content$/],

  ["POST", /^\/v1\/uploads$/],
  ["POST", /^\/v1\/uploads\/[^/]+\/parts$/],
  ["POST", /^\/v1\/uploads\/[^/]+\/complete$/],
  ["POST", /^\/v1\/uploads\/[^/]+\/cancel$/],

  ["POST", /^\/v1\/fine_tuning\/jobs$/],
  ["GET", /^\/v1\/fine_tuning\/jobs$/],
  ["GET", /^\/v1\/fine_tuning\/jobs\/[^/]+$/],
  ["POST", /^\/v1\/fine_tuning\/jobs\/[^/]+\/cancel$/],
  ["GET", /^\/v1\/fine_tuning\/jobs\/[^/]+\/events$/],
  ["GET", /^\/v1\/fine_tuning\/jobs\/[^/]+\/checkpoints$/],

  ["POST", /^\/v1\/batches$/],
  ["GET", /^\/v1\/batches$/],
  ["GET", /^\/v1\/batches\/[^/]+$/],
  ["POST", /^\/v1\/batches\/[^/]+\/cancel$/],

  ["GET", /^\/v1\/assistants$/],
  ["POST", /^\/v1\/assistants$/],
  ["GET", /^\/v1\/assistants\/[^/]+$/],
  ["POST", /^\/v1\/assistants\/[^/]+$/],
  ["DELETE", /^\/v1\/assistants\/[^/]+$/],

  ["GET", /^\/v1\/threads.*$/],
  ["POST", /^\/v1\/threads.*$/],
  ["DELETE", /^\/v1\/threads.*$/],

  ["GET", /^\/v1\/vector_stores.*$/],
  ["POST", /^\/v1\/vector_stores.*$/],
  ["DELETE", /^\/v1\/vector_stores.*$/],
];

/** @type {Map<string, RegExp[]>} */
const ROUTES_BY_METHOD = new Map();
for (const [m, re] of ROUTES) {
  let list = ROUTES_BY_METHOD.get(m);
  if (!list) {
    list = [];
    ROUTES_BY_METHOD.set(m, list);
  }
  list.push(re);
}

function matchRoute(method, pathname) {
  const list = ROUTES_BY_METHOD.get(method);
  if (!list) return false;
  for (let i = 0; i < list.length; i++) {
    if (list[i].test(pathname)) return true;
  }
  return false;
}

function notFound() {
  return new Response(null, { status: 404 });
}

function applyCors(headers) {
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  headers.set("Access-Control-Allow-Headers", "*");
  return headers;
}

function json(obj, status = 200) {
  const headers = applyCors(new Headers());
  headers.set("content-type", "application/json");
  return new Response(JSON.stringify(obj), { status, headers });
}

const STRIP_HEADERS = [
  "host",
  "cf-connecting-ip",
  "cf-ipcountry",
  "cf-ray",
  "cf-visitor",
  "x-forwarded-for",
  "x-forwarded-proto",
];

// Fields some OpenAI clients send that many OpenAI-compatible origins
// (e.g. NVIDIA NIM) reject with a 400 "Unsupported parameter(s)" error.
// Override via the STRIP_PARAMS env var (comma-separated list), or set
// STRIP_PARAMS to an empty string to disable stripping entirely and
// restore full zero-parse passthrough.
const DEFAULT_STRIP_PARAMS = ["promptCacheKey", "prompt_cache_key"];

function getStripParams(env) {
  if (env.STRIP_PARAMS === undefined) return DEFAULT_STRIP_PARAMS;
  if (env.STRIP_PARAMS === "") return [];
  return env.STRIP_PARAMS.split(",").map((s) => s.trim()).filter(Boolean);
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: applyCors(new Headers()) });
    }

    const clientKey = (request.headers.get("Authorization") || "")
      .replace(/^Bearer\s+/i, "")
      .trim();

    if (!env.CLIENT_API_KEY || !clientKey || clientKey !== env.CLIENT_API_KEY) {
      return notFound();
    }

    const incoming = new URL(request.url);

    if (!matchRoute(request.method, incoming.pathname)) {
      return notFound();
    }

    if (!env.BASE_URL || !env.ORIGIN_API_KEY) {
      return json(
        { error: { message: "Worker misconfigured: missing BASE_URL/ORIGIN_API_KEY" } },
        500
      );
    }

    const base = env.BASE_URL.endsWith("/") ? env.BASE_URL.slice(0, -1) : env.BASE_URL;
    const path =
      base.endsWith("/v1") && incoming.pathname.startsWith("/v1")
        ? incoming.pathname.slice(3)
        : incoming.pathname;

    const targetUrl = base + path + incoming.search;

    const outHeaders = new Headers(request.headers);
    outHeaders.set("Authorization", `Bearer ${env.ORIGIN_API_KEY}`);
    for (const h of STRIP_HEADERS) outHeaders.delete(h);

    const method = request.method;
    const hasBody = method !== "GET" && method !== "HEAD";

    let outBody = hasBody ? request.body : undefined;

    const stripParams = hasBody ? getStripParams(env) : [];
    if (stripParams.length > 0) {
      const contentType = request.headers.get("content-type") || "";
      if (contentType.includes("application/json")) {
        const bodyText = await request.text();
        if (bodyText) {
          try {
            const parsed = JSON.parse(bodyText);
            let changed = false;
            for (const p of stripParams) {
              if (p in parsed) {
                delete parsed[p];
                changed = true;
              }
            }
            outBody = changed ? JSON.stringify(parsed) : bodyText;
          } catch (e) {
            outBody = bodyText;
          }
          if (typeof outBody === "string") {
            outHeaders.set("content-length", String(new TextEncoder().encode(outBody).length));
          }
        } else {
          outBody = bodyText;
        }
      }
    }

    const originResponse = await fetch(targetUrl, {
      method,
      headers: outHeaders,
      body: outBody,
      // @ts-ignore
      duplex: hasBody && outBody instanceof ReadableStream ? "half" : undefined,
    });

    const respHeaders = applyCors(new Headers(originResponse.headers));
    respHeaders.delete("content-security-policy");

    return new Response(originResponse.body, {
      status: originResponse.status,
      statusText: originResponse.statusText,
      headers: respHeaders,
    });
  },
};
