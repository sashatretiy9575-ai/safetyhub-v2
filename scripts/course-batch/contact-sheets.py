from PIL import Image, ImageOps
from pathlib import Path
import json
root=Path('content/course-batch-2026-09')
for folder in root.glob('*/*'):
    if not (folder/'deck.json').exists(): continue
    qa=Path('artifacts/course-batch-2026-09')/folder.parent.name/folder.name
    pages=sorted((qa/'pages').glob('*.png'))
    if not pages: continue
    for offset in range(0,len(pages),9):
        sheet=Image.new('RGB',(1600,900),(210,210,210))
        for j,p in enumerate(pages[offset:offset+9]):
            thumb=Image.open(p).convert('RGB').resize((528,297))
            sheet.paste(thumb,((j%3)*534,(j//3)*300))
        sheet.save(qa/f'contact-{offset//9+1:02}.jpg',quality=93)
    Image.open(pages[0]).save(folder/'thumbnail.webp',quality=90)
