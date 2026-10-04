# Czyta pamięć współdzieloną HWiNFO (Global\HWiNFO_SENS_SM2) i co 2 s wypisuje jedną linię JSON: {"cpu":{...},"gpu":{...}}.
# Czujniki dobierane są po nazwach z list priorytetów (Intel / AMD / NVIDIA / Radeon / Intel GPU) – bierzemy pierwszy najlepiej pasujący.
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

while ($true) {
	if ($ParentPid -gt 0 -and -not (Get-Process -Id $ParentPid)) { exit }
	$line = '{"status":"disabled"}'
	if (-not (Get-Process -Name 'HWiNFO64', 'HWiNFO32' -ErrorAction SilentlyContinue)) { $line = '{"status":"notrunning"}' }
	try {
		$mmf = [IO.MemoryMappedFiles.MemoryMappedFile]::OpenExisting('Global\HWiNFO_SENS_SM2', [IO.MemoryMappedFiles.MemoryMappedFileRights]::Read)
		$v = $mmf.CreateViewAccessor(0, 0, [IO.MemoryMappedFiles.MemoryMappedFileAccess]::Read)
		$age = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds() - $v.ReadInt64(12)
		if ($v.ReadUInt32(0) -eq 0x53695748 -and $age -lt 15) {
			$ro = $v.ReadUInt32(32); $rs = $v.ReadUInt32(36); $rn = $v.ReadUInt32(40)
			$best = @{}   # kategoria => @(indeks wzorca, wartość)
			$coreTemps = New-Object System.Collections.Generic.List[double]
			$coreClocks = New-Object System.Collections.Generic.List[double]
			for ($i = 0; $i -lt $rn; $i++) {
				$o = $ro + $i * $rs
				$t = $v.ReadUInt32($o)
				if ($t -ne 1 -and $t -ne 5 -and $t -ne 6 -and $t -ne 7) { continue }
				$l = Str $v ($o + 12) 128
				foreach ($cat in $rules.Keys) {
					$r = $rules[$cat]
					if ($r[0] -ne $t) { continue }
					$pats = $r[1]
					for ($k = 0; $k -lt $pats.Count; $k++) {
						if ($l -match $pats[$k]) {
							if (-not $best.ContainsKey($cat) -or $k -lt $best[$cat][0]) { $best[$cat] = @($k, $v.ReadDouble($o + 284)) }
							break
						}
					}
				}
				if ($t -eq 1 -and $l -match $coreTempRe) { $coreTemps.Add($v.ReadDouble($o + 284)) }
				if ($t -eq 6 -and $l -match $coreClockRe) { $coreClocks.Add($v.ReadDouble($o + 284)) }
			}
			$val = @{}
			foreach ($c in $best.Keys) { $val[$c] = $best[$c][1] }
			if (-not $val.ContainsKey('cpuTemp') -and $coreTemps.Count) { $val['cpuTemp'] = ($coreTemps | Measure-Object -Maximum).Maximum }
			if (-not $val.ContainsKey('cpuClock') -and $coreClocks.Count) { $val['cpuClock'] = ($coreClocks | Measure-Object -Average).Average }

			function MakeGroup($prefix) {
				if (-not $val.ContainsKey($prefix + 'Temp')) { return $null }
				$p = @('"temp":' + (Num $val[$prefix + 'Temp']))
				foreach ($f in 'Load', 'Power', 'Clock') { if ($val.ContainsKey($prefix + $f)) { $p += ('"' + $f.ToLower() + '":' + (Num $val[$prefix + $f])) } }
				return '{' + ($p -join ',') + '}'
			}
			$parts = @()
			$cpu = MakeGroup 'cpu'; if ($cpu) { $parts += '"cpu":' + $cpu }
			$gpu = MakeGroup 'gpu'; if ($gpu) { $parts += '"gpu":' + $gpu }
			$line = '{' + (@('"status":"ok"') + $parts -join ',') + '}'
		}
		$v.Dispose(); $mmf.Dispose()
	} catch { }
	[Console]::Out.WriteLine($line); [Console]::Out.Flush()
	Start-Sleep -Seconds 2
}
