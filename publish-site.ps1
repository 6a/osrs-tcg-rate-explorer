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
  Copy-Item C:\tcg-rates\styles.css C:\tcg-site\styles.css -Force
  Copy-Item C:\tcg-rates\app.js C:\tcg-site\app.js -Force
  Copy-Item C:\tcg-rates\data.js C:\tcg-site\data.js -Force
  New-Item -ItemType Directory -Force C:\tcg-site\.github\workflows | Out-Null
  Copy-Item C:\tcg-rates\.github\workflows\deploy-site.yml C:\tcg-site\.github\workflows\deploy-site.yml -Force
  robocopy C:\tcg-rates\art C:\tcg-site\art /E /NFL /NDL /NJH /NJS | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "robocopy failed ($LASTEXITCODE)" }

  Push-Location C:\tcg-site
  git add index.html styles.css app.js data.js .github art
  # Fail-closed full-art mirror guard: .gitignore contains art/, and `git add`
  # on an ignored path adds nothing yet exits 0 - then amend+push succeed
  # shipping data.js paths with zero bytes. Count "fullArt":1 rows in the
  # just-built data.js (strip the window.PULL_DATA wrapper, JSON.parse, count
  # cards with fullArt === 1); if > 0, abort unless art/full files are tracked
  # AND not ignored. check-ignore -q signals via exit code: 1 means NOT
  # ignored (passing). Check a concrete mirrored file (first fullArtPath),
  # not the bare directory. Self-skips when the expected count is 0.
  $guardJson = node -e "const fs=require('fs');const raw=fs.readFileSync('data.js','utf8');const payload=JSON.parse(raw.replace(/^window\.PULL_DATA\s*=\s*/,'').replace(/;\s*$/,''));const arts=payload.cards.filter(c=>c.fullArt===1);console.log(JSON.stringify({count:arts.length,first:arts.length?arts[0].fullArtPath:null}))"
  if ($LASTEXITCODE -ne 0) { throw "full-art guard: failed to parse data.js" }
  $guard = $guardJson | ConvertFrom-Json
  if ($guard.count -gt 0) {
    $tracked = git ls-files --cached art/full
    if ([string]::IsNullOrWhiteSpace(($tracked | Out-String))) { throw "full-art guard: data.js has $($guard.count) full-art rows but no art/full files are tracked (gitignored?)" }
    git check-ignore -q $guard.first
    if ($LASTEXITCODE -ne 1) { throw "full-art guard: $($guard.first) is git-ignored; art/full mirror would not deploy" }
  }
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

