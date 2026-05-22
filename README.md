# Slack Channel Inviter

Aplicacao simples para adicionar membros existentes do workspace a um canal do Slack usando e-mails e nome ou ID do canal.

## Requisitos

- Node.js 18 ou superior
- Um Slack OAuth Token (`xoxb-...` ou `xoxp-...`)

## Escopos do app Slack

Adicione estes escopos em **OAuth & Permissions** no app do Slack e reinstale o app no workspace:

- `users:read.email` para localizar o usuario pelo e-mail
- `channels:read` para encontrar canais publicos pelo nome
- `groups:read` para encontrar canais privados pelo nome
- `channels:join` para o bot entrar temporariamente em canais publicos pelo ID
- `channels:write.invites` para convidar em canais publicos
- `groups:write.invites` para convidar em canais privados
- `channels:write` para o bot sair do canal publico depois do convite

Ao informar o ID de um canal publico (`C...`), o app tenta entrar no canal, convidar os usuarios e sair em seguida. Para canais privados (`G...`), o bot ainda precisa ser adicionado ao canal por um membro.

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
2. Se voce informar o nome do canal, `conversations.list` encontra o canal pelo nome.
3. Se voce informar o ID do canal, o app pula a busca por nome.
4. Para canal publico por ID, `conversations.join` entra temporariamente no canal.
5. `conversations.invite` adiciona os usuarios ao canal.
6. `conversations.leave` tenta remover o bot do canal publico quando o convite termina. Se essa etapa falhar, o convite ainda e considerado concluido.

Se o Slack responder `ratelimited`, a tela aguarda o tempo indicado pela API e tenta novamente automaticamente algumas vezes.

Observacao: isso adiciona usuarios que ja existem no workspace. Para convidar pessoas externas que ainda nao estao no workspace, o fluxo e outro e normalmente exige APIs administrativas do Slack.
