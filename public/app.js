const form = document.querySelector("#invite-form");
const statusBox = document.querySelector("#status");
const submitButton = document.querySelector("#submit-button");

function wait(seconds) {
  return new Promise((resolve) => window.setTimeout(resolve, seconds * 1000));
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

  const data = await response.json();
  if (!response.ok || !data.ok) {
    const suffix = data.code ? ` (${data.code})` : "";
    const error = new Error(`${data.error || "Nao foi possivel adicionar o membro."}${suffix}`);
    error.code = data.code;
    error.retryAfter = Number(data.retryAfter || 0);
    throw error;
  }

  return data.result;
}

async function sendInviteWithRetry(payload) {
  try {
    return await sendInvite(payload);
  } catch (error) {
    if (error.code !== "ratelimited") {
      throw error;
    }

    const retryAfter = Math.max(error.retryAfter || 60, 5);
    showStatus(`Limite do Slack atingido. Vou tentar novamente em ${retryAfter} segundos...`);
    await wait(retryAfter);
    showStatus("Tentando novamente...");
    return sendInvite(payload);
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
