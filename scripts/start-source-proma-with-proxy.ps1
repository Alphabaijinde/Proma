$ErrorActionPreference = 'Stop'

$Utf8NoBom = [System.Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = $Utf8NoBom
[Console]::OutputEncoding = $Utf8NoBom
$OutputEncoding = $Utf8NoBom
$env:PYTHONIOENCODING = 'utf-8'
$env:PYTHONUTF8 = '1'
$env:LANG = 'C.UTF-8'
$env:LC_ALL = 'C.UTF-8'
chcp.com 65001 | Out-Null

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = (Resolve-Path (Join-Path $ScriptDir '..')).Path
$LogDir = Join-Path $ProjectRoot 'logs'
$ProxyScript = 'C:\Users\admin\azure_responses_proxy.py'
$PythonExe = 'D:\Python\Python313\python.exe'
$ProxyUrl = 'http://127.0.0.1:8787/health'
$VitePort = 5173

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

$LauncherLog = Join-Path $LogDir 'start-source-proma-with-proxy.log'
$PromaStdout = Join-Path $LogDir 'source-dev.stdout.log'
$PromaStderr = Join-Path $LogDir 'source-dev.stderr.log'
$ViteStdout = Join-Path $LogDir 'source-vite.stdout.log'
$ViteStderr = Join-Path $LogDir 'source-vite.stderr.log'
$BuildStdout = Join-Path $LogDir 'source-build.stdout.log'
$BuildStderr = Join-Path $LogDir 'source-build.stderr.log'
$ProxyStdout = Join-Path $LogDir 'azure-proxy.stdout.log'
$ProxyStderr = Join-Path $LogDir 'azure-proxy.stderr.log'

function Write-LauncherLog {
  param([string]$Message)
  $line = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
  Add-Content -LiteralPath $LauncherLog -Value $line
}

function Test-HttpOk {
  param([string]$Url)
  try {
    $result = Invoke-RestMethod -Uri $Url -TimeoutSec 2
    return ($result.status -eq 'ok')
  } catch {
    return $false
  }
}

function Test-PortListening {
  param([int]$Port)
  $endpoints = @(
    @{ Address = '::1'; Family = [System.Net.Sockets.AddressFamily]::InterNetworkV6 },
    @{ Address = '127.0.0.1'; Family = [System.Net.Sockets.AddressFamily]::InterNetwork }
  )

  foreach ($endpoint in $endpoints) {
    $client = $null
    try {
      $client = [System.Net.Sockets.TcpClient]::new($endpoint.Family)
      $address = [System.Net.IPAddress]::Parse($endpoint.Address)
      $async = $client.BeginConnect($address, $Port, $null, $null)
      if (-not $async.AsyncWaitHandle.WaitOne(500)) {
        continue
      }
      $client.EndConnect($async)
      return $true
    } catch {
      continue
    } finally {
      if ($client) {
        $client.Close()
      }
    }
  }
  return $false
}

function Show-WindowByTitle {
  param(
    [string]$Title,
    [int]$TimeoutSeconds = 30
  )

  if (-not ('WindowActivator' -as [type])) {
    Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;

public static class WindowActivator {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
}
'@
  }

  $shell = New-Object -ComObject WScript.Shell
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)

  while ((Get-Date) -lt $deadline) {
    $script:WindowActivatorHandle = [IntPtr]::Zero
    [WindowActivator]::EnumWindows({
      param([IntPtr]$Handle, [IntPtr]$Param)
      $text = New-Object System.Text.StringBuilder 512
      [void][WindowActivator]::GetWindowText($Handle, $text, $text.Capacity)
      if ([WindowActivator]::IsWindowVisible($Handle) -and $text.ToString() -eq $Title) {
        $script:WindowActivatorHandle = $Handle
        return $false
      }
      return $true
    }, [IntPtr]::Zero) | Out-Null

    if ($script:WindowActivatorHandle -ne [IntPtr]::Zero) {
      [void][WindowActivator]::ShowWindow($script:WindowActivatorHandle, 9)
      [void][WindowActivator]::SetForegroundWindow($script:WindowActivatorHandle)
      Write-LauncherLog "Activated window: $Title."
      return $true
    }

    if ($shell.AppActivate($Title)) {
      Write-LauncherLog "Activated window: $Title."
      return $true
    }
    Start-Sleep -Milliseconds 500
  }

  Write-LauncherLog "Timed out activating window: $Title."
  return $false
}

function Start-Proxy {
  if (Test-HttpOk $ProxyUrl) {
    Write-LauncherLog 'Proxy already healthy on 127.0.0.1:8787.'
    return
  }

  $listeners = Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue
  foreach ($listener in $listeners) {
    Write-LauncherLog ("Stopping stale listener on 8787, pid={0}." -f $listener.OwningProcess)
    Stop-Process -Id $listener.OwningProcess -Force -ErrorAction SilentlyContinue
  }

  if (-not (Test-Path -LiteralPath $PythonExe)) {
    throw "Python executable not found: $PythonExe"
  }
  if (-not (Test-Path -LiteralPath $ProxyScript)) {
    throw "Proxy script not found: $ProxyScript"
  }

  Write-LauncherLog 'Starting Azure responses proxy.'
  Start-Process `
    -WindowStyle Hidden `
    -FilePath $PythonExe `
    -ArgumentList @($ProxyScript) `
    -RedirectStandardOutput $ProxyStdout `
    -RedirectStandardError $ProxyStderr `
    -PassThru | Out-Null

  Start-Sleep -Seconds 2
  if (-not (Test-HttpOk $ProxyUrl)) {
    throw 'Proxy failed health check on 127.0.0.1:8787.'
  }

  Write-LauncherLog 'Proxy health check passed.'
}

function Get-BunCommand {
  $preferred = Join-Path $env:APPDATA 'npm\bun.cmd'
  if (Test-Path -LiteralPath $preferred) {
    return $preferred
  }

  $found = Get-Command bun.cmd -ErrorAction SilentlyContinue
  if ($found) {
    return $found.Source
  }

  $found = Get-Command bun -ErrorAction SilentlyContinue
  if ($found) {
    return $found.Source
  }

  throw 'Bun command not found.'
}

function Test-PromaElectronRunning {
  $electronPath = Join-Path $ProjectRoot 'node_modules\electron\dist\electron.exe'
  $process = Get-Process -Name electron -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -eq $electronPath } |
    Select-Object -First 1

  return ($null -ne $process)
}

function Start-PromaElectronWindow {
  $electronExe = Join-Path $ProjectRoot 'node_modules\electron\dist\electron.exe'
  $electronAppDir = Join-Path $ProjectRoot 'apps\electron'

  if (-not (Test-Path -LiteralPath $electronExe)) {
    Write-LauncherLog "Electron executable not found for wake-up: $electronExe"
    return
  }

  Write-LauncherLog 'Starting/showing Proma Electron window.'
  Start-Process `
    -WindowStyle Normal `
    -FilePath $electronExe `
    -ArgumentList @($electronAppDir) `
    -WorkingDirectory $electronAppDir `
    -PassThru | Out-Null
}

function Wait-For-PromaDevReady {
  $mainBundle = Join-Path $ProjectRoot 'apps\electron\dist\main.cjs'
  $deadline = (Get-Date).AddSeconds(35)

  while ((Get-Date) -lt $deadline) {
    if ((Test-PortListening $VitePort) -and (Test-Path -LiteralPath $mainBundle)) {
      Write-LauncherLog 'Proma dev server and main bundle are ready.'
      return $true
    }
    Start-Sleep -Seconds 1
  }

  Write-LauncherLog 'Timed out waiting for Proma dev readiness; trying Electron anyway.'
  return $false
}

function Invoke-BunInElectronApp {
  param([string[]]$Arguments)

  $bun = Get-BunCommand
  $electronAppDir = Join-Path $ProjectRoot 'apps\electron'
  Write-LauncherLog ("Running bun {0}." -f ($Arguments -join ' '))

  $process = Start-Process `
    -FilePath $bun `
    -ArgumentList $Arguments `
    -WorkingDirectory $electronAppDir `
    -RedirectStandardOutput $BuildStdout `
    -RedirectStandardError $BuildStderr `
    -Wait `
    -PassThru

  if ($process.ExitCode -ne 0) {
    throw "bun $($Arguments -join ' ') failed with exit code $($process.ExitCode)."
  }
}

function Ensure-PromaBundles {
  $electronAppDir = Join-Path $ProjectRoot 'apps\electron'
  $distDir = Join-Path $electronAppDir 'dist'
  New-Item -ItemType Directory -Force -Path $distDir | Out-Null

  Invoke-BunInElectronApp @('run', 'build:main')
  Invoke-BunInElectronApp @('run', 'build:preload')
  Invoke-BunInElectronApp @('run', 'build:preview-preload')

  $resources = Join-Path $electronAppDir 'resources'
  $distResources = Join-Path $distDir 'resources'
  if (Test-Path -LiteralPath $resources) {
    Copy-Item -LiteralPath $resources -Destination $distResources -Recurse -Force
  }
}

function Start-PromaVite {
  if (Test-PortListening $VitePort) {
    Write-LauncherLog 'Proma Vite dev server already running.'
    return
  }

  $bun = Get-BunCommand
  $electronAppDir = Join-Path $ProjectRoot 'apps\electron'
  Write-LauncherLog ("Starting Proma Vite dev server with {0}." -f $bun)
  Start-Process `
    -FilePath $bun `
    -ArgumentList @('run', 'dev:vite') `
    -WorkingDirectory $electronAppDir `
    -RedirectStandardOutput $ViteStdout `
    -RedirectStandardError $ViteStderr `
    -PassThru | Out-Null

  Wait-For-PromaDevReady | Out-Null
}

function Start-Proma {
  Start-PromaVite

  if (Test-PromaElectronRunning) {
    if (-not (Show-WindowByTitle 'Proma' 3)) {
      Start-PromaElectronWindow
    }
    return
  }

  Ensure-PromaBundles
  Start-PromaElectronWindow
}

try {
  Write-LauncherLog 'Launcher invoked.'
  Start-Proxy
  Start-Proma
  Show-WindowByTitle 'Proma' 30 | Out-Null
  Write-LauncherLog 'Launcher completed.'
} catch {
  Write-LauncherLog ("ERROR: {0}" -f $_.Exception.Message)
  throw
}
