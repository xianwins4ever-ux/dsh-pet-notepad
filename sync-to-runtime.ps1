<#
.SYNOPSIS
  把本仓库的插件源码同步到 DSH 运行副本。

.DESCRIPTION
  本仓库是源码真身，DSH 实际加载的是 ~/.dsh/plugins/dsh-pet-notepad。
  改完代码后跑一次本脚本，再让 agent 执行 dev_reload_package 热重载即可生效。
  同步是逐文件覆盖 + 哈希校验，失败会明确指出哪个文件没同步上。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\sync-to-runtime.ps1
  powershell -ExecutionPolicy Bypass -File .\sync-to-runtime.ps1 -WhatIf
#>
param(
  [string]$Target = (Join-Path $env:USERPROFILE '.dsh\plugins\dsh-pet-notepad'),
  [switch]$WhatIf
)

$ErrorActionPreference = 'Stop'
$Source = $PSScriptRoot
$Files = @('package.json', 'cordis.patch.yml', 'README.md', 'lib\index.js', 'lib\client.js')

if (-not (Test-Path -LiteralPath $Target)) {
  Write-Error "Runtime copy not found: $Target"
}

Write-Host "source: $Source"
Write-Host "target: $Target"
if ($WhatIf) { Write-Host "(WhatIf: compare only, no write)" -ForegroundColor Yellow }
Write-Host ''

$failed = 0
foreach ($rel in $Files) {
  $src = Join-Path $Source $rel
  $dst = Join-Path $Target $rel
  if (-not (Test-Path -LiteralPath $src)) {
    Write-Host ("MISSING   {0}" -f $rel) -ForegroundColor Red
    $failed++
    continue
  }
  $hashSrc = (Get-FileHash -LiteralPath $src -Algorithm SHA256).Hash
  $hashDst = if (Test-Path -LiteralPath $dst) { (Get-FileHash -LiteralPath $dst -Algorithm SHA256).Hash } else { '' }

  if ($hashSrc -eq $hashDst) {
    Write-Host ("unchanged {0}" -f $rel) -ForegroundColor DarkGray
    continue
  }
  if ($WhatIf) {
    Write-Host ("would copy {0}" -f $rel) -ForegroundColor Yellow
    continue
  }
  $parent = Split-Path -Parent $dst
  if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
  Copy-Item -LiteralPath $src -Destination $dst -Force
  $hashAfter = (Get-FileHash -LiteralPath $dst -Algorithm SHA256).Hash
  if ($hashAfter -eq $hashSrc) {
    Write-Host ("copied    {0}" -f $rel) -ForegroundColor Green
  } else {
    Write-Host ("MISMATCH  {0}" -f $rel) -ForegroundColor Red
    $failed++
  }
}

Write-Host ''
if ($failed -gt 0) {
  Write-Host "FAILED: $failed file(s)" -ForegroundColor Red
  exit 1
}
if ($WhatIf) { Write-Host 'OK (compare only)' -ForegroundColor Green; exit 0 }
Write-Host 'OK - now run in DSH: dev_reload_package {"packageName":"dsh-pet-notepad"}' -ForegroundColor Green
