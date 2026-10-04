# Ubija proces pluginu; Stream Deck uruchamia go sam z nowym bundlem (streamdeck restart tego nie robił).
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
	Where-Object { $_.CommandLine -match 'com.elemental.temps' } |
	ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
