import * as SQLite from 'expo-sqlite';
import { SqliteRepo, type Repo } from './repo';

/** Android/iOS: durable on-device SQLite database. */
export async function openRepo(): Promise<Repo> {
  return SqliteRepo.open(await SQLite.openDatabaseAsync('dukaan.db'));
}
