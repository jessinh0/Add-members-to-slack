const form = document.querySelector("#invite-form");
const statusBox = document.querySelector("#status");
const submitButton = document.querySelector("#submit-button");

// Erros que vao se repetir em todos os canais: melhor parar logo
const FATAL_CODES = new Set([
  "invalid_auth",
  "not_authed",
  "missing_token",
  "missing_scope",
  "user_not_found",
  "invalid_email",
  "too_many_users",
  "not_json_response"
]);

function wait(seconds) {
  return new Promise((resolve) => window.setTimeout(resolve, seconds * 1000));
}

function showStatus(message, type = "", details = []) {
  statusBox.textContent = message;
  statusBox.className = `status ${type}`.trim();

  if (details.length) {
    const list = document.createElement("ul");
    for (const line of details) {
      const item = document.createElement("li");
      item.textContent = line;
      list.appendChild(item);
    }
    statusBox.appendChild(list);
  }
}

async function waitWithCountdown(seconds, progressLabel) {
  for (let remaining = seconds; remaining > 0; remaining -= 1) {
    showStatus(`${progressLabel} Slack rate limit reached. Retrying in ${remaining} seconds...`);
    await wait(1);
  }
}

function parseChannelIds(value) {
  const ids = String(value || "")
    .split(/[\s,;]+/)
    .map((id) => id.trim().replace(/^#/, ""))
    .filter(Boolean);
  return [...new Set(ids)];
}

async function sendInvite(payload) {
  const response = await fetch("/api/invite", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });

  const contentType = response.headers.get("content-type") || "";
  const data = contentType.includes("application/json")
    ? await response.json()
    : { error: await response.text(), code: "not_json_response" };

  if (!response.ok || !data.ok) {
    const suffix = data.code ? ` (${data.code})` : "";
    const message = data.code === "not_json_response"
      ? "The /api/invite API was not found. Confirm the app is deployed as a Node Web Service, not a static site."
      : data.error || "Could not add the member.";
    const error = new Error(`${message}${suffix}`);
    error.code = data.code;
    error.retryAfter = Number(data.retryAfter || 0);
    throw error;
  }

  return data.result;
}

async function sendInviteWithRetry(payload, progressLabel) {
  const maxAttempts = 6;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await sendInvite(payload);
    } catch (error) {
      const retryable = error.code === "ratelimited" || error.code === "slack_timeout";
      if (!retryable || attempt === maxAttempts) {
        throw error;
      }

      const retryAfter = Math.max(error.retryAfter || 30, 5);
      await waitWithCountdown(retryAfter, progressLabel);
    }
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const formData = new FormData(form);
  const emails = formData.get("emails");
  const channelIds = parseChannelIds(formData.get("channelIds"));

  if (!channelIds.length) {
    showStatus("Enter at least one channel ID.", "error");
    return;
  }

  submitButton.disabled = true;

  const added = [];
  const alreadyMember = [];
  const failed = [];
  let stoppedEarly = null;

  for (let index = 0; index < channelIds.length; index += 1) {
    const channelId = channelIds[index];
    const progressLabel = `Channel ${index + 1} of ${channelIds.length} (${channelId}).`;
    showStatus(`${progressLabel} Adding...`);

    try {
      const result = await sendInviteWithRetry({ emails, channelName: channelId }, progressLabel);
      if (result.alreadyInChannel) {
        alreadyMember.push(channelId);
      } else {
        added.push(channelId);
      }
    } catch (error) {
      if (error.message === "Failed to fetch") {
        failed.push(`${channelId}: could not reach the server.`);
      } else {
        failed.push(`${channelId}: ${error.message}`);
      }

      if (FATAL_CODES.has(error.code)) {
        stoppedEarly = error.message;
        break;
      }
    }
  }

  const processed = added.length + alreadyMember.length + failed.length;
  const summary = [
    `Done: ${added.length} channel(s) added`,
    alreadyMember.length ? `${alreadyMember.length} already had the member(s)` : null,
    failed.length ? `${failed.length} failed` : null
  ].filter(Boolean).join(", ") + ".";

  if (stoppedEarly) {
    showStatus(
      `Stopped after ${processed} of ${channelIds.length} channels because of an error that would repeat on every channel. ${summary}`,
      "error",
      failed
    );
  } else if (failed.length) {
    showStatus(`${summary} Channels that failed:`, "error", failed);
  } else {
    showStatus(summary, "success");
    form.reset();
  }

  submitButton.disabled = false;
});
