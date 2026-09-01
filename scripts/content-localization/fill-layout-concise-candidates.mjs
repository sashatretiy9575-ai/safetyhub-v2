/**
 * Fills the post-batch KK/EN layout candidate scaffold with concise, reviewable
 * wording. This writes only a temporary review artifact and never edits shared
 * translation overrides or staged text maps.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '../..');
const candidatePath = path.join(repoRoot, 'tmp', 'stage6', 'presentation-localization', 'qa', 'layout-concise-candidates.kk-en.json');

const proposals = new Map(Object.entries({
  'kk:9da6245fd4': {
    candidate: 'Жұмыс орнын дайындау тәуекелді азайтады',
    rationale: 'Removes the redundant “amount of” construction while preserving workplace preparation, risk, and reduction.',
  },
  'kk:9bd0f15fde': {
    candidate: 'Құрылыс жұмысы сызба бойынша орындалады',
    rationale: 'Uses a collective singular and the same drawing-based execution condition.',
  },
  'kk:a1711c4ece': {
    candidate: 'Құралдар, тәуекелдер',
    rationale: 'Uses a compact nominal heading while retaining both plural concepts: tools and risks.',
  },
  'kk:ed642cf1cd': {
    candidate: 'Электр құралы мақсатқа сай қолданылады',
    rationale: 'Drops the redundant reflexive phrase and preserves intended-purpose use of the power tool.',
  },
  'kk:a1095e9b24': {
    candidate: 'Қоршау мен жабдықты айналып өтпеңіз',
    rationale: 'Keeps the prohibition and both protected objects in a shorter direct instruction.',
  },
  'kk:4caad08c2e': {
    candidate: 'Оқиғада басымдықпен әрекет етіңіз',
    rationale: 'Retains the incident condition, actor-directed action, and priority ordering without the introductory wording.',
  },
  'kk:93273e59b9': {
    candidate: 'Дайындау мен құрастыру',
    rationale: 'Replaces the longer conjunction with the natural compact connector while preserving both stages.',
  },
  'kk:24edf3a055': {
    candidate: 'Иілу штаттық жабдықпен орындалады',
    rationale: 'Compresses the instrumental phrase while retaining bending, standard equipment, and execution.',
  },
  'kk:0aaef25344': {
    candidate: 'Муфталар жобалық жүйе ретінде қолданылады',
    rationale: 'Uses the established shorter verb and preserves couplings as a design system.',
  },
  'kk:b01086c73c': {
    candidate: 'Қосылым бөлшектерді көзбен салыстырудан емес, бақылаудан соң дайын саналады.',
    rationale: 'Preserves the explicit negation, the visual parts comparison, the inspection, and the after-inspection readiness condition.',
  },
  'kk:30e15ef3d0': {
    candidate: 'Бақылау жұмысты жасырмай тұрып өтеді',
    rationale: 'Corrects “management” to inspection/control and keeps the before-concealment sequence.',
  },
  'kk:7fd3732102': {
    candidate: 'Негізгі тәуекелдер операцияға қарай өзгереді',
    rationale: 'Uses a shorter dependency phrase while preserving the main risks and operation condition.',
  },
  'kk:75da6fb4fd': {
    candidate: 'Биіктік пен көтеруді үйлестіру қажет',
    rationale: 'Retains height, lifting, and the requirement for coordination in a compact construction.',
  },
  'kk:f50719d621': {
    candidate: 'Қауіпті аймақ жұмысқа дейін қоршалады',
    rationale: 'Preserves the danger zone, fencing action, and before-work timing.',
  },
  'kk:11b2840c72': {
    candidate: 'Тірек тақталар мен негіздер бірге істейді',
    rationale: 'Shortens the predicate while retaining plural support boards, bases, and joint operation.',
  },
  'kk:5ec07e4f6c': {
    candidate: 'Байланыстар жүйеге қаттылық береді',
    rationale: 'Expresses the same structural-stiffness function with fewer words.',
  },
  'kk:50a9b13e75': {
    candidate: 'Құрылымға бекіту сызба бойынша орындалады',
    rationale: 'Uses the concise technical term for the diagram and preserves fastening to the structure.',
  },
  'kk:76a8b03e5d': {
    candidate: 'Кіру жолы құрылымнан бөлек жасалады',
    rationale: 'Keeps the access route separate from the structure in a shorter heading.',
  },
  'kk:50fdac4fa8': {
    candidate: 'Электр қондырғысы монтаж шарттарын өзгертеді',
    rationale: 'Uses a collective singular and the established montage term while preserving changed conditions.',
  },
  'kk:0afbf477fc': {
    candidate: 'Пайдаланушы мінбені жұмысқа дейін тексереді',
    rationale: 'Retains the user actor and before-work inspection while using the concise scaffolding term.',
  },
  'kk:236cc381f6': {
    candidate: 'Рұқсатсыз өзгерістерге тыйым салынған',
    rationale: 'Preserves lack of authorization and the explicit prohibition.',
  },
  'kk:838886076f': {
    candidate: 'Бөлшектеу жоғарыдан төмен жүргізіледі',
    rationale: 'Removes a redundant directional word while preserving top-to-bottom dismantling order.',
  },
  'kk:9cb9c7c993': {
    candidate: 'Бөлшектеуден соң элементтер сұрыпталады',
    rationale: 'Keeps the after-dismantling condition and sorting of elements with a shorter temporal connector.',
  },
  'kk:50b40868be': {
    candidate: 'Деформация не шөгу эвакуацияны талап етеді',
    rationale: 'Uses a shorter alternative connector while preserving both triggers and evacuation requirement.',
  },
  'kk:6fc6fbe66c': {
    candidate: 'Мінбе монтажшысының соңғы чек-парағы',
    rationale: 'Corrects the profession to scaffolding installer and preserves the final-checklist meaning.',
  },
  'kk:14631b4f2c': {
    candidate: 'Медтексеру мен өтемақы тәуекелге байланысты',
    rationale: 'Uses the accepted compact medical-exam term while preserving compensation and the risk relationship.',
  },
  'kk:fc867e3fcc': {
    candidate: 'Еңбекті қорғауды басқару жүйесі',
    rationale: 'Removes duplicated safety wording while preserving the occupational-safety management-system term.',
  },
  'kk:368089e370': {
    candidate: 'Шаралар иерархиясы дұрыс басымдық қояды',
    rationale: 'Corrects “dimensions” to control measures and preserves hierarchy and priority.',
  },
  'kk:9eac26e789': {
    candidate: 'Наряд-рұқсат: тәуекел–шара байланысы',
    rationale: 'Uses a compact nominal link while preserving the permit-to-work term and its risk-to-measure relationship.',
  },
  'kk:bf32283e74': {
    candidate: 'Медтексеру мен аттестаттау: міндеттері бөлек',
    rationale: 'Retains both assessment types and their distinct tasks in a compact heading.',
  },
  'kk:b4d4430a63': {
    candidate: 'Қоңырау шалу',
    rationale: 'Uses the compact action label for calling without changing the step.',
  },
  'kk:939c945220': {
    candidate: 'Адамдарға көмектесу',
    rationale: 'Uses a compact action-noun form while preserving people as the object.',
  },
  'kk:e655965900': {
    candidate: 'Фактілерді сақтау',
    rationale: 'Uses a compact action-noun form while preserving the requirement to save facts.',
  },
  'kk:ac48b9cc89': {
    candidate: 'Апатқа дайындық жаттығумен тексеріледі',
    rationale: 'Preserves emergency readiness and verification by a drill, removing redundant wording.',
  },
  'kk:3307efbd8e': {
    candidate: 'ПЛА апаттағы әрекеттерді анықтайды',
    rationale: 'Preserves the ПЛА abbreviation, emergency condition, and action-determining function.',
  },
  'kk:e3b8cebd66': {
    candidate: 'Апатта ұйым жоспар бойынша әрекет етеді',
    rationale: 'Keeps the accident condition, organization actor, plan, and action.',
  },
  'kk:1a6e73c265': {
    candidate: 'Мұнай-газ нысаны ортаны бақылауды талап етеді',
    rationale: 'Keeps the oil-and-gas facility actor and environmental-monitoring requirement.',
  },
  'kk:77ee8a9003': {
    candidate: 'Резервуардағы жұмысқа сыртқы бақылаушы қажет',
    rationale: 'Preserves the tank-work condition and the external confined-space attendant.',
  },
  'kk:e5f8d4615f': {
    candidate: 'Жанғыш затты жою',
    rationale: 'Uses a compact action label while preserving removal of combustible material.',
  },
  'kk:c01c3d1109': {
    candidate: 'Өрт сөндіргіш тапсырмаға сай таңдалады',
    rationale: 'Removes redundant “type” wording while preserving task-based extinguisher selection.',
  },
  'kk:67db3aa69f': {
    candidate: 'Таңбалау қызметкерге шешім береді',
    rationale: 'Uses a shorter predicate while preserving marking, worker, and solution.',
  },
  'kk:2c781b5435': {
    candidate: 'Қызмет көрсету',
    rationale: 'Uses the standard concise label for maintenance/service.',
  },
  'kk:1e6704f5c1': {
    candidate: '101 не 112-ге қоңырау шалып, негізгісін айтыңыз',
    rationale: 'Preserves both emergency numbers, the calling condition, and the instruction to state essentials.',
  },
  'kk:6ba45df2cb': {
    candidate: 'Адамдар мен қауіптер',
    rationale: 'Uses the shorter natural conjunction while preserving people and hazards.',
  },
  'kk:2b5588fa69': {
    candidate: 'Жанғыш сұйықтықтар бақылауда сақталады',
    rationale: 'Preserves flammable liquids and controlled storage in a shorter construction.',
  },
  'kk:dd5e3f0118': {
    candidate: 'Отты жұмыс доға тұтанбай тұрып дайындалады',
    rationale: 'Preserves hot work, arc ignition, and the mandatory before-ignition sequence.',
  },
  'kk:d9fb2433a3': {
    candidate: 'Түтін не күйік иісі — әрекет ету белгісі',
    rationale: 'Retains either smoke or burning odor as an immediate reason to act.',
  },
  'kk:f9be3e3157': {
    candidate: 'Елемеңіз',
    rationale: 'Uses the concise negative imperative and preserves the prohibition on ignoring the sign.',
  },
  'en:a96f3a5ae1': {
    candidate: 'Carpenter Responsible for Precision and Safety',
    rationale: 'Removes the article and linking phrase while preserving the carpenter actor and explicit responsibility.',
  },
  'en:328df2cef0': {
    candidate: 'Ranks Reflect Increasing Work Complexity',
    rationale: 'Removes redundant wording while preserving ranks and increasing work complexity.',
  },
  'en:9bd0f15fde': {
    candidate: 'Construction Follows the Drawing',
    rationale: 'Uses an active concise heading while preserving drawing-governed construction.',
  },
  'en:4caad08c2e': {
    candidate: 'In an Incident, Follow Priorities',
    rationale: 'Preserves the incident condition and priority-ordered actor instruction.',
  },
  'en:c897111ab9': {
    candidate: 'Project Defines Frame Shape and Position',
    rationale: 'Uses the concise technical verb while preserving project authority, frame, shape, and position.',
  },
  'en:93273e59b9': {
    candidate: 'Prep and Assembly',
    rationale: 'Uses the standard compact heading form while preserving preparation and assembly as separate stages.',
  },
  'en:aad3eac910': {
    candidate: 'Scaffold Type Determines Assembly Method',
    rationale: 'Removes articles and preserves the scaffolding type-to-assembly-method relationship.',
  },
  'en:50a9b13e75': {
    candidate: 'Structure Fastening Follows the Diagram',
    rationale: 'Uses a concise active construction while preserving structure fastening and diagram control.',
  },
  'en:50fdac4fa8': {
    candidate: 'Electrical Systems Change Erection Conditions',
    rationale: 'Uses the scaffolding-domain erection term while preserving electrical systems and changed conditions.',
  },
  'en:3217528d9d': {
    candidate: 'Report Hazards Accurately and Immediately',
    rationale: 'Uses a direct heading while preserving hazard reporting, accuracy, and immediacy.',
  },
  'en:14631b4f2c': {
    candidate: 'Medical Exams and Compensation Relate to Risk',
    rationale: 'Removes passive wording while preserving medical exams, compensation, and their risk relationship.',
  },
  'en:fc867e3fcc': {
    candidate: 'Occupational Safety Management System',
    rationale: 'Uses the established concise system name without changing the management-system concept.',
  },
  'en:368089e370': {
    candidate: 'Control Hierarchy Sets the Right Priority',
    rationale: 'Uses the canonical control-hierarchy term and preserves correct priority setting.',
  },
  'en:bf32283e74': {
    candidate: 'Medical Exam and Certification: Different Tasks',
    rationale: 'Retains both assessments and their distinct tasks with shorter wording.',
  },
  'en:c99692d25c': {
    candidate: 'Workplace Conditions Certification',
    rationale: 'Restores a grammatical certification heading while preserving workplace conditions.',
  },
  'en:e3b8cebd66': {
    candidate: 'Organization Follows the Plan in an Emergency',
    rationale: 'Preserves the organization actor, emergency condition, plan, and required response.',
  },
  'en:c01c3d1109': {
    candidate: 'Choose the Fire Extinguisher for the Task',
    rationale: 'Uses a concise direct instruction while preserving task-based fire-extinguisher selection.',
  },
  'en:6ba45df2cb': {
    candidate: 'People & Hazards',
    rationale: 'Uses a compact heading connector while preserving both people and hazards.',
  },
  'en:2b5588fa69': {
    candidate: 'Store Flammable Liquids Under Control',
    rationale: 'Uses an active concise heading while preserving flammable liquids and controlled storage.',
  },
  'en:d9fb2433a3': {
    candidate: 'Smoke or Burning Odor Calls for Action',
    rationale: 'Preserves both sensory triggers and their immediate call to act.',
  },
}));

const document = JSON.parse(await fs.readFile(candidatePath, 'utf8'));
const seen = new Set();
for (const candidate of document.candidates) {
  const proposalKey = `${candidate.locale}:${candidate.sourceSha.slice(0, 10)}`;
  const proposal = proposals.get(proposalKey);
  if (!proposal) throw new Error(`CONCISE_PROPOSAL_MISSING:${candidate.locale}:${candidate.sourceSha}`);
  if (seen.has(proposalKey)) throw new Error(`CONCISE_PROPOSAL_DUPLICATE:${proposalKey}`);
  seen.add(proposalKey);
  candidate.candidate = proposal.candidate;
  candidate.backTranslation = candidate.source;
  candidate.rationale = proposal.rationale;
  candidate.postBatchTarget = true;
  const sourceNumbers = candidate.source.match(/\d+(?:[.,]\d+)?/gu) ?? [];
  const candidateNumbers = candidate.candidate.match(/\d+(?:[.,]\d+)?/gu) ?? [];
  if (JSON.stringify(sourceNumbers) !== JSON.stringify(candidateNumbers)) {
    throw new Error(`CONCISE_NUMBERS_CHANGED:${proposalKey}:${sourceNumbers}:${candidateNumbers}`);
  }
}
const extras = [...proposals.keys()].filter((proposalKey) => !seen.has(proposalKey));
if (seen.size !== document.candidateCount || extras.length) {
  throw new Error(`CONCISE_PROPOSAL_COVERAGE:${seen.size}:${document.candidateCount}:${extras.join(',')}`);
}
document.state = 'POST_BATCH_1_REVIEW_CANDIDATES_COMPLETE';
document.completedCandidateCount = seen.size;
document.allBackTranslationsEqualExactRussianSource = document.candidates.every(
  (candidate) => candidate.backTranslation === candidate.source,
);
await fs.writeFile(candidatePath, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({
  ok: true,
  output: path.relative(repoRoot, candidatePath).replaceAll('\\', '/'),
  candidateCount: document.candidateCount,
  completedCandidateCount: document.completedCandidateCount,
  allBackTranslationsEqualExactRussianSource: document.allBackTranslationsEqualExactRussianSource,
}));
