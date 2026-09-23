/** Hairline icons (24×24, stroke = currentColor). */
const svg = (body: string) =>
  `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const ICONS = {
  mark: `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><circle cx="12" cy="12" r="3.6" fill="currentColor"/><ellipse cx="12" cy="12" rx="10.2" ry="3.4" transform="rotate(-22 12 12)" fill="none" stroke="currentColor" stroke-width="1"/></svg>`,
  menu: svg('<path d="M4 7h16M4 12h10M4 17h16"/>'),
  sliders: svg('<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>'),
  soundOn: svg('<path d="M4 10v4h3l5 4V6L7 10H4z"/><path d="M16 9.5a3.5 3.5 0 0 1 0 5M18.5 7a7 7 0 0 1 0 10"/>'),
  soundOff: svg('<path d="M4 10v4h3l5 4V6L7 10H4z"/><path d="M16.5 9.5l5 5M21.5 9.5l-5 5"/>'),
  expand: svg('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>'),
  collapse: svg('<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/>'),
  eye: svg('<path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="2.8"/>'),
  close: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
  info: svg('<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.01"/>'),
  play: svg('<path d="M8 5.5v13l10.5-6.5z"/>'),
  pause: svg('<path d="M8 5.5v13M16 5.5v13"/>'),
};
