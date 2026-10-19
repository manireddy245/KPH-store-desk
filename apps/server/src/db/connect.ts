import postgres from 'postgres';

export type Sql = postgres.Sql<{}>;
export type Tx = postgres.TransactionSql<{}>;
export type Q = Sql | Tx;

/**
 * Connection with our type rules:
 *  - bigint (paise, milli) and numeric (sums) come back as JS numbers — every value we
 *    store is far below 2^53, and sums of integers stay integers.
 *  - date columns come back as "YYYY-MM-DD" strings, never shifted by timezone.
 */
export function connect(url: string, opts: { max?: number } = {}): Sql {
  return postgres(url, {
    max: opts.max ?? 10,
    onnotice: () => {},
    connection: { TimeZone: 'Asia/Kolkata', application_name: 'kph-store-desk' },
    types: {
      bigint: {
        to: 20,
        from: [20, 1700],
        serialize: (x: number | bigint | string) => String(x),
        parse: (x: string) => {
          const n = Number(x);
          if (!Number.isSafeInteger(n)) throw new Error(`Number out of safe range: ${x}`);
          return n;
        },
      },
      dateOnly: {
        to: 1082,
        from: [1082],
        serialize: (x: string) => x,
        parse: (x: string) => x,
      },
    },
  }) as unknown as Sql;
}
