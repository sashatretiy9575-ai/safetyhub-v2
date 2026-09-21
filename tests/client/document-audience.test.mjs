import assert from 'node:assert/strict';
import test from 'node:test';
import { protocolGroupsByAudience } from '../../lib/pdf/document-audience.ts';

const profile = (id, audience) => ({ id, audience, courseSlug: 'biot' });
const people = [
  { name: 'a', position: 'Инженер' },
  { name: 'b', position: 'Плотник' },
  { name: 'c', position: 'Мастер участка' },
];

test('engineers and workers are two protocols, as the training centre prints them', () => {
  const groups = protocolGroupsByAudience(people, [profile('biot-itr', 'itr'), profile('biot-worker', 'worker')]);
  assert.deepEqual(
    groups.map((group) => [group.profile.id, group.people.map((person) => person.name)]),
    [
      ['biot-itr', ['a', 'c']],
      ['biot-worker', ['b']],
    ],
  );
});

test('a category chosen for the whole company, or a programme with one, is one protocol', () => {
  const split = [profile('biot-itr', 'itr'), profile('biot-worker', 'worker')];
  assert.equal(protocolGroupsByAudience(people, split, 'biot-worker').length, 1);
  assert.equal(protocolGroupsByAudience(people, [profile('plotnik', 'all')])[0].people.length, 3);
  assert.equal(protocolGroupsByAudience(people, [])[0].profile, null);
});
