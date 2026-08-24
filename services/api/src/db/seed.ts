import { pathToFileURL } from 'node:url';

import pg from 'pg';

/**
 * Development seed data.
 *
 * `pnpm seed` has pointed at this file since the scripts were written; the file
 * did not exist, so the command failed for anyone following the setup steps
 * (D-19).
 *
 * ## What is and is not in here
 *
 * Enough to open the admin panel and drive a ride through by hand: an admin, a
 * rider, and two drivers with vehicles. The fare configuration is already
 * there - migration 0001 inserts it. Driver POSITIONS are not seeded: they
 * live in Redis (§3.1) and arrive when a driver goes online.
 *
 * Every phone number is inside the `+96477000000xx` block that the test suite
 * already uses. CLAUDE.md §12.6 forbids committing a real number, and a seed
 * file is exactly where one would otherwise end up — someone's own mobile,
 * committed once and then receiving OTP messages from a staging server for
 * years.
 *
 * Idempotent: re-running changes nothing. It is also refused outright in
 * production. Seed data in a production database is not a tidiness problem —
 * a seeded driver is dispatchable, and a rider would be sent to one.
 */

interface SeedCounts {
  users: number;
  drivers: number;
}

const ADMIN = {
  id: '00000000-0000-4000-8000-0000000000a1',
  phone: '+9647700000010',
  name: 'مدير النظام',
};

const RIDER = {
  id: '00000000-0000-4000-8000-0000000000b1',
  phone: '+9647700000011',
  name: 'راكب تجريبي',
};

const DRIVERS = [
  {
    id: '00000000-0000-4000-8000-0000000000c1',
    phone: '+9647700000012',
    name: 'سائق تجريبي أ',
    plate: '12345',
    model: 'Toyota Corolla',
    colour: 'أبيض',
  },
  {
    id: '00000000-0000-4000-8000-0000000000c2',
    phone: '+9647700000013',
    name: 'سائق تجريبي ب',
    plate: '67890',
    model: 'Kia Rio',
    colour: 'أسود',
  },
];

export async function seed(connectionString: string): Promise<SeedCounts> {
  const pool = new pg.Pool({ connectionString, max: 1 });
  const counts: SeedCounts = { users: 0, drivers: 0 };

  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // ON CONFLICT DO NOTHING on the id, so a second run is a no-op rather
      // than a duplicate-phone failure.
      const insertUser = async (
        id: string,
        role: string,
        phone: string,
        name: string,
      ): Promise<void> => {
        const result = await client.query(
          `INSERT INTO users (id, role, phone_e164, display_name)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (id) DO NOTHING`,
          [id, role, phone, name],
        );
        counts.users += result.rowCount ?? 0;
      };

      await insertUser(ADMIN.id, 'ADMIN', ADMIN.phone, ADMIN.name);
      await insertUser(RIDER.id, 'RIDER', RIDER.phone, RIDER.name);
      await client.query(
        `INSERT INTO riders (user_id) VALUES ($1) ON CONFLICT DO NOTHING`,
        [RIDER.id],
      );

      for (const driver of DRIVERS) {
        await insertUser(driver.id, 'DRIVER', driver.phone, driver.name);
        const result = await client.query(
          `INSERT INTO drivers (user_id, vehicle_plate, vehicle_model, vehicle_color)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (user_id) DO NOTHING`,
          [driver.id, driver.plate, driver.model, driver.colour],
        );
        counts.drivers += result.rowCount ?? 0;
      }

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }

  return counts;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  // Refused rather than warned about. A seeded driver is a dispatchable
  // driver, and a real rider would be matched to one.
  if (process.env['NODE_ENV'] === 'production') {
    process.stderr.write('Refusing to seed a production database.\n');
    process.exit(1);
  }

  const connectionString =
    process.env['DATABASE_MIGRATION_URL'] ?? process.env['DATABASE_URL'];

  if (!connectionString) {
    process.stderr.write('DATABASE_MIGRATION_URL (or DATABASE_URL) must be set.\n');
    process.exit(1);
  }

  seed(connectionString)
    .then((counts) => {
      process.stdout.write(
        `Seeded: ${counts.users} user(s), ${counts.drivers} driver profile(s). ` +
          'Re-running is a no-op.\n',
      );
    })
    .catch((error: unknown) => {
      process.stderr.write(`Seed failed: ${String(error)}\n`);
      process.exit(1);
    });
}
