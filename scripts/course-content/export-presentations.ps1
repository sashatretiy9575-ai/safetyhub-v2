[CmdletBinding()]
param(
  [string]$DerivedRoot = (Join-Path (Resolve-Path (Join-Path $PSScriptRoot '..\..')) 'content\source-materials\derived'),
  [string]$SnapshotRoot = (Join-Path (Resolve-Path (Join-Path $PSScriptRoot '..\..')) 'content\snapshots\courses')
)

$ErrorActionPreference = 'Stop'
$courseSlugs = @(
  'plotnik',
  'armaturshchik',
  'lesomontazhnye-raboty',
  'biot',
  'pozharnaya-bezopasnost'
)

$powerPoint = $null
try {
  $powerPoint = New-Object -ComObject PowerPoint.Application
  foreach ($slug in $courseSlugs) {
    $derivedDir = Join-Path $DerivedRoot $slug
    $courseDir = Join-Path $SnapshotRoot $slug
    $pptxPath = Join-Path $derivedDir 'presentation.pptx'
    $pdfPath = Join-Path $courseDir 'presentation.pdf'

    if (-not (Test-Path -LiteralPath $pptxPath -PathType Leaf)) {
      throw "Missing derived presentation: $pptxPath"
    }

    New-Item -ItemType Directory -Path $courseDir -Force | Out-Null

    $deck = $null
    try {
      $deck = $powerPoint.Presentations.Open($pptxPath, $true, $false, $false)
      $deck.SaveAs($pdfPath, 32)
    }
    finally {
      if ($null -ne $deck) {
        $deck.Close()
        [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($deck)
      }
    }
  }
}
finally {
  if ($null -ne $powerPoint) {
    $powerPoint.Quit()
    [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($powerPoint)
  }
  [GC]::Collect()
  [GC]::WaitForPendingFinalizers()
}
