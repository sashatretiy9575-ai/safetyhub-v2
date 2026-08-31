export const ADMIN_CAPABILITIES = [
  'content.manage',
  'test.manage',
  'support.view',
  'user.read',
  'user.invite',
  'user.suspend',
  'user.delete',
  'role.manage',
  'identity.read',
  'identity.manage',
  'certificate.read',
  'certificate.issue',
  'certificate.revoke',
  'results.read',
  'results.delete',
  'results.export',
  'site.settings.manage',
  'audit.read',
  'capability.manage',
] as const;

export type AdminCapability = (typeof ADMIN_CAPABILITIES)[number];

export const DEFAULT_ADMIN_CAPABILITIES: readonly AdminCapability[] = [
  'content.manage',
  'test.manage',
  'user.read',
  'identity.read',
  'identity.manage',
  'certificate.read',
  'certificate.issue',
  'certificate.revoke',
  'results.read',
  'results.delete',
  'results.export',
  'site.settings.manage',
];

export const SUPERADMIN_ONLY_CAPABILITIES: readonly AdminCapability[] = [
  'user.delete',
  'role.manage',
  'capability.manage',
];

export const CAPABILITY_LABELS: Record<AdminCapability, string> = {
  'content.manage': 'Статьи: редактирование и публикация',
  'test.manage': 'Тесты: редактирование и публикация',
  'support.view': 'Поддержка: просмотр обращений',
  'user.read': 'Пользователи: PII и список аккаунтов',
  'user.invite': 'Пользователи: приглашение',
  'user.suspend': 'Пользователи: блокировка и восстановление',
  'user.delete': 'Пользователи: безвозвратное удаление',
  'role.manage': 'Доступ: управление крупными ролями',
  'identity.read': 'Личность: просмотр проверенных данных',
  'identity.manage': 'Личность: проверка и отзыв',
  'certificate.read': 'Сертификаты: просмотр и PDF',
  'certificate.issue': 'Сертификаты: выдача и перевыпуск',
  'certificate.revoke': 'Сертификаты: отзыв',
  'results.read': 'Результаты: просмотр аттестаций',
  'results.delete': 'Результаты: удаление учебной истории',
  'results.export': 'Результаты: экспорт отчётов и ZIP',
  'site.settings.manage': 'Сайт: телефон и WhatsApp',
  'audit.read': 'Аудит: просмотр журнала',
  'capability.manage': 'Доступ: назначение полномочий',
};

export function hasAdminCapability(capabilities: readonly string[], capability: AdminCapability) {
  return capabilities.includes(capability);
}
