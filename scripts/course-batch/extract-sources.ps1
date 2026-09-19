$ErrorActionPreference = 'Stop'
$root = (Resolve-Path '.').Path
$out = Join-Path $root 'content/course-batch-2026-09/sources'
$ppt = New-Object -ComObject PowerPoint.Application
try {
  $files = Get-ChildItem 'C:/Users/oatmeal/Downloads' -File | Where-Object { $_.Name -match '^(Сварщик\.ppt|Обучение Промбез.*\.ppt|Презентация вебинара.*\.pptx)$' }
  foreach ($file in $files) {
    $deck = $ppt.Presentations.Open($file.FullName, -1, 0, 0)
    try {
      $slides = @()
      foreach ($slide in $deck.Slides) {
        $texts = @()
        foreach ($shape in $slide.Shapes) {
          if ($shape.HasTextFrame -and $shape.TextFrame.HasText) { $texts += $shape.TextFrame.TextRange.Text }
          if ($shape.HasTable) { foreach ($row in $shape.Table.Rows) { foreach ($cell in $row.Cells) { $texts += $cell.Shape.TextFrame.TextRange.Text } } }
        }
        $slides += @{number=$slide.SlideIndex; text=($texts -join "`n")}
      }
      @{file=$file.Name; sha256=(Get-FileHash $file.FullName).Hash.ToLower(); slideCount=$deck.Slides.Count; slides=$slides} | ConvertTo-Json -Depth 8 | Set-Content -Encoding utf8 (Join-Path $out ($file.BaseName+'.json'))
      Write-Output "$($file.Name): $($deck.Slides.Count) slides"
    } finally {$deck.Close()}
  }
  $ref = $ppt.Presentations.Open((Join-Path $root 'content/source-materials/derived/biot/presentation.pptx'), -1, 0, 0)
  try { foreach ($i in @(1,2,5,10)) { $ref.Slides.Item($i).Export((Join-Path $out "reference-biot-$i.png"),'PNG',1600,900) }; @{width=$ref.PageSetup.SlideWidth;height=$ref.PageSetup.SlideHeight} | ConvertTo-Json | Set-Content (Join-Path $out 'reference-size.json') } finally {$ref.Close()}
} finally {$ppt.Quit()}
