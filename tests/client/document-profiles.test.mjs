import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { PDFDocument, PDFName, PDFDict } from 'pdf-lib';
import { applyDocumentProfile, protocolColumns } from '../../lib/pdf/document-profile.ts';
import { groupItemsForProtocols, generateProtocolInBrowser } from '../../lib/pdf/protocol-renderer.ts';
import { assertCertificateBranding } from '../../lib/pdf/certificate-client-contract.ts';
import { loadCertificateImageBytes } from '../../lib/pdf/certificate-renderer.ts';

const ids = ['00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000004'];
const base = { organizationName:'ТОО «Work Safety (Уорк Сэйфти)»',bin:'171140039242',chairmanName:'Old',chairmanPosition:'',memberName:'Old',memberPosition:'',secondMemberName:'Old',secondMemberPosition:'',protocolNumber:'19.09',protocolDate:'2026-09-19',validityMonths:12,examTextKk:'',examTextRu:'',knowledgeTextKk:'',knowledgeTextRu:'',stampUrl:null,chairmanSignatureUrl:null,memberSignatureUrl:null };
const profile = { id:'test-worker',courseSlug:'test',audience:'worker',label:'Рабочий состав',programName:'Промышленная безопасность',family:'industrial',hours:10,validityMonths:0,protocolText:'Проверка по программе «{program}»',decisionText:'Результаты проверки знаний зафиксированы. Допуск к самостоятельной работе оформляет работодатель.',orderNumber:'',orderDate:'',verificationKind:'',commission:[
  {signerId:'bitemirov-au',name:'Битемиров А.У.',position:'Директор',assetId:ids[0]},
  {signerId:'akhmetzhanov-em',name:'Ахметжанов Е.М.',position:'Преподаватель',assetId:ids[1]},
  {signerId:'kudiyarov-am',name:'Кудияров А.М.',position:'Преподаватель',assetId:ids[2]},
],stampAssetId:ids[3] };

test('profile signatures follow explicit signer identities and one protocol is one file', () => {
  const branding=applyDocumentProfile(base,profile);
  assertCertificateBranding(branding);
  assert.equal(branding.chairmanName,'Битемиров А.У.');
  assert.equal(branding.commissionSignatureUrls.length,3);
  assert.equal(branding.documentDefaults.commission[1].name,'Кудияров А.М.');
  // Settings saved between two issuances of one sitting do not split its protocol.
  const items=[{organization:'Компания',titleSnapshot:'Курс',branding},{organization:'Компания',titleSnapshot:'Курс',branding:{...branding,validityMonths:24}}];
  assert.equal(groupItemsForProtocols(items).length,1);
  // Another number, another day or another company is another protocol.
  assert.equal(groupItemsForProtocols([...items,{organization:'Компания',titleSnapshot:'Курс',branding:{...branding,protocolNumber:'19.09-2'}}]).length,2);
  assert.equal(groupItemsForProtocols([...items,{organization:'Компания',titleSnapshot:'Курс',branding:{...branding,protocolDate:'2026-09-20'}}]).length,2);
  assert.equal(groupItemsForProtocols([...items,{organization:'Другая',titleSnapshot:'Курс',branding}]).length,2);
  // «Примечание» closes every protocol, not only the «БиОТ» one.
  assert.equal(protocolColumns('ptm').length,8);
  assert.equal(protocolColumns('biot').length,6);
  assert.equal(protocolColumns('qualification').length,7);
  for (const family of ['general','biot','ptm','industrial','qualification','first-aid'])
    assert.equal(protocolColumns(family).at(-1),'Примечание',family);
  assert.equal(protocolColumns('first-aid',2).at(-1),'Примечание');
});

test('cancelling one preview does not abort the shared immutable image of another document', async () => {
  const original = globalThis.fetch;
  let release;
  let requests = 0;
  globalThis.fetch = async () => { requests++; return new Promise(resolve => { release = () => resolve(new Response(new Uint8Array([1,2,3]))); }); };
  try {
    const controller = new AbortController();
    const first = loadCertificateImageBytes('/registered-cache-cancellation-test', controller.signal);
    const second = loadCertificateImageBytes('/registered-cache-cancellation-test');
    const cancelled = assert.rejects(first, { name: 'AbortError' });
    controller.abort(); release();
    await cancelled;
    assert.deepEqual(await second, new Uint8Array([1,2,3]));
    assert.equal(requests, 1);
  } finally { globalThis.fetch = original; }
});

test('each protocol family renders its source columns and all three transparent signatures', async () => {
  const original=globalThis.fetch;
  const pixel=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==','base64');
  globalThis.fetch=async input=>{
    const url=String(input);
    if(url.includes('/registered?')) {
      if(process.env.DOCUMENT_PROFILE_VISUAL_QA) {
        const names=['bitemirov','akhmetzhanov','kudiyarov','stamp'];
        return new Response(await readFile(`artifacts/document-assets-2026-09/${names[ids.indexOf(new URL(url,'https://x').searchParams.get('id'))]}.png`));
      }
      return new Response(pixel);
    }
    const file=url.includes('face=serif')?`NotoSerif-${url.includes('weight=bold')?'Bold':'Regular'}.ttf`:url.includes('face=sans')?'NotoSans-Bold.ttf':'noto-sans-latin-cyrillic.ttf';
    return new Response(await readFile(new URL('../../lib/pdf/assets/'+file,import.meta.url)));
  };
  try {
    for(const family of ['general','ptm','biot','industrial','qualification','first-aid','first-aid-legacy']) {
      const branding=applyDocumentProfile({...base,...(family === 'first-aid-legacy' ? {} : {protocolLayoutVersion:2})},{...profile,family:family === 'first-aid-legacy' ? 'first-aid' : family});
      const people=Array.from({length:7},(_,i)=>({userId:String(i),fullName:'Участник '+(i+1)+' Длиннаяфамилия',position:'Инженер по охране труда',education:'Высшее',status:'passed',score:9,total:10,certificateId:null,trainingReason:'Периодическое обучение',notes:'',qualificationDecision:'Решение № 7 от 19.09.2026'}));
      const bytes=await generateProtocolInBrowser({organization:'Проверочная организация',courseTitle:profile.programName,items:[],participants:people},branding,'/certificate-assets/font?locale=ru&v=1');
      const doc=await PDFDocument.load(bytes);
      assert.equal(doc.getPages().reduce((sum,p)=>sum+(p.node.Resources().lookupMaybe(PDFName.of('XObject'),PDFDict)?.keys().length??0),0),4);
      const pdfjs=await import('pdfjs-dist/legacy/build/pdf.mjs');
      const task=pdfjs.getDocument({data:bytes.slice(),useSystemFonts:true}); const pdf=await task.promise;
      let text='';
      for(let i=1;i<=pdf.numPages;i++) {
        const page=await pdf.getPage(i); const content=await page.getTextContent();
        for(const item of content.items) if('str'in item) {text+=item.str+' ';assert.ok(item.transform[4]>=0&&item.transform[4]+item.width<=596,'horizontal clipping');assert.ok(item.transform[5]>=20,'vertical clipping');}
        if(process.env.DOCUMENT_PROFILE_VISUAL_QA || process.env.DOCUMENT_PROFILE_RENDER_QA) {
          const {createCanvas}=await import('@napi-rs/canvas');const viewport=page.getViewport({scale:1.4});const canvas=createCanvas(Math.ceil(viewport.width),Math.ceil(viewport.height));
          await page.render({canvas,canvasContext:canvas.getContext('2d'),viewport}).promise;
          await mkdir('test-results/document-profiles',{recursive:true});await writeFile(`test-results/document-profiles/${family}-${i}.png`,canvas.toBuffer('image/png'));await writeFile(`test-results/document-profiles/${family}.pdf`,bytes);
        }
      }
      assert.match(text,/Участник 7/);assert.match(text,/Кудияров/);assert.doesNotMatch(text,/допускаются к самостоятельной/u);
      if(family==='ptm') assert.match(text,/Причина обучения/);
      if(family==='first-aid') { assert.doesNotMatch(text,/Образование|Высшее/); assert.match(text,/Организация/); }
      if(family==='general' || family==='industrial' || family==='first-aid-legacy') assert.match(text,/Высшее/);
      if(family==='qualification') assert.match(text,/Решение № 7/);
      await task.destroy();
    }
  } finally {globalThis.fetch=original;}
});


test('education follows new form applicability and first-aid historical layout remains stable', async () => {
  const { requiresDocumentEducation } = await import('../../lib/pdf/document-education.ts');
  for (const family of ['general', 'industrial', undefined, null]) assert.equal(requiresDocumentEducation(family), true);
  for (const family of ['ptm', 'biot', 'qualification', 'first-aid']) assert.equal(requiresDocumentEducation(family), false);
  assert.ok(protocolColumns('first-aid').includes('Образование'));
  assert.ok(!protocolColumns('first-aid', 2).includes('Образование'));
  assert.ok(protocolColumns('general', 2).includes('Образование'));
  assert.throws(() => assertCertificateBranding({...base,protocolLayoutVersion:3}), /PROTOCOL_LAYOUT_INVALID/);
  assert.equal(groupItemsForProtocols([{ organization:'A', titleSnapshot:'T', branding:base }, { organization:'A', titleSnapshot:'T', branding:{...base,protocolNumber:'19.09-2'} }]).length, 2);
});

test('a course may print its own booklet, and «без срока» is a term of its own', async () => {
  const { completeDocumentProfile } = await import('../../lib/pdf/document-family-defaults.ts');
  const texts={examTextKk:'Өз мәтін',examTextRu:'Свой текст',knowledgeTextKk:'Өз',knowledgeTextRu:'Своё'};
  const own=applyDocumentProfile({...base,examTextRu:'Общий текст'},{...profile,booklet:{layout:'standard',texts}});
  assert.equal(own.examTextRu,'Свой текст');
  assert.equal(own.knowledgeTextKk,'Өз');
  assert.equal(applyDocumentProfile({...base,examTextRu:'Общий текст'},profile).examTextRu,'Общий текст');
  // 0 months is the form's term; «без срока» is said explicitly.
  assert.equal(completeDocumentProfile({...profile,family:'biot',validityMonths:0}).validityMonths,12);
  assert.equal(completeDocumentProfile({...profile,family:'biot',validityMonths:0,noExpiry:true}).validityMonths,0);
  assert.equal(completeDocumentProfile({...profile,family:'biot',validityMonths:24}).validityMonths,24);
});

test('the ПТМ protocol prints «Примечание» in its own cell', async () => {
  const original=globalThis.fetch;
  const pixel=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==','base64');
  globalThis.fetch=async input=>{
    const url=String(input);
    if(url.includes('/registered?')) return new Response(pixel);
    const file=url.includes('face=serif')?`NotoSerif-${url.includes('weight=bold')?'Bold':'Regular'}.ttf`:url.includes('face=sans')?'NotoSans-Bold.ttf':'noto-sans-latin-cyrillic.ttf';
    return new Response(await readFile(new URL('../../lib/pdf/assets/'+file,import.meta.url)));
  };
  try {
    const branding=applyDocumentProfile({...base,protocolLayoutVersion:2},{...profile,family:'ptm'});
    const people=[{userId:'1',fullName:'Участник Первый',position:'Слесарь',status:'passed',score:9,total:10,certificateId:null,notes:'Пересдача'}];
    const bytes=await generateProtocolInBrowser({organization:'Проверочная организация',courseTitle:'ПТМ',items:[],participants:people},branding,'/certificate-assets/font?locale=ru&v=1');
    const pdfjs=await import('pdfjs-dist/legacy/build/pdf.mjs');
    const task=pdfjs.getDocument({data:bytes.slice(),useSystemFonts:true}); const pdf=await task.promise;
    const content=await (await pdf.getPage(1)).getTextContent();
    const text=content.items.map(item=>'str' in item?item.str:'').join(' ');
    assert.match(text,/Пересдача/u);
    await task.destroy();
  } finally {globalThis.fetch=original;}
});
