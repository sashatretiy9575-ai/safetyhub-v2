[CmdletBinding()]
param(
  [ValidateSet('kk', 'en', 'zh')]
  [string[]]$Locales = @('kk', 'en'),
  [ValidateSet('armaturshchik', 'biot', 'lesomontazhnye-raboty', 'plotnik', 'pozharnaya-bezopasnost')]
  [string[]]$Slugs = @('armaturshchik', 'biot', 'lesomontazhnye-raboty', 'plotnik', 'pozharnaya-bezopasnost')
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$stagedRoot = Join-Path $repoRoot 'content\localizations\staged-2026-09-01'
$workspaceRoot = Join-Path $repoRoot 'tmp\stage6\presentation-localization'

# Content summary: export each reviewed localized SafetyHub course deck to an
# immutable PDF while keeping its one-page-per-source-slide learning sequence.
# Design description: PowerPoint performs the fixed-format export so the source
# master/layout hierarchy, typography, imagery, crops, spacing and 16:9 canvas
# used by the edited PPTX remain the rendering authority.

function Convert-ToRepoPath([string]$Path) {
  return [IO.Path]::GetRelativePath($repoRoot, $Path).Replace('\', '/')
}

function Write-DeterministicJson([string]$Path, [object]$Value) {
  # ConvertTo-Json follows the host platform's newline convention. Normalize
  # before hashing/committing receipts so Windows generation and Linux CI read
  # the exact same bytes.
  $json = ($Value | ConvertTo-Json -Depth 12).Replace("`r`n", "`n").Replace("`r", "`n")
  [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($Path)) | Out-Null
  [IO.File]::WriteAllText($Path, "$json`n", [Text.UTF8Encoding]::new($false))
}

function Measure-TextFrame(
  [object]$TextFrame,
  [double]$OwnerWidth,
  [double]$OwnerHeight,
  [int]$SlideNumber,
  [string]$ObjectName,
  [string]$ObjectKind
) {
  if ($TextFrame.HasText -ne -1) {
    return $null
  }
  $text = [string]$TextFrame.TextRange.Text
  if ([string]::IsNullOrWhiteSpace($text)) {
    return $null
  }
  $availableWidth = [Math]::Max(0, $OwnerWidth - [double]$TextFrame.MarginLeft - [double]$TextFrame.MarginRight)
  $availableHeight = [Math]::Max(0, $OwnerHeight - [double]$TextFrame.MarginTop - [double]$TextFrame.MarginBottom)
  $boundWidth = [double]$TextFrame.TextRange.BoundWidth
  $boundHeight = [double]$TextFrame.TextRange.BoundHeight
  $wordWrap = [int]$TextFrame.WordWrap
  $autoSize = [int]$TextFrame.AutoSize
  # PowerPoint reports the un-fitted natural bounds for some TextFrame2 objects
  # even when it is actively growing the shape or shrinking text to fit. Those
  # modes cannot clip internally; template-preserving font shrink and title-wrap
  # are enforced separately by the artifact-tool layout regression gate.
  $fitManaged = $autoSize -eq 1 -or $autoSize -eq 2
  $verticalOverflow = -not $fitManaged -and $boundHeight -gt ($availableHeight + 1.5)
  $horizontalOverflow = -not $fitManaged -and $wordWrap -eq 0 -and $boundWidth -gt ($availableWidth + 1.5)
  return [ordered]@{
    slide = $SlideNumber
    object = $ObjectName
    kind = $ObjectKind
    textSha256 = ([Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($text)))).ToLowerInvariant()
    availableWidthPt = [Math]::Round($availableWidth, 3)
    availableHeightPt = [Math]::Round($availableHeight, 3)
    boundWidthPt = [Math]::Round($boundWidth, 3)
    boundHeightPt = [Math]::Round($boundHeight, 3)
    autoSize = $autoSize
    fitManaged = $fitManaged
    wordWrap = $wordWrap
    verticalOverflow = $verticalOverflow
    horizontalOverflow = $horizontalOverflow
    verticalOverflowExcessPt = [Math]::Round([Math]::Max(0, $boundHeight - $availableHeight), 3)
    horizontalOverflowExcessPt = [Math]::Round([Math]::Max(0, $boundWidth - $availableWidth), 3)
  }
}

function Measure-ShapeTextFrames(
  [object]$Shape,
  [int]$SlideNumber,
  [string]$ObjectPath
) {
  $measurements = @()
  if ($Shape.HasTable -eq -1) {
    for ($row = 1; $row -le $Shape.Table.Rows.Count; $row += 1) {
      for ($column = 1; $column -le $Shape.Table.Columns.Count; $column += 1) {
        $cellShape = $Shape.Table.Cell($row, $column).Shape
        if ($cellShape.HasTextFrame -eq -1) {
          $measurement = Measure-TextFrame $cellShape.TextFrame2 $cellShape.Width $cellShape.Height $SlideNumber "${ObjectPath}:r$row-c$column" 'table-cell'
          if ($null -ne $measurement) { $measurements += $measurement }
        }
      }
    }
  }
  elseif ($Shape.Type -eq 6) {
    for ($groupIndex = 1; $groupIndex -le $Shape.GroupItems.Count; $groupIndex += 1) {
      $child = $Shape.GroupItems.Item($groupIndex)
      $measurements += @(Measure-ShapeTextFrames $child $SlideNumber "${ObjectPath}/$($child.Name)")
    }
  }
  elseif ($Shape.HasTextFrame -eq -1) {
    $measurement = Measure-TextFrame $Shape.TextFrame2 $Shape.Width $Shape.Height $SlideNumber $ObjectPath 'shape-text'
    if ($null -ne $measurement) { $measurements += $measurement }
  }
  return $measurements
}

function Inspect-PresentationTextFrames(
  [object]$Deck,
  [string]$Locale,
  [string]$Slug,
  [string]$PptxSha256
) {
  $measurements = @()
  foreach ($slide in $Deck.Slides) {
    foreach ($shape in $slide.Shapes) {
      $measurements += @(Measure-ShapeTextFrames $shape $slide.SlideIndex $shape.Name)
    }
  }
  $overflows = @($measurements | Where-Object { $_.verticalOverflow -or $_.horizontalOverflow })
  return [ordered]@{
    schemaVersion = 1
    locale = $Locale
    slug = $Slug
    pptxSha256 = $PptxSha256
    engine = 'Microsoft PowerPoint TextFrame2 bounds'
    inspectedSlideCount = [int]$Deck.Slides.Count
    inspectedTextFrameCount = $measurements.Count
    overflowCount = $overflows.Count
    overflows = $overflows
    measurements = $measurements
  }
}

$powerPoint = $null
$results = @()
try {
  $powerPoint = New-Object -ComObject PowerPoint.Application
  foreach ($locale in $Locales) {
    foreach ($slug in $Slugs) {
      $localeRoot = Join-Path $stagedRoot "presentations\$slug\$locale"
      $pptxReceiptPath = Join-Path $localeRoot 'pptx-receipt.json'
      $textMapPath = Join-Path $localeRoot 'text-map.json'
      $layoutReportPath = Join-Path $workspaceRoot "$locale\$slug\qa\layout-regressions.json"
      if (-not (Test-Path -LiteralPath $pptxReceiptPath -PathType Leaf)) {
        throw "Missing PPTX receipt: $pptxReceiptPath"
      }
      if (-not (Test-Path -LiteralPath $textMapPath -PathType Leaf) -or -not (Test-Path -LiteralPath $layoutReportPath -PathType Leaf)) {
        throw "$locale/${slug}: current text map or layout report is missing."
      }
      $pptxReceipt = Get-Content -LiteralPath $pptxReceiptPath -Raw | ConvertFrom-Json
      $layoutReport = Get-Content -LiteralPath $layoutReportPath -Raw | ConvertFrom-Json
      $textMapHash = (Get-FileHash -LiteralPath $textMapPath -Algorithm SHA256).Hash.ToLowerInvariant()
      if (
        $pptxReceipt.locale -ne $locale -or
        $pptxReceipt.slug -ne $slug -or
        $pptxReceipt.source.textMapSha256 -ne $textMapHash -or
        $pptxReceipt.qa.templateTypographyRegressionCount -ne 0 -or
        $pptxReceipt.qa.sourceGeometryVerified -ne $true -or
        $layoutReport.locale -ne $locale -or
        $layoutReport.slug -ne $slug -or
        $layoutReport.textMapSha256 -ne $textMapHash -or
        $layoutReport.regressionCount -ne 0
      ) {
        throw "$locale/${slug}: PPTX, text map, or zero-regression layout evidence is stale."
      }
      $pptxPath = Join-Path $repoRoot ($pptxReceipt.pptx.path.Replace('/', '\'))
      if (-not (Test-Path -LiteralPath $pptxPath -PathType Leaf)) {
        throw "Missing immutable PPTX: $pptxPath"
      }
      if ((Get-FileHash -LiteralPath $pptxPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $pptxReceipt.pptx.sha256) {
        throw "$locale/${slug}: PPTX hash differs from its receipt."
      }

      $workspaceFinal = Join-Path $workspaceRoot "$locale\$slug\final"
      [IO.Directory]::CreateDirectory($workspaceFinal) | Out-Null
      $temporaryPdf = Join-Path $workspaceFinal 'presentation.pdf'
      if (Test-Path -LiteralPath $temporaryPdf) {
        Remove-Item -LiteralPath $temporaryPdf -Force
      }

      $deck = $null
      $sourceDeck = $null
      $layoutQa = $null
      try {
        $deck = $powerPoint.Presentations.Open($pptxPath, $true, $false, $false)
        if ($deck.Slides.Count -ne $pptxReceipt.pptx.slideCount) {
          throw "$locale/${slug}: PowerPoint slide count differs from the PPTX receipt."
        }
        $finalInspection = Inspect-PresentationTextFrames $deck $locale $slug $pptxReceipt.pptx.sha256
        $deck.SaveAs($temporaryPdf, 32)

        $sourcePptxPath = Join-Path $repoRoot ($pptxReceipt.source.pptx.Replace('/', '\'))
        if (-not (Test-Path -LiteralPath $sourcePptxPath -PathType Leaf)) {
          throw "$locale/${slug}: source PPTX is missing."
        }
        if ((Get-FileHash -LiteralPath $sourcePptxPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $pptxReceipt.source.pptxSha256) {
          throw "$locale/${slug}: source PPTX hash differs from the PPTX receipt."
        }
        $sourceDeck = $powerPoint.Presentations.Open($sourcePptxPath, $true, $false, $false)
        $sourceInspection = Inspect-PresentationTextFrames $sourceDeck 'ru' $slug $pptxReceipt.source.pptxSha256
        $sourceByFrame = @{}
        foreach ($measurement in $sourceInspection.measurements) {
          $sourceByFrame["$($measurement.slide)|$($measurement.object)|$($measurement.kind)"] = $measurement
        }
        $inheritedOverflows = @()
        $newOverflows = @()
        foreach ($overflow in $finalInspection.overflows) {
          $key = "$($overflow.slide)|$($overflow.object)|$($overflow.kind)"
          $sourceMeasurement = $sourceByFrame[$key]
          $verticalInherited = -not $overflow.verticalOverflow -or (
            $null -ne $sourceMeasurement -and
            $sourceMeasurement.verticalOverflow -and
            [double]$overflow.verticalOverflowExcessPt -le ([double]$sourceMeasurement.verticalOverflowExcessPt + 1.5)
          )
          $horizontalInherited = -not $overflow.horizontalOverflow -or (
            $null -ne $sourceMeasurement -and
            $sourceMeasurement.horizontalOverflow -and
            [double]$overflow.horizontalOverflowExcessPt -le ([double]$sourceMeasurement.horizontalOverflowExcessPt + 1.5)
          )
          if ($verticalInherited -and $horizontalInherited) {
            $inheritedOverflows += [ordered]@{
              final = $overflow
              source = $sourceMeasurement
            }
          }
          else {
            $newOverflows += [ordered]@{
              final = $overflow
              source = $sourceMeasurement
            }
          }
        }
        $layoutQa = [ordered]@{
          schemaVersion = 2
          locale = $locale
          slug = $slug
          pptxSha256 = $pptxReceipt.pptx.sha256
          sourcePptxSha256 = $pptxReceipt.source.pptxSha256
          engine = 'Microsoft PowerPoint TextFrame2 bounds, source-relative regression comparison'
          inspectedSlideCount = $finalInspection.inspectedSlideCount
          inspectedTextFrameCount = $finalInspection.inspectedTextFrameCount
          sourceInspectedTextFrameCount = $sourceInspection.inspectedTextFrameCount
          observedOverflowCount = $finalInspection.overflowCount
          sourceObservedOverflowCount = $sourceInspection.overflowCount
          inheritedWithinToleranceOverflowCount = $inheritedOverflows.Count
          newlyIntroducedOverflowCount = $newOverflows.Count
          overflowCount = $newOverflows.Count
          overflows = $newOverflows
          inheritedOverflows = $inheritedOverflows
        }
      }
      finally {
        if ($null -ne $sourceDeck) {
          $sourceDeck.Close()
          [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($sourceDeck)
        }
        if ($null -ne $deck) {
          $deck.Close()
          [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($deck)
        }
      }
      if (-not (Test-Path -LiteralPath $temporaryPdf -PathType Leaf)) {
        throw "$locale/${slug}: PowerPoint did not create the PDF."
      }
      Write-DeterministicJson (Join-Path $workspaceFinal 'text-overflow-qa.json') $layoutQa
      $pdfHash = (Get-FileHash -LiteralPath $temporaryPdf -Algorithm SHA256).Hash.ToLowerInvariant()
      $immutablePath = Join-Path $localeRoot "assets\pdf\$pdfHash\presentation.pdf"
      [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($immutablePath)) | Out-Null
      Copy-Item -LiteralPath $temporaryPdf -Destination $immutablePath -Force
      $bytes = (Get-Item -LiteralPath $immutablePath).Length
      $receipt = [ordered]@{
        schemaVersion = 1
        slug = $slug
        locale = $locale
        productionPublished = $false
        sourcePptx = [ordered]@{
          path = $pptxReceipt.pptx.path
          sha256 = $pptxReceipt.pptx.sha256
        }
        pdf = [ordered]@{
          path = Convert-ToRepoPath $immutablePath
          sha256 = $pdfHash
          byteSize = $bytes
          pageCount = [int]$pptxReceipt.pptx.slideCount
          aspectRatio = '16:9'
          mimeType = 'application/pdf'
        }
        export = [ordered]@{
          engine = 'Microsoft PowerPoint fixed-format PDF'
          onePagePerSlide = $true
          notesRendered = $false
        }
      }
      Write-DeterministicJson (Join-Path $localeRoot 'pdf-receipt.json') $receipt
      $results += [ordered]@{
        locale = $locale
        slug = $slug
        sha256 = $pdfHash
        pageCount = [int]$pptxReceipt.pptx.slideCount
        path = Convert-ToRepoPath $immutablePath
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

[ordered]@{ ok = $true; presentationCount = $results.Count; presentations = $results } |
  ConvertTo-Json -Depth 8
