import { getSettings } from '@/storage/settingsStore';
import * as friendStatsRestore from './home/friendStatsRestore';
import * as layoutRearranger from './home/layoutRearranger';
import * as mostPlayedWidget from './home/mostPlayedWidget';

function isHomePage(): boolean {
  const p = location.pathname;
  return p === '/' || p === '/home' || p.startsWith('/home');
}

export async function run(): Promise<void> {
  if (!isHomePage()) {
    mostPlayedWidget.cleanup();
    return;
  }

  const settings = await getSettings();

  // Layout rearrangement runs on every dispatch (idempotent). This is
  // separate from the most-played widget so it self-heals when Roblox
  // re-renders sections.
  void layoutRearranger.run(settings);

  // Friend-tile stats restoration is a bug fix, not a feature; always on.
  void friendStatsRestore.run();

  void mostPlayedWidget.run(settings);
}
