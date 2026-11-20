#Requires -Version 5.1
<#
.SYNOPSIS
    Install both skills into a Hermes skills directory.
.DESCRIPTION
    Backs up an existing same-named skill instead of overwriting it silently,
    so any install can be rolled back by renaming the .bak folder.
.EXAMPLE
    .\install.ps1
    .\install.ps1 -Dest "D:\HermesData\skills"
#>
param(
    [string]$Dest = ""
)

$ErrorActionPreference = "Stop"

if (-not $Dest) {
    if ($env:HERMES_SKILLS_DIR) { $Dest = $env:HERMES_SKILLS_DIR }
    elseif ($env:LOCALAPPDATA)  { $Dest = Join-Path $env:LOCALAPPDATA "hermes\skills" }
    else                        { $Dest = Join-Path $HOME ".hermes\skills" }
}

$src = Join-Path $PSScriptRoot "skills"
if (-not (Test-Path $src)) {
    throw "$src not found - run this script from the repository root"
}

New-Item -ItemType Directory -Force -Path $Dest | Out-Null
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"

Write-Host "source: $src"
Write-Host "target: $Dest"

Get-ChildItem -Path $src -Directory | ForEach-Object {
    $name = $_.Name
    $target = Join-Path $Dest $name
    if (Test-Path $target) {
        $bak = "$target.bak-$stamp"
        Move-Item -Path $target -Destination $bak
        Write-Host "  backed up existing $name -> $name.bak-$stamp"
    }
    Copy-Item -Path $_.FullName -Destination $target -Recurse -Force
    Write-Host "  installed $name"
}

Write-Host ""
Write-Host "done. restart Hermes (or reload skills) to pick them up."
Write-Host "rollback: rename the .bak-$stamp folder back to its original name."
