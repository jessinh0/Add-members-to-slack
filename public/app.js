const form = document.querySelector("#invite-form");
const statusBox = document.querySelector("#status");
const submitButton = document.querySelector("#submit-button");

function wait(seconds) {
  return new Promise((resolve) => window.setTimeout(resolve, seconds * 1000));
}

async function waitWithCountdown(seconds) {
  for (let remaining = seconds; remaining > 0; remaining -= 1) {
    showStatus(`Limite do Slack atingido. Nova tentativa em ${remaining} segundos...`);
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
    const message = data.code === "not_json_response"
      ? "A API /api/invite nao foi encontrada. Confirme que o app foi hospedado como Web Service Node, nao como site estatico."
      : data.error || "Nao foi possivel adicionar o membro.";
    const error = new Error(`${message}${suffix}`);
    error.code = data.code;
    error.retryAfter = Number(data.retryAfter || 0);
    throw error;
  }

  return data.result;
}

async function sendInviteWithRetry(payload) {
  const maxAttempts = 4;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await sendInvite(payload);
    } catch (error) {
      if (error.code !== "ratelimited" || attempt === maxAttempts) {
        throw error;
      }

      const retryAfter = Math.max(error.retryAfter || 60, 10);
      await waitWithCountdown(retryAfter);
      showStatus(`Tentando novamente (${attempt + 1}/${maxAttempts})...`);
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
  showStatus("Enviando convite...");

  try {
    const result = await sendInviteWithRetry(payload);
    const count = result.users.length;
    const noun = count === 1 ? "membro foi adicionado" : "membros foram adicionados";
    showStatus(`${count} ${noun} ao canal #${result.channelName}.`, "success");
    form.reset();
  } catch (error) {
    const message = error.message === "Failed to fetch"
      ? "Nao consegui conectar ao servidor local. Recarregue a pagina ou reinicie o app com .\\run-server.ps1."
      : error.message;
    showStatus(message, "error");
  } finally {
    submitButton.disabled = false;
  }
});
