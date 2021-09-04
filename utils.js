const core = require('@actions/core');
const style = require('ansi-styles');

exports.saveStates = function(states) {
  core.startGroup('Saving state...');

  for (const state in states) {
    core.saveState(state, states[state]);
    core.info(`Saved value ${states[state]} for state ${state}.`);
  }

  core.saveState('keys', JSON.stringify(Object.keys(states)));
  core.endGroup();
}

exports.restoreStates = function(states) {
  core.startGroup('Restoring state...');

  const saved = core.getState('keys');

  if (saved) {
    const keys = JSON.parse(saved);
    core.info(`Loaded keys: ${keys}`);

    for (const key of keys) {
      states[key] = core.getState(key);
      core.info(`Restored value ${states[key]} for state ${key}.`);
    }
  }
  else {
    core.info('No saved state.');
  }

  core.endGroup();
  return states;
}

function styleText(color, bgColor, label, text) {
  core.info(`${style[bgColor].open}${style.black.open}${style.bold.open}${label}:${style.bold.close}${style.black.close}${style[bgColor].close} ${style[color].open}${text}${style[color].close}`);
}

exports.showError = function(text) {
  styleText('red', 'bgRed', 'Error', text);
}

exports.showSuccess = function(text) {
  styleText('green', 'bgGreen', 'Success', text);
}

exports.showWarning = function(text) {
  styleText('yellow', 'bgYellow', 'Warning', text);
}
