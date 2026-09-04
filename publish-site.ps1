# Fetches fresh OSRS TCG data, rebuilds the site, and force-pushes it to the
# 'site' branch, which triggers the GitHub Pages deploy workflow.
#
# Designed to be run hourly by Windows Task Scheduler. Fetch failures are
# non-fatal: the previously deployed data simply stays live.

$ErrorActionPreference = 'Stop'

$repo = 'C:\Users\james\Documents\dev\osrs-tcg-pull-rates'
$siteDir = 'C:\Users\james\Documents\dev\osrs-tcg-site'
$log = Join-Path $repo 'publish.log'

function Log($msg) {
  "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $msg" | Add-Content -Path $log
  if ($log.Length -gt 1MB) { # keep log small
    $lines = Get-Content $log -Tail 500
    Set-Content -Path $log -Value $lines
  }
}

try {
  # 1. Fetch + build (any failure here aborts; old data stays live)
  Push-Location $repo
  node fetch-data.mjs
  if ($LASTEXITCODE -ne 0) { throw "fetch-data.mjs exited $LASTEXITCODE" }
  node build.mjs
  if ($LASTEXITCODE -ne 0) { throw "build.mjs exited $LASTEXITCODE" }
  Pop-Location

  # 2. Copy built site into the site clone
  Copy-Item (Join-Path $repo 'index.html') $siteDir -Force
  Copy-Item (Join-Path $repo 'data.js') $siteDir -Force

  # 3. Amend the single site commit and force-push
  Push-Location $siteDir
  git add index.html data.js
  git commit --amend -m "site data $(Get-Date -Format 'yyyy-MM-dd HH:mm')" | Out-Null
  git push -f origin site 2>&1 | ForEach-Object { Log "git: $_" }
  Pop-Location

  Log 'OK - site pushed'
} catch {
  Log "FAILED: $_"
  exit 1
}
