# agentgate keepalive guard. Register it as a scheduled task that runs at logon
# and every 5 minutes, through guard-hidden.vbs so no console window flashes.
#
# ASCII ONLY IN THIS FILE. Task Scheduler runs powershell.exe 5.1, which decodes
# a UTF-8-no-BOM script as the ANSI codepage; non-ASCII characters (even in
# comments) can corrupt parsing and silently break the logic.
#
# Liveness: state\gateway.pid process alive -> else TCP connect to the panel port.
# Only when both fail do we launch the gateway.
param([int]$PanelPort = 18790)

$root = Split-Path -Parent $PSScriptRoot
$stateDir = Join-Path $root "state"
if (-not (Test-Path $stateDir)) { New-Item -ItemType Directory -Force $stateDir | Out-Null }
$log = Join-Path $stateDir "guard.log"
$reason = @()
$alive = $false

$pidFile = Join-Path $stateDir "gateway.pid"
if (Test-Path $pidFile) {
    try {
        $gwPid = [int](Get-Content $pidFile -ErrorAction Stop)
        $proc = Get-Process -Id $gwPid -ErrorAction Stop
        if ($proc.ProcessName -match 'node') {
            $alive = $true
        } else {
            $reason += "pid $gwPid is $($proc.ProcessName), not node"
        }
    } catch {
        $reason += "pid check failed: $($_.Exception.Message)"
    }
} else {
    $reason += "no pid file"
}

if (-not $alive) {
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $iar = $client.BeginConnect("127.0.0.1", $PanelPort, $null, $null)
        if ($iar.AsyncWaitHandle.WaitOne(3000) -and $client.Connected) {
            $alive = $true
        } else {
            $reason += "panel port $PanelPort not reachable"
        }
    } catch {
        $reason += "port check failed: $($_.Exception.Message)"
    } finally {
        $client.Close()
    }
}

if (-not $alive) {
    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $launcher = Join-Path $PSScriptRoot "gateway.cmd"
    try {
        # Launch through cmd.exe explicitly: Start-Process on a .cmd path goes
        # through ShellExecute and fails silently in a non-interactive host.
        $proc = Start-Process -FilePath "cmd.exe" `
            -ArgumentList '/c', "`"$launcher`"" `
            -WindowStyle Hidden -PassThru -ErrorAction Stop
        Add-Content $log "$ts - down ($($reason -join '; ')) -> launched cmd pid $($proc.Id)"
    } catch {
        Add-Content $log "$ts - down ($($reason -join '; ')) -> LAUNCH FAILED: $($_.Exception.Message)"
    }
}
