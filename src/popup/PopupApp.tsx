import { useEffect, useState } from 'react';
import { getSettings, setSettings } from '@/storage/settingsStore';
import { Settings } from '@/types';

type BooleanSettingKey = {
  [K in keyof Settings]: Settings[K] extends boolean ? K : never;
}[keyof Settings];

type StringSettingKey = {
  [K in keyof Settings]: Settings[K] extends string ? K : never;
}[keyof Settings];

interface SelectControl {
  type: 'select';
  key: StringSettingKey;
  label: string;
  options: { value: string; label: string }[];
}

interface FeatureRow {
  key: BooleanSettingKey;
  label: string;
  summary: string;
  controls?: SelectControl[];
}

const FEATURES: FeatureRow[] = [
  {
    key: 'showMostPlayedWidget',
    label: 'Most played experiences on homepage',
    summary: 'Shows your local playtime ranking widget near the Home header.',
  },
  {
    key: 'showHomeFavorites',
    label: 'Favorites carousel on homepage',
    summary: 'Adds the SviBlox Favorites carousel with likes, active players, arrows, and See all.',
  },
  {
    key: 'showHomeMyGames',
    label: 'My Games carousel on homepage',
    summary: 'Adds your public creations as a Roblox-style carousel on Home.',
  },
  {
    key: 'collapseDiscoverSections',
    label: 'Standout and recommended dropdown',
    summary: 'Groups Roblox discovery sections under one collapsible control.',
  },
  {
    key: 'showFriendTileStats',
    label: 'Restore stats on friend tiles',
    summary:
      'When a friend is in an experience on a Roblox carousel tile, also show the like % and player count beside the friend avatar.',
  },
  {
    key: 'showGameBadges',
    label: 'Experience badge replacement',
    summary: 'Replaces game badge lists with ownership, rarity, and sorting controls.',
  },
  {
    key: 'showGameStoreDevProducts',
    label: 'Dev products on Store tab',
    summary: 'Shows public developer products below Passes on game Store tabs.',
  },
  {
    key: 'showGameSubplaces',
    label: 'Subplaces on Servers tab',
    summary:
      'Adds a collapsible Subplaces section above Your private servers, listing other places in the experience with thumbnails and a Play button.',
  },
  {
    key: 'showTotalSpent',
    label: 'Total spent on this experience',
    summary:
      'Reads your purchase history (gamepasses, dev products, private servers) and totals the Robux you have spent on the current experience. First load on a session pulls your transaction history, then caches.',
  },
  {
    key: 'showRobuxCash',
    label: 'Robux to currency converter',
    summary:
      'Shows a real-money estimate beside every Robux price (gamepasses, dev products, store cards). Pick currency and which Roblox rate to use.',
    controls: [
      {
        type: 'select',
        key: 'robuxCashCurrency',
        label: 'Currency',
        options: [
          { value: 'USD', label: 'US Dollar (USD)' },
          { value: 'GBP', label: 'British Pound (GBP)' },
          { value: 'NOK', label: 'Norwegian Krone (NOK)' },
        ],
      },
      {
        type: 'select',
        key: 'robuxCashRate',
        label: 'Rate',
        options: [
          { value: 'regular', label: 'Regular (purchase)' },
          { value: 'devex', label: 'DevEx (cash-out)' },
          { value: 'robloxPlus', label: 'Roblox+ (Premium, -20% on passes/products)' },
        ],
      },
    ],
  },
  {
    key: 'enablePlaytimeTracking',
    label: 'Experience playtime tracking',
    summary: 'Tracks in-game presence every minute while the browser is open.',
  },
];

export function PopupApp() {
  const [settings, setLocal] = useState<Settings | null>(null);
  const [activeInfo, setActiveInfo] = useState<string | null>(null);

  useEffect(() => {
    void getSettings().then(setLocal);
  }, []);

  if (!settings) {
    return (
      <div className="sv-popup sv-popup-loading">
        <style>{popupCss}</style>
        Loading...
      </div>
    );
  }

  const toggle = async (key: BooleanSettingKey) => {
    const next = await setSettings({ [key]: !settings[key] } as Partial<Settings>);
    setLocal(next);
  };

  const setSelect = async (key: StringSettingKey, value: string) => {
    const next = await setSettings({ [key]: value } as Partial<Settings>);
    setLocal(next);
  };

  const openOptions = () => chrome.runtime.openOptionsPage();

  return (
    <div className="sv-popup">
      <style>{popupCss}</style>
      <section className="sv-panel">
        <div className="sv-title-row">
          <h1>General Features</h1>
          <button className="sv-options" type="button" onClick={openOptions}>
            Options
          </button>
        </div>

        <div className="sv-feature-list">
          {FEATURES.map((feature) => (
            <div className="sv-feature-block" key={feature.key}>
              <div className="sv-feature-row">
                <div className="sv-feature-label">
                  <span>{feature.label}</span>
                  <button
                    className="sv-info"
                    type="button"
                    aria-label={`About ${feature.label}`}
                    aria-expanded={activeInfo === feature.key}
                    title={feature.summary}
                    onClick={() =>
                      setActiveInfo(activeInfo === feature.key ? null : feature.key)
                    }
                  >
                    !
                  </button>
                </div>
                <button
                  className={`sv-switch ${settings[feature.key] ? 'sv-switch-on' : ''}`}
                  type="button"
                  role="switch"
                  aria-checked={settings[feature.key]}
                  onClick={() => void toggle(feature.key)}
                >
                  <span />
                </button>
              </div>
              {activeInfo === feature.key && (
                <div className="sv-feature-summary">{feature.summary}</div>
              )}
              {settings[feature.key] && feature.controls && (
                <div className="sv-feature-controls">
                  {feature.controls.map((control) => (
                    <label className="sv-control-row" key={control.key}>
                      <span className="sv-control-label">{control.label}</span>
                      <select
                        className="sv-select"
                        value={settings[control.key] as string}
                        onChange={(e) => void setSelect(control.key, e.target.value)}
                      >
                        {control.options.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

const popupCss = `
  :root {
    color-scheme: dark;
  }
  body {
    background: #30363b;
  }
  .sv-popup {
    width: 520px;
    min-height: 480px;
    box-sizing: border-box;
    padding: 0;
    background: #343a40;
    color: #fff;
    font-family: Arial, Helvetica, sans-serif;
    font-size: 15px;
  }
  .sv-popup-loading {
    padding: 18px;
  }
  .sv-panel {
    min-height: 100%;
    box-sizing: border-box;
    padding: 30px 38px 28px;
    border: 1px solid rgba(0,0,0,0.2);
    box-shadow: inset 0 1px 0 rgba(255,255,255,0.03);
  }
  .sv-title-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 4px;
  }
  .sv-title-row h1 {
    margin: 0;
    font-size: 18px;
    font-weight: 700;
    line-height: 1.25;
    border-bottom: 2px solid #fff;
    padding-bottom: 3px;
    letter-spacing: 0;
  }
  .sv-options {
    border: 0;
    border-radius: 4px;
    background: #258edf;
    color: #fff;
    cursor: pointer;
    font: inherit;
    font-size: 12px;
    font-weight: 700;
    padding: 7px 10px;
  }
  .sv-options:hover {
    background: #35a1f2;
  }
  .sv-feature-list {
    margin-top: 12px;
  }
  .sv-feature-block {
    margin: 0;
  }
  .sv-feature-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    min-height: 40px;
    gap: 18px;
  }
  .sv-feature-label {
    display: flex;
    align-items: center;
    gap: 7px;
    min-width: 0;
    line-height: 1.25;
    text-shadow: 0 1px 1px rgba(0,0,0,0.55);
  }
  .sv-info {
    width: 15px;
    height: 15px;
    border-radius: 50%;
    border: 2px solid rgba(255,255,255,0.85);
    background: transparent;
    color: #fff;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 10px;
    font-weight: 800;
    line-height: 1;
    padding: 0;
    flex: 0 0 auto;
  }
  .sv-info:hover,
  .sv-info[aria-expanded="true"] {
    border-color: #fff;
    background: rgba(255,255,255,0.12);
  }
  .sv-switch {
    width: 50px;
    height: 21px;
    border: 0;
    border-radius: 999px;
    background: #58616a;
    cursor: pointer;
    padding: 0;
    position: relative;
    flex: 0 0 auto;
    transition: background 0.12s ease;
  }
  .sv-switch span {
    width: 21px;
    height: 21px;
    border-radius: 50%;
    background: #f5f5f5;
    box-shadow: 0 1px 3px rgba(0,0,0,0.35);
    position: absolute;
    top: 0;
    left: 0;
    transition: transform 0.12s ease;
  }
  .sv-switch-on {
    background: #1f9be6;
  }
  .sv-switch-on span {
    transform: translateX(29px);
  }
  .sv-feature-summary {
    margin: -2px 62px 8px 0;
    padding: 8px 10px;
    border-left: 2px solid rgba(31,155,230,0.9);
    background: rgba(0,0,0,0.18);
    color: rgba(255,255,255,0.78);
    font-size: 12px;
    line-height: 1.35;
  }
  .sv-feature-controls {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin: 4px 62px 10px 0;
    padding: 8px 10px;
    border-left: 2px solid rgba(31,155,230,0.4);
    background: rgba(0,0,0,0.12);
  }
  .sv-control-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    font-size: 12px;
  }
  .sv-control-label {
    color: rgba(255,255,255,0.78);
  }
  .sv-select {
    appearance: none;
    background: #2a2f33;
    color: #fff;
    border: 1px solid rgba(255,255,255,0.2);
    border-radius: 4px;
    font: inherit;
    font-size: 12px;
    padding: 4px 8px;
    min-width: 170px;
    cursor: pointer;
  }
  .sv-select:focus {
    outline: 1px solid #1f9be6;
  }
`;
