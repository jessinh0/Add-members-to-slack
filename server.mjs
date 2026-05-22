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
  missing_scope: "O token nao tem todos os escopos necessarios no Slack.",
  not_authed: "Nenhum token foi enviado ao Slack.",
  not_in_channel: "O usuario/app do token precisa estar no canal antes de convidar membros.",
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

async function slackApi(method, { httpMethod = "POST", params = {}, body = null } = {}) {
  if (!SLACK_TOKEN) {
    const error = new Error("Configure a variavel SLACK_TOKEN antes de usar o app.");
    error.code = "missing_token";
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

  const response = await fetch(url, request);
  const data = await response.json();

  if (!response.ok || !data.ok) {
    const errorCode = data.error || "slack_error";
    const friendlyMessage = slackErrorMessages[errorCode] || `Slack respondeu com erro: ${errorCode}`;
    const error = new Error(friendlyMessage);
    error.code = errorCode;
    error.details = data;
    error.retryAfter = Number(response.headers.get("retry-after") || 0);
    throw error;
  }

  return data;
}

async function findUserByEmail(email) {
  const data = await slackApi("users.lookupByEmail", {
    httpMethod: "GET",
    params: { email }
  });
  return data.user;
}

async function findChannelByName(channelName) {
  const targetName = normalizeChannelName(channelName);
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
      return channel;
    }

    cursor = data.response_metadata?.next_cursor || "";
  } while (cursor);

  return null;
}

function parseEmails(value) {
  return String(value || "")
    .split(/[\s,;]+/)
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
}

async function inviteMember({ email, emails, channelName }) {
  const cleanEmails = parseEmails(emails || email);
  const cleanChannelName = normalizeChannelName(channelName);

  if (!cleanEmails.length || cleanEmails.some((item) => !item.includes("@"))) {
    const error = new Error("Informe um ou mais e-mails validos.");
    error.code = "invalid_email";
    throw error;
  }

  if (cleanEmails.length > 100) {
    const error = new Error("Informe no maximo 100 e-mails por envio.");
    error.code = "too_many_users";
    throw error;
  }

  if (!cleanChannelName) {
    const error = new Error("Informe o nome do canal.");
    error.code = "invalid_channel";
    throw error;
  }

  const channel = await findChannelByName(cleanChannelName);

  if (!channel) {
    const error = new Error(`Canal #${cleanChannelName} nao encontrado ou sem acesso pelo token.`);
    error.code = "channel_not_found";
    throw error;
  }

  const users = [];
  for (const cleanEmail of cleanEmails) {
    const user = await findUserByEmail(cleanEmail);
    users.push({
      email: cleanEmail,
      id: user.id,
      name: user.real_name || user.name || cleanEmail
    });
  }

  await slackApi("conversations.invite", {
    body: {
      channel: channel.id,
      users: users.map((user) => user.id).join(",")
    }
  });

  return {
    users,
    channelId: channel.id,
    channelName: channel.name
  };
}

async function serveStatic(req, res) {
  const requestedPath = req.url === "/" ? "/index.html" : new URL(req.url, "http://localhost").pathname;
  const safePath = normalize(requestedPath).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(PUBLIC_DIR, safePath);

  try {
    const content = await readFile(filePath);
    res.writeHead(200, { "content-type": mimeTypes[extname(filePath)] || "application/octet-stream" });
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
