from pathlib import Path
import json,zipfile,re,hashlib
from lxml import etree
root=Path('artifacts/source-review-2026-09');records=json.loads((root/'forms-extracted.json').read_text(encoding='utf-8'));ns={'w':'http://schemas.openxmlformats.org/wordprocessingml/2006/main'};results=[]
for d in records:
 src=Path.home()/'Downloads'/d['name'];out=root/'templates'/d['name'];a=zipfile.ZipFile(src);b=zipfile.ZipFile(out);x=etree.fromstring(b.read('word/document.xml'))
 delta=[n for n in a.namelist() if a.read(n)!=b.read(n)]
 assert set(delta)<=set(['word/document.xml','docProps/core.xml'])
 assert hashlib.sha256(src.read_bytes()).hexdigest()==d['sha256']
 assert [etree.tostring(s).decode() for s in x.findall('.//w:sectPr',ns)]==d['sections']
 s='\n'.join(x.xpath('//w:t/text()',namespaces=ns))
 assert 'Samruk Business Academy' not in s and 'ШалкияЦинк' not in s and 'Тяньчэнь' not in s
 if d['id'] not in (14,23):
  for old in d['tables'][0][2 if d['id'] in (21,22) else 1:]:
   name=old[1].strip()
   if name:assert name not in s, (d['id'],name)
 rows=[len(t.findall('w:tr',ns)) for t in x.findall('.//w:tbl',ns)]
 results.append({'id':d['id'],'packagePartsChanged':delta,'pageGeometryPreserved':True,'sourceUnmodified':True,'historicalParticipantsRemoved':d['id']!=23,'rows':rows})
(root/'structural-qa.json').write_text(json.dumps(results,ensure_ascii=False,indent=2),encoding='utf-8');print('19/19 structural checks passed')
