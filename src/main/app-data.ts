import { app } from 'electron';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

/** Keep existing prototype workspaces usable after the TaskSprig rename. */
export function configureAppData() {
  app.setName('TaskSprig');
  const override = process.env.TASKSPRIG_DATA_DIR || process.env.TEND_DATA_DIR;
  const preferred = path.join(app.getPath('appData'), 'TaskSprig');
  const legacy = path.join(app.getPath('appData'), 'Tend');
  const hasLegacyData = existsSync(path.join(legacy, 'tend.sqlite')) || existsSync(path.join(legacy, 'settings.json'));
  const directory = override ? path.resolve(override)
    : !existsSync(preferred) && hasLegacyData ? legacy : preferred;
  mkdirSync(directory, { recursive: true });
  app.setPath('userData', directory);
}
