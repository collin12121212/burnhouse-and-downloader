'use strict';

/**
 * Which button the remote moves to when an arrow key is pressed.
 *
 * This exists because the alternative is unknowable. If the navigation is left
 * out of the spumux file, spumux invents it with an undocumented "reasonably
 * intelligent algorithm" — so what the disc actually does cannot be predicted
 * from here, and the simulator built into Burnhouse would be guessing. A
 * simulator that guesses is worse than no simulator: it would show her one
 * thing and the television would do another.
 *
 * So the mapping is computed once, in this file, and then used twice:
 *
 *   1. written into the spumux file as explicit up/down/left/right button
 *      names, which is where the disc gets its behaviour from; and
 *   2. read by the simulator to move its highlight.
 *
 * Both readers consume the same table, so they cannot drift apart.
 *
 * The rule itself is the one a person expects from a menu: pressing a direction
 * moves to the nearest button that actually lies that way, preferring one
 * straight ahead over one off to the side.
 */

/** The four directions, with how to measure "along" and "across" each. */
const DIRECTIONS = {
  left: { along: (dx) => -dx, across: (dx, dy) => Math.abs(dy) },
  right: { along: (dx) => dx, across: (dx, dy) => Math.abs(dy) },
  up: { along: (dx, dy) => -dy, across: (dx) => Math.abs(dx) },
  down: { along: (dx, dy) => dy, across: (dx) => Math.abs(dx) },
};

const DIRECTION_NAMES = ['up', 'down', 'left', 'right'];

function centreOf(button) {
  return {
    x: (Number(button.x0) + Number(button.x1)) / 2,
    y: (Number(button.y0) + Number(button.y1)) / 2,
  };
}

/**
 * The button to move to, or null when there is nothing that way.
 *
 * Distance is measured between button centres. A candidate has to be genuinely
 * in the requested direction (`along > 0`), otherwise pressing Right on the
 * bottom-right button would jump backwards to something behind it. The
 * off-axis distance is weighted, which is what makes a button in the same row
 * win over one further down the other column.
 */
function bestInDirection(buttons, from, direction) {
  const rule = DIRECTIONS[direction];
  if (!rule) return null;

  const origin = centreOf(from);
  let best = null;
  let bestScore = Infinity;

  for (const candidate of buttons) {
    if (candidate === from) continue;
    const target = centreOf(candidate);
    const dx = target.x - origin.x;
    const dy = target.y - origin.y;

    const along = rule.along(dx, dy);
    if (!(along > 0)) continue;

    const score = along + rule.across(dx, dy) * 2;
    if (score < bestScore) {
      bestScore = score;
      best = candidate;
    }
  }

  return best;
}

/**
 * The full navigation table for one menu page.
 *
 * Returns a Map of button name to `{ up, down, left, right }`, where each value
 * is the name of the button that key moves to.
 *
 * Every direction is filled in. A DVD player needs a defined target for each
 * key, and where there is nowhere to go the sensible answer is "stay here",
 * which on a disc means pointing the direction at the button itself. Leaving
 * those out would hand the decision back to spumux's auto algorithm, which is
 * exactly what this module exists to avoid.
 */
function navigationFor(buttons) {
  const list = Array.isArray(buttons) ? buttons : [];
  const table = new Map();

  for (const button of list) {
    const entry = {};
    for (const direction of DIRECTION_NAMES) {
      const target = bestInDirection(list, button, direction);
      entry[direction] = (target || button).name;
    }
    table.set(button.name, entry);
  }

  return table;
}

/** The same table as a plain object, for handing across the process boundary. */
function navigationObject(buttons) {
  const out = {};
  for (const [name, entry] of navigationFor(buttons)) out[name] = { ...entry };
  return out;
}

module.exports = {
  DIRECTIONS,
  DIRECTION_NAMES,
  bestInDirection,
  navigationFor,
  navigationObject,
};
