/**
 * The preset Metro uses with no config at all, written down for Jest.
 *
 * `jest-expo/android` hands `babel-jest` a platform and nothing else, so with
 * no config file it transforms with no preset, and the first Flow annotation in
 * React Native's own Jest setup fails to parse. Metro reads this file too, and
 * gets the preset it already used.
 *
 * `.cjs` because the package is an ES module and `babel-jest` loads its config
 * synchronously.
 */
module.exports = {
  presets: ["babel-preset-expo"],
};
