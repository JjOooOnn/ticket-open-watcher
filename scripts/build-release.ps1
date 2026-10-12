$ErrorActionPreference = 'Stop'

$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$manifestPath = Join-Path $projectRoot 'extension\manifest.json'
$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($manifest.manifest_version -ne 3 -or $manifest.version -notmatch '^\d+\.\d+\.\d+$') {
    throw 'Expected a valid Manifest V3 version.'
}

$releaseDir = Join-Path $projectRoot 'release'
[IO.Directory]::CreateDirectory($releaseDir) | Out-Null
$archiveName = "nol-ticket-watcher-v$($manifest.version).zip"
$archivePath = Join-Path $releaseDir $archiveName
$checksumPath = Join-Path $releaseDir "$archiveName.sha256"

# Only ship files needed to load and use the extension.
$entries = [ordered]@{
    'manifest.json' = 'extension\manifest.json'
    'content.js' = 'extension\content.js'
    'popup.html' = 'extension\popup.html'
    'popup.css' = 'extension\popup.css'
    'popup.js' = 'extension\popup.js'
    'INSTALL.md' = 'INSTALL.md'
}

Add-Type -AssemblyName System.IO.Compression
$output = [IO.File]::Open($archivePath, [IO.FileMode]::Create, [IO.FileAccess]::Write)
try {
    $archive = [IO.Compression.ZipArchive]::new($output, [IO.Compression.ZipArchiveMode]::Create, $false)
    try {
        foreach ($entryName in $entries.Keys) {
            $sourcePath = Join-Path $projectRoot $entries[$entryName]
            if (-not [IO.File]::Exists($sourcePath)) { throw "Missing release file: $sourcePath" }
            $entry = $archive.CreateEntry($entryName, [IO.Compression.CompressionLevel]::Optimal)
            $entry.LastWriteTime = [DateTimeOffset]::new(2020, 1, 1, 0, 0, 0, [TimeSpan]::Zero)
            $source = [IO.File]::OpenRead($sourcePath)
            try {
                $destination = $entry.Open()
                try { $source.CopyTo($destination) }
                finally { $destination.Dispose() }
            }
            finally { $source.Dispose() }
        }
    }
    finally { $archive.Dispose() }
}
finally { $output.Dispose() }

$hash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
$checksum = "$hash  $archiveName`n"
[IO.File]::WriteAllText($checksumPath, $checksum, [Text.UTF8Encoding]::new($false))
Write-Output $archivePath
Write-Output "SHA256: $hash"
