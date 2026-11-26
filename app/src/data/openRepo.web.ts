import { MemoryRepo } from './memoryRepo';
import type { Repo } from './repo';

/** Web preview: in-memory (refreshing the page starts over). */
export async function openRepo(): Promise<Repo> {
  return new MemoryRepo();
}
