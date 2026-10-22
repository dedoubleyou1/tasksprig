import type { Task } from '../../shared/types';

/** category is retained in storage only so older generated snippets keep working. */
export function tasksForModel(tasks: Task[]): Omit<Task, 'category'>[] {
  return tasks.map(({ category: _legacyCategory, ...task }) => task);
}
