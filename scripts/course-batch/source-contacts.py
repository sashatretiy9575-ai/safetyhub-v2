from PIL import Image
from pathlib import Path
root=Path('artifacts/course-batch-2026-09/source-pages')
for folder in root.iterdir():
    if not folder.is_dir(): continue
    pages=sorted(folder.glob('*.png'))
    for offset in range(0,len(pages),6):
        sheet=Image.new('RGB',(1600,1350),'white')
        for j,p in enumerate(pages[offset:offset+6]):
            sheet.paste(Image.open(p).convert('RGB').resize((800,450)),((j%2)*800,(j//2)*450))
        sheet.save(folder/f'contact-{offset//6+1:02}.jpg',quality=95)
