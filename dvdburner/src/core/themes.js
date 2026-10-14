'use strict';

/**
 * Menu themes.
 *
 * These are deliberately restrained. A DVD menu is a piece of printed
 * typography: a background, a title, a stack of labels, one accent colour.
 * Every theme here is built from a single material idea (charcoal, newsprint,
 * darkroom, blueprint) rather than a decorative gradient, and each keeps its
 * text at a contrast ratio that survives being viewed on a television from
 * across a room.
 */

const THEMES = {
  none: {
    id: 'none',
    label: 'None',
    blurb: 'Plain black. Nothing behind your words at all.',
    background: '#000000',
    accent: '#d9a353',
    text: '#f2ece2',
    muted: '#8d8579',
    rule: '#2b2b2b',
    panel: '#151515',
    panelOutline: '#343434',
    // "None" means nothing, so this one gets no vignette and no glow. The
    // decoration every other theme carries is exactly what is being turned off.
    plain: true,
  },
  charcoal: {
    id: 'charcoal',
    label: 'Charcoal',
    blurb: 'Dark, quiet, works with anything.',
    background: '#1c1b19',
    accent: '#d9a353',
    text: '#f2ece2',
    muted: '#8d8579',
    rule: '#3a3733',
    // `panel` is the fill behind each button label.
    panel: '#26241f',
    panelOutline: '#3d3931',
  },
  newsprint: {
    id: 'newsprint',
    label: 'Newsprint',
    blurb: 'Warm paper and black ink.',
    background: '#e8e2d4',
    accent: '#8c3b2e',
    text: '#22201c',
    muted: '#6d675c',
    rule: '#c6bfae',
    panel: '#f2ede1',
    panelOutline: '#cfc7b5',
  },
  darkroom: {
    id: 'darkroom',
    label: 'Darkroom',
    blurb: 'Amber on near-black, easy on old eyes.',
    background: '#141311',
    accent: '#e0a34a',
    text: '#f5efe4',
    muted: '#877e70',
    rule: '#312d27',
    panel: '#1f1d19',
    panelOutline: '#38332b',
  },
  blueprint: {
    id: 'blueprint',
    label: 'Blueprint',
    blurb: 'Cool, technical, high contrast.',
    background: '#12233a',
    accent: '#78b6e8',
    text: '#eaf2fb',
    muted: '#7d94ad',
    rule: '#26405f',
    panel: '#182e4a',
    panelOutline: '#2d4c72',
  },
  cedar: {
    id: 'cedar',
    label: 'Cedar',
    blurb: 'Deep green and brass.',
    background: '#16231d',
    accent: '#c8a45c',
    text: '#eef1ea',
    muted: '#87968a',
    rule: '#27392f',
    panel: '#1d2d25',
    panelOutline: '#2f463a',
  },
  plum: {
    id: 'plum',
    label: 'Plum',
    blurb: 'Muted wine, soft cream text.',
    background: '#241a24',
    accent: '#c98a9a',
    text: '#f4ecf0',
    muted: '#94808c',
    rule: '#3a2b39',
    panel: '#2e2230',
    panelOutline: '#453348',
  },
  slate: {
    id: 'slate',
    label: 'Slate',
    blurb: 'Neutral grey, almost invisible.',
    background: '#e6e7e6',
    accent: '#4a5b6b',
    text: '#1e2124',
    muted: '#6c7276',
    rule: '#cdcfcf',
    panel: '#f2f3f2',
    panelOutline: '#d3d6d6',
  },
  projection: {
    id: 'projection',
    label: 'Projection',
    blurb: 'Black with a warm lamp glow.',
    background: '#0f1012',
    accent: '#f0c574',
    text: '#f6f3ee',
    muted: '#7c7d80',
    rule: '#2a2c30',
    panel: '#191b1f',
    panelOutline: '#32353a',
  },
};

const DEFAULT_THEME_ID = 'charcoal';

module.exports = { THEMES, DEFAULT_THEME_ID };
