from pathlib import Path
import zipfile,json,hashlib
from lxml import etree
root=Path('artifacts/source-review-2026-09'); root.mkdir(exist_ok=True,parents=True)
names=['Лицо отв по надзору за безоп экспл ГПМ ШЦ','Лицо отв по надзору за безоп экспл ГПМ СБА','Лицо отв за исправное сост ГПМ','Лицо отв за безоп перемещ кранами','Сертификат медпомощь 1-4','Протокол Стропальщик','Работы на высоте','ПТМ ИТР','ПТМ  Рабочий состав','Промбез Рабочий состав','Промбез ИТР','БиОТ ИТР','БиОТ  Рабочий состав','Курсы','Машинист крана','Работа в замкнутом пространстве ИТР','Работа с сосудами под давлением','Протокол Лесомонтажник','Слесарь ГПМ']
ns={'w':'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
records=[]
for i,name in enumerate(names,10):
 p=Path.home()/'Downloads'/(name+'.docx'); z=zipfile.ZipFile(p); x=etree.fromstring(z.read('word/document.xml'))
 paras=[''.join(t.itertext()) for t in x.findall('.//w:t',ns)]
 lines=[''.join(p.itertext()) for p in []]
 lines=[''.join(p.xpath('.//w:t/text()',namespaces=ns)) for p in x.findall('.//w:p',ns)]
 tables=[[[ ''.join(c.xpath('.//w:t/text()',namespaces=ns)) for c in r.findall('w:tc',ns)] for r in t.findall('w:tr',ns)] for t in x.findall('.//w:tbl',ns)]
 media=[]
 for item in z.namelist():
  if item.startswith('word/media/'):
   data=z.read(item); dest=root/'media'/str(i)/Path(item).name;dest.parent.mkdir(parents=True,exist_ok=True);dest.write_bytes(data);media.append({'part':item,'sha256':hashlib.sha256(data).hexdigest(),'file':str(dest)})
 record={'id':i,'name':p.name,'sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'paragraphs':lines,'tables':tables,'media':media,'sections':[etree.tostring(s).decode() for s in x.findall('.//w:sectPr',ns)]}
 records.append(record)
 (root/f'{i:02d}-source.txt').write_text('\n'.join(lines),encoding='utf-8')
(root/'forms-extracted.json').write_text(json.dumps(records,ensure_ascii=False,indent=2),encoding='utf-8')
for r in records: print(r['id'],r['name'],'paragraphs',len(r['paragraphs']),'tables',len(r['tables']),'media',len(r['media']))
