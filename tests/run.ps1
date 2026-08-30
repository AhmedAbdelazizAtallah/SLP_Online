# SLP Next - one-shot verification suite (works on Windows PowerShell 5.1+)
$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
$psExe = if (Get-Command pwsh -ErrorAction SilentlyContinue) { 'pwsh' } else { 'powershell' }
$pyExe = if ($env:PYTHON_EXE) { $env:PYTHON_EXE } elseif (Get-Command python3 -ErrorAction SilentlyContinue) { 'python3' } else { 'python' }
$nodeExe = if ($env:NODE_EXE) { $env:NODE_EXE } else {
  $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
  if ($nodeCmd) { $nodeCmd.Source } else {
    $bundled = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
    if (Test-Path $bundled) { $bundled } else { 'node' }
  }
}
Write-Host "using PS=$psExe PY=$pyExe NODE=$nodeExe"
$script:fail = 0
function Step($name, $sb) {
  Write-Host "== $name ==" -ForegroundColor Cyan
  try { & $sb; if ($LASTEXITCODE -ne 0) { $script:fail++ } }
  catch { Write-Host "FAIL $name`: $($_.Exception.Message)"; $script:fail++ }
}

Step 'build bundle'      { & $psExe -NoProfile -ExecutionPolicy Bypass -File "$root\build.ps1" }
Step 'bundle syntax'     { & $nodeExe --check "$root\app.compiled.js" }
Step 'python syntax'     { & $pyExe -m py_compile "$root\Server.py" }

Write-Host "== live server + endpoints ==" -ForegroundColor Cyan
$env:PORT='8131'; $env:MAX_ROOM_SIZE='3'
$env:TURN_URL=''; $env:TURN_USERNAME=''; $env:TURN_CREDENTIAL=''
$p = Start-Process -FilePath $pyExe -ArgumentList 'Server.py' -WorkingDirectory $root -WindowStyle Hidden -PassThru
try {
  $okSrv = $false
  foreach ($i in 1..25) { Start-Sleep -Milliseconds 800; try { Invoke-RestMethod "http://127.0.0.1:8131/health" -TimeoutSec 3 | Out-Null; $okSrv=$true; break } catch {} }
  if (-not $okSrv) { Write-Host 'FAIL server did not start'; $script:fail++ }
  else {
    $checks = @('health','models','api/ice-servers','app.compiled.js','manifest.json','sw.js','vendor/react.js','vendor/react-dom.js','vendor/three.min.js','icons/icon-192.png')
    foreach ($cp in $checks) {
      try { $r = Invoke-WebRequest "http://127.0.0.1:8131/$cp" -UseBasicParsing -TimeoutSec 10; Write-Host ("{0} {1}" -f $r.StatusCode, $cp) } catch { Write-Host "FAIL $cp"; $script:fail++ }
    }
    if (Test-Path "$root\tests\node_modules\jsdom") {
      Step 'ui smoke (jsdom)' { & $nodeExe "$root\tests\ui.smoke.test.js" }
      Step 'upload UI (jsdom)' { & $nodeExe "$root\tests\up.ui.test.js" }
      Step 'quiz UI (jsdom)' { & $nodeExe "$root\tests\quiz.ui.test.js" }
      Step 'speaker mode UI (jsdom)' { & $nodeExe "$root\tests\speaker.ui.test.js" }
      Step 'text to sign UI (jsdom)' { & $nodeExe "$root\tests\text.to.sign.test.js" }
      Step '3D avatar UI (jsdom)' { & $nodeExe "$root\tests\avatar.ui.test.js" }
      Step 'responsive/a11y (jsdom)' { & $nodeExe "$root\tests\verify.responsive.test.js" }
    }
    Step 'api validation' { & $pyExe "$root\tests\api.test.py" }
    Step 'preprocessing regression' { & $nodeExe "$root\tests\preproc.test.js" }
    Step 'one letter = one capture' { & $nodeExe "$root\tests\capture.once.test.js" }
    Step 'latency + discrimination' { & $nodeExe "$root\tests\latency.discrim.test.js" }
    Step 'recognition hardening' { & $nodeExe "$root\tests\harden.test.js" }
    Step 'room hearing/deaf modes' { & $nodeExe "$root\tests\room.modes.test.js" }
    Step 'sign room controls audit' { & $nodeExe "$root\tests\room.audit.test.js" }
    Step 'ws integration'   { & $pyExe "$root\tests\ws.test.py" }
    Step 'ws reconnect'     { & $pyExe "$root\tests\ws.reconnect.test.py" }
  }
} finally { try { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue } catch {} }

if ($script:fail -eq 0) { Write-Host 'ALL CHECKS PASSED' -ForegroundColor Green; exit 0 }
else { Write-Host "$($script:fail) CHECK(S) FAILED" -ForegroundColor Red; exit 1 }
