# Generates app.compiled.js (prebuilt JSX bundle) from the app-source block
# inside app.html. Run this after every edit to app.html's React code:
#   powershell -ExecutionPolicy Bypass -File build.ps1
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot

# Package-runner child processes invoke `node` by name. Honor an explicit
# executable and support Codex's bundled runtime without hard-coding a user.
$nodeExe = $env:NODE_EXE
if (-not $nodeExe) {
  $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
  if ($nodeCmd) { $nodeExe = $nodeCmd.Source }
  else {
    $bundledNode = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
    if (Test-Path $bundledNode) { $nodeExe = $bundledNode }
  }
}
if ($nodeExe -and (Test-Path $nodeExe)) {
  $nodeDir = Split-Path -Parent $nodeExe
  if (($env:PATH -split [IO.Path]::PathSeparator) -notcontains $nodeDir) {
    $env:PATH = $nodeDir + [IO.Path]::PathSeparator + $env:PATH
  }
}

$htmlPath = Join-Path $root 'app.html'
$html = [IO.File]::ReadAllText($htmlPath)
$m = [regex]::Match($html, '(?s)<script type="text/plain" id="app-source">(.*?)</script>')
if (-not $m.Success) { throw 'app-source block not found in app.html' }

# Use npx when available, with pnpm dlx as a portable fallback. NODE_PACKAGE_RUNNER
# can override the runner in CI or in bundled desktop environments.
$runner = $env:NODE_PACKAGE_RUNNER
if (-not $runner) {
  $npx = Get-Command npx.cmd, npx -ErrorAction SilentlyContinue | Select-Object -First 1
  $pnpm = Get-Command pnpm.cmd, pnpm -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($npx) { $runner = $npx.Source }
  elseif ($pnpm) { $runner = $pnpm.Source }
  else { throw 'Neither npx nor pnpm was found. Install Node.js/npm or pnpm, or set NODE_PACKAGE_RUNNER.' }
}

$tmp = Join-Path ([IO.Path]::GetTempPath()) ('slp_' + [guid]::NewGuid().ToString('N') + '.jsx')
[IO.File]::WriteAllText($tmp, $m.Groups[1].Value, (New-Object System.Text.UTF8Encoding($false)))

$outTmp = Join-Path $root 'app.compiled.js.tmp'
$runnerName = [IO.Path]::GetFileNameWithoutExtension($runner)
$runnerArgs = if ($runnerName -eq 'pnpm') { @('dlx', 'esbuild@0.25.9') } else { @('-y', 'esbuild@0.25.9') }
& $runner @runnerArgs $tmp '--loader:.jsx=jsx' '--jsx=transform' "--outfile=$outTmp"
if ($LASTEXITCODE -ne 0) { throw "esbuild failed with exit code $LASTEXITCODE" }

$code = [IO.File]::ReadAllText($outTmp)
$compiledPath = Join-Path $root 'app.compiled.js'
$tail = @"

window.__SLP_BUNDLED=1;
try {
  ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(App));
} catch (e) {
  if (window.__SLP_RENDER_FATAL) { window.__SLP_RENDER_FATAL(e); } else { throw e; }
}
"@
[IO.File]::WriteAllText($compiledPath, $code + $tail, (New-Object System.Text.UTF8Encoding($false)))
Remove-Item $outTmp, $tmp -Force
$bundleHash = (Get-FileHash $compiledPath -Algorithm SHA256).Hash.ToLowerInvariant()
$stamp = 'next-' + $bundleHash.Substring(0, 12)
$html2 = [IO.File]::ReadAllText($htmlPath)
$html2 = [regex]::Replace($html2, "window\.__SLP_BUILD_ID='[^']*'", "window.__SLP_BUILD_ID='$stamp'")
[IO.File]::WriteAllText($htmlPath, $html2, (New-Object System.Text.UTF8Encoding($false)))
Write-Host ("stamp $stamp")
Write-Host ("OK app.compiled.js generated ({0:N0} bytes)" -f (Get-Item $compiledPath).Length)
