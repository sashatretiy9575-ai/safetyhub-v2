param([string]$Locale='ru')
$ErrorActionPreference='Stop'
$root=(Resolve-Path '.').Path
$app=New-Object -ComObject PowerPoint.Application
try {
 foreach($slug in @('promyshlennaya-bezopasnost','svarshchik')) {
  $dir=Join-Path $root "content/course-batch-2026-09/$slug/$Locale"
  $data=Get-Content -Raw -Encoding utf8 (Join-Path $dir 'deck.json') | ConvertFrom-Json
  $deck=$app.Presentations.Open((Join-Path $root 'content/source-materials/derived/biot/presentation.pptx'),-1,0,0)
  try {
   for($i=$deck.Slides.Count;$i -ge 1;$i--){if($i -ne 5){$deck.Slides.Item($i).Delete()}}
   for($i=1;$i -lt $data.slides.Count;$i++){ $null=$deck.Slides.Item(1).Duplicate() }
   $qa=@()
   $pagesDir=Join-Path $root "artifacts/course-batch-2026-09/$slug/$Locale/pages"
   New-Item -ItemType Directory -Force $pagesDir | Out-Null
   for($i=1;$i -le $data.slides.Count;$i++){
    $slide=$deck.Slides.Item($i);$src=$data.slides[$i-1]
    $slide.Shapes.Item('SLIDE_TITLE').TextFrame.TextRange.Text=$src.title
    $slide.Shapes.Item('SLIDE_TITLE').TextFrame.TextRange.Font.Size=36
    $slide.Shapes.Item('Rectangle 2').TextFrame.TextRange.Text=($src.body -join "`r")
    $slide.Shapes.Item('Rectangle 2').TextFrame.TextRange.Font.Size=20.25
    $slide.Shapes.Item('Rectangle 2').TextFrame.TextRange.Font.Bold=0
    $slide.Shapes.Item('Rectangle 2').TextFrame.TextRange.ParagraphFormat.Bullet.Type=1
    $slide.Shapes.Item('Rectangle 2').TextFrame.TextRange.ParagraphFormat.Bullet.Character=8226
    $slide.Shapes.Item('Rectangle 2').TextFrame.TextRange.ParagraphFormat.Bullet.Visible=-1
    $slide.Shapes.Item('Rectangle 2').TextFrame.TextRange.ParagraphFormat.SpaceAfter=10
    $slide.Shapes.Item('KEY_TAKEAWAY').TextFrame.TextRange.Text=$src.callout
    $slide.Shapes.Item('KEY_TAKEAWAY').TextFrame.TextRange.Font.Size=19.5
    if($Locale -eq 'zh'){
     foreach($name in @('SLIDE_TITLE','Rectangle 2','KEY_TAKEAWAY','DECK_FOOTER')){$slide.Shapes.Item($name).TextFrame.TextRange.Font.Name='Microsoft YaHei'}
    }
    if($Locale -eq 'kk'){
     foreach($name in @('SLIDE_TITLE','Rectangle 2','KEY_TAKEAWAY','DECK_FOOTER')){$slide.Shapes.Item($name).TextFrame.TextRange.Font.Name='Arial'}
    }
    $slide.Shapes.Item('DECK_FOOTER').TextFrame.TextRange.Text=$data.title
    $slide.Shapes.Item('SLIDE_NUMBER').TextFrame.TextRange.Text=('{0:D2}' -f $i)
    $notes=@($src.sourceRefs | ForEach-Object { $id=$_; $s=$data.sources | Where-Object {$_.id -eq $id}; if($s.url){$s.url}else{$s.file} }) -join "`r"
    foreach($shape in $slide.NotesPage.Shapes){if($shape.Type -eq 14 -and $shape.PlaceholderFormat.Type -eq 2){$shape.TextFrame.TextRange.Text=$notes}}
    foreach($name in @('SLIDE_TITLE','Rectangle 2','KEY_TAKEAWAY')) {
     $shape=$slide.Shapes.Item($name)
     $qa+=@{slide=$i;shape=$name;height=$shape.Height;boundHeight=$shape.TextFrame.TextRange.BoundHeight;overflow=($shape.TextFrame.TextRange.BoundHeight -gt ($shape.Height+2))}
    }
    $slide.Export((Join-Path $pagesDir ('{0:D2}.png' -f $i)),'PNG',1600,900)
   }
   $deck.SaveAs((Join-Path $dir 'presentation.pptx'),24)
   $deck.SaveAs((Join-Path $dir 'presentation.pdf'),32)
   $qa | ConvertTo-Json -Depth 4 | Set-Content -Encoding utf8 (Join-Path $dir 'layout-qa.json')
   Write-Output "$slug/$Locale rendered $($data.slides.Count) slides; overflow=$(@($qa | Where-Object {$_.overflow}).Count)"
  } finally {$deck.Close()}
 }
} finally {$app.Quit()}

