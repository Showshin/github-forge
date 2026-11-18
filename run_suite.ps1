param(
  [string]$Root = "C:\Users\ADMIN\Desktop\DoAn\makefun\github-forge",
  [string]$Kit = "C:\Users\ADMIN\Desktop\DoAn\makefun\github-core-clone-01-kit\github-core-clone-01-kit",
  [int]$Port = 8097,
  [string]$Token = "testtoken-github-forge",
  [int]$Wall = 600
)
$state = Join-Path $Root "state"
if (Test-Path (Join-Path $state "env.pid")) {
  $old = Get-Content (Join-Path $state "env.pid")
  Stop-Process -Id $old -Force -ErrorAction SilentlyContinue
}
Remove-Item -Recurse -Force $state -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $state | Out-Null
$env:MAKEFUN_STATE_DIR = $state
$env:MAKEFUN_ENV_HOST = "127.0.0.1"
$env:MAKEFUN_ENV_PORT = "$Port"
$env:MAKEFUN_SHOP_TOKEN = $Token
$env:MAKEFUN_TRIAL_WALL_BUDGET_SEC = "$Wall"
$envp = Start-Process node -ArgumentList (Join-Path $Kit "program/env/server.mjs") -PassThru -WindowStyle Hidden -RedirectStandardOutput (Join-Path $state "env.out") -RedirectStandardError (Join-Path $state "env.err")
$envp.Id | Set-Content (Join-Path $state "env.pid")
for ($i = 0; $i -lt 60; $i++) {
  if (Test-Path (Join-Path $state "ready")) { break }
  Start-Sleep -Milliseconds 250
}
if (-not (Test-Path (Join-Path $state "ready"))) {
  Write-Output "env did not become ready"
  Get-Content (Join-Path $state "env.err") -ErrorAction SilentlyContinue
  exit 1
}
$env:MAKEFUN_ENV_URL = "http://127.0.0.1:$Port"
$sw = [Diagnostics.Stopwatch]::StartNew()
Push-Location $Root
node --experimental-strip-types main.ts 2>&1 | Select-Object -Last 20
Pop-Location
$sw.Stop()
Write-Output ("bot elapsed_s=" + [math]::Round($sw.Elapsed.TotalSeconds, 1))
Stop-Process -Id $envp.Id -Force -ErrorAction SilentlyContinue
$stateFile = Join-Path $state "state.json"
if (Test-Path $stateFile) {
  python -c "import json,collections;d=json.load(open(r'$stateFile',encoding='utf-8'));print('bootOk',d.get('bootOk'),'counts',d.get('counts'));r=d.get('results',{});print('passed',sum(1 for v in r.values() if v.get('ok')) if isinstance(r,dict) else 'list');print(json.dumps([(k,v) for k,v in (r.items() if isinstance(r,dict) else []) if not v.get('ok')][:8],indent=1)[:3000])"
} else {
  Write-Output "no state.json"
  Get-Content (Join-Path $state "env.err") -ErrorAction SilentlyContinue | Select-Object -Last 20
}
