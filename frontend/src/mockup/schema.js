import { COMPONENT_TYPES } from './tokens.js';

const TYPE_SET = new Set(COMPONENT_TYPES);

export function validateSpec(spec) {
  if (!spec || typeof spec !== 'object') return false;
  if (spec.noOp === true) return true;
  if (!Array.isArray(spec.screens)) return false;
  for (const screen of spec.screens) {
    if (!Array.isArray(screen.components)) continue;
    for (const comp of screen.components) {
      if (!TYPE_SET.has(comp.type)) return false;
    }
  }
  return true;
}
