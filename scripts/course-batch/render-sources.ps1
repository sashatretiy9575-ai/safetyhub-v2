$ErrorActionPreference='Stop'
$root=(Resolve-Path '.').Path
$out=Join-Path $root 'artifacts/course-batch-2026-09/source-pages'
New-Item -ItemType Directory -Force $out | Out-Null
$app=New-Object -ComObject PowerPoint.Application
try {
 $files=Get-ChildItem 'C:/Users/oatmeal/Downloads' -File | Where-Object { $_.Name -match '^(Сварщик\.ppt|Обучение Промбез.*\.ppt|Презентация вебинара.*\.pptx)$' }
 foreach($file in $files){
  $dir=Join-Path $out $file.BaseName
  New-Item -ItemType Directory -Force $dir | Out-Null
  $deck=$app.Presentations.Open($file.FullName,-1,0,0)
  try{foreach($slide in $deck.Slides){$slide.Export((Join-Path $dir ('{0:D2}.png' -f $slide.SlideIndex)),'PNG',1200,675)};Write-Output "$($file.Name) $($deck.Slides.Count)"}finally{$deck.Close()}
 }
}finally{$app.Quit()}
