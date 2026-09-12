import type { Icon } from '@phosphor-icons/react';
import {
  Airplane,
  Ambulance,
  Bandaids,
  Barricade,
  BatteryCharging,
  Bicycle,
  Biohazard,
  BookOpen,
  Boot,
  Buildings,
  Bus,
  Car,
  Certificate,
  Circuitry,
  ClipboardText,
  Cloud,
  Crane,
  Cube,
  Drop,
  Ear,
  Factory,
  Fan,
  FileText,
  Fire,
  FireExtinguisher,
  FirstAid,
  FirstAidKit,
  Fish,
  Flame,
  FolderOpen,
  GasPump,
  Gear,
  Goggles,
  Hammer,
  Hand,
  HardHat,
  Heartbeat,
  Hospital,
  IdentificationCard,
  Ladder,
  Leaf,
  Lightbulb,
  Lightning,
  Lock,
  MaskHappy,
  Microscope,
  Motorcycle,
  Newspaper,
  Note,
  Package,
  PersonSimple,
  PersonSimpleRun,
  PhoneCall,
  Pill,
  Plug,
  Power,
  Pulse,
  Recycle,
  Screwdriver,
  Shield,
  ShieldCheck,
  ShieldWarning,
  Stethoscope,
  Sun,
  Syringe,
  Thermometer,
  Toolbox,
  TrafficCone,
  Train,
  Tree,
  Truck,
  UserGear,
  Users,
  Virus,
  Warehouse,
  Warning,
  Wind,
  Wrench,
} from '@phosphor-icons/react/dist/ssr';

export const COURSE_ICON_CATEGORIES = [
  'Первая помощь',
  'Медицина',
  'Пожарная безопасность',
  'Промышленность',
  'СИЗ',
  'Электричество',
  'Транспорт',
  'Люди',
  'Документы',
  'Экология',
] as const;

export type CourseIconCategory = (typeof COURSE_ICON_CATEGORIES)[number];

function icon<const Id extends string>(
  id: Id,
  label: string,
  category: CourseIconCategory,
  keywords: string,
  component: Icon,
) {
  return { id, label, category, keywords, component } as const;
}

export const COURSE_ICONS = [
  icon('first-aid', 'Первая помощь', 'Первая помощь', 'first aid cross помощь крест', FirstAid),
  icon('first-aid-kit', 'Аптечка', 'Первая помощь', 'kit аптечка emergency', FirstAidKit),
  icon('bandaids', 'Пластыри', 'Первая помощь', 'bandage пластырь рана', Bandaids),
  icon('ambulance', 'Скорая помощь', 'Первая помощь', 'ambulance 103 emergency', Ambulance),
  icon('phone-call', 'Экстренный вызов', 'Первая помощь', 'phone call 112 звонок', PhoneCall),
  icon('heartbeat', 'Сердцебиение', 'Медицина', 'heart cardio сердце', Heartbeat),
  icon('pulse', 'Пульс', 'Медицина', 'pulse ecg пульс', Pulse),
  icon('stethoscope', 'Стетоскоп', 'Медицина', 'doctor врач осмотр', Stethoscope),
  icon('hospital', 'Больница', 'Медицина', 'hospital clinic клиника', Hospital),
  icon('pill', 'Лекарства', 'Медицина', 'pill medicine таблетки', Pill),
  icon('syringe', 'Инъекция', 'Медицина', 'syringe vaccine укол', Syringe),
  icon('thermometer', 'Температура', 'Медицина', 'thermometer heat температура', Thermometer),
  icon('microscope', 'Лаборатория', 'Медицина', 'microscope lab анализ', Microscope),
  icon('virus', 'Инфекция', 'Медицина', 'virus infection инфекция', Virus),
  icon('biohazard', 'Биологическая опасность', 'Медицина', 'biohazard биориск', Biohazard),
  icon('fire', 'Пожар', 'Пожарная безопасность', 'fire flame огонь пожар', Fire),
  icon('flame', 'Пламя', 'Пожарная безопасность', 'flame огонь горение', Flame),
  icon(
    'fire-extinguisher',
    'Огнетушитель',
    'Пожарная безопасность',
    'extinguisher тушение',
    FireExtinguisher,
  ),
  icon('warning', 'Предупреждение', 'Пожарная безопасность', 'warning danger опасность', Warning),
  icon(
    'shield-warning',
    'Защита от опасности',
    'Пожарная безопасность',
    'shield warning защита',
    ShieldWarning,
  ),
  icon('factory', 'Производство', 'Промышленность', 'factory завод производство', Factory),
  icon('warehouse', 'Склад', 'Промышленность', 'warehouse storage склад', Warehouse),
  icon('buildings', 'Объекты', 'Промышленность', 'buildings предприятие объект', Buildings),
  icon('crane', 'Кран', 'Промышленность', 'crane lifting подъём', Crane),
  icon('gear', 'Механизмы', 'Промышленность', 'gear machine механизм', Gear),
  icon('wrench', 'Инструмент', 'Промышленность', 'wrench repair ключ ремонт', Wrench),
  icon('hammer', 'Работы', 'Промышленность', 'hammer молоток работы', Hammer),
  icon(
    'screwdriver',
    'Обслуживание',
    'Промышленность',
    'screwdriver service отвёртка',
    Screwdriver,
  ),
  icon('toolbox', 'Набор инструментов', 'Промышленность', 'toolbox tools ящик', Toolbox),
  icon('package', 'Груз', 'Промышленность', 'package cargo коробка груз', Package),
  icon('cube', 'Материал', 'Промышленность', 'cube block материал', Cube),
  icon('barricade', 'Ограждение', 'Промышленность', 'barricade barrier ограждение', Barricade),
  icon('ladder', 'Работа на высоте', 'Промышленность', 'ladder height лестница', Ladder),
  icon('gas-pump', 'Топливо', 'Промышленность', 'gas fuel топливо', GasPump),
  icon('hard-hat', 'Каска', 'СИЗ', 'hard hat helmet каска', HardHat),
  icon('goggles', 'Защитные очки', 'СИЗ', 'goggles glasses очки', Goggles),
  icon('boot', 'Защитная обувь', 'СИЗ', 'boot shoes обувь ботинки', Boot),
  icon('ear', 'Защита слуха', 'СИЗ', 'ear hearing слух наушники', Ear),
  icon('hand', 'Защита рук', 'СИЗ', 'hand gloves руки перчатки', Hand),
  icon('mask', 'Защита лица', 'СИЗ', 'mask respirator маска респиратор', MaskHappy),
  icon('shield', 'Охрана труда', 'СИЗ', 'shield safety охрана труда', Shield),
  icon('shield-check', 'Безопасность', 'СИЗ', 'shield check безопасность', ShieldCheck),
  icon('lightning', 'Электроопасность', 'Электричество', 'lightning voltage молния ток', Lightning),
  icon('plug', 'Электропитание', 'Электричество', 'plug socket вилка розетка', Plug),
  icon('power', 'Отключение', 'Электричество', 'power shutdown питание', Power),
  icon('battery', 'Аккумулятор', 'Электричество', 'battery заряд аккумулятор', BatteryCharging),
  icon('circuitry', 'Электросхема', 'Электричество', 'circuit wiring схема проводка', Circuitry),
  icon('lightbulb', 'Освещение', 'Электричество', 'light bulb лампа свет', Lightbulb),
  icon('fan', 'Вентиляция', 'Электричество', 'fan ventilation вентилятор', Fan),
  icon('lockout', 'Блокировка', 'Электричество', 'lockout tagout loto замок', Lock),
  icon('truck', 'Грузовой транспорт', 'Транспорт', 'truck cargo грузовик', Truck),
  icon('car', 'Автомобиль', 'Транспорт', 'car vehicle машина', Car),
  icon('bus', 'Автобус', 'Транспорт', 'bus автобус', Bus),
  icon('motorcycle', 'Мотоцикл', 'Транспорт', 'motorcycle мотоцикл', Motorcycle),
  icon('bicycle', 'Велосипед', 'Транспорт', 'bicycle велосипед', Bicycle),
  icon('train', 'Железная дорога', 'Транспорт', 'train railway поезд', Train),
  icon('airplane', 'Авиация', 'Транспорт', 'airplane aviation самолёт', Airplane),
  icon('traffic-cone', 'Дорожные работы', 'Транспорт', 'traffic cone дорога конус', TrafficCone),
  icon('users', 'Команда', 'Люди', 'users team люди команда', Users),
  icon('person', 'Работник', 'Люди', 'person worker человек работник', PersonSimple),
  icon('running-person', 'Эвакуация', 'Люди', 'run evacuation бег эвакуация', PersonSimpleRun),
  icon('user-gear', 'Специалист', 'Люди', 'user gear специалист инженер', UserGear),
  icon(
    'identification-card',
    'Удостоверение',
    'Люди',
    'id identity удостоверение',
    IdentificationCard,
  ),
  icon('file-text', 'Документ', 'Документы', 'file document файл документ', FileText),
  icon('clipboard', 'Чек-лист', 'Документы', 'clipboard checklist список', ClipboardText),
  icon('book', 'Инструкция', 'Документы', 'book manual книга инструкция', BookOpen),
  icon('certificate', 'Сертификат', 'Документы', 'certificate диплом сертификат', Certificate),
  icon('note', 'Заметка', 'Документы', 'note memo заметка', Note),
  icon('newspaper', 'Материал', 'Документы', 'article news статья', Newspaper),
  icon('folder', 'Архив документов', 'Документы', 'folder files папка', FolderOpen),
  icon('leaf', 'Экология', 'Экология', 'leaf eco лист экология', Leaf),
  icon('recycle', 'Переработка', 'Экология', 'recycle waste переработка отходы', Recycle),
  icon('tree', 'Природа', 'Экология', 'tree forest дерево', Tree),
  icon('drop', 'Вода', 'Экология', 'drop water вода капля', Drop),
  icon('wind', 'Воздух', 'Экология', 'wind air воздух ветер', Wind),
  icon('cloud', 'Выбросы', 'Экология', 'cloud emissions выбросы', Cloud),
  icon('sun', 'Климат', 'Экология', 'sun climate солнце климат', Sun),
  icon('fish', 'Водная среда', 'Экология', 'fish aquatic рыба вода', Fish),
] as const;

export type IconId = (typeof COURSE_ICONS)[number]['id'];

const COURSE_ICON_BY_ID = new Map<string, (typeof COURSE_ICONS)[number]>(
  COURSE_ICONS.map((entry) => [entry.id, entry]),
);

const LEGACY_ALIASES: Readonly<Record<string, IconId>> = {
  factory: 'factory',
  shield: 'shield',
  fire: 'fire',
  'first-aid': 'first-aid',
};

export function isCourseIconId(value: unknown): value is IconId {
  return typeof value === 'string' && COURSE_ICON_BY_ID.has(value.trim().toLowerCase());
}

export function resolveCourseIcon(value: string | null | undefined) {
  const normalized = value?.trim().toLowerCase() ?? '';
  return (
    COURSE_ICON_BY_ID.get(normalized) ??
    COURSE_ICON_BY_ID.get(LEGACY_ALIASES[normalized] ?? 'shield-check')!
  );
}

export function searchCourseIcons(query: string, category: CourseIconCategory | 'Все') {
  const normalized = query.trim().toLocaleLowerCase('ru-RU');
  return COURSE_ICONS.filter(
    (entry) =>
      (category === 'Все' || entry.category === category) &&
      (!normalized ||
        `${entry.id} ${entry.label} ${entry.keywords}`
          .toLocaleLowerCase('ru-RU')
          .includes(normalized)),
  );
}
