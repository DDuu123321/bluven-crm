import { beforeEach, describe, expect, it } from 'vitest';
import { ingestLeads, listPipelineOrders, systemCtx } from '../src';
import { as, lead, makeUser, resetDb, source, testDb, type TestUser } from './helpers';

const db = testDb();
let manager: TestUser;

beforeEach(async () => {
  await resetDb();
  manager = await makeUser(['MANAGER'], 'Morgan Manager');
  const sourceId = (await source('bluven-website')).id;
  await ingestLeads(
    systemCtx(db, 'Bluven website'),
    [
      lead({ externalId: 'a', firstName: 'Jane', lastName: 'Smith', phone: '0412 345 678', email: 'jane@example.com', address: '12 Sample St', suburb: 'Parramatta', postcode: '2150' }),
      lead({ externalId: 'b', firstName: 'Bob', lastName: 'Brown', phone: '(02) 9123 4567', email: 'bob@example.com', address: '345 George St', suburb: 'Sydney', postcode: '2000' }),
      lead({ externalId: 'c', firstName: 'Cara', lastName: 'Lee', phone: '0433 678 345', email: 'cara@example.com', address: '9 Kite Ave', suburb: 'Orange', postcode: '2800' }),
    ],
    { sourceId, requireExternalId: true },
  );
});

async function find(q: string): Promise<string[]> {
  const page = await listPipelineOrders(as(manager), { view: 'all', q });
  return page.rows.map((r) => r.customer.firstName).sort();
}

describe('searching orders', () => {
  it('finds a phone number however it is typed', async () => {
    // The way the screen shows it, the way people say it, and the way it is stored.
    for (const q of ['0412 345 678', '0412345678', '+61 412 345 678', '+61412345678', '412 345 678', '0412-345-678']) {
      expect(await find(q), q).toEqual(['Jane']);
    }
    for (const q of ['(02) 9123 4567', '02 9123 4567', '9123 4567', '91234567']) {
      expect(await find(q), q).toEqual(['Bob']);
    }
    // Part of a number is enough.
    expect(await find('0412 345')).toEqual(['Jane']);
  });

  it('still finds by name, address, postcode, email and order number, alone or combined', async () => {
    expect(await find('smith')).toEqual(['Jane']);
    expect(await find('Jane 0412')).toEqual(['Jane']);
    expect(await find('345 George')).toEqual(['Bob']);
    expect(await find('2150')).toEqual(['Jane']);
    expect(await find('cara@example.com')).toEqual(['Cara']);
    expect(await find('BLV-')).toEqual(['Bob', 'Cara', 'Jane']);
    expect(await find('12 Sample')).toEqual(['Jane']);
    expect(await find('nobody')).toEqual([]);
    // Every word has to match: Jane does not live in Sydney.
    expect(await find('Jane Sydney')).toEqual([]);
  });
});
