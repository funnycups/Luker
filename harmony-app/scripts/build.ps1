# build.ps1 — build the unsigned Luker HAP for HarmonyOS from source.
#
# For Windows. On macOS and Linux use build.sh.
#
# Prerequisites:
#   - Node.js 24 or newer
#   - DevEco Studio installed (it provides the HarmonyOS toolchain and hvigorw.bat)
$ErrorActionPreference = "Stop"

$ScriptDir   = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = (Resolve-Path (Join-Path $ScriptDir "..")).Path
$RepoRoot    = (Resolve-Path (Join-Path $ProjectRoot "..")).Path

Write-Host "==> Installing Node dependencies"
Set-Location $RepoRoot
npm install
if ($LASTEXITCODE -ne 0) { throw "npm install failed" }

# --- Prepare the Node runtime (mirrors scripts/prepare-node.sh) ---------------
$NodeVersion    = if ($env:NODE_VERSION) { $env:NODE_VERSION } else { "24.2.0" }
$ReleaseRepo    = if ($env:RELEASE_REPO) { $env:RELEASE_REPO } else { "electerm/ohos-node-shared" }
$ReleaseTag     = if ($env:RELEASE_TAG)  { $env:RELEASE_TAG }  else { "ohos-node-shared-v$NodeVersion" }
$ExpectedSha256 = "3019bf5f9a279d98a87606fc13c53b0e797b6a50cf174f8a1243d880c71151a1"
$DownloadUrl    = "https://github.com/$ReleaseRepo/releases/download/$ReleaseTag/libnode-arm64.so"

$LibsDir = Join-Path $ProjectRoot "entry\libs\arm64-v8a"
$OutBin  = Join-Path $LibsDir "libnode.so"
New-Item -ItemType Directory -Force -Path $LibsDir | Out-Null

function Assert-Sha256($Path, $Expected) {
  $actual = (Get-FileHash -Algorithm SHA256 -Path $Path).Hash.ToLower()
  if ($actual -ne $Expected) {
    throw "sha256 mismatch for $Path`n  expected: $Expected`n  actual:   $actual"
  }
  Write-Host "==> sha256 verified: $actual"
}

Write-Host "==> Preparing the Node runtime"
if ((Test-Path $OutBin) -and ((Get-Item $OutBin).Length -gt 0)) {
  Assert-Sha256 $OutBin $ExpectedSha256
} else {
  $Tmp = "$OutBin.tmp"
  Write-Host "==> Downloading $DownloadUrl"
  Invoke-WebRequest -Uri $DownloadUrl -OutFile $Tmp
  Assert-Sha256 $Tmp $ExpectedSha256
  Move-Item -Force $Tmp $OutBin
}

# --- Prepare the web assets (mirrors scripts/prepare-web.sh) -----------------
Write-Host "==> Building frontend bundles"
Set-Location $RepoRoot
node docker/build-lib.js
if ($LASTEXITCODE -ne 0) { throw "webpack build failed" }

Write-Host "==> Staging Luker project into resfile"
$ResfileDir = Join-Path $ProjectRoot "entry\src\main\resources\resfile\luker"
$BundlesDir = Join-Path $ResfileDir "_prebuilt-bundles"
if (Test-Path $ResfileDir) { Remove-Item -Recurse -Force $ResfileDir }
New-Item -ItemType Directory -Force -Path $BundlesDir | Out-Null

foreach ($item in @("server.js","webpack.config.js","package.json","package-lock.json","plugins.js","src","public","default","plugins","node_modules")) {
  Copy-Item -Recurse -Force (Join-Path $RepoRoot $item) (Join-Path $ResfileDir $item)
}

$configSrc = Join-Path $RepoRoot "config.yaml"
if (-not (Test-Path $configSrc)) { $configSrc = Join-Path $RepoRoot "default\config.yaml" }
Copy-Item -Force $configSrc (Join-Path $ResfileDir "config.yaml")

Copy-Item -Force (Join-Path $ProjectRoot "resfile-src\bootstrap.js") (Join-Path $ResfileDir "bootstrap.js")

foreach ($bundle in @("lib.core.bundle.js","lib.optional.bundle.js","codemirror.bundle.js")) {
  $src = Get-ChildItem -Path (Join-Path $RepoRoot "dist\_webpack") -Recurse -Filter $bundle -File | Select-Object -First 1
  if (-not $src) { throw "missing bundle: $bundle" }
  Copy-Item -Force $src.FullName (Join-Path $BundlesDir $bundle)
}

# hvigor's resfile copy aborts on symbolic links and junctions; drop them.
Get-ChildItem -Path $ResfileDir -Recurse -Force -ErrorAction SilentlyContinue |
  Where-Object { ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 } |
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue

# --- Build the HAP -----------------------------------------------------------
$hvigorw = $env:HVIGORW
if (-not $hvigorw) {
  $cmd = Get-Command hvigorw.bat -ErrorAction SilentlyContinue
  if ($cmd) { $hvigorw = $cmd.Source }
  elseif (Test-Path "C:\Program Files\Huawei\DevEco Studio\tools\hvigor\bin\hvigorw.bat") {
    $hvigorw = "C:\Program Files\Huawei\DevEco Studio\tools\hvigor\bin\hvigorw.bat"
  } else {
    throw "hvigorw.bat not found. Install DevEco Studio, add its tools\hvigor\bin to PATH, or set HVIGORW."
  }
}

# DevEco ships the SDK and a Node.js that hvigor is compatible with. The system
# Node may be too new (hvigor calls fs.rmdirSync with recursive, removed in Node 26).
$devecoHome = $null
try { $devecoHome = (Resolve-Path (Join-Path (Split-Path $hvigorw) "..\..\..")).Path } catch {}
if ($devecoHome -and (Test-Path (Join-Path $devecoHome "sdk"))) {
  if (-not $env:DEVECO_SDK_HOME)  { $env:DEVECO_SDK_HOME  = Join-Path $devecoHome "sdk" }
  if (-not $env:DEVECO_NODE_HOME) { $env:DEVECO_NODE_HOME = Join-Path $devecoHome "tools\node" }
  if (-not $env:NODE_HOME)        { $env:NODE_HOME        = Join-Path $devecoHome "tools\node" }
  $env:PATH = "$(Join-Path $devecoHome 'tools\node\bin');$(Join-Path $devecoHome 'tools\ohpm\bin');$(Join-Path $devecoHome 'tools\hvigor\bin');$env:PATH"
}

Write-Host "==> Building the HAP"
Set-Location $ProjectRoot
& $hvigorw assembleHap -p product=default -p buildMode=release --no-daemon
if ($LASTEXITCODE -ne 0) { throw "hvigorw build failed" }

$hap = Get-ChildItem -Path (Join-Path $ProjectRoot "entry\build") -Recurse -Filter "*.hap" -File | Select-Object -First 1
Write-Host "==> Done. HAP: $($hap.FullName)"
