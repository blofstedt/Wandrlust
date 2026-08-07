# Applies this update to your Wandrlust repo.
#
# 1. Unzip this folder somewhere.
# 2. Open PowerShell in the unzipped folder.
# 3. Run:  .\APPLY.ps1 -RepoPath "C:\Users\Brian.Lofstedt\Wandrlust"
#
# It copies the updated files in, removes the dead ones, and tells you what to
# run next. Nothing is deleted from your repo except the two duplicate legal
# files listed below.

param(
    [Parameter(Mandatory = $true)]
    [string]$RepoPath
)

$ErrorActionPreference = 'Stop'
$source = $PSScriptRoot

if (-not (Test-Path $RepoPath)) {
    Write-Host "Can't find $RepoPath" -ForegroundColor Red
    exit 1
}

Write-Host "Updating $RepoPath" -ForegroundColor Cyan

# --- Copy updated files -------------------------------------------------
$skip = @('APPLY.ps1', 'CHANGES.md')

Get-ChildItem -Path $source -Recurse -File | ForEach-Object {
    $relative = $_.FullName.Substring($source.Length).TrimStart('\')
    if ($skip -contains $relative) { return }

    $target = Join-Path $RepoPath $relative
    $targetDir = Split-Path $target -Parent
    if (-not (Test-Path $targetDir)) { New-Item -ItemType Directory -Path $targetDir -Force | Out-Null }

    Copy-Item $_.FullName $target -Force
    Write-Host "  updated  $relative" -ForegroundColor Green
}

# --- Remove dead files --------------------------------------------------
# Duplicates of public/legal/*.md that nothing imports.
$dead = @(
    'src\legal\privacy-policy.md',
    'src\legal\terms-of-service.md'
)

foreach ($file in $dead) {
    $path = Join-Path $RepoPath $file
    if (Test-Path $path) {
        Remove-Item $path -Force
        Write-Host "  removed  $file" -ForegroundColor Yellow
    }
}

$legalDir = Join-Path $RepoPath 'src\legal'
if ((Test-Path $legalDir) -and -not (Get-ChildItem $legalDir -Force)) {
    Remove-Item $legalDir -Force
    Write-Host "  removed  src\legal\" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "Done. Now run these in the repo folder:" -ForegroundColor Cyan
Write-Host "  npm install      (dependencies changed)"
Write-Host "  npm run lint     (typecheck)"
Write-Host "  npm run dev"