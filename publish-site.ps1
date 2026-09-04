# Fetches fresh TCG data + card art, rebuilds, force-pushes to the site branch.
$ErrorActionPreference = 'Continue'
$log = 'C:\tcg-rates\publish.log'
function Log($msg) {
  "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $msg" | Add-Content -Path $log
  if ((Get-Item $log -ErrorAction SilentlyContinue).Length -gt 1MB) {
    Set-Content -Path $log -Value (Get-Content $log -Tail 500)
  }
}
try {
  Push-Location C:\tcg-rates
  node fetch-data.mjs
  if ($LASTEXITCODE -ne 0) { throw "fetch-data.mjs exited $LASTEXITCODE" }
  node build.mjs
  if ($LASTEXITCODE -ne 0) { throw "build.mjs exited $LASTEXITCODE" }
  node fetch-art.mjs
  if ($LASTEXITCODE -ne 0) { throw "fetch-art.mjs exited $LASTEXITCODE" }
  Pop-Location

  Copy-Item C:\tcg-rates\index.html C:\tcg-site\index.html -Force
  Copy-Item C:\tcg-rates\data.js C:\tcg-site\data.js -Force
  New-Item -ItemType Directory -Force C:\tcg-site\.github\workflows | Out-Null
  Copy-Item C:\tcg-rates\.github\workflows\deploy-site.yml C:\tcg-site\.github\workflows\deploy-site.yml -Force
  robocopy C:\tcg-rates\art C:\tcg-site\art /E /NFL /NDL /NJH /NJS | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "robocopy failed ($LASTEXITCODE)" }

  Push-Location C:\tcg-site
  git add index.html data.js .github art
  git commit --amend -m "site data $(Get-Date -Format 'yyyy-MM-dd HH:mm')"
  if (($LASTEXITCODE -ne 0) -and ($LASTEXITCODE -ne 1)) { throw "commit failed ($LASTEXITCODE)" }
  git push -f origin site
  if ($LASTEXITCODE -ne 0) { throw "push failed ($LASTEXITCODE)" }
  Pop-Location
  Log 'OK - site pushed'
} catch {
  Log "FAILED: $_"
  try { Pop-Location } catch {}
  exit 1
}

