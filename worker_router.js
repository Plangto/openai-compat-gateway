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
  "content-length",
];

const DEFAULT_STRIP_PARAMS = ["promptCacheKey", "prompt_cache_key"];

function getStripParams(env) {
  if (env.STRIP_PARAMS === undefined) return DEFAULT_STRIP_PARAMS;
  if (env.STRIP_PARAMS === "") return [];
  return env.STRIP_PARAMS.split(",").map((s) => s.trim()).filter(Boolean);
}

function parseProviders(raw, defaultThinking) {
  if (!raw) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const parts = entry.split(";");
      const baseUrlRaw = (parts[0] || "").trim();
      const apiKey = (parts[1] || "").trim();
      const modelSpec = (parts[2] || "").trim();
      const thinkingRaw = (parts[3] || "").trim().toLowerCase();
      const thinking = thinkingRaw === "auto" ? "auto" : thinkingRaw === "off" ? "off" : defaultThinking;
      const models = modelSpec.length > 0 ? modelSpec.split("+").map((s) => s.trim()).filter(Boolean) : ["req"];
      const baseUrl = baseUrlRaw.endsWith("/") ? baseUrlRaw.slice(0, -1) : baseUrlRaw;
      return { baseUrl, apiKey, models: models.length > 0 ? models : ["req"], thinking };
    })
    .filter((p) => p.baseUrl && p.apiKey);
}

function resolveModelToken(token, clientModel) {
  if (!token || token.toLowerCase() === "req") {
    return clientModel || undefined;
  }
  return token;
}

function buildAttemptModelIds(provider, clientModel) {
  const out = [];
  for (const token of provider.models) {
    const resolved = resolveModelToken(token, clientModel);
    if (resolved && !out.includes(resolved)) out.push(resolved);
  }
  return out;
}

function targetPathFor(baseUrl, pathname) {
  const baseAlreadyVersioned = /\/v1$/i.test(baseUrl) || /\/openai$/i.test(baseUrl);
  return baseAlreadyVersioned && pathname.startsWith("/v1") ? pathname.slice(3) : pathname;
}

const REASONING_MODEL_PATTERN =
  /(^|[^a-z0-9])o1([^a-z0-9]|$)|(^|[^a-z0-9])o3([^a-z0-9]|$)|(^|[^a-z0-9])o4([^a-z0-9]|$)|gpt-5|reasoning|thinking|qwq|qwen3|deepseek-r1|deepseek-reasoner|r1$|magistral|grok-3-mini|grok-4|glm-4\.5|gemini-2\.5/i;

function looksLikeReasoningModel(modelId) {
  if (!modelId) return false;
  return REASONING_MODEL_PATTERN.test(modelId);
}

function hasThinkingParam(obj) {
  if (!obj || typeof obj !== "object") return false;
  if ("reasoning_effort" in obj) return true;
  if ("reasoning" in obj) return true;
  if ("thinking" in obj) return true;
  if ("enable_thinking" in obj) return true;
  if (
    obj.chat_template_kwargs &&
    typeof obj.chat_template_kwargs === "object" &&
    "enable_thinking" in obj.chat_template_kwargs
  ) {
    return true;
  }
  return false;
}

function guessThinkingParams(modelId) {
  const id = (modelId || "").toLowerCase();
  if (/qwen3|qwq/.test(id)) {
    return { chat_template_kwargs: { enable_thinking: true } };
  }
  if (/deepseek-r1|deepseek-reasoner/.test(id)) {
    return {};
  }
  return { reasoning_effort: "medium" };
}

function applyAutoThinking(clone, provider, modelId) {
  if (!provider || provider.thinking !== "auto") return clone;
  if (!looksLikeReasoningModel(modelId)) return clone;
  if (hasThinkingParam(clone)) return clone;
  const extra = guessThinkingParams(modelId);
  return { ...clone, ...extra };
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

    const defaultThinking = (env.AUTO_THINKING || "").trim().toLowerCase() === "auto" ? "auto" : "off";
    const providers = parseProviders(env.PROVIDERS, defaultThinking);
    if (providers.length === 0) {
      return json(
        { error: { message: "Worker misconfigured: missing/invalid PROVIDERS variable" } },
        500
      );
    }

    const method = request.method;
    const hasBody = method !== "GET" && method !== "HEAD";

    const baseHeaders = new Headers(request.headers);
    for (const h of STRIP_HEADERS) baseHeaders.delete(h);

    const stripParams = getStripParams(env);
    const contentType = (request.headers.get("content-type") || "").toLowerCase();

    let bodyKind = "none";
    let jsonBody = null;
    let formData = null;
    let rawBytes = null;

    if (hasBody) {
      if (contentType.includes("application/json")) {
        const bodyText = await request.text();
        bodyKind = "json";
        if (bodyText) {
          try {
            jsonBody = JSON.parse(bodyText);
          } catch (e) {

            bodyKind = "raw";
            rawBytes = new TextEncoder().encode(bodyText);
          }
        } else {
          jsonBody = {};
        }
        if (jsonBody) {
          for (const p of stripParams) {
            if (p in jsonBody) delete jsonBody[p];
          }
        }
      } else if (
        contentType.includes("multipart/form-data") ||
        contentType.includes("application/x-www-form-urlencoded")
      ) {
        try {
          formData = await request.formData();
          bodyKind = "form";
        } catch (e) {
          bodyKind = "raw";
          rawBytes = await request.arrayBuffer();
        }
      } else {
        bodyKind = "raw";
        rawBytes = await request.arrayBuffer();
      }
    }

    function clientRequestedModel() {
      if (bodyKind === "json" && jsonBody) return jsonBody.model;
      if (bodyKind === "form" && formData) return formData.get("model");
      return undefined;
    }

    function buildBodyForAttempt(provider, modelId) {
      if (bodyKind === "json") {
        let clone = { ...jsonBody };
        if (modelId) clone.model = modelId;
        clone = applyAutoThinking(clone, provider, modelId);
        const text = JSON.stringify(clone);
        return { body: text, contentType: "application/json" };
      }
      if (bodyKind === "form") {
        const fd = new FormData();
        for (const [k, v] of formData.entries()) {
          if (k === "model") continue;
          fd.append(k, v);
        }
        if (modelId) fd.append("model", modelId);
        return { body: fd, contentType: undefined };
      }
      if (bodyKind === "raw") {
        return { body: rawBytes, contentType: contentType || undefined };
      }
      return { body: undefined, contentType: undefined };
    }

    const timeoutMs = Number(env.PROVIDER_TIMEOUT_MS) > 0 ? Number(env.PROVIDER_TIMEOUT_MS) : 20000;

    async function attempt(provider, modelId) {
      const path = targetPathFor(provider.baseUrl, incoming.pathname);
      const targetUrl = provider.baseUrl + path + incoming.search;

      const headers = new Headers(baseHeaders);
      headers.set("Authorization", `Bearer ${provider.apiKey}`);

      const { body, contentType: ct } = buildBodyForAttempt(provider, modelId);
      if (ct) headers.set("content-type", ct);
      else if (bodyKind === "form") headers.delete("content-type");

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const resp = await fetch(targetUrl, {
          method,
          headers,
          body,
          signal: controller.signal,
        });
        clearTimeout(timer);
        return { ok: resp.ok, resp };
      } catch (err) {
        clearTimeout(timer);
        return { ok: false, error: err };
      }
    }

    const clientModel = clientRequestedModel();
    const attemptsLog = [];

    for (const provider of providers) {
      let modelIds;
      if (bodyKind === "json" || bodyKind === "form") {
        modelIds = buildAttemptModelIds(provider, clientModel);
        if (modelIds.length === 0) modelIds = [undefined];
      } else {

        modelIds = [undefined];
      }

      for (const modelId of modelIds) {
        const result = await attempt(provider, modelId);

        if (result.ok) {
          const resp = result.resp;
          const respHeaders = applyCors(new Headers(resp.headers));
          respHeaders.delete("content-security-policy");
          return new Response(resp.body, {
            status: resp.status,
            statusText: resp.statusText,
            headers: respHeaders,
          });
        }

        if (result.resp) {
          attemptsLog.push({ baseUrl: provider.baseUrl, model: modelId, status: result.resp.status });
          try {
            if (result.resp.body && result.resp.body.cancel) await result.resp.body.cancel();
          } catch (e) {

          }
        } else {
          attemptsLog.push({
            baseUrl: provider.baseUrl,
            model: modelId,
            error: String((result.error && result.error.message) || result.error),
          });
        }
      }
    }

    return json(
      { error: { message: "All providers/models failed", attempts: attemptsLog } },
      502
    );
  },
};
