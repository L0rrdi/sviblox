export const ANIMATED_ICON_PRESETS = [
  {
    id: 'chart-line',
    label: 'Chart line',
  },
  {
    id: 'youtube',
    label: 'YouTube',
  },
  {
    id: 'paint',
    label: 'Paint',
  },
  {
    id: 'twitch',
    label: 'Twitch',
  },
] as const;

export type AnimatedIconPresetId = typeof ANIMATED_ICON_PRESETS[number]['id'];

export function isAnimatedIconPresetId(value: string | undefined): value is AnimatedIconPresetId {
  return ANIMATED_ICON_PRESETS.some((preset) => preset.id === value);
}

export function animatedIconOptions(selected: string | undefined): string {
  return [
    '<option value="">None</option>',
    ...ANIMATED_ICON_PRESETS.map((preset) =>
      `<option value="${preset.id}" ${preset.id === selected ? 'selected' : ''}>${preset.label}</option>`
    ),
  ].join('');
}

export function animatedIconSvg(id: AnimatedIconPresetId): string {
  if (id === 'chart-line') {
    return `
      <svg class="bp-animated-nav-icon bp-animated-nav-icon-chart-line" data-bp-animated-icon="chart-line" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path stroke="none" d="M0 0h24v24H0z" fill="none"></path>
        <path class="bp-animated-chart-base" d="M4 19l16 0"></path>
        <path class="bp-animated-chart-line" d="M4 15l4 -6l4 2l4 -5l4 4" pathLength="1"></path>
      </svg>
    `;
  }
  if (id === 'youtube') {
    return `
      <svg class="bp-animated-nav-icon bp-animated-nav-icon-youtube" data-bp-animated-icon="youtube" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <rect class="bp-animated-youtube-frame" x="3" y="6" width="18" height="12" rx="3" stroke="currentColor" stroke-width="2"></rect>
        <path class="bp-animated-youtube-play" d="M10 9.5v5l4.5-2.5L10 9.5z" fill="currentColor"></path>
      </svg>
    `;
  }
  if (id === 'paint') {
    // Source: itshover.com paint-icon (paint roller + reveal stroke).
    // Original used Framer Motion; we replicate with hover-triggered CSS.
    return `
      <svg class="bp-animated-nav-icon bp-animated-nav-icon-paint" data-bp-animated-icon="paint" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path stroke="none" d="M0 0h24v24H0z" fill="none"></path>
        <rect class="bp-animated-paint-stroke" x="4" y="9" width="16" height="3" rx="1.5" fill="currentColor" stroke="none"></rect>
        <g class="bp-animated-paint-roller">
          <path d="M5 3m0 2a2 2 0 0 1 2 -2h10a2 2 0 0 1 2 2v2a2 2 0 0 1 -2 2h-10a2 2 0 0 1 -2 -2z"></path>
          <path d="M19 6h1a2 2 0 0 1 2 2a5 5 0 0 1 -5 5l-5 0v2"></path>
          <path d="M10 15m0 1a1 1 0 0 1 1 -1h2a1 1 0 0 1 1 1v4a1 1 0 0 1 -1 1h-2a1 1 0 0 1 -1 -1z"></path>
        </g>
      </svg>
    `;
  }
  if (id === 'twitch') {
    // Source: itshover.com brand-twitch-icon. Original uses Framer Motion for
    // random blinks + occasional glitch jitter; we replicate via CSS keyframes
    // looped on hover (fixed cadence, no randomness — close enough).
    return `
      <svg class="bp-animated-nav-icon bp-animated-nav-icon-twitch" data-bp-animated-icon="twitch" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path stroke="none" d="M0 0h24v24H0z" fill="none"></path>
        <path class="bp-animated-twitch-body" d="M21 2H3v16h5v4l4-4h5l4-4V2z"></path>
        <g class="bp-animated-twitch-eyes">
          <path d="M11 11V7"></path>
          <path d="M16 11V7"></path>
        </g>
      </svg>
    `;
  }
  return '';
}

export function createAnimatedIconElement(id: AnimatedIconPresetId): SVGSVGElement {
  const template = document.createElement('template');
  template.innerHTML = animatedIconSvg(id).trim();
  return template.content.firstElementChild as SVGSVGElement;
}
