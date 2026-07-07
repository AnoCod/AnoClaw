<#
.SYNOPSIS
    Start Edge or Chrome with remote debugging port 9222
.DESCRIPTION
    Kills existing browser processes and restarts with CDP debugging enabled,
    using the user's real profile (keeping all cookies and sessions intact).
.PARAMETER Browser
    Which browser to launch: "edge" (default) or "chrome"
.EXAMPLE
    .\setup-browser.ps1
    .\setup-browser.ps1 -Browser chrome
#>
param(
    [ValidateSet("edge", "chrome")]
    [string]$Browser = "edge"
)

Write-Host "🔄 Killing existing browser processes..." -ForegroundColor Yellow

if ($Browser -eq "edge") {
    taskkill /F /IM msedge.exe 2>$null | Out-Null
    Start-Sleep -Seconds 2

    $edgePath = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
    if (-not (Test-Path $edgePath)) {
        $edgePath = "C:\Program Files\Microsoft\Edge\Application\msedge.exe"
    }

    if (-not (Test-Path $edgePath)) {
        Write-Host "❌ Edge not found at expected paths" -ForegroundColor Red
        exit 1
    }

    Write-Host "🚀 Starting Edge with remote debugging..." -ForegroundColor Green
    $userData = "$env:LOCALAPPDATA\Microsoft\Edge\User Data"
    Start-Process -FilePath $edgePath -ArgumentList "--remote-debugging-port=9222", "--user-data-dir=`"$userData`""

} else {
    taskkill /F /IM chrome.exe 2>$null | Out-Null
    Start-Sleep -Seconds 2

    $chromePath = "C:\Program Files\Google\Chrome\Application\chrome.exe"
    if (-not (Test-Path $chromePath)) {
        $chromePath = "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
    }

    if (-not (Test-Path $chromePath)) {
        Write-Host "❌ Chrome not found at expected paths" -ForegroundColor Red
        exit 1
    }

    Write-Host "🚀 Starting Chrome with remote debugging..." -ForegroundColor Green
    $userData = "$env:LOCALAPPDATA\Google\Chrome\User Data"
    Start-Process -FilePath $chromePath -ArgumentList "--remote-debugging-port=9222", "--user-data-dir=`"$userData`""
}

Start-Sleep -Seconds 3

# Verify port is listening
$listening = netstat -ano | Select-String "9222.*LISTENING"
if ($listening) {
    Write-Host "✅ Browser started successfully on port 9222" -ForegroundColor Green
    Write-Host ""
    Write-Host "Now you can run:" -ForegroundColor Cyan
    Write-Host "  node scripts/cdp-navigate.js ""https://example.com""" -ForegroundColor White
    Write-Host "  node scripts/cdp-extract.js" -ForegroundColor White
    Write-Host "  node scripts/cdp-chat.js ""your question""" -ForegroundColor White
    Write-Host "  node scripts/cdp-network.js --duration 10" -ForegroundColor White
} else {
    Write-Host "⚠️  Port 9222 not listening yet. Wait a moment and try again." -ForegroundColor Yellow
}
