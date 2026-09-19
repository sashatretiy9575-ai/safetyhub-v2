import fs from 'node:fs/promises';
import path from 'node:path';
const titles={ru:['Промышленная безопасность','Сварщик'],kk:['Өнеркәсіптік қауіпсіздік','Дәнекерлеуші'],zh:['工业安全','焊工']};
const descriptions={ru:['Курс промышленной безопасности в Казахстане: производственный контроль, грузоподъёмные механизмы, сосуды под давлением и электробезопасность.','Курс для сварщиков: подготовка соединений, оборудование, электрические и пожарные опасности, защитные меры и контроль качества.'],kk:['Қазақстандағы өнеркәсіптік қауіпсіздік: өндірістік бақылау, жүк көтеру механизмдері, қысыммен жұмыс істейтін ыдыстар және электр қауіпсіздігі.','Дәнекерлеушілер курсы: қосылысты дайындау, жабдық, электр және өрт қауіптері, қорғаныс шаралары және сапаны бақылау.'],zh:['哈萨克斯坦工业安全课程：生产监督、起重机械、压力容器和电气安全。学习设备检查、作业许可、风险控制及事故应对。','焊工培训课程：接头准备、焊接设备、电气与火灾危险、防护措施和质量检查。学习安全开工、作业中控制及收工检查。']};
for(const [locale,names] of Object.entries(titles))for(const [i,slug] of ['promyshlennaya-bezopasnost','svarshchik'].entries()){
 const file=path.resolve('content/course-batch-2026-09',slug,locale,'deck.json');
 let d;try{d=JSON.parse(await fs.readFile(file,'utf8'));}catch{continue;}
 d.title=names[i];d.description=descriptions[locale][i];
 d.seo={title:`${names[i]} | SafetyHub`,description:d.description,ogTitle:locale==='zh'&&i===1?'焊工培训':names[i],ogDescription:d.description,ogImage:`/images/course-batch/${slug}-${locale}.webp`,indexable:true};
 await fs.writeFile(file,JSON.stringify(d,null,2)+'\n');
}
