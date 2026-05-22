$ErrorActionPreference = "Stop"

Set-Location $PSScriptRoot

$node = "C:\Users\Jeff\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
$log = Join-Path $PSScriptRoot "server-output.log"

"[$(Get-Date -Format o)] Iniciando supervisor do Slack Channel Inviter" | Out-File -FilePath $log -Encoding utf8

while ($true) {
  "[$(Get-Date -Format o)] Iniciando servidor" | Out-File -FilePath $log -Append -Encoding utf8
  & $node ".\server.mjs" *>> $log
  $exitCode = $LASTEXITCODE
  "[$(Get-Date -Format o)] Servidor saiu com codigo $exitCode; reiniciando em 2 segundos" | Out-File -FilePath $log -Append -Encoding utf8
  Start-Sleep -Seconds 2
}
