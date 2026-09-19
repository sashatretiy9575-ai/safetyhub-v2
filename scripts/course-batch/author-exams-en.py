from pathlib import Path
import json,hashlib
root=Path('content/course-batch-2026-09');base=Path('scripts/course-batch/translations')
for slug,source in [('promyshlennaya-bezopasnost','industrial-exam-en.txt'),('svarshchik','welding-exam-en.txt')]:
 p=root/slug/'ru/assessment.json';d=json.loads(p.read_text(encoding='utf-8'));deck=json.loads((root/slug/'en/deck.json').read_text(encoding='utf-8'));slides={s['id']:s for s in deck['slides']};lines=(base/source).read_text(encoding='utf-8-sig').splitlines();qs=[q for v in d['variants'] for q in v['questions']];assert len(qs)==len(lines)==30
 for q,line in zip(qs,lines):
  cells=line.split('|');assert len(cells)==5;q['text']=cells[0]
  for o,t in zip(q['options'],cells[1:]):o['text']=t
  q['explanation']=' '.join(' '.join(slides[ref]['body']) for ref in q['slideRefs'])
  if q['id']=='e0ef5c0d-049b-5686-afb7-26c56fd8d0ea':q['explanation']+=' '+slides['slide-06']['callout']
 d['locale']='en';d['status']='translation-awaiting-independent-review';d['translationSourceSha256']=hashlib.sha256(p.read_bytes()).hexdigest();(root/slug/'en/assessment.json').write_text(json.dumps(d,ensure_ascii=False,indent=2),encoding='utf-8')
print('60 English questions and 240 options generated')

