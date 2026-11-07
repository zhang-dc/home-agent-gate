# Delayed restart: wait a little (so an in-flight reply can be delivered),
# kill the gateway process tree recorded in state\gateway.pid, then relaunch.
# Usage: powershell -NoProfile -File scripts\restart-once.ps1 [-DelaySeconds 20]
# ASCII ONLY (see gateway-guard.ps1).
param([int]$DelaySeconds = 20)

$root = Split-Path -Parent $PSScriptRoot
$stateDir = Join-Path $root "state"
$log = Join-Path $stateDir "guard.log"
$pidFile = Join-Path $stateDir "gateway.pid"

Start-Sleep -Seconds $DelaySeconds
$ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
if (Test-Path $pidFile) {
    $gwPid = [int](Get-Content $pidFile)
    & taskkill.exe /PID $gwPid /T /F | Out-Null
    Add-Content $log "$ts - restart-once: killed gateway pid $gwPid"
} else {
    Add-Content $log "$ts - restart-once: no pid file"
}
Start-Sleep -Seconds 3
$launcher = Join-Path $PSScriptRoot "gateway.cmd"
Start-Process -FilePath "cmd.exe" -ArgumentList '/c', "`"$launcher`"" -WindowStyle Hidden
$ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
Add-Content $log "$ts - restart-once: gateway relaunched"
