from pathlib import Path
from lxml import etree
import zipfile,json,re,hashlib,copy
ROOT=Path(__file__).resolve().parents[2]
OUT=ROOT/'artifacts/source-review-2026-09'
NS={'w':'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
W='{'+NS['w']+'}'
FORMS=json.loads((OUT/'forms-extracted.json').read_text(encoding='utf-8'))
DEST=OUT/'templates';DEST.mkdir(exist_ok=True)
def text(e):return ''.join(e.xpath('.//w:t/text()',namespaces=NS))
def settext(e,value):
 if e.tag==W+'tc':
  paras=e.findall('w:p',NS)
  p=paras[0] if paras else etree.SubElement(e,W+'p')
  for extra in paras[1:]:e.remove(extra)
  for child in list(p):
   if child.tag!=W+'pPr':p.remove(child)
  pr=p.find('w:pPr',NS)
  if pr is None:pr=etree.SubElement(p,W+'pPr')
  for node in list(pr):
   if node.tag in [W+'numPr',W+'spacing',W+'ind']:pr.remove(node)
  space=etree.SubElement(pr,W+'spacing');space.set(W+'before','0');space.set(W+'after','0')
  run=etree.SubElement(p,W+'r');ts=[etree.SubElement(run,W+'t')]
 else:
  ts=e.findall('.//w:t',NS)
  if not ts:
   run=etree.SubElement(e,W+'r');ts=[etree.SubElement(run,W+'t')]
 ts[0].text=value;ts[0].set('{http://www.w3.org/XML/1998/namespace}space','preserve')
 for t in ts[1:]:t.text=''

def slot(header):
 h=header.lower()
 if '№' in h:return '1'
 if 'решени' in h:return '[РЕШЕНИЕ]'
 if 'ф.и.о' in h or 'фио' in h or 'фамили' in h:return '[ФИО]'
 if 'должност' in h:return '[ДОЛЖН.]'
 if 'организац' in h or 'место работы' in h:return '[ОРГ.]'
 if 'образован' in h:return '[ОБРАЗ.]'
 if 'причин' in h:return '[ПРИЧИНА]'
 if 'подпись' in h:return '[ПОДП.]'
 if 'примечан' in h:return '[ПРИМ.]'
 return '[ИТОГ]'

profiles=[]
for d in FORMS:
 source=Path.home()/'Downloads'/d['name'];z=zipfile.ZipFile(source);x=etree.fromstring(z.read('word/document.xml'));i=d['id']
 changed=[]
 if i!=23 and i!=14:
  for table in x.findall('.//w:tbl',NS):
   rows=table.findall('w:tr',NS);headercount=2 if i in (21,22) else 1
   headers=[text(c) for c in rows[0].findall('w:tc',NS)]
   if len(rows)>headercount:
    row=rows[headercount]
    for j,c in enumerate(row.findall('w:tc',NS)):settext(c,'1' if j==0 else slot(headers[j]))
    for extra in rows[headercount+1:]:table.remove(extra)
    for r in rows[:headercount]:
     pr=r.find('w:trPr',NS)
     if pr is None:pr=etree.SubElement(r,W+'trPr')
     if pr.find('w:tblHeader',NS) is None:etree.SubElement(pr,W+'tblHeader')
    for height in table.findall('.//w:trHeight',NS):height.getparent().remove(height)
    changed.append('Participant table reduced to one repeatable placeholder row; original columns retained')
 for p in x.findall('.//w:p',NS):
  s=text(p);v=s
  if i==14:
   v=re.sub(r'Сертификат №\s*00([1-4])',r'Сертификат № [НОМЕР \1]',v)
   if v.strip() in ['Аширов Абу-Бакир Абдумаликович','Аширов Фахрутдин Абдумаликович','Сатыбалдиева Гулбану Елмуратовна','Бекберов Нурлан Бестерекбаевич']:v='[ФИО СЛУШАТЕЛЯ]'
   v=re.sub(r'«12»\s*января\s*2026\s*года','[ДАТА ОБУЧЕНИЯ]',v)
   if v.startswith('Дата выдачи'):v='Дата выдачи [ДАТА ВЫДАЧИ]'
   v=v.replace('в течении','в течение')
  elif i!=23:
   if 'Филиал Китайской Инжиниринговой Корпорации' in v:v='[ОРГАНИЗАЦИЯ ЗАКАЗЧИКА]'
   if re.search(r'(?:Протокол|ПРОТОКОЛ|^\s*№).*?\d',v):
    v=re.sub(r'№\s*\d+(?:[-/]\d+)*','№ [НОМЕР]',v)
   if re.match(r'^\s*[«"].*202[56]',v) or (i==27 and re.match(r'^2025',v)):v='[ДАТА ПРОВЕРКИ / ТЕКСЕРУ КҮНІ]'
   v=re.sub(r'08\.07\.2026 года','[ДАТА ПРОВЕРКИ]',v)
   if v.startswith('На основании приказа от'):v='На основании приказа от [ДАТА ПРИКАЗА] № [НОМЕР ПРИКАЗА]'
   v=v.replace('периодический вид проверки знаний','[ВИД ПРОВЕРКИ] вид проверки знаний')
  v=v.replace('Преподователь','Преподаватель').replace('на опасно производственных объектах','на опасных производственных объектах')
  if v!=s:settext(p,v)
 # Compact empty source spacing left by historical participant lists.
 if i not in (14,23):
  body=x.find('w:body',NS);previous_blank=False
  for para in list(body):
   if para.tag!=W+'p':previous_blank=False;continue
   blank=not text(para).strip()
   if blank and previous_blank:body.remove(para);continue
   if blank:
    pr=para.find('w:pPr',NS)
    if pr is None:pr=etree.SubElement(para,W+'pPr')
    for node in list(pr):
     if node.tag==W+'spacing':pr.remove(node)
    spacing=etree.SubElement(pr,W+'spacing');spacing.set(W+'before','0');spacing.set(W+'after','0');spacing.set(W+'line','120');spacing.set(W+'lineRule','exact')
   previous_blank=blank
 # Strip stale author/comments/revisions metadata, preserve document formatting parts.
 output=DEST/d['name']
 with zipfile.ZipFile(output,'w',zipfile.ZIP_DEFLATED) as new:
  for item in z.infolist():
   data=z.read(item.filename)
   if item.filename=='word/document.xml':data=etree.tostring(x,xml_declaration=True,encoding='UTF-8',standalone=True)
   elif item.filename=='docProps/core.xml':
    c=etree.fromstring(data)
    for node in c:
     if etree.QName(node).localname in ('creator','lastModifiedBy'):node.text='Work Safety'
    data=etree.tostring(c,xml_declaration=True,encoding='UTF-8',standalone=True)
   new.writestr(item,data)
 body='\n'.join(d['paragraphs']);family='reference'
 if i in (17,18):family='fire-safety'
 elif i in (19,20):family='industrial-safety'
 elif i in (21,22):family='occupational-safety'
 elif i==16:family='height'
 elif i==27:family='scaffolder'
 elif i==14:family='first-aid'
 elif i==23:family='catalog'
 elif i==25:family='confined-space'
 elif i==26:family='pressure-vessels'
 else:family='lifting-equipment'
 profile={'sourceId':i,'sourceFile':d['name'],'sourceSha256':d['sha256'],'templateFile':d['name'],'templateSha256':hashlib.sha256(output.read_bytes()).hexdigest(),'family':family,'type':'catalog' if i==23 else 'certificate' if i==14 else 'protocol','category':'engineering' if 'ИТР' in d['name'] else 'workers' if 'Рабочий состав' in d['name'] else None,'hours':40 if i in (17,20) else 10 if i in (18,19) else 8 if i==14 else None,'validityYears':1 if i==14 else None,'commission':['bitemirov','lenchenko'] if i==14 else [] if i==23 else ['bitemirov','ismailov-gb' if i==15 else 'ismailov-bt','kudiyarov'] if i in (10,11,12,13,15,24,28) else ['bitemirov','akhmetzhanov','kudiyarov'],'columns':[] if i==14 else [t[0] for t in d['tables']],'embeddedMediaCount':len(d['media']),'changes':changed+['Historical participant data, issuance dates and numbers replaced by explicit placeholders; statutory reference dates retained'],'status':'sanitized-awaiting-visual-review','automaticActivation':False,'risks':[]}
 if i in (10,11,12,13,15,24,28):profile['risks']+=['Ismailov initials differ across sources; signature not supplied','Historical publisher/title of order 359 requires legal verification']
 if i==26:profile['risks']+=['Historical publisher/title of order 358 requires legal verification']
 if i==14:profile['risks']+=['Lenchenko signature not supplied; 8 hours and 1 year are source-specific']
 if 'допускаются к самостоятельной работе' in body:profile['risks']+=['Source admission sentence is retained as source wording, not authorization to grant workplace access automatically']
 profiles.append(profile)
(OUT/'template-profiles.json').write_text(json.dumps(profiles,ensure_ascii=False,indent=2),encoding='utf-8')
(ROOT/'content/document-templates/source-profiles.json').write_text(json.dumps(profiles,ensure_ascii=False,indent=2),encoding='utf-8')
print('Created',len(profiles),'source-derived DOCX templates')

