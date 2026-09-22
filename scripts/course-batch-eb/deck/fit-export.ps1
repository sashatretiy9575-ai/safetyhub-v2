# Opens a built deck in PowerPoint, shrinks any text that no longer fits the
# box it had in the Russian original, and exports the PDF.
# -Measure writes the bound height of every text shape to -Report (JSON).
# -Allow reads such a report: a shape may be as tall as its box or as tall as
#  the Russian text was, whichever is larger.
# Boxes of the same size on one slide are the rows of one list, so whatever one
# of them has to give up, its siblings give up too: a list set in three sizes
# reads worse than a list set one step smaller.
param([string]$In,[string]$Out,[string]$Report,[string]$Allow,[switch]$Measure)
$ErrorActionPreference = 'Stop'
$app = New-Object -ComObject PowerPoint.Application
$allowed = @{}
if ($Allow) { (Get-Content -Raw -Encoding utf8 $Allow | ConvertFrom-Json) | ForEach-Object { $allowed["$($_.slide)/$($_.shape)"] = [double]$_.bound } }
$rows = New-Object System.Collections.ArrayList
$changes = New-Object System.Collections.ArrayList
function Shrink-Once($tf) {
  foreach ($run in $tf.TextRange.Runs()) { $run.Font.Size = [Math]::Round($run.Font.Size * 0.96, 1) }
}
try {
  $pres = $app.Presentations.Open((Resolve-Path $In).Path, 0, 0, 0)
  foreach ($slide in $pres.Slides) {
    $i = 0
    $shrunk = New-Object System.Collections.ArrayList
    foreach ($shape in $slide.Shapes) {
      $i++
      if (-not $shape.HasTextFrame) { continue }
      $tf = $shape.TextFrame
      if (-not $tf.HasText) { continue }
      $bound = $tf.TextRange.BoundHeight
      $key = "$($slide.SlideIndex)/$i"
      if ($Measure) { [void]$rows.Add([pscustomobject]@{ slide = $slide.SlideIndex; shape = $i; height = $shape.Height; bound = $bound; text = $tf.TextRange.Text.Substring(0, [Math]::Min(40, $tf.TextRange.Text.Length)) }); continue }
      # The box is measured before anything is shrunk: PowerPoint resizes a box
      # to the text it now holds, so afterwards the rows of one list no longer
      # look alike.
      $family = "$([Math]::Round($shape.Width, 1))x$([Math]::Round($shape.Height, 1))"
      $limit = [Math]::Max($shape.Height, $(if ($allowed.ContainsKey($key)) { $allowed[$key] } else { 0 })) + 0.5
      $steps = 0
      while ($tf.TextRange.BoundHeight -gt $limit -and $steps -lt 25) {
        Shrink-Once $tf
        $steps++
      }
      [void]$shrunk.Add([pscustomobject]@{ index = $i; frame = $tf; steps = $steps; before = $bound; limit = $limit; family = $family })
      if ($steps -gt 0) { [void]$changes.Add([pscustomobject]@{ slide = $slide.SlideIndex; shape = $i; steps = $steps; before = $bound; after = $tf.TextRange.BoundHeight; limit = $limit; text = $tf.TextRange.Text.Substring(0, [Math]::Min(50, $tf.TextRange.Text.Length)) }) }
    }
    if ($Measure) { continue }
    # The rows of one list are boxes of one size: they end at one size too.
    foreach ($family in ($shrunk | Group-Object family)) {
      if ($family.Count -lt 2) { continue }
      $deepest = ($family.Group | Measure-Object steps -Maximum).Maximum
      if ($deepest -eq 0) { continue }
      foreach ($member in $family.Group) {
        for ($step = $member.steps; $step -lt $deepest; $step++) { Shrink-Once $member.frame }
        if ($member.steps -lt $deepest) {
          [void]$changes.Add([pscustomobject]@{ slide = $slide.SlideIndex; shape = $member.index; steps = $deepest - $member.steps; before = $member.before; after = $member.frame.TextRange.BoundHeight; limit = $member.limit; text = 'matched to its list' })
        }
      }
    }
  }
  if ($Out) { $pres.SaveAs([System.IO.Path]::GetFullPath($Out), 32) }
  $pres.Close()
} finally { $app.Quit() }
if ($Measure) { $rows | ConvertTo-Json -Depth 3 | Set-Content -Encoding utf8 $Report } else { if ($changes.Count -eq 0) { Set-Content -Encoding utf8 $Report '[]' } else { ConvertTo-Json -InputObject @($changes) -Depth 3 | Set-Content -Encoding utf8 $Report } }
Write-Output "done"
