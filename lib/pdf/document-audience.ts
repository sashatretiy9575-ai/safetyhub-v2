import { documentAudienceForPosition } from './document-family-defaults.ts';
import type { DocumentProfile } from './document-profile.ts';

export type AudienceGroup<T> = { profile: DocumentProfile | null; people: T[] };

const AUDIENCE_LABEL = { itr: 'ИТР', worker: 'Рабочие', all: '' } as const;

/** «ИТР» or «Рабочие» for a file name; nothing for a programme with one category. */
export function audienceLabel(profile: Pick<DocumentProfile, 'audience'> | null | undefined) {
  return profile ? AUDIENCE_LABEL[profile.audience] : '';
}

/**
 * The protocols one company's people fill for one programme. БиОТ, промбез and
 * ПТМ are taught to engineers for 40 hours and to workers for 10, and the
 * training centre prints each category on a protocol of its own; the position a
 * person holds says which one, exactly as issuance decides it
 * (`private.document_audience_for_position`). A category the administrator
 * chose for the whole company overrides the split.
 */
export function protocolGroupsByAudience<T extends { position: string }>(
  people: readonly T[],
  courseProfiles: readonly DocumentProfile[],
  chosenProfileId?: string | null,
): AudienceGroup<T>[] {
  const chosen = chosenProfileId
    ? courseProfiles.find((profile) => profile.id === chosenProfileId)
    : undefined;
  const common = chosen ?? courseProfiles.find((profile) => profile.audience === 'all');
  if (common || !courseProfiles.length) return [{ profile: common ?? null, people: [...people] }];
  return (['itr', 'worker'] as const)
    .map((audience) => ({
      profile: courseProfiles.find((profile) => profile.audience === audience) ?? null,
      people: people.filter((person) => documentAudienceForPosition(person.position) === audience),
    }))
    .filter((group) => group.people.length > 0);
}
