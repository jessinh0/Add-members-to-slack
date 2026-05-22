import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

async function loadLocalEnv() {
  try {
    const content = await readFile(join(process.cwd(), ".env"), "utf8");
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) {
        continue;
      }

      const [key, ...valueParts] = trimmed.split("=");
      const value = valueParts.join("=").trim().replace(/^["']|["']$/g, "");
      if (key && process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
}

await loadLocalEnv();

const PORT = Number(process.env.PORT || 3000);
const SLACK_TOKEN = process.env.SLACK_TOKEN || process.env.SLACK_BOT_TOKEN;
const PUBLIC_DIR = join(process.cwd(), "public");
const userCache = new Map();
const channelCache = new Map();
const slackCooldowns = new Map();

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8"
};

const slackErrorMessages = {
  already_in_channel: "Um ou mais usuarios ja estao no canal.",
  channel_not_found: "Canal nao encontrado ou o token nao tem acesso a esse canal.",
  invalid_auth: "Token invalido. Gere um novo token no Slack e atualize o arquivo .env.",
  method_not_supported_for_channel_type: "Este metodo nao funciona para esse tipo de canal.",
  missing_scope: "O token nao tem todos os escopos necessarios no Slack.",
  not_authed: "Nenhum token foi enviado ao Slack.",
  not_in_channel: "O usuario/app do token precisa estar no canal antes de convidar membros.",
  slack_timeout: "A chamada ao Slack demorou demais para responder. Tente novamente em alguns segundos.",
  user_not_found: "Usuario nao encontrado pelo e-mail informado."
};

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

async function readJsonBody(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 1024 * 1024) {
      throw new Error("Payload muito grande.");
    }
  }
  return body ? JSON.parse(body) : {};
}

function normalizeChannelName(channelName) {
  return String(channelName || "")
    .trim()
    .replace(/^#/, "")
    .toLowerCase();
}

function normalizeChannelInput(channelName) {
  return String(channelName || "").trim().replace(/^#/, "");
}

function looksLikeChannelId(channelName) {
  return /^[CG][A-Z0-9]{8,}$/.test(normalizeChannelInput(channelName));
}

function looksLikePublicChannelId(channelName) {
  return /^C[A-Z0-9]{8,}$/.test(normalizeChannelInput(channelName));
}

async function slackApi(method, { httpMethod = "POST", params = {}, body = null } = {}) {
  if (!SLACK_TOKEN) {
    const error = new Error("Configure a variavel SLACK_TOKEN antes de usar o app.");
    error.code = "missing_token";
    throw error;
  }

  const cooldownUntil = slackCooldowns.get(method) || 0;
  if (Date.now() < cooldownUntil) {
    const retryAfter = Math.ceil((cooldownUntil - Date.now()) / 1000);
    const error = new Error(`Slack pediu para aguardar antes de chamar ${method}.`);
    error.code = "ratelimited";
    error.method = method;
    error.retryAfter = retryAfter;
    throw error;
  }

  const url = new URL(`https://slack.com/api/${method}`);
  const headers = {
    authorization: `Bearer ${SLACK_TOKEN}`,
    "content-type": "application/json; charset=utf-8"
  };

  const request = { method: httpMethod, headers };
  if (httpMethod === "GET") {
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, value);
      }
    });
    delete headers["content-type"];
  } else {
    request.body = JSON.stringify(body ?? params);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  request.signal = controller.signal;

  let response;
  try {
    response = await fetch(url, request);
  } catch (error) {
    if (error.name === "AbortError") {
      const timeoutError = new Error(slackErrorMessages.slack_timeout);
      timeoutError.code = "slack_timeout";
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  const data = await response.json();

  if (!response.ok || !data.ok) {
    const errorCode = data.error || "slack_error";
    const friendlyMessage = slackErrorMessages[errorCode] || `Slack respondeu com erro: ${errorCode}`;
    const error = new Error(friendlyMessage);
    error.code = errorCode;
    error.method = method;
    error.details = data;
    error.retryAfter = Number(response.headers.get("retry-after") || 0);
    if (error.code === "ratelimited" && error.retryAfter > 0) {
      slackCooldowns.set(method, Date.now() + error.retryAfter * 1000);
    }
    throw error;
  }

  return data;
}

async function findUserByEmail(email) {
  if (userCache.has(email)) {
    return userCache.get(email);
  }

  const data = await slackApi("users.lookupByEmail", {
    httpMethod: "GET",
    params: { email }
  });
  userCache.set(email, data.user);
  return data.user;
}

async function findChannelByName(channelName) {
  const targetName = normalizeChannelName(channelName);
  if (channelCache.has(targetName)) {
    return channelCache.get(targetName);
  }

  let cursor = "";

  do {
    const data = await slackApi("conversations.list", {
      httpMethod: "GET",
      params: {
        cursor,
        exclude_archived: "true",
        limit: "200",
        types: "public_channel,private_channel"
      }
    });

    const channel = data.channels.find((item) => {
      return item.name?.toLowerCase() === targetName || item.name_normalized?.toLowerCase() === targetName;
    });

    if (channel) {
      channelCache.set(targetName, channel);
      return channel;
    }

    cursor = data.response_metadata?.next_cursor || "";
  } while (cursor);

  return null;
}

async function joinChannel(channelId) {
  await slackApi("conversations.join", {
    body: { channel: channelId }
  });
}

async function leaveChannel(channelId) {
  try {
    await slackApi("conversations.leave", {
      body: { channel: channelId }
    });
    return null;
  } catch (error) {
    return {
      code: error.code || "leave_failed",
      message: error.message,
      method: error.method || "conversations.leave"
    };
  }
}

function parseEmails(value) {
  return String(value || "")
    .split(/[\s,;]+/)
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
}

async function inviteMember({ email, emails, channelName }) {
  const cleanEmails = parseEmails(emails || email);
  const cleanChannelInput = normalizeChannelInput(channelName);

  if (!cleanEmails.length || cleanEmails.some((item) => !item.includes("@"))) {
    const error = new Error("Enter one or more valid emails.");
    error.code = "invalid_email";
    throw error;
  }

  if (cleanEmails.length > 100) {
    const error = new Error("Enter up to 100 emails per request.");
    error.code = "too_many_users";
    throw error;
  }

  if (!cleanChannelInput) {
    const error = new Error("Enter the channel ID.");
    error.code = "invalid_channel";
    throw error;
  }

  if (!looksLikeChannelId(cleanChannelInput)) {
    const error = new Error("Enter a valid Slack channel ID, such as C012ABCDEF3.");
    error.code = "invalid_channel_id";
    throw error;
  }

  const channel = { id: cleanChannelInput, name: cleanChannelInput };

  const users = [];
  for (const cleanEmail of cleanEmails) {
    const user = await findUserByEmail(cleanEmail);
    users.push({
      email: cleanEmail,
      id: user.id,
      name: user.real_name || user.name || cleanEmail
    });
  }

  const shouldAutoJoinAndLeave = looksLikePublicChannelId(cleanChannelInput);
  let joinedForInvite = false;
  let leaveWarning = null;

  try {
    if (shouldAutoJoinAndLeave) {
      await joinChannel(channel.id);
      joinedForInvite = true;
    }

    await slackApi("conversations.invite", {
      body: {
        channel: channel.id,
        users: users.map((user) => user.id).join(",")
      }
    });
  } finally {
    if (joinedForInvite) {
      leaveWarning = await leaveChannel(channel.id);
    }
  }

  return {
    users,
    channelId: channel.id,
    channelName: channel.name,
    warning: leaveWarning
  };
}

async function serveStatic(req, res) {
  const requestedPath = req.url === "/" ? "/index.html" : new URL(req.url, "http://localhost").pathname;
  const safePath = normalize(requestedPath).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(PUBLIC_DIR, safePath);

  try {
    const content = await readFile(filePath);
    res.writeHead(200, {
      "content-type": mimeTypes[extname(filePath)] || "application/octet-stream",
      "cache-control": "no-store"
    });
    res.end(content);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Arquivo nao encontrado.");
  }
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "POST" && req.url === "/api/invite") {
      const payload = await readJsonBody(req);
      const result = await inviteMember(payload);
      sendJson(res, 200, { ok: true, result });
      return;
    }

    if (req.method === "GET") {
      await serveStatic(req, res);
      return;
    }

    sendJson(res, 405, { ok: false, error: "Metodo nao permitido." });
  } catch (error) {
    console.error(
      JSON.stringify(
        {
          at: new Date().toISOString(),
          error: error.message,
          code: error.code || "unknown_error",
          method: error.method,
          retryAfter: error.retryAfter,
          details: error.details
        },
        null,
        2
      )
    );
    const statusCode = error.code === "missing_token" ? 500 : 400;
    sendJson(res, statusCode, {
      ok: false,
      error: error.message,
      code: error.code || "unknown_error",
      method: error.method || undefined,
      retryAfter: error.retryAfter || undefined,
      details: error.details
    });
  }
});

process.on("uncaughtException", (error) => {
  console.error(
    JSON.stringify(
      {
        at: new Date().toISOString(),
        type: "uncaughtException",
        error: error.message,
        stack: error.stack
      },
      null,
      2
    )
  );
});

process.on("unhandledRejection", (error) => {
  console.error(
    JSON.stringify(
      {
        at: new Date().toISOString(),
        type: "unhandledRejection",
        error: error?.message || String(error),
        stack: error?.stack
      },
      null,
      2
    )
  );
});

server.listen(PORT, () => {
  console.log(`Slack Channel Inviter rodando em http://localhost:${PORT}`);
});
