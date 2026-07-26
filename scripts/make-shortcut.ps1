<#
.SYNOPSIS
    Create the Ganglion desktop shortcut (and optionally a Start Menu entry).

.DESCRIPTION
    The desktop shell is launched as `electron.exe electron\main.js`, never as a .bat --
    a .bat flashes a console window every time, and `electron .` would resolve
    package.json:main (server.js) and boot Express inside Electron.

    That recipe lived only in README.md as three fields to type into the shortcut
    properties dialog, which meant it was re-derived by hand on every rebuild. This is the
    same recipe, executable.

    Runs unelevated: both targets are per-user paths.

.PARAMETER Name
    Shortcut file name, without .lnk. Defaults to "Ganglion".

.PARAMETER StartMenu
    Also create the shortcut under the user's Start Menu\Programs.

.PARAMETER Force
    Overwrite an existing shortcut instead of leaving it alone.

.EXAMPLE
    .\scripts\make-shortcut.ps1
    .\scripts\make-shortcut.ps1 -StartMenu -Force
#>
[CmdletBinding()]
param(
    [string] $Name = 'Ganglion',
    [switch] $StartMenu,
    [switch] $Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Resolve the repo from this script's own location rather than the caller's cwd, so the
# shortcut is correct no matter where it was invoked from.
$repoRoot = Split-Path -Parent $PSScriptRoot
$electron = Join-Path $repoRoot 'node_modules\electron\dist\electron.exe'
$mainJs   = Join-Path $repoRoot 'electron\main.js'

if (-not (Test-Path $electron)) {
    # The usual cause is a skipped postinstall download, not a missing npm install --
    # so say which fix applies rather than "run npm install".
    throw "Electron binary not found at $electron. If node_modules exists, the postinstall download was skipped: run ``node node_modules/electron/install.js`` from $repoRoot."
}
if (-not (Test-Path $mainJs)) {
    throw "electron\main.js not found at $mainJs. Is $repoRoot really the Ganglion repo?"
}

$targets = @([Environment]::GetFolderPath('Desktop'))
if ($StartMenu) {
    $targets += Join-Path ([Environment]::GetFolderPath('StartMenu')) 'Programs'
}

$shell = New-Object -ComObject WScript.Shell
try {
    foreach ($dir in $targets) {
        $linkPath = Join-Path $dir "$Name.lnk"

        if ((Test-Path $linkPath) -and -not $Force) {
            Write-Host "exists, left alone: $linkPath  (re-run with -Force to overwrite)"
            continue
        }

        $link = $shell.CreateShortcut($linkPath)
        $link.TargetPath = $electron
        # Relative to WorkingDirectory below. Electron resolves it against cwd, and keeping
        # it relative means a moved repo still works if WorkingDirectory is fixed up.
        $link.Arguments = 'electron\main.js'
        $link.WorkingDirectory = $repoRoot
        $link.Description = 'Ganglion desktop shell (attaches to the running pm2 server)'
        $link.IconLocation = "$electron,0"
        $link.Save()

        Write-Host "created: $linkPath"
    }
} finally {
    # Without this the COM object can keep a handle alive for the rest of the session.
    [void][Runtime.InteropServices.Marshal]::ReleaseComObject($shell)
}

Write-Host ''
Write-Host 'The shortcut opens a window onto the already-running server; it never starts one.'
Write-Host 'If nothing is listening you get the retry screen until pm2 brings Ganglion back.'
