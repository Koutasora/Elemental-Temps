# Czyta pamięć współdzieloną HWiNFO (Global\HWiNFO_SENS_SM2) i co 2 s wypisuje jedną linię JSON:
#   {"status":"ok","cpu":{temp,load,power,clock},"gpu":{"0":{...},"1":{...}}}
# Czujniki dobierane są po nazwach z list priorytetów (Intel / AMD / NVIDIA / Radeon / Intel GPU) – bierzemy pierwszy najlepiej pasujący.
# Karty GPU rozpoznajemy po nazwie czujnika HWiNFO: "GPU [#N]: ...".
param([int]$ParentPid = 0)
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Core
$inv = [Globalization.CultureInfo]::InvariantCulture
function Str($v, $o, $n) { $b = New-Object byte[] $n; [void]$v.ReadArray($o, $b, 0, $n); [Text.Encoding]::ASCII.GetString($b).Split([char]0)[0] }
function Num($x) { $x.ToString('0.##', $inv) }

# kategoria => (typ czujnika HWiNFO, lista wzorców od najlepszego)
# typy: 1 temp, 5 moc, 6 zegar, 7 użycie
$rules = @{
	cpuTemp  = @(1, @('^CPU Package$', '^CPU \(Tctl/Tdie\)$', '^CPU Die \(average\)$', '^CPU Tctl$', '^CPU Tdie$', '^Core Max$', '^CPU$', '^CPU \(Tctl\)$'))
	cpuPower = @(5, @('^CPU Package Power$', '^CPU PPT$', '^CPU Core Power$', '^Core Power$'))
	cpuLoad  = @(7, @('^Total CPU Usage$', '^Total CPU Utility$'))
	cpuClock = @(6, @('^Average Effective Clock$', '^Core Clocks? \(avg\)$', '^Average Clock$'))
	gpuTemp  = @(1, @('^GPU Temperature$', '^GPU Core Temperature$', '^GPU Temperature \(Edge\)$', '^GPU Hot Spot Temperature$', '^GPU Hot Spot$'))
	gpuPower = @(5, @('^GPU Power$', '^GPU Total Board Power$', '^GPU ASIC Power$', '^GPU Chip Power$', '^GPU Core Power$'))
	gpuLoad  = @(7, @('^GPU Core Load$', '^GPU Utilization$', '^GPU Core Utilization$', '^GPU D3D Usage$', '^GPU Usage$'))
	gpuClock = @(6, @('^GPU Clock$', '^GPU Core Clock$'))
}
$coreTempRe = '^(P-core |E-core |Core )\d+$'
$coreClockRe = '^(P-core |E-core |Core )\d+ Clock$'

function MakeGroup($val, $prefix) {
	if (-not $val.ContainsKey($prefix + 'Temp')) { return $null }
	$p = @('"temp":' + (Num $val[$prefix + 'Temp']))
	foreach ($f in 'Load', 'Power', 'Clock') { if ($val.ContainsKey($prefix + $f)) { $p += ('"' + $f.ToLower() + '":' + (Num $val[$prefix + $f])) } }
	return '{' + ($p -join ',') + '}'
}

while ($true) {
	if ($ParentPid -gt 0 -and -not (Get-Process -Id $ParentPid)) { exit }
	$line = '{"status":"disabled"}'
	if (-not (Get-Process -Name 'HWiNFO64', 'HWiNFO32' -ErrorAction SilentlyContinue)) { $line = '{"status":"notrunning"}' }
	try {
		$mmf = [IO.MemoryMappedFiles.MemoryMappedFile]::OpenExisting('Global\HWiNFO_SENS_SM2', [IO.MemoryMappedFiles.MemoryMappedFileRights]::Read)
		$v = $mmf.CreateViewAccessor(0, 0, [IO.MemoryMappedFiles.MemoryMappedFileAccess]::Read)
		$age = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds() - $v.ReadInt64(12)
		if ($v.ReadUInt32(0) -eq 0x53695748 -and $age -lt 15) {
			# numer karty GPU dla każdego czujnika ($null = to nie jest czujnik GPU)
			$so = $v.ReadUInt32(20); $ss = $v.ReadUInt32(24); $sn = $v.ReadUInt32(28)
			$gpuOf = @{}
			$diskOf = @{}; $diskName = @{}; $diskTemp = @{}; $diskCount = 0
			for ($i = 0; $i -lt $sn; $i++) {
				$sname = Str $v ($so + $i * $ss + 8) 128
				if ($sname -match '^GPU \[#(\d+)\]') { $gpuOf[[uint32]$i] = [int]$Matches[1] }
				elseif ($sname -match '^S\.M\.A\.R\.T\.: (.*)$') {
					# dysk: litery z "[C:]" albo model sprzed " ("
					$rest = $Matches[1]
					if ($rest -match '\[([A-Za-z]:[^\]]*)\]') { $nm = $Matches[1] } else { $nm = ($rest -split ' \(')[0] }
					$diskOf[[uint32]$i] = $diskCount; $diskName[$diskCount] = ($nm -replace '["\\]', ''); $diskCount++
				}
			}
			$ro = $v.ReadUInt32(32); $rs = $v.ReadUInt32(36); $rn = $v.ReadUInt32(40)
			$best = @{}   # klucz ("cpuTemp" albo "gpuTemp|0") => @(indeks wzorca, wartość)
			$coreTemps = New-Object System.Collections.Generic.List[double]
			$coreClocks = New-Object System.Collections.Generic.List[double]
			for ($i = 0; $i -lt $rn; $i++) {
				$o = $ro + $i * $rs
				$t = $v.ReadUInt32($o)
				if ($t -ne 1 -and $t -ne 5 -and $t -ne 6 -and $t -ne 7) { continue }
				$l = Str $v ($o + 12) 128
				$gpuNum = $gpuOf[$v.ReadUInt32($o + 4)]
				if ($t -eq 1 -and $l -eq 'Drive Temperature') {
					$dn = $diskOf[$v.ReadUInt32($o + 4)]
					if ($null -ne $dn -and -not $diskTemp.ContainsKey($dn)) { $diskTemp[$dn] = $v.ReadDouble($o + 284) }
				}
				foreach ($cat in $rules.Keys) {
					$r = $rules[$cat]
					if ($r[0] -ne $t) { continue }
					$key = $cat
					if ($cat.StartsWith('gpu')) { if ($null -eq $gpuNum) { continue }; $key = "$cat|$gpuNum" }
					$pats = $r[1]
					for ($k = 0; $k -lt $pats.Count; $k++) {
						if ($l -match $pats[$k]) {
							if (-not $best.ContainsKey($key) -or $k -lt $best[$key][0]) { $best[$key] = @($k, $v.ReadDouble($o + 284)) }
							break
						}
					}
				}
				if ($t -eq 1 -and $l -match $coreTempRe) { $coreTemps.Add($v.ReadDouble($o + 284)) }
				if ($t -eq 6 -and $l -match $coreClockRe) { $coreClocks.Add($v.ReadDouble($o + 284)) }
			}
			# wartości CPU
			$cpuVal = @{}
			foreach ($c in 'cpuTemp', 'cpuPower', 'cpuLoad', 'cpuClock') { if ($best.ContainsKey($c)) { $cpuVal[$c] = $best[$c][1] } }
			if (-not $cpuVal.ContainsKey('cpuTemp') -and $coreTemps.Count) { $cpuVal['cpuTemp'] = ($coreTemps | Measure-Object -Maximum).Maximum }
			if (-not $cpuVal.ContainsKey('cpuClock') -and $coreClocks.Count) { $cpuVal['cpuClock'] = ($coreClocks | Measure-Object -Average).Average }
			# wartości GPU per karta
			$gpuNums = @($best.Keys | Where-Object { $_.StartsWith('gpu') } | ForEach-Object { [int]($_.Split('|')[1]) } | Sort-Object -Unique)
			$gpuJson = @()
			foreach ($n in $gpuNums) {
				$gv = @{}
				foreach ($c in 'gpuTemp', 'gpuPower', 'gpuLoad', 'gpuClock') { if ($best.ContainsKey("$c|$n")) { $gv[$c] = $best["$c|$n"][1] } }
				$g = MakeGroup $gv 'gpu'
				if ($g) { $gpuJson += ('"' + $n + '":' + $g) }
			}
			$diskJson = @()
			foreach ($dn in ($diskTemp.Keys | Sort-Object)) { $diskJson += ('"' + $dn + '":{"temp":' + (Num $diskTemp[$dn]) + ',"name":"' + $diskName[$dn] + '"}') }
			$parts = @('"status":"ok"')
			$cpu = MakeGroup $cpuVal 'cpu'; if ($cpu) { $parts += '"cpu":' + $cpu }
			if ($gpuJson.Count) { $parts += '"gpu":{' + ($gpuJson -join ',') + '}' }
			if ($diskJson.Count) { $parts += '"disk":{' + ($diskJson -join ',') + '}' }
			$line = '{' + ($parts -join ',') + '}'
		}
		$v.Dispose(); $mmf.Dispose()
	} catch { }
	[Console]::Out.WriteLine($line); [Console]::Out.Flush()
	Start-Sleep -Seconds 2
}
