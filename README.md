# Slack Channel Inviter

Aplicacao simples para adicionar membros existentes do workspace a um canal do Slack usando e-mails e nome do canal.

## Requisitos

- Node.js 18 ou superior
- Um Slack OAuth Token (`xoxb-...` ou `xoxp-...`)

## Escopos do app Slack

Adicione estes escopos em **OAuth & Permissions** no app do Slack e reinstale o app no workspace:

- `users:read.email` para localizar o usuario pelo e-mail
- `channels:read` para encontrar canais publicos pelo nome
- `groups:read` para encontrar canais privados pelo nome
- `channels:write.invites` para convidar em canais publicos
- `groups:write.invites` para convidar em canais privados

O app tambem precisa estar no canal quando o Slack exigir isso, especialmente em canais privados.

## Como rodar

No PowerShell:

```powershell
.\run-server.ps1
```

Depois abra:

```text
http://localhost:3000
```

## Como funciona

1. `users.lookupByEmail` encontra cada usuario pelo e-mail.
2. `conversations.list` encontra o canal pelo nome.
3. `conversations.invite` adiciona os usuarios ao canal.

Se o Slack responder `ratelimited`, a tela aguarda o tempo indicado pela API e tenta novamente uma vez.

Observacao: isso adiciona usuarios que ja existem no workspace. Para convidar pessoas externas que ainda nao estao no workspace, o fluxo e outro e normalmente exige APIs administrativas do Slack.
