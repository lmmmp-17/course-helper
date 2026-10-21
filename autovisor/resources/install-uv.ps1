# Install uv from a PyPI mirror. run.cmd runs this when uv is missing.
#
# uv's own installer and winget both download uv from GitHub, which is slow or
# unreachable from many networks in China, where most people using this are.
# uv is also published on PyPI as a wheel that carries uv.exe, and PyPI has
# mirrors there, so take uv.exe out of the wheel. It goes to
# %USERPROFILE%\.local\bin, where uv's own installer puts it and run.cmd looks.
#
# Only .NET here, no module cmdlets (Get-FileHash, Expand-Archive, ...).
# Started from PowerShell 7 through node or Go, this Windows PowerShell 5.1
# inherits a PSModulePath with PowerShell 7's modules first, and those cmdlets
# then fail to load: every mirror failed at the checksum (seen on Windows).
# run.cmd clears PSModulePath as well.
#
# Keep this file ASCII: Windows PowerShell 5.1 reads a file without a BOM in
# the ANSI code page.
param(
    [string[]]$Indexes = @(
        'https://pypi.tuna.tsinghua.edu.cn/simple/uv/',
        'https://mirrors.aliyun.com/pypi/simple/uv/',
        'https://pypi.org/simple/uv/'
    )
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
[void][Reflection.Assembly]::Load('System.IO.Compression, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089')
[void][Reflection.Assembly]::Load('System.IO.Compression.FileSystem, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089')

# "powershell -File install-uv.ps1 -Indexes a,b" passes a,b as one string
$list = @()
foreach ($item in $Indexes) {
    foreach ($part in $item.Split(',')) {
        if ($part.Trim()) { $list += $part.Trim() }
    }
}

$platform = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'win_arm64' } else { 'win_amd64' }
$bin = [IO.Path]::Combine($env:USERPROFILE, '.local', 'bin')
# Every file of every release is listed; only wheels with a checksum count
$pattern = 'href="([^"]*?/uv-(\d+)\.(\d+)\.(\d+)-py3-none-' + $platform + '\.whl)#sha256=([0-9a-f]{64})"'

# The mirrors answer 403 to requests without a User-Agent: Tsinghua for the
# wheel, Aliyun already for the index (pc on Windows). Invoke-WebRequest sent
# one by itself, WebClient doesn't. A fresh client per request, so the header
# is surely there.
$agent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) WindowsPowerShell/5.1 course-helper'
function New-WebClient {
    $client = [Net.WebClient]::new()
    $client.Headers['User-Agent'] = $agent
    return $client
}

foreach ($index in $list) {
    $tmp = $null
    try {
        $page = (New-WebClient).DownloadString($index)
        $best = $null
        foreach ($m in [regex]::Matches($page, $pattern)) {
            $version = [version]('{0}.{1}.{2}' -f $m.Groups[2].Value, $m.Groups[3].Value, $m.Groups[4].Value)
            if (-not $best -or $version -gt $best.Version) {
                $best = @{ Version = $version; Href = $m.Groups[1].Value; Sha = $m.Groups[5].Value }
            }
        }
        if (-not $best) { throw "no $platform wheel listed" }

        $tmp = [IO.Path]::Combine([IO.Path]::GetTempPath(), 'uv-wheel-' + [guid]::NewGuid())
        [void][IO.Directory]::CreateDirectory($tmp)
        $wheel = [IO.Path]::Combine($tmp, 'uv.whl')
        (New-WebClient).DownloadFile([Uri]::new([Uri]$index, $best.Href), $wheel)

        $stream = [IO.File]::OpenRead($wheel)
        try {
            $hash = [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($stream)).Replace('-', '').ToLower()
        } finally {
            $stream.Dispose()
        }
        if ($hash -ne $best.Sha) { throw 'checksum mismatch' }

        [void][IO.Directory]::CreateDirectory($bin)
        $copied = 0
        $zip = [IO.Compression.ZipFile]::OpenRead($wheel)
        try {
            # uv.exe, uvx.exe and uvw.exe sit together in the wheel
            foreach ($entry in $zip.Entries) {
                if ($entry.FullName -match '\.data/scripts/(uv[a-z]?\.exe)$') {
                    $target = [IO.Path]::Combine($bin, $Matches[1])
                    [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $target, $true)
                    # The wheel stores 1980-01-01 as the time of every file
                    [IO.File]::SetLastWriteTime($target, [DateTime]::Now)
                    $copied++
                }
            }
        } finally {
            $zip.Dispose()
        }
        if (-not $copied) { throw 'uv.exe not found in the wheel' }

        [IO.Directory]::Delete($tmp, $true)
        [Console]::WriteLine("uv $($best.Version) from $index")
        exit 0
    } catch {
        # One short line: the launcher may show the last line as its status
        $e = $_.Exception
        while ($e.InnerException) { $e = $e.InnerException }
        $reason = $e.Message
        if ($reason.Length -gt 80) { $reason = $reason.Substring(0, 80) + '...' }
        [Console]::WriteLine("uv from $index failed: $reason")
        if ($tmp -and [IO.Directory]::Exists($tmp)) {
            try { [IO.Directory]::Delete($tmp, $true) } catch { }
        }
    }
}
exit 1
