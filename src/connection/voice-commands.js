'use strict';

const BUILTIN_VOICE_COMMANDS = {
  'scratch that':      { action: 'scratch' },
  'new line':          { action: 'key',  key: 'Return' },
  'new paragraph':     { action: 'key',  key: 'Return Return' },
  'period':            { action: 'type', text: '.' },
  'full stop':         { action: 'type', text: '.' },
  'comma':             { action: 'type', text: ',' },
  'question mark':     { action: 'type', text: '?' },
  'exclamation mark':  { action: 'type', text: '!' },
  'exclamation point': { action: 'type', text: '!' },
  'open bracket':      { action: 'type', text: '(' },
  'close bracket':     { action: 'type', text: ')' },
  'colon':             { action: 'type', text: ':' },
  'semicolon':         { action: 'type', text: ';' },
  'dash':              { action: 'type', text: ' - ' },
  'open quote':        { action: 'type', text: '"' },
  'close quote':       { action: 'type', text: '"' },
};

function getVoiceCommands(config) {
  return { ...BUILTIN_VOICE_COMMANDS, ...(config.voiceCommandsExtra || {}) };
}

module.exports = { BUILTIN_VOICE_COMMANDS, getVoiceCommands };
