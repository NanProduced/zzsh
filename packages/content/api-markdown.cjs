"use strict";
// Native import survives Nest's CommonJS compilation; this bridge is never part of the browser contract.
exports.inspectContentMarkdown = (...args) => import("./markdown.mjs").then(module => module.inspectMarkdown(...args));
exports.convertContentDocument = (...args) => import("./markdown.mjs").then(module => module.convertLegacyDocument(...args));
