from pathlib import Path
from pypdf import PdfReader
import json,hashlib
root=Path('content/course-batch-2026-09')
report=[]
for slug in ['promyshlennaya-bezopasnost','svarshchik']:
    for locale in ['ru','kk','en','zh']:
        folder=root/slug/locale
        deck=json.loads((folder/'deck.json').read_text(encoding='utf-8-sig'))
        exam=json.loads((folder/'assessment.json').read_text(encoding='utf-8-sig'))
        pdf=PdfReader(folder/'presentation.pdf')
        errors=[]
        if len(pdf.pages)!=len(deck['slides']): errors.append('page count')
        for i,page in enumerate(pdf.pages):
            text=page.extract_text()
            if not text or len(text)<50: errors.append(f'page {i+1} text missing')
            if '\ufffd' in text: errors.append(f'page {i+1} replacement glyph')
        if len(exam['variants'])!=3: errors.append('variant count')
        for v in exam['variants']:
            if len(v['questions'])!=10: errors.append('question count')
            for q in v['questions']:
                if len(q['options'])!=4 or sum(o['id']==q['correctOptionId'] for o in q['options'])!=1: errors.append(q['id'])
                if any(ref not in [s['id'] for s in deck['slides']] for ref in q['slideRefs']): errors.append('slide ref')
        layout=json.loads((folder/'layout-qa.json').read_text(encoding='utf-8-sig'))
        if any(x['overflow'] for x in layout): errors.append('layout overflow')
        report.append(dict(slug=slug,locale=locale,pages=len(pdf.pages),questions=sum(len(v['questions']) for v in exam['variants']),pdfSha256=hashlib.sha256((folder/'presentation.pdf').read_bytes()).hexdigest(),errors=errors))
out=Path('artifacts/course-batch-2026-09/artifact-check.json')
out.write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf8')
print(json.dumps(report,ensure_ascii=True,indent=2))
if any(r['errors'] for r in report): raise SystemExit(1)
