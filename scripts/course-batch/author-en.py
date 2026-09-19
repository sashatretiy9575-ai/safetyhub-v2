from pathlib import Path
import json,copy,hashlib
root=Path('content/course-batch-2026-09');base=Path('scripts/course-batch/translations')
for slug,source in [('promyshlennaya-bezopasnost','industrial-en.txt'),('svarshchik','welding-en.txt')]:
 ru=root/slug/'ru/deck.json';d=json.loads(ru.read_text(encoding='utf-8'));lines=(base/source).read_text(encoding='utf-8-sig').strip().splitlines();assert len(lines)==len(d['slides']),(slug,len(lines))
 for slide,line in zip(d['slides'],lines):
  cells=line.split('|');assert len(cells)==len(slide['body'])+2,(slug,slide['id'],len(cells));slide['title']=cells[0];slide['body']=cells[1:-1];slide['callout']=cells[-1]
 d['locale']='en';d['title']=d['slides'][0]['title'];d['description']=' '.join(d['slides'][0]['body']);d['status']='translation-awaiting-independent-review';d['translationSourceSha256']=hashlib.sha256(ru.read_bytes()).hexdigest()
 title=d['title']+' Training in Kazakhstan | Work Safety'
 desc='Industrial safety training covering lifting equipment, pressure equipment, electrical hazards and emergency actions. Study the course and test your knowledge.' if source.startswith('industrial') else 'Welding fundamentals, equipment, hot-work precautions and safe working practices. Study the course and test your knowledge.'
 d['seo']={'title':title,'description':desc,'ogTitle':title,'ogDescription':desc,'ogImage':f'/images/course-batch/{slug}-en.webp','indexable':True}
 out=root/slug/'en';out.mkdir(exist_ok=True);(out/'deck.json').write_text(json.dumps(d,ensure_ascii=False,indent=2),encoding='utf-8')
 (out/'manuscript.md').write_text('# '+d['title']+'\n\n'+'\n\n'.join('## '+str(i+1)+'. '+s['title']+'\n\n'+'\n'.join('- '+t for t in s['body'])+'\n\n**'+s['callout']+'**\n\nSources: '+', '.join(s['sourceRefs']) for i,s in enumerate(d['slides'])),encoding='utf-8')
print('97 English slides generated with source hash')


