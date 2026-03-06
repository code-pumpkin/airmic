'use strict';

// ─── Built-in themes ─────────────────────────────────────────────────────────

const BUILT_IN_THEMES = {
  opencode: {
    bg: '#0a0a0a', bgPanel: '#141414', bgElement: '#1e1e1e',
    primary: '#e8a838', text: '#eeeeee', textMuted: '#808080', textDim: '#555555',
    border: '#333333', green: '#7fd88f', red: '#e06c75', purple: '#9d7cd8',
    blue: '#5c9cf5', yellow: '#e5c07b', cyan: '#56b6c2',
  },
  catppuccin: {
    bg: '#1e1e2e', bgPanel: '#181825', bgElement: '#313244',
    primary: '#f5c2e7', text: '#cdd6f4', textMuted: '#6c7086', textDim: '#45475a',
    border: '#45475a', green: '#a6e3a1', red: '#f38ba8', purple: '#cba6f7',
    blue: '#89b4fa', yellow: '#f9e2af', cyan: '#94e2d5',
  },
  nord: {
    bg: '#2e3440', bgPanel: '#3b4252', bgElement: '#434c5e',
    primary: '#88c0d0', text: '#d8dee9', textMuted: '#4c566a', textDim: '#434c5e',
    border: '#4c566a', green: '#a3be8c', red: '#bf616a', purple: '#b48ead',
    blue: '#5e81ac', yellow: '#ebcb8b', cyan: '#8fbcbb',
  },
  tokyonight: {
    bg: '#1a1b26', bgPanel: '#16161e', bgElement: '#292e42',
    primary: '#7aa2f7', text: '#c0caf5', textMuted: '#565f89', textDim: '#3b4261',
    border: '#3b4261', green: '#9ece6a', red: '#f7768e', purple: '#bb9af7',
    blue: '#7aa2f7', yellow: '#e0af68', cyan: '#7dcfff',
  },
  gruvbox: {
    bg: '#282828', bgPanel: '#1d2021', bgElement: '#3c3836',
    primary: '#fe8019', text: '#ebdbb2', textMuted: '#665c54', textDim: '#504945',
    border: '#504945', green: '#b8bb26', red: '#fb4934', purple: '#d3869b',
    blue: '#83a598', yellow: '#fabd2f', cyan: '#8ec07c',
  },
};

/** Create a mutable theme token object, optionally loading saved theme. */
function createTheme(savedThemeName) {
  const T = { ...BUILT_IN_THEMES.opencode };
  if (savedThemeName && BUILT_IN_THEMES[savedThemeName]) {
    Object.assign(T, BUILT_IN_THEMES[savedThemeName]);
  }
  return T;
}

module.exports = { BUILT_IN_THEMES, createTheme };
