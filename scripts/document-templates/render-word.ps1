param([string]$Mode='sources')
$ErrorActionPreference='Stop'
$base=Join-Path (Get-Location) 'artifacts/source-review-2026-09'
$records=Get-Content (Join-Path $base 'forms-extracted.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$dir=Join-Path $base ($Mode+'-pdf'); New-Item -ItemType Directory -Force $dir | Out-Null
$word=New-Object -ComObject Word.Application
$word.Visible=$false; $word.DisplayAlerts=0
try {
foreach($record in $records) {
 if($Mode -eq 'sources') {$source=Join-Path "$env:USERPROFILE/Downloads" $record.name} else {$source=Join-Path $base ('templates/'+$record.name)}
 $safe=Join-Path $base ('render-input-'+$record.id+'.docx'); [IO.File]::WriteAllBytes($safe,[IO.File]::ReadAllBytes($source)); $doc=$word.Documents.Open($safe,$false,$true)
 try {$pdf=Join-Path $dir ('{0:D2}.pdf' -f [int]$record.id);$doc.ExportAsFixedFormat($pdf,17); Write-Output "$($record.id) $($doc.ComputeStatistics(2))"} finally {$doc.Close(0)}
}
} finally {$word.Quit()}

