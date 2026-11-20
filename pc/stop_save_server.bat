@echo off
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^python' -and $_.CommandLine -match 'media_save_server\.py' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"
