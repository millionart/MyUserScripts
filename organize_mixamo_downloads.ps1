param(
    [Parameter(Mandatory = $false)]
    [string]$Source = "$env:USERPROFILE\Downloads",

    [Parameter(Mandatory = $false)]
    [string]$Destination = ".\mixamo_downloads"
)

$ErrorActionPreference = "Stop"

function Convert-ToSafeName {
    param([string]$Name)
    $invalidPattern = "[{0}]" -f [regex]::Escape(([System.IO.Path]::GetInvalidFileNameChars() -join ""))
    $safe = ($Name -replace $invalidPattern, " ") -replace "\s+", " "
    $safe = $safe.Trim()
    if ([string]::IsNullOrWhiteSpace($safe)) {
        return "Untitled"
    }
    return $safe
}

$sourcePath = (Resolve-Path -LiteralPath $Source).Path
$destinationPath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Destination)
New-Item -ItemType Directory -Force -Path $destinationPath | Out-Null

$moved = 0
$skipped = 0

Get-ChildItem -LiteralPath $sourcePath -Filter "*.fbx" -File | ForEach-Object {
    $baseName = [System.IO.Path]::GetFileNameWithoutExtension($_.Name)
    if ($baseName -notmatch "__") {
        $skipped += 1
        return
    }

    $parts = $baseName -split "__", 2
    $folderName = Convert-ToSafeName $parts[0]
    $fileName = Convert-ToSafeName $parts[1]

    $targetFolder = Join-Path $destinationPath $folderName
    New-Item -ItemType Directory -Force -Path $targetFolder | Out-Null

    $targetPath = Join-Path $targetFolder "$fileName.fbx"
    $suffix = 1
    while (Test-Path -LiteralPath $targetPath) {
        $targetPath = Join-Path $targetFolder ("{0} ({1}).fbx" -f $fileName, $suffix)
        $suffix += 1
    }

    Move-Item -LiteralPath $_.FullName -Destination $targetPath
    $moved += 1
}

Write-Host ("Moved {0} file(s). Skipped {1} file(s)." -f $moved, $skipped)
