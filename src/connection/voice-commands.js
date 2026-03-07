'use strict';

const BUILTIN_VOICE_COMMANDS = {
  // ── Undo / Redo ──
  'scratch that':      { action: 'scratch' },
  'undo':              { action: 'key',  key: 'ctrl+z' },
  'undo that':         { action: 'key',  key: 'ctrl+z' },
  'redo':              { action: 'key',  key: 'ctrl+y' },
  'redo that':         { action: 'key',  key: 'ctrl+y' },

  // ── Navigation ──
  'new line':          { action: 'key',  key: 'Return' },
  'new paragraph':     { action: 'key',  key: 'Return Return' },
  'tab':               { action: 'key',  key: 'Tab' },
  'tab key':           { action: 'key',  key: 'Tab' },
  'go up':             { action: 'key',  key: 'Up' },
  'go down':           { action: 'key',  key: 'Down' },
  'go left':           { action: 'key',  key: 'Left' },
  'go right':          { action: 'key',  key: 'Right' },
  'go home':           { action: 'key',  key: 'Home' },
  'go end':            { action: 'key',  key: 'End' },
  'page up':           { action: 'key',  key: 'Page_Up' },
  'page down':         { action: 'key',  key: 'Page_Down' },

  // ── Editing ──
  'select all':        { action: 'key',  key: 'ctrl+a' },
  'copy':              { action: 'key',  key: 'ctrl+c' },
  'copy that':         { action: 'key',  key: 'ctrl+c' },
  'paste':             { action: 'key',  key: 'ctrl+v' },
  'paste that':        { action: 'key',  key: 'ctrl+v' },
  'cut':               { action: 'key',  key: 'ctrl+x' },
  'cut that':          { action: 'key',  key: 'ctrl+x' },
  'delete':            { action: 'key',  key: 'Delete' },
  'delete that':       { action: 'key',  key: 'Delete' },
  'backspace':         { action: 'key',  key: 'BackSpace' },
  'escape':            { action: 'key',  key: 'Escape' },
  'enter':             { action: 'key',  key: 'Return' },
  'space':             { action: 'type', text: ' ' },
  'spacebar':          { action: 'type', text: ' ' },

  // ── Punctuation ──
  'period':            { action: 'type', text: '.' },
  'full stop':         { action: 'type', text: '.' },
  'dot':               { action: 'type', text: '.' },
  'comma':             { action: 'type', text: ',' },
  'question mark':     { action: 'type', text: '?' },
  'exclamation mark':  { action: 'type', text: '!' },
  'exclamation point': { action: 'type', text: '!' },
  'colon':             { action: 'type', text: ':' },
  'semicolon':         { action: 'type', text: ';' },
  'dash':              { action: 'type', text: ' - ' },
  'hyphen':            { action: 'type', text: '-' },
  'underscore':        { action: 'type', text: '_' },
  'ellipsis':          { action: 'type', text: '...' },
  'ampersand':         { action: 'type', text: '&' },
  'at sign':           { action: 'type', text: '@' },
  'hash':              { action: 'type', text: '#' },
  'hashtag':           { action: 'type', text: '#' },
  'dollar sign':       { action: 'type', text: '$' },
  'percent':           { action: 'type', text: '%' },
  'asterisk':          { action: 'type', text: '*' },
  'plus sign':         { action: 'type', text: '+' },
  'equals sign':       { action: 'type', text: '=' },
  'forward slash':     { action: 'type', text: '/' },
  'backslash':         { action: 'type', text: '\\' },
  'pipe':              { action: 'type', text: '|' },
  'tilde':             { action: 'type', text: '~' },

  // ── Brackets / Quotes ──
  'open bracket':      { action: 'type', text: '(' },
  'close bracket':     { action: 'type', text: ')' },
  'open paren':        { action: 'type', text: '(' },
  'close paren':       { action: 'type', text: ')' },
  'open square bracket':  { action: 'type', text: '[' },
  'close square bracket': { action: 'type', text: ']' },
  'open curly':        { action: 'type', text: '{' },
  'close curly':       { action: 'type', text: '}' },
  'open angle':        { action: 'type', text: '<' },
  'close angle':       { action: 'type', text: '>' },
  'open quote':        { action: 'type', text: '"' },
  'close quote':       { action: 'type', text: '"' },
  'single quote':      { action: 'type', text: "'" },
  'backtick':          { action: 'type', text: '`' },
};

function getVoiceCommands(config) {
  return { ...BUILTIN_VOICE_COMMANDS, ...(config.voiceCommandsExtra || {}) };
}

module.exports = { BUILTIN_VOICE_COMMANDS, getVoiceCommands };
