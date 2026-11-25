param(
  [Parameter(Mandatory = $false)][string]$Repo = "",
  [string]$Version = "latest",
  [switch]$NoLaunch,
  [switch]$NoSkills
)

# Installs OpenHack from a GitHub release: resolves the asset, verifies its
# SHA-256 against SHA256SUMS.txt, installs silently, copies the bundled skills,
# then launches. Idempotent: running it again upgrades in place.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Say($text, $color = 'Cyan') { Write-Host $text -ForegroundColor $color }

if (-not $Repo) { throw "Repo is required, for example: -Repo owner/openhack" }

$api = if ($Version -eq "latest") {
  "https://api.github.com/repos/$Repo/releases/latest"
} else {
  "https://api.github.com/repos/$Repo/releases/tags/$Version"
}

Say "Resolving $Repo ($Version)..."
$headers = @{ 'User-Agent' = 'openhack-installer' }
if ($env:GITHUB_TOKEN) { $headers['Authorization'] = "Bearer $env:GITHUB_TOKEN" }
$release = Invoke-RestMethod -Uri $api -Headers $headers

$asset = $release.assets | Where-Object { $_.name -like 'OpenHack-Setup-*.exe' } | Select-Object -First 1
if (-not $asset) { throw "No OpenHack-Setup-*.exe asset on release $($release.tag_name)" }
$sums = $release.assets | Where-Object { $_.name -eq 'SHA256SUMS.txt' } | Select-Object -First 1

$temp = Join-Path $env:TEMP ("openhack-install-" + [guid]::NewGuid().ToString('n'))
New-Item -ItemType Directory -Force -Path $temp | Out-Null
$setup = Join-Path $temp $asset.name

Say "Downloading $($asset.name) ($([math]::Round($asset.size / 1MB)) MB)..."
Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $setup -Headers $headers

if ($sums) {
  $sumFile = Join-Path $temp 'SHA256SUMS.txt'
  Invoke-WebRequest -Uri $sums.browser_download_url -OutFile $sumFile -Headers $headers
  $line = Get-Content $sumFile | Where-Object { $_ -match [regex]::Escape($asset.name) } | Select-Object -First 1
  if ($line) {
    $expected = ($line -split '\s+')[0].ToLower()
    $actual = (Get-FileHash $setup -Algorithm SHA256).Hash.ToLower()
    if ($expected -ne $actual) { throw "SHA-256 mismatch. Expected $expected, got $actual" }
    Say "Hash verified."
  }
}

Say "Installing (per-user, no admin)..."
Start-Process -FilePath $setup -ArgumentList '/S' -Wait

$exe = Join-Path $env:LOCALAPPDATA 'Programs\OpenHack\OpenHack.exe'
$deadline = (Get-Date).AddMinutes(3)
while (-not (Test-Path $exe) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 800 }
if (-not (Test-Path $exe)) { throw "Install finished but $exe was not found." }

$data = Join-Path $env:APPDATA 'OpenHack'
New-Item -ItemType Directory -Force -Path $data | Out-Null

# Skills that sit beside this script (a cloned checkout) become the operator's
# library. The installer already ships a starter set; this adds the rest.
if (-not $NoSkills) {
  $localSkills = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) '..\skills'
  if (Test-Path $localSkills) {
    Say "Copying skills..."
    $target = Join-Path $data 'skills'
    New-Item -ItemType Directory -Force -Path $target | Out-Null
    Copy-Item (Join-Path $localSkills '*') $target -Recurse -Force
  }
}

Remove-Item $temp -Recurse -Force -ErrorAction SilentlyContinue

Say "Installed: $exe"
Say "Version:   $($release.tag_name)"
if (-not $NoLaunch) {
  Say "Launching."
  Start-Process -FilePath $exe
}

Say ""
Say "Next: open Settings -> Model providers and add an OpenAI-compatible endpoint," -ForegroundColor Yellow
Say "or run Extensions -> Import OpenCode if OpenCode is already configured." -ForegroundColor Yellow
