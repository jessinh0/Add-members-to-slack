const form = document.querySelector("#invite-form");
const statusBox = document.querySelector("#status");
const submitButton = document.querySelector("#submit-button");

function wait(seconds) {
  return new Promise((resolve) => window.setTimeout(resolve, seconds * 1000));
}

async function waitWithCountdown(seconds) {
  for (let remaining = seconds; remaining > 0; remaining -= 1) {
    showStatus(`Slack rate limit reached. Retrying in ${remaining} seconds...`);
    await wait(1);
  }
}

function showStatus(message, type = "") {
  statusBox.textContent = message;
  statusBox.className = `status ${type}`.trim();
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
    const method = data.method ? ` Metodo: ${data.method}.` : "";
    const message = data.code === "not_json_response"
      ? "The /api/invite API was not found. Confirm the app is deployed as a Node Web Service, not a static site."
      : data.error || "Could not add the member.";
    const error = new Error(`${message}${method}${suffix}`);
    error.code = data.code;
    error.retryAfter = Number(data.retryAfter || 0);
    throw error;
  }

  return data.result;
}

async function sendInviteWithRetry(payload) {
  const maxAttempts = 2;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await sendInvite(payload);
    } catch (error) {
      if (error.code !== "ratelimited" || attempt === maxAttempts) {
        throw error;
      }

      const retryAfter = Math.max(error.retryAfter || 60, 10);
      await waitWithCountdown(retryAfter);
      showStatus(`Retrying (${attempt + 1}/${maxAttempts})...`);
    }
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const formData = new FormData(form);
  const payload = {
    emails: formData.get("emails"),
    channelName: formData.get("channelName")
  };

  submitButton.disabled = true;
  showStatus("Sending invite...");

  try {
    const result = await sendInviteWithRetry(payload);
    const count = result.users.length;
    const noun = count === 1 ? "member was added" : "members were added";
    const warning = result.warning
      ? " The invite worked, but the bot could not leave the channel automatically."
      : "";
    showStatus(`${count} ${noun} to channel ${result.channelName}.${warning}`, "success");
    form.reset();
  } catch (error) {
    const message = error.message === "Failed to fetch"
      ? "Could not connect to the local server. Reload the page or restart the app with .\\run-server.ps1."
      : error.message;
    showStatus(message, "error");
  } finally {
    submitButton.disabled = false;
  }
});
