# Install uv from a PyPI mirror. run.cmd runs this when uv is missing.
#
# uv's own installer and winget both download uv from GitHub, which is slow or
# unreachable from many networks in China, where most people using this are.
# uv is also published on PyPI as a wheel that carries uv.exe, and PyPI has
# mirrors there, so take uv.exe out of the wheel. It goes to
# %USERPROFILE%\.local\bin, where uv's own installer puts it and run.cmd looks.
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
# The progress bar makes downloads several times slower in PowerShell 5.1
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$platform = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'win_arm64' } else { 'win_amd64' }
$bin = Join-Path $env:USERPROFILE '.local\bin'

foreach ($index in $Indexes) {
    $tmp = $null
    try {
        # The simple index lists every file of every release; pick the newest
        # wheel for this platform
        $page = Invoke-WebRequest -UseBasicParsing -TimeoutSec 30 -Uri $index
        $best = $null
        foreach ($link in $page.Links) {
            $href = [string]$link.href
            if ($href -match "/uv-(\d+)\.(\d+)\.(\d+)-py3-none-$platform\.whl(#sha256=([0-9a-f]{64}))?$") {
                $version = [version]"$($Matches[1]).$($Matches[2]).$($Matches[3])"
                if (-not $best -or $version -gt $best.Version) {
                    $best = @{ Version = $version; Href = $href; Sha = $Matches[5] }
                }
            }
        }
        if (-not $best) { throw "no $platform wheel listed" }
        $url = [Uri]::new([Uri]$index, ($best.Href -replace '#.*$', ''))

        $tmp = Join-Path ([IO.Path]::GetTempPath()) ('uv-wheel-' + [guid]::NewGuid())
        New-Item -ItemType Directory -Path $tmp | Out-Null
        # Expand-Archive only takes .zip; a wheel is a zip
        $zip = Join-Path $tmp 'uv.zip'
        Invoke-WebRequest -UseBasicParsing -TimeoutSec 600 -Uri $url -OutFile $zip
        if ($best.Sha -and (Get-FileHash -Algorithm SHA256 $zip).Hash -ne $best.Sha.ToUpper()) {
            throw 'checksum mismatch'
        }
        Expand-Archive -Path $zip -DestinationPath $tmp
        $exe = Get-ChildItem -Path $tmp -Recurse -Filter 'uv.exe' | Select-Object -First 1
        if (-not $exe) { throw 'uv.exe not found in the wheel' }

        New-Item -ItemType Directory -Force -Path $bin | Out-Null
        # uv.exe, uvx.exe and uvw.exe sit together in the wheel
        Get-ChildItem -Path $exe.DirectoryName -Filter 'uv*.exe' | Copy-Item -Destination $bin -Force
        Remove-Item -Recurse -Force $tmp
        Write-Output "uv $($best.Version) from $index"
        exit 0
    } catch {
        Write-Output "uv from $index failed: $($_.Exception.Message)"
        if ($tmp -and (Test-Path $tmp)) { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue }
    }
}
exit 1
